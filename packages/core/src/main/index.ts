import { config as appConfig } from '../config/index.js';
import {
  Addon,
  Manifest,
  StrictManifestResource,
  UserData,
} from '../db/index.js';
import { Cache, createLogger, IdParser, userScopeKey } from '../utils/index.js';
import { withVariantSelector } from '../variants/runtime.js';
import Proxifier from '../streams/proxifier.js';
import StreamLimiter from '../streams/limiter.js';
import {
  StreamFetcher as Fetcher,
  StreamFilterer as Filterer,
  StreamSorter as Sorter,
  StreamDeduplicator as Deduplicator,
  StreamPrecomputer as Precomputer,
  StreamContext,
} from '../streams/index.js';
import type { AIOStreamsContext, AIOStreamsOptions } from './types.js';
import {
  applyPresets,
  assignPublicIps,
  fetchManifests,
  buildResources,
} from './setup.js';
import { getCatalog as _getCatalog } from './catalog.js';
import {
  getStreams as _getStreams,
  getMeta as _getMeta,
  getSubtitles as _getSubtitles,
  getAddonCatalog as _getAddonCatalog,
} from './resources.js';

const logger = createLogger('core');

/**
 * This private Master Add-On fork is supposed to expose Master Native on every
 * installed configuration. Historically those catalogs reached Stremio through
 * AIOStreams' normal preset/addon aggregation pipeline, which is also the path
 * that made Live TV, Radio and Porn render as ordinary Home/Board rows.
 *
 * Some saved configurations predate Master Source Pack or have it disabled.
 * Rather than manually appending raw catalog JSON at the final manifest route,
 * inject one minimal in-memory Master Source Pack preset when no enabled preset
 * is already providing Master Native. This does not mutate the stored config.
 */
function withRequiredMasterNative(userData: UserData): UserData {
  const presets = userData.presets ?? [];
  const hasEnabledMasterNative = presets.some(
    (preset) =>
      preset.enabled &&
      preset.type === 'master-source-pack' &&
      preset.options?.includeGeneral !== false
  );

  if (hasEnabledMasterNative) return userData;

  return {
    ...userData,
    presets: [
      ...presets,
      {
        type: 'master-source-pack',
        instanceId: 'master-source-pack-auto',
        enabled: true,
        options: {
          includeGeneral: true,
          includeLibrary: false,
          includeAnime: false,
          includeNekoBt: false,
          includeLiveTv: false,
          includeArgentinaTv: false,
          includeStreamingCatalogs: false,
          includeSubtitles: false,
        },
      },
    ],
  };
}

export class AIOStreams {
  private ctx: AIOStreamsContext;

  constructor(userData: UserData, options?: AIOStreamsOptions) {
    const effectiveUserData = withRequiredMasterNative(userData);
    const filterer = new Filterer(effectiveUserData);
    const precomputer = new Precomputer(effectiveUserData);
    this.ctx = {
      userData: effectiveUserData,
      options,
      manifestUrl: withVariantSelector(
        `${appConfig.bootstrap.baseUrl}/stremio/${effectiveUserData.uuid}/${effectiveUserData.encryptedPassword}`,
        '/manifest.json',
        effectiveUserData.activeVariants,
        effectiveUserData.variantSelectorLocation
      ),
      manifests: {},
      supportedResources: {},
      finalResources: [],
      finalCatalogs: [],
      finalAddonCatalogs: [],
      isInitialised: false,
      addons: [],
      proxifier: new Proxifier(effectiveUserData),
      limiter: new StreamLimiter(effectiveUserData),
      filterer,
      precomputer,
      fetcher: new Fetcher(effectiveUserData, filterer, precomputer),
      deduplicator: new Deduplicator(effectiveUserData),
      sorter: new Sorter(effectiveUserData),
      streamContext: null,
      addonInitialisationErrors: [],
    };
  }

  public async initialise(): Promise<AIOStreams> {
    if (this.ctx.isInitialised) return this;
    await applyPresets(this.ctx);
    await assignPublicIps(this.ctx);
    await fetchManifests(this.ctx);
    buildResources(this.ctx);
    this.ctx.isInitialised = true;
    return this;
  }

  private checkInitialised() {
    if (!this.ctx.isInitialised) {
      throw new Error(
        'AIOStreams is not initialised. Call initialise() first.'
      );
    }
  }

  public async getStreams(
    id: string,
    type: string,
    preCaching: boolean = false
  ) {
    return _getStreams(this.ctx, id, type, preCaching);
  }

  public async getCatalog(type: string, id: string, extras?: string) {
    return _getCatalog(this.ctx, type, id, extras);
  }

  public async getMeta(type: string, id: string) {
    return _getMeta(this.ctx, type, id);
  }

  public async getSubtitles(type: string, id: string, extras?: string) {
    return _getSubtitles(this.ctx, type, id, extras);
  }

  public async getAddonCatalog(type: string, id: string) {
    return _getAddonCatalog(this.ctx, type, id);
  }

  public getStreamContext(): StreamContext | null {
    return this.ctx.streamContext;
  }

  public getResources(): StrictManifestResource[] {
    this.checkInitialised();
    return this.ctx.finalResources;
  }

  public getCatalogs(): Manifest['catalogs'] {
    this.checkInitialised();
    return this.ctx.finalCatalogs;
  }

  public getAddonCatalogs(): Manifest['addonCatalogs'] {
    this.checkInitialised();
    return this.ctx.finalAddonCatalogs;
  }

  public getAddon(instanceId: string): Addon | undefined {
    return this.ctx.addons.find((a) => a.instanceId === instanceId);
  }

  public async shouldStopAutoPlay(type: string, id: string) {
    if (
      !this.ctx.userData.areYouStillThere?.enabled ||
      !this.ctx.userData.uuid ||
      type !== 'series'
    ) {
      return false;
    }
    logger.debug({ type, id }, 'checking if autoplay should be stopped');
    let disableAutoplay = false;
    const cfg = this.ctx.userData.areYouStillThere;
    const threshold = cfg.episodesBeforeCheck ?? 3;
    const cooldownMs = (cfg.cooldownMinutes ?? 60) * 60 * 1000;
    const cache = Cache.getInstance<string, { count: number; lastAt: number }>(
      'ays',
      10000,
      appConfig.bootstrap.redisUri ? undefined : 'sql'
    );
    const parsed = IdParser.parse(id, type);
    const baseSeriesKey = parsed
      ? `${parsed.type}:${parsed.value}`
      : id.split(':')[0] || id;
    const key = `${userScopeKey(this.ctx.userData)}:${baseSeriesKey}`;
    logger.trace({ key }, 'formed ays cache key');
    const now = Date.now();
    const prev = (await cache.get(key)) || { count: 0, lastAt: 0 };
    const withinWindow = now - prev.lastAt <= cooldownMs;
    const nextCount = withinWindow ? prev.count + 1 : 1;
    if (nextCount >= threshold) {
      disableAutoplay = true;
      await cache.set(
        key,
        { count: 0, lastAt: now },
        Math.ceil(cooldownMs / 1000)
      );
    } else {
      await cache.set(
        key,
        { count: nextCount, lastAt: now },
        Math.ceil(cooldownMs / 1000)
      );
    }
    logger.debug(
      { disableAutoplay, count: nextCount, withinWindow },
      'autoplay disable check result'
    );
    return disableAutoplay;
  }
}
