/*
 * Adult catalog and playback providers for Master Add-On.
 *
 * Direct tube sources are the primary browse experience. Torrent sources are
 * retained only as a fallback. This mirrors the working Porn Tube pattern:
 * catalog cards carry real artwork/tags and playback resolves direct HTTP video
 * URLs only when Stremio requests streams for a selected item.
 */

import parseTorrent from 'parse-torrent';

export const MASTER_ADULT_ID_PREFIX = 'aiostreams::adult.';
export const MASTER_ADULT_CATALOG_ID = 'master-adult';

export const MASTER_ADULT_GENRES = [
  'Latest',
  'Popular',
  'Teen (18+)',
  'Anal',
  'Blowjob',
  'MILF',
  'Lesbian',
  'Amateur',
  'Mature',
  'Threesome',
  'Creampie',
  'Interracial',
  'Asian',
  'Ebony',
  'Big Tits',
  'Big Ass',
  'POV',
] as const;

export type AdultTorrentItem = {
  hash: string;
  title: string;
  seeders: number;
  size: number;
  indexer: string;
  poster?: string;
  detailUrl?: string;
  sourceKind?: 'direct' | 'torrent';
  sourceId?: string;
  tags?: string[];
  duration?: string;
  description?: string;
};

export type AdultDirectStream = {
  url: string;
  name: string;
  referer?: string;
};

const TIMEOUT_MS = 7000;
const PORNRIPS_BASE = 'https://pornrips.to';
const EPORNER_BASE = 'https://www.eporner.com';
const FREEPORNVIDEOS_BASE = 'https://www.freepornvideos.xxx';
const DIRECT_PAGE_SIZE = 60;

async function fetchResponse(
  url: string,
  referer?: string,
  redirect: 'follow' | 'manual' = 'follow'
): Promise<Response> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 Master-Addon/2.0',
      Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,video/mp4,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      ...(referer ? { Referer: referer } : {}),
    },
    redirect,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (redirect === 'manual' && response.status >= 300 && response.status < 400) {
    return response;
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response;
}

async function fetchText(url: string, referer?: string): Promise<string> {
  return (await fetchResponse(url, referer)).text();
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function strip(value: string): string {
  return decode(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function absoluteUrl(value: string, base: string): string {
  try {
    return new URL(decode(value), base).toString();
  } catch {
    return '';
  }
}

function parseSize(text: string): number {
  const match = text.match(/([\d.,]+)\s*(B|KB|MB|GB|TB|GiB|MiB)\b/i);
  if (!match) return 0;
  const value = Number.parseFloat(match[1].replace(',', '.'));
  const units: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    tb: 1024 ** 4,
  };
  return Number.isFinite(value)
    ? Math.round(value * (units[match[2].toLowerCase()] ?? 1))
    : 0;
}

function genreQuery(genre?: string): string | undefined {
  if (!genre || genre === 'Latest') return undefined;
  if (genre === 'Popular') return undefined;
  if (genre === 'Teen (18+)') return 'teen';
  return genre;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function directFirst(items: AdultTorrentItem[]): AdultTorrentItem[] {
  const seen = new Set<string>();
  const unique: AdultTorrentItem[] = [];
  for (const item of items) {
    const key = item.sourceId
      ? `${item.indexer}:${item.sourceId}`
      : item.detailUrl
        ? `${item.indexer}:${item.detailUrl}`
        : item.hash
          ? `hash:${item.hash.toLowerCase()}`
          : `${item.indexer}:${item.title}`;
    if (seen.has(key) || !item.title) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.sort((a, b) => {
    const directDelta = Number(b.sourceKind === 'direct') - Number(a.sourceKind === 'direct');
    if (directDelta !== 0) return directDelta;
    const artDelta = Number(Boolean(b.poster)) - Number(Boolean(a.poster));
    if (artDelta !== 0) return artDelta;
    return b.seeders - a.seeders;
  });
}

function interleave<T>(left: T[], right: T[]): T[] {
  const out: T[] = [];
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    if (left[i]) out.push(left[i]);
    if (right[i]) out.push(right[i]);
  }
  return out;
}

type EpornerThumb = { src?: string; width?: number; height?: number };
type EpornerVideo = {
  id?: string;
  title?: string;
  keywords?: string;
  views?: number;
  rate?: number;
  url?: string;
  added?: string;
  length_min?: string;
  default_thumb?: EpornerThumb;
  thumbs?: EpornerThumb[];
};
type EpornerResponse = { videos?: EpornerVideo[] };

function bestEpornerPoster(video: EpornerVideo): string | undefined {
  const thumbs = [...(video.thumbs ?? [])]
    .filter((thumb) => thumb.src)
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return thumbs[0]?.src || video.default_thumb?.src || undefined;
}

async function searchEporner(
  search?: string,
  genre?: string,
  skip = 0
): Promise<AdultTorrentItem[]> {
  const tag = genreQuery(genre);
  const q = [tag, search].filter(Boolean).join(' ').trim() || 'all';
  const page = Math.floor(skip / DIRECT_PAGE_SIZE) + 1;
  const url = new URL(`${EPORNER_BASE}/api/v2/video/search/`);
  url.searchParams.set('query', q);
  url.searchParams.set('per_page', String(DIRECT_PAGE_SIZE));
  url.searchParams.set('page', String(page));
  url.searchParams.set('thumbsize', 'big');
  url.searchParams.set('order', genre === 'Popular' ? 'most-popular' : 'latest');
  url.searchParams.set('gay', '0');
  url.searchParams.set('lq', '1');
  url.searchParams.set('format', 'json');

  const data = JSON.parse(await fetchText(url.toString())) as EpornerResponse;
  return (data.videos ?? [])
    .filter((video) => video.id && video.title && video.url)
    .map((video) => ({
      hash: '',
      title: video.title!,
      seeders: 0,
      size: 0,
      indexer: 'EPorner',
      sourceKind: 'direct' as const,
      sourceId: video.id!,
      poster: bestEpornerPoster(video),
      detailUrl: video.url!,
      tags: uniqueStrings((video.keywords ?? '').split(',')),
      duration: video.length_min,
      description: `${Number(video.views ?? 0).toLocaleString()} views${video.rate ? ` • ${video.rate}/5` : ''}`,
    }));
}

async function searchFreePornVideos(skip = 0): Promise<AdultTorrentItem[]> {
  const page = Math.floor(skip / 40) + 1;
  const html = await fetchText(`${FREEPORNVIDEOS_BASE}/latest-updates/${page}/`);
  const linkRe = /<a\b([^>]*?)href=["']([^"']*\/videos\/(\d+)\/([^"'?#/]+)\/?)['"]([^>]*)>/gi;
  const seen = new Set<string>();
  const out: AdultTorrentItem[] = [];

  for (const match of html.matchAll(linkRe)) {
    const sourceId = match[3];
    if (seen.has(sourceId)) continue;
    const attrs = `${match[1]} ${match[5]}`;
    const title = strip(attrs.match(/\btitle=["']([^"']+)["']/i)?.[1] ?? '');
    if (!title) continue;
    seen.add(sourceId);

    const detailUrl = absoluteUrl(match[2], FREEPORNVIDEOS_BASE);
    const start = Math.max(0, (match.index ?? 0) - 700);
    const end = Math.min(html.length, (match.index ?? 0) + match[0].length + 2200);
    const window = html.slice(start, end);
    const imageMatch =
      window.match(/<img[^>]+class=["'][^"']*\bthumb\b[^"']*["'][^>]+(?:data-original|data-src|src)=["']([^"']+)["']/i) ??
      window.match(/<img[^>]+(?:data-original|data-src|src)=["']([^"']+)["'][^>]*class=["'][^"']*\bthumb\b/i);
    const duration = strip(window.match(/<span[^>]+class=["'][^"']*duration[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '');

    out.push({
      hash: '',
      title,
      seeders: 0,
      size: 0,
      indexer: 'FreePornVideos',
      sourceKind: 'direct',
      sourceId,
      poster: imageMatch ? absoluteUrl(imageMatch[1], detailUrl) : undefined,
      detailUrl,
      duration: duration.replace(/^Full Video\s*/i, '').trim() || undefined,
    });
    if (out.length >= 40) break;
  }
  return out;
}

type PornRipsListing = {
  title: string;
  detailUrl: string;
  poster?: string;
  size: number;
};

function parsePornRipsListings(html: string): PornRipsListing[] {
  const results: PornRipsListing[] = [];
  const articleRe = /<article\b[\s\S]*?<\/article>/gi;
  for (const match of html.matchAll(articleRe)) {
    const article = match[0];
    const titleMatch =
      article.match(/<h2[^>]*class=["'][^"']*(?:entry-title)?[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i) ??
      article.match(/<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const title = strip(titleMatch[2]);
    const detailUrl = absoluteUrl(titleMatch[1], PORNRIPS_BASE);
    if (!title || !detailUrl) continue;
    const imageMatch = article.match(/<img[^>]+(?:data-lazy-src|data-src|src)=["']([^"']+)["'][^>]*>/i);
    results.push({
      title,
      detailUrl,
      poster: imageMatch ? absoluteUrl(imageMatch[1], detailUrl) || undefined : undefined,
      size: parseSize(strip(article)),
    });
  }
  return results;
}

async function searchPornRips(search?: string): Promise<AdultTorrentItem[]> {
  const url = search ? `${PORNRIPS_BASE}/?s=${encodeURIComponent(search)}` : `${PORNRIPS_BASE}/`;
  const html = await fetchText(url);
  return parsePornRipsListings(html).slice(0, 40).map((listing) => ({
    hash: '',
    title: listing.title,
    seeders: 0,
    size: listing.size,
    indexer: 'PornRips',
    sourceKind: 'torrent' as const,
    poster: listing.poster,
    detailUrl: listing.detailUrl,
  }));
}

async function searchPirateBayAdult(search?: string): Promise<AdultTorrentItem[]> {
  type TpbRow = { id?: string; name?: string; info_hash?: string; seeders?: string; size?: string };
  const url = search
    ? `https://apibay.org/q.php?q=${encodeURIComponent(search)}&cat=500`
    : 'https://apibay.org/precompiled/data_top100_500.json';
  const rows = JSON.parse(await fetchText(url)) as TpbRow[];
  if (!Array.isArray(rows) || rows[0]?.id === '0') return [];
  return rows
    .filter((row) => /^[a-f0-9]{40}$/i.test(row.info_hash ?? '') && row.name)
    .map((row) => ({
      hash: row.info_hash!.toLowerCase(),
      title: row.name!,
      seeders: Number(row.seeders ?? 0) || 0,
      size: Number(row.size ?? 0) || 0,
      indexer: 'ThePirateBay Adult',
      sourceKind: 'torrent' as const,
    }));
}

async function searchSukebei(search?: string): Promise<AdultTorrentItem[]> {
  const url = new URL('https://sukebei.nyaa.si/');
  url.searchParams.set('page', 'rss');
  url.searchParams.set('c', '2_0');
  url.searchParams.set('f', '0');
  url.searchParams.set('s', 'seeders');
  url.searchParams.set('o', 'desc');
  if (search) url.searchParams.set('q', search);
  const xml = await fetchText(url.toString());
  const results: AdultTorrentItem[] = [];
  for (const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = item[1];
    const title = strip(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    const hash = strip(block.match(/<(?:nyaa:)?infoHash>([\s\S]*?)<\/(?:nyaa:)?infoHash>/i)?.[1] ?? '').toLowerCase();
    if (!/^[a-f0-9]{40}$/i.test(hash) || !title) continue;
    results.push({
      hash,
      title,
      seeders: Number(strip(block.match(/<(?:nyaa:)?seeders>([\s\S]*?)<\/(?:nyaa:)?seeders>/i)?.[1] ?? '0')) || 0,
      size: parseSize(strip(block.match(/<(?:nyaa:)?size>([\s\S]*?)<\/(?:nyaa:)?size>/i)?.[1] ?? '')),
      indexer: 'Sukebei',
      sourceKind: 'torrent',
    });
  }
  return results;
}

async function resolvePornRipsItem(item: AdultTorrentItem): Promise<AdultTorrentItem | null> {
  if (!item.detailUrl) return null;
  const detailHtml = await fetchText(item.detailUrl, item.detailUrl);
  const magnet = decode(detailHtml.match(/href=["'](magnet:\?xt=urn:btih:[^"']+)["']/i)?.[1] ?? '');
  let hash = '';
  if (magnet) {
    try {
      hash = (await parseTorrent(magnet)).infoHash?.toLowerCase() ?? '';
    } catch {
      hash = '';
    }
  }
  if (!hash) {
    let torrentUrl = decode(detailHtml.match(/href=["']([^"']+\.torrent(?:\?[^"']*)?)["']/i)?.[1] ?? '');
    if (torrentUrl) torrentUrl = absoluteUrl(torrentUrl, item.detailUrl);
    if (!torrentUrl) torrentUrl = `${PORNRIPS_BASE}/torrents/${encodeURIComponent(item.title)}.torrent`;
    try {
      const torrentResponse = await fetchResponse(torrentUrl, item.detailUrl);
      hash = (await parseTorrent(Buffer.from(await torrentResponse.arrayBuffer()))).infoHash?.toLowerCase() ?? '';
    } catch {
      hash = '';
    }
  }
  if (!/^[a-f0-9]{40}$/i.test(hash)) return null;
  return { ...item, hash };
}

function qualityRank(name: string): number {
  const match = name.match(/(2160|1440|1080|720|480|360|240)p?/i);
  return Number(match?.[1] ?? 0);
}

async function resolveFreePornVideos(item: AdultTorrentItem): Promise<AdultDirectStream[]> {
  if (!item.detailUrl) return [];
  const html = await fetchText(item.detailUrl, FREEPORNVIDEOS_BASE);
  const videoBlock = html.match(/<video\b[^>]*class=["'][^"']*video-js[^"']*["'][^>]*>([\s\S]*?)<\/video>/i)?.[1] ?? html;
  const streams: AdultDirectStream[] = [];
  for (const match of videoBlock.matchAll(/<source\b([^>]*)>/gi)) {
    const attrs = match[1];
    const raw = attrs.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    const label = attrs.match(/\blabel=["']([^"']+)["']/i)?.[1] ?? attrs.match(/\btitle=["']([^"']+)["']/i)?.[1];
    if (!raw) continue;
    const url = absoluteUrl(raw, item.detailUrl);
    if (!/^https?:\/\//i.test(url)) continue;
    streams.push({ url, name: `FreePornVideos ${label || 'Watch'}`, referer: item.detailUrl });
  }
  return streams.sort((a, b) => qualityRank(b.name) - qualityRank(a.name));
}

async function resolveEporner(item: AdultTorrentItem): Promise<AdultDirectStream[]> {
  if (!item.detailUrl) return [];
  const html = await fetchText(item.detailUrl, EPORNER_BASE);
  const streams: AdultDirectStream[] = [];

  for (const match of html.matchAll(/<source\b([^>]*)>/gi)) {
    const attrs = match[1];
    const raw = attrs.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (!raw) continue;
    const url = absoluteUrl(raw, item.detailUrl);
    if (!/^https?:\/\//i.test(url)) continue;
    const label = attrs.match(/\b(?:label|title)=["']([^"']+)["']/i)?.[1] ?? 'Watch';
    streams.push({ url, name: `EPorner ${label}`, referer: item.detailUrl });
  }

  if (streams.length > 0) {
    return streams.sort((a, b) => qualityRank(b.name) - qualityRank(a.name));
  }

  const sectionStart = html.search(/id=["']hd-porn-dload["']/i);
  const section = sectionStart >= 0 ? html.slice(sectionStart, sectionStart + 20000) : html;
  const downloadUrls = uniqueStrings(
    [...section.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)]
      .map((match) => absoluteUrl(match[1], item.detailUrl!))
      .filter((url) => /download|dload|\.mp4(?:\?|$)/i.test(url))
  ).slice(0, 8);

  for (const downloadUrl of downloadUrls) {
    try {
      if (/\.mp4(?:\?|$)/i.test(downloadUrl)) {
        streams.push({ url: downloadUrl, name: `EPorner ${qualityRank(downloadUrl) || 'Watch'}`, referer: item.detailUrl });
        continue;
      }
      const response = await fetchResponse(downloadUrl, item.detailUrl, 'manual');
      const location = response.headers.get('location');
      if (!location) continue;
      const url = absoluteUrl(location, downloadUrl);
      if (/^https?:\/\//i.test(url)) {
        const q = qualityRank(url) || qualityRank(downloadUrl);
        streams.push({ url, name: `EPorner ${q ? `${q}p` : 'Watch'}`, referer: item.detailUrl });
      }
    } catch {
      // Try the remaining quality links.
    }
  }
  return streams.sort((a, b) => qualityRank(b.name) - qualityRank(a.name));
}

export async function resolveAdultDirectStreams(item: AdultTorrentItem): Promise<AdultDirectStream[]> {
  if (item.indexer === 'EPorner') return resolveEporner(item);
  if (item.indexer === 'FreePornVideos') return resolveFreePornVideos(item);
  return [];
}

export async function resolveAdultItem(item: AdultTorrentItem): Promise<AdultTorrentItem | null> {
  if (item.hash && /^[a-f0-9]{40}$/i.test(item.hash)) return { ...item, hash: item.hash.toLowerCase() };
  if (item.indexer === 'PornRips') return resolvePornRipsItem(item);
  return null;
}

export async function fetchAdultCatalog(
  search?: string,
  genre?: string,
  skip = 0
): Promise<AdultTorrentItem[]> {
  const directTasks: Promise<AdultTorrentItem[]>[] = [searchEporner(search, genre, skip)];
  if (!search && (!genre || genre === 'Latest')) directTasks.push(searchFreePornVideos(skip));

  const directSettled = await Promise.allSettled(directTasks);
  const eporner = directSettled[0]?.status === 'fulfilled' ? directSettled[0].value : [];
  const fpv = directSettled[1]?.status === 'fulfilled' ? directSettled[1].value : [];
  const direct = directFirst(interleave(eporner, fpv));
  if (direct.length > 0) return direct.slice(0, 100);

  // Direct tube sites are primary. Only fall back to artwork-bearing PornRips,
  // then raw torrent rows, when the direct providers are unavailable.
  const fallbackQuery = [genreQuery(genre), search].filter(Boolean).join(' ').trim() || undefined;
  const fallbackSettled = await Promise.allSettled([
    searchPornRips(fallbackQuery),
    searchPirateBayAdult(fallbackQuery),
    searchSukebei(fallbackQuery),
  ]);
  const fallback = fallbackSettled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  return directFirst(fallback).slice(0, 100);
}

export function encodeAdultId(item: AdultTorrentItem): string {
  const payload = Buffer.from(
    JSON.stringify({
      h: item.hash,
      t: item.title,
      s: item.size,
      i: item.indexer,
      n: item.seeders,
      p: item.poster,
      u: item.detailUrl,
      k: item.sourceKind,
      x: item.sourceId,
      g: item.tags,
      d: item.duration,
      e: item.description,
    }),
    'utf8'
  ).toString('base64url');
  return `${MASTER_ADULT_ID_PREFIX}${payload}`;
}

export function decodeAdultId(id: string): AdultTorrentItem | null {
  if (!id.startsWith(MASTER_ADULT_ID_PREFIX)) return null;
  try {
    const payload = JSON.parse(Buffer.from(id.slice(MASTER_ADULT_ID_PREFIX.length), 'base64url').toString('utf8')) as {
      h?: string;
      t?: string;
      s?: number;
      i?: string;
      n?: number;
      p?: string;
      u?: string;
      k?: 'direct' | 'torrent';
      x?: string;
      g?: string[];
      d?: string;
      e?: string;
    };
    if (!payload.t) return null;
    if (payload.h && !/^[a-f0-9]{40}$/i.test(payload.h)) return null;
    if (!payload.h && !payload.u) return null;
    return {
      hash: (payload.h ?? '').toLowerCase(),
      title: payload.t,
      size: Number(payload.s ?? 0),
      indexer: payload.i ?? 'Adult',
      seeders: Number(payload.n ?? 0),
      poster: payload.p,
      detailUrl: payload.u,
      sourceKind: payload.k,
      sourceId: payload.x,
      tags: Array.isArray(payload.g) ? payload.g : undefined,
      duration: payload.d,
      description: payload.e,
    };
  } catch {
    return null;
  }
}
