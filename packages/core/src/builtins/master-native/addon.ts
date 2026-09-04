/*
 * Master Native source engine.
 *
 * Provider strategies are adapted from the Apache-2.0 Magnetio scraper
 * project (peterdsp/Magnetio) and implemented inside Master Add-On so
 * Stremio does not depend on another hosted addon service.
 */
import { z } from 'zod';
import {
  BaseDebridAddon,
  BaseDebridConfigSchema,
  SearchMetadata,
} from '../base/debrid.js';
import {
  NZB,
  UnprocessedTorrent,
} from '../../debrid/utils.js';
import {
  Torrent,
  TitleMetadata,
  fileInfoStore,
  metadataStore,
} from '../../debrid/index.js';
import {
  BuiltinServiceId,
  createLogger,
  encryptString,
  getSimpleTextHash,
  ParsedId,
} from '../../utils/index.js';
import { config as appConfig } from '../../config/index.js';
import { Manifest, Meta, MetaPreview, Stream } from '../../db/schemas.js';
import { processTorrents, validateInfoHash } from '../utils/debrid.js';
import {
  searchBitsearch,
  searchBT4G,
  searchBTDig,
} from './providers-extra.js';
import {
  search1337x,
  searchGloTorrents,
  searchSubsPlease,
  searchTheRarBG,
  searchTorrentDownloads,
  searchTorrentGalaxy,
} from './providers-tier1.js';
import {
  searchKickass,
  searchMagnetDL,
  searchNyaa,
  searchRutor,
  searchTokyoTosho,
} from './providers-torrentio.js';
import {
  decodeAdultId,
  encodeAdultId,
  fetchAdultCatalog,
  MASTER_ADULT_CATALOG_ID,
  MASTER_ADULT_ID_PREFIX,
} from './providers-adult.js';

const logger = createLogger('master-native');

export const MasterNativeAddonConfigSchema = BaseDebridConfigSchema;
export type MasterNativeAddonConfig = z.infer<typeof MasterNativeAddonConfigSchema>;

type TorrentCandidate = {
  hash?: string;
  title?: string;
  seeders?: number;
  size?: number;
  indexer: string;
};

const PROVIDER_TIMEOUT_MS = 4500;
const PROVIDER_BUDGET_MS = 2500;

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Master-Addon/1.0' },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function cleanQueryPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9 ._-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildQuery(
  title: string,
  year: number | undefined,
  mediaType: string,
  season: number | undefined,
  episode: number | undefined
): string {
  const base = cleanQueryPart(title);
  if (mediaType === 'series' && season !== undefined) {
    const s = String(season).padStart(2, '0');
    if (episode !== undefined) {
      const e = String(episode).padStart(2, '0');
      return `${base} S${s}E${e}`;
    }
    return `${base} S${s}`;
  }
  return year ? `${base} ${year}` : base;
}

function withProviderBudget<T>(
  name: string,
  promise: Promise<T[]>
): Promise<T[]> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.debug('Master native provider budget exhausted', {
        provider: name,
        budgetMs: PROVIDER_BUDGET_MS,
      });
      resolve([]);
    }, PROVIDER_BUDGET_MS);

    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logger.warn('Master native provider failed', {
          provider: name,
          error: error instanceof Error ? error.message : String(error),
        });
        resolve([]);
      });
  });
}

async function searchYts(imdbId: string | undefined): Promise<TorrentCandidate[]> {
  if (!imdbId) return [];
  const url = new URL('https://yts.mx/api/v2/list_movies.json');
  url.searchParams.set('query_term', imdbId);
  url.searchParams.set('limit', '50');
  url.searchParams.set('sort_by', 'seeds');

  type YtsResponse = {
    status?: string;
    data?: {
      movies?: Array<{
        title_long?: string;
        imdb_code?: string;
        torrents?: Array<{
          hash?: string;
          quality?: string;
          type?: string;
          seeds?: number;
          size_bytes?: number;
        }>;
      }>;
    };
  };

  const data = await fetchJson<YtsResponse>(url.toString());
  if (data.status !== 'ok') return [];
  return (data.data?.movies ?? []).flatMap((movie) =>
    (movie.torrents ?? []).map((torrent) => ({
      hash: torrent.hash?.toLowerCase(),
      title: `${movie.title_long ?? 'Unknown'} ${torrent.quality ?? ''} ${torrent.type ?? ''}`.trim(),
      seeders: torrent.seeds ?? 0,
      size: torrent.size_bytes ?? 0,
      indexer: 'YTS',
    }))
  );
}

async function searchEztv(
  imdbId: string | undefined,
  season: number | undefined,
  episode: number | undefined
): Promise<TorrentCandidate[]> {
  if (!imdbId || season === undefined || episode === undefined) return [];
  const imdbNumeric = imdbId.replace(/^tt/i, '');
  const url = new URL('https://eztvx.to/api/get-torrents');
  url.searchParams.set('imdb_id', imdbNumeric);
  url.searchParams.set('limit', '100');
  url.searchParams.set('page', '1');

  type EztvResponse = {
    torrents?: Array<{
      hash?: string;
      title?: string;
      filename?: string;
      seeds?: number;
      size_bytes?: string;
      season?: string;
      episode?: string;
    }>;
  };

  const data = await fetchJson<EztvResponse>(url.toString());
  return (data.torrents ?? [])
    .filter((torrent) => {
      const s = Number(torrent.season);
      const e = Number(torrent.episode);
      return s === season && (e === episode || e === 0);
    })
    .map((torrent) => ({
      hash: torrent.hash?.toLowerCase(),
      title: torrent.title || torrent.filename || 'EZTV',
      seeders: torrent.seeds ?? 0,
      size: Number(torrent.size_bytes ?? 0),
      indexer: 'EZTV',
    }));
}

async function searchPirateBay(query: string, mediaType: string): Promise<TorrentCandidate[]> {
  if (!query) return [];
  const url = new URL('https://apibay.org/q.php');
  url.searchParams.set('q', query);
  url.searchParams.set('cat', mediaType === 'movie' ? '207' : '205');

  type TpbRow = {
    id?: string;
    name?: string;
    info_hash?: string;
    seeders?: string;
    size?: string;
  };

  const rows = await fetchJson<TpbRow[]>(url.toString());
  if (!Array.isArray(rows) || rows[0]?.id === '0') return [];
  return rows.map((row) => ({
    hash: row.info_hash?.toLowerCase(),
    title: row.name,
    seeders: Number(row.seeders ?? 0),
    size: Number(row.size ?? 0),
    indexer: 'ThePirateBay',
  }));
}

function normaliseWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function titleLooksRelevant(candidateTitle: string, requestedTitle: string): boolean {
  const wanted = normaliseWords(requestedTitle).filter((word) => word.length > 1);
  if (wanted.length === 0) return true;

  const candidateWords = new Set(normaliseWords(candidateTitle));
  const matched = wanted.filter((word) => candidateWords.has(word)).length;

  if (wanted.length === 1) return matched === 1;
  return matched >= Math.max(2, Math.ceil(wanted.length * 0.6));
}

function episodeLooksRelevant(
  candidateTitle: string,
  mediaType: string,
  season: number | undefined,
  episode: number | undefined
): boolean {
  if (mediaType !== 'series' || season === undefined) return true;

  const raw = candidateTitle.toLowerCase();
  const seasonText = String(season);
  const episodeText = episode === undefined ? undefined : String(episode);

  if (episodeText !== undefined) {
    const exactEpisodePatterns = [
      new RegExp(`s0*${seasonText}e0*${episodeText}(?:\\D|$)`, 'i'),
      new RegExp(`(?:^|\\D)0*${seasonText}x0*${episodeText}(?:\\D|$)`, 'i'),
    ];
    if (exactEpisodePatterns.some((pattern) => pattern.test(raw))) return true;

    if (/s\d{1,2}e\d{1,3}|(?:^|\D)\d{1,2}x\d{1,3}(?:\D|$)/i.test(raw)) {
      return false;
    }
  }

  const seasonPackPatterns = [
    new RegExp(`s0*${seasonText}(?:\\D|$)`, 'i'),
    new RegExp(`season[ ._-]*0*${seasonText}(?:\\D|$)`, 'i'),
  ];
  return seasonPackPatterns.some((pattern) => pattern.test(raw));
}

function filterRelevantCandidates(
  candidates: TorrentCandidate[],
  requestedTitle: string,
  mediaType: string,
  season: number | undefined,
  episode: number | undefined
): TorrentCandidate[] {
  return candidates.filter((candidate) => {
    if (!candidate.title) return false;
    return (
      titleLooksRelevant(candidate.title, requestedTitle) &&
      episodeLooksRelevant(candidate.title, mediaType, season, episode)
    );
  });
}

function deduplicate(candidates: TorrentCandidate[]): UnprocessedTorrent[] {
  const byHash = new Map<string, TorrentCandidate>();
  for (const candidate of candidates) {
    const hash = validateInfoHash(candidate.hash);
    if (!hash || !candidate.title) continue;
    const current = byHash.get(hash);
    if (!current || (candidate.seeders ?? 0) > (current.seeders ?? 0)) {
      byHash.set(hash, { ...candidate, hash });
    }
  }

  return [...byHash.values()].map((candidate) => ({
    confirmed: true,
    hash: candidate.hash!,
    downloadUrl: undefined,
    sources: [],
    indexer: candidate.indexer,
    seeders: candidate.seeders,
    title: candidate.title!,
    size: candidate.size ?? 0,
    type: 'torrent' as const,
  }));
}

export class MasterNativeAddon extends BaseDebridAddon<MasterNativeAddonConfig> {
  readonly id = 'master-native';
  readonly name = 'Master Native';
  readonly version = '1.4.0';
  readonly logger = logger;

  constructor(userData: MasterNativeAddonConfig, clientIp?: string) {
    super(userData, MasterNativeAddonConfigSchema, clientIp);
  }

  public override getManifest(): Manifest {
    const baseManifest = super.getManifest();
    return {
      ...baseManifest,
      description: 'Master native movie, TV, anime and adult source engine',
      types: [...(baseManifest.types ?? []), 'adult'],
      catalogs: [
        ...(baseManifest.catalogs ?? []),
        {
          type: 'adult',
          id: MASTER_ADULT_CATALOG_ID,
          name: 'Master Adult',
          extra: [
            { name: 'skip' },
            { name: 'search' },
            {
              name: 'genre',
              options: ['Latest', 'VR', 'JAV'],
              isRequired: false,
            },
          ],
        },
      ],
      resources: [
        ...baseManifest.resources,
        {
          name: 'catalog',
          types: ['adult'],
          idPrefixes: [MASTER_ADULT_CATALOG_ID],
        },
        {
          name: 'meta',
          types: ['adult'],
          idPrefixes: [MASTER_ADULT_ID_PREFIX],
        },
        {
          name: 'stream',
          types: ['adult'],
          idPrefixes: [MASTER_ADULT_ID_PREFIX],
        },
      ],
    };
  }

  public async getCatalog(
    type: string,
    catalogId: string,
    extras?: string
  ): Promise<MetaPreview[]> {
    if (type !== 'adult' || catalogId !== MASTER_ADULT_CATALOG_ID) {
      throw new Error(`Unsupported catalog: ${type}/${catalogId}`);
    }

    const params = new URLSearchParams(extras ?? '');
    const skip = Math.max(0, Number(params.get('skip') ?? 0) || 0);
    const search = params.get('search') || undefined;
    const genre = params.get('genre') || undefined;
    const items = await fetchAdultCatalog(search, genre, skip);

    return items.map((item) => ({
      id: encodeAdultId(item),
      type: 'adult',
      name: item.title,
      description: `${item.indexer} • ${item.seeders} seeders${item.size ? ` • ${(item.size / 1024 ** 3).toFixed(2)} GB` : ''}`,
      posterShape: 'landscape',
    }));
  }

  public async getMeta(type: string, id: string): Promise<Meta> {
    if (type !== 'adult') {
      throw new Error(`Unsupported meta type: ${type}`);
    }
    const item = decodeAdultId(id);
    if (!item) throw new Error(`Unsupported adult ID: ${id}`);

    return {
      id,
      type: 'adult',
      name: item.title,
      description: `${item.indexer} • ${item.seeders} seeders${item.size ? ` • ${(item.size / 1024 ** 3).toFixed(2)} GB` : ''}`,
      posterShape: 'landscape',
      videos: [],
      behaviorHints: {},
    };
  }

  public override async getStreams(type: string, id: string): Promise<Stream[]> {
    if (type !== 'adult' || !id.startsWith(MASTER_ADULT_ID_PREFIX)) {
      return super.getStreams(type, id);
    }

    const item = decodeAdultId(id);
    if (!item) throw new Error(`Unsupported adult ID: ${id}`);

    const torrentServices = this.userData.services.filter(
      (service) =>
        ![
          'nzbdav',
          'altmount',
          'stremio_nntp',
          'stremthru_newz',
          'aiostreams',
        ].includes(service.id)
    );
    if (torrentServices.length === 0) {
      return [
        this._createErrorStream({
          title: this.name,
          description: 'No torrent debrid service configured for adult playback.',
        }),
      ];
    }

    const candidate: Torrent = {
      confirmed: true,
      hash: item.hash,
      downloadUrl: undefined,
      sources: [],
      indexer: item.indexer,
      seeders: item.seeders,
      title: item.title,
      size: item.size,
      type: 'torrent',
    };
    const searchMetadata: SearchMetadata = {
      primaryTitle: item.title,
      titles: [item.title],
    };

    const processed = await processTorrents(
      [candidate],
      torrentServices,
      id,
      searchMetadata,
      this.clientIp,
      this.userData.checkOwned
    );

    const titleMetadata: TitleMetadata = { titles: [item.title] };
    const metadataId = getSimpleTextHash(JSON.stringify(titleMetadata));
    await metadataStore().set(
      metadataId,
      titleMetadata,
      appConfig.builtins.debrid.playbackLinkValidity,
      true
    );

    const encryptedStoreAuths = torrentServices.reduce(
      (acc, service) => {
        const auth = { id: service.id, credential: service.credential };
        acc[service.id] = encryptString(JSON.stringify(auth)).data ?? '';
        return acc;
      },
      {} as Record<BuiltinServiceId, string | string[]>
    );

    let streams = await Promise.all(
      processed.results.map((result) =>
        this._createStream(result, metadataId, encryptedStoreAuths)
      )
    );
    const serviceIds = processed.results.map((result) => result.service?.id);
    await fileInfoStore()?.flush();
    const proxied = await this._applyServiceProxying(streams, serviceIds);
    streams = proxied.streams;

    const errors = processed.errors.map((error) =>
      this._createErrorStream({
        title: this.name,
        description: error.error.message,
      })
    );

    return [...streams, ...proxied.errorStreams, ...errors];
  }

  protected async _searchNzbs(_parsedId: ParsedId): Promise<NZB[]> {
    return [];
  }

  protected async _searchTorrents(parsedId: ParsedId): Promise<UnprocessedTorrent[]> {
    const metadata = await this.getSearchMetadata();
    const title = metadata.primaryTitle;
    if (!title) return [];

    const imdbId =
      metadata.imdbId ??
      (parsedId.type === 'imdbId' ? `tt${parsedId.value}` : undefined);
    const season = metadata.season ?? (parsedId.season ? Number(parsedId.season) : undefined);
    const episode = metadata.episode ?? (parsedId.episode ? Number(parsedId.episode) : undefined);
    const query = buildQuery(title, metadata.year, parsedId.mediaType, season, episode);

    const tasks: Array<Promise<TorrentCandidate[]>> = [
      withProviderBudget('ThePirateBay', searchPirateBay(query, parsedId.mediaType)),
      withProviderBudget('Bitsearch', searchBitsearch(query)),
      withProviderBudget('BT4G', searchBT4G(query)),
      withProviderBudget('BTDig', searchBTDig(query)),
      withProviderBudget('1337x', search1337x(query, parsedId.mediaType)),
      withProviderBudget('GloTorrents', searchGloTorrents(query, parsedId.mediaType)),
      withProviderBudget('TorrentGalaxy', searchTorrentGalaxy(query, parsedId.mediaType)),
      withProviderBudget('TorrentDownloads', searchTorrentDownloads(query, parsedId.mediaType)),
      withProviderBudget('TheRarBG', searchTheRarBG(query, parsedId.mediaType)),
      withProviderBudget('KickassTorrents', searchKickass(query)),
      withProviderBudget('MagnetDL', searchMagnetDL(query, parsedId.mediaType)),
      withProviderBudget('Rutor', searchRutor(query)),
    ];
    if (parsedId.mediaType === 'movie') {
      tasks.push(withProviderBudget('YTS', searchYts(imdbId)));
    }
    if (parsedId.mediaType === 'series') {
      tasks.push(withProviderBudget('EZTV', searchEztv(imdbId, season, episode)));
    }
    if (parsedId.mediaType === 'series' || parsedId.mediaType === 'anime') {
      tasks.push(withProviderBudget('SubsPlease', searchSubsPlease(title, episode)));
      tasks.push(withProviderBudget('Nyaa', searchNyaa(query)));
      tasks.push(withProviderBudget('TokyoTosho', searchTokyoTosho(query)));
    }

    const started = Date.now();
    const groups = await Promise.all(tasks);
    const candidates = groups.flat();
    const relevantCandidates = filterRelevantCandidates(
      candidates,
      title,
      parsedId.mediaType,
      season,
      episode
    );
    const torrents = deduplicate(relevantCandidates);

    logger.info('Master native search complete', {
      query,
      providers: tasks.length,
      rawResults: candidates.length,
      droppedIrrelevant: candidates.length - relevantCandidates.length,
      results: torrents.length,
      providerBudgetMs: PROVIDER_BUDGET_MS,
      tookMs: Date.now() - started,
    });
    return torrents;
  }
}
