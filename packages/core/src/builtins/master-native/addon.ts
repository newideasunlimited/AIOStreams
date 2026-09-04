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
} from '../base/debrid.js';
import { NZB, UnprocessedTorrent } from '../../debrid/utils.js';
import { createLogger, ParsedId } from '../../utils/index.js';
import { validateInfoHash } from '../utils/debrid.js';
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
  readonly version = '1.2.0';
  readonly logger = logger;

  constructor(userData: MasterNativeAddonConfig, clientIp?: string) {
    super(userData, MasterNativeAddonConfigSchema, clientIp);
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
      searchPirateBay(query, parsedId.mediaType),
      searchBitsearch(query),
      searchBT4G(query),
      searchBTDig(query),
      search1337x(query, parsedId.mediaType),
      searchGloTorrents(query, parsedId.mediaType),
      searchTorrentGalaxy(query, parsedId.mediaType),
      searchTorrentDownloads(query, parsedId.mediaType),
      searchTheRarBG(query, parsedId.mediaType),
    ];
    if (parsedId.mediaType === 'movie') tasks.push(searchYts(imdbId));
    if (parsedId.mediaType === 'series') tasks.push(searchEztv(imdbId, season, episode));
    if (parsedId.mediaType === 'series' || parsedId.mediaType === 'anime') {
      tasks.push(searchSubsPlease(title, episode));
    }

    const started = Date.now();
    const settled = await Promise.allSettled(tasks);
    const candidates: TorrentCandidate[] = [];
    let failedProviders = 0;
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        candidates.push(...result.value);
      } else {
        failedProviders++;
        logger.warn('Master native provider failed', {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    const torrents = deduplicate(candidates);
    logger.info('Master native search complete', {
      query,
      providers: tasks.length,
      failedProviders,
      rawResults: candidates.length,
      results: torrents.length,
      tookMs: Date.now() - started,
    });
    return torrents;
  }
}
