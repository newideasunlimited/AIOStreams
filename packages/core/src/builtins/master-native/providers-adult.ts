/*
 * Native adult catalog/search providers for Master Add-On.
 *
 * PornRips follows the working GPL reference architecture: catalog/meta are
 * returned from scene listings immediately, while magnet/.torrent resolution
 * happens lazily only when Stremio requests streams for a selected item.
 */

import parseTorrent from 'parse-torrent';

export const MASTER_ADULT_ID_PREFIX = 'aiostreams::adult.';
export const MASTER_ADULT_CATALOG_ID = 'master-adult';

export type AdultTorrentItem = {
  hash?: string;
  title: string;
  seeders: number;
  size: number;
  indexer: string;
  poster?: string;
  detailUrl?: string;
};

const TIMEOUT_MS = 7000;
const PORNRIPS_BASE = 'https://pornrips.to';

async function fetchResponse(url: string, referer?: string): Promise<Response> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 Master-Addon/1.6',
      Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      ...(referer ? { Referer: referer } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
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

function absoluteUrl(value: string, base: string): string {
  try {
    return new URL(decode(value), base).toString();
  } catch {
    return '';
  }
}

function itemKey(item: AdultTorrentItem): string {
  if (item.hash && /^[a-f0-9]{40}$/i.test(item.hash)) return `hash:${item.hash.toLowerCase()}`;
  if (item.detailUrl) return `url:${item.detailUrl}`;
  return `title:${item.indexer}:${item.title}`;
}

function dedupe(items: AdultTorrentItem[]): AdultTorrentItem[] {
  const byKey = new Map<string, AdultTorrentItem>();
  for (const item of items) {
    if (!item.title) continue;
    if (!item.hash && !item.detailUrl) continue;
    const key = itemKey(item);
    const current = byKey.get(key);
    if (!current || item.seeders > current.seeders) {
      byKey.set(key, {
        ...item,
        hash: item.hash?.toLowerCase(),
      });
    }
  }
  return [...byKey.values()].sort((a, b) => b.seeders - a.seeders);
}

async function searchPirateBayAdult(search?: string): Promise<AdultTorrentItem[]> {
  type TpbRow = {
    id?: string;
    name?: string;
    info_hash?: string;
    seeders?: string;
    size?: string;
  };

  const url = search
    ? `https://apibay.org/q.php?q=${encodeURIComponent(search)}&cat=500`
    : 'https://apibay.org/precompiled/data_top100_500.json';

  const text = await fetchText(url);
  const rows = JSON.parse(text) as TpbRow[];
  if (!Array.isArray(rows) || rows[0]?.id === '0') return [];

  return rows
    .filter((row) => /^[a-f0-9]{40}$/i.test(row.info_hash ?? '') && row.name)
    .map((row) => ({
      hash: row.info_hash!.toLowerCase(),
      title: row.name!,
      seeders: Number(row.seeders ?? 0) || 0,
      size: Number(row.size ?? 0) || 0,
      indexer: 'ThePirateBay Adult',
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
    const hash = strip(
      block.match(/<(?:nyaa:)?infoHash>([\s\S]*?)<\/(?:nyaa:)?infoHash>/i)?.[1] ?? ''
    ).toLowerCase();
    if (!/^[a-f0-9]{40}$/i.test(hash) || !title) continue;
    const seeders =
      Number(
        strip(
          block.match(/<(?:nyaa:)?seeders>([\s\S]*?)<\/(?:nyaa:)?seeders>/i)?.[1] ?? '0'
        )
      ) || 0;
    const sizeText = strip(
      block.match(/<(?:nyaa:)?size>([\s\S]*?)<\/(?:nyaa:)?size>/i)?.[1] ?? ''
    );
    results.push({
      hash,
      title,
      seeders,
      size: parseSize(sizeText),
      indexer: 'Sukebei',
    });
  }
  return results;
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
    const titleMatch = article.match(
      /<h2[^>]*class=["'][^"']*(?:entry-title)?[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i
    ) ?? article.match(/<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;

    const title = strip(titleMatch[2]);
    const detailUrl = absoluteUrl(titleMatch[1], PORNRIPS_BASE);
    if (!title || !detailUrl) continue;

    const imageMatch = article.match(
      /<img[^>]+(?:data-lazy-src|data-src|src)=["']([^"']+)["'][^>]*>/i
    );
    const poster = imageMatch ? absoluteUrl(imageMatch[1], detailUrl) : undefined;
    results.push({
      title,
      detailUrl,
      poster: poster || undefined,
      size: parseSize(strip(article)),
    });
  }
  return results;
}

async function searchPornRips(search?: string): Promise<AdultTorrentItem[]> {
  const url = search
    ? `${PORNRIPS_BASE}/?s=${encodeURIComponent(search)}`
    : `${PORNRIPS_BASE}/`;
  const html = await fetchText(url);
  return parsePornRipsListings(html).slice(0, 40).map((listing) => ({
    title: listing.title,
    seeders: 0,
    size: listing.size,
    indexer: 'PornRips',
    poster: listing.poster,
    detailUrl: listing.detailUrl,
  }));
}

async function resolvePornRipsItem(item: AdultTorrentItem): Promise<AdultTorrentItem | null> {
  if (!item.detailUrl) return null;

  const detailHtml = await fetchText(item.detailUrl, item.detailUrl);
  const magnet = decode(
    detailHtml.match(/href=["'](magnet:\?xt=urn:btih:[^"']+)["']/i)?.[1] ?? ''
  );

  let hash = '';
  if (magnet) {
    try {
      hash = (await parseTorrent(magnet)).infoHash?.toLowerCase() ?? '';
    } catch {
      hash = '';
    }
  }

  if (!hash) {
    let torrentUrl = decode(
      detailHtml.match(/href=["']([^"']+\.torrent(?:\?[^"']*)?)["']/i)?.[1] ?? ''
    );
    if (torrentUrl) torrentUrl = absoluteUrl(torrentUrl, item.detailUrl);
    if (!torrentUrl) {
      torrentUrl = `${PORNRIPS_BASE}/torrents/${encodeURIComponent(item.title)}.torrent`;
    }

    try {
      const torrentResponse = await fetchResponse(torrentUrl, item.detailUrl);
      const buffer = Buffer.from(await torrentResponse.arrayBuffer());
      hash = (await parseTorrent(buffer)).infoHash?.toLowerCase() ?? '';
    } catch {
      hash = '';
    }
  }

  if (!/^[a-f0-9]{40}$/i.test(hash)) return null;
  return { ...item, hash };
}

export async function resolveAdultItem(item: AdultTorrentItem): Promise<AdultTorrentItem | null> {
  if (item.hash && /^[a-f0-9]{40}$/i.test(item.hash)) {
    return { ...item, hash: item.hash.toLowerCase() };
  }
  if (item.indexer === 'PornRips') return resolvePornRipsItem(item);
  return null;
}

export async function fetchAdultCatalog(
  search?: string,
  genre?: string,
  skip = 0
): Promise<AdultTorrentItem[]> {
  const effectiveSearch =
    genre === 'VR' ? [search, 'VR'].filter(Boolean).join(' ') : search;

  const settled = await Promise.allSettled([
    searchPornRips(effectiveSearch),
    searchPirateBayAdult(effectiveSearch),
    searchSukebei(effectiveSearch),
  ]);

  let items = dedupe(
    settled.flatMap((result) =>
      result.status === 'fulfilled' ? result.value : []
    )
  );

  if (genre === 'VR') {
    items = items.filter((item) => /(?:^|\W)vr(?:\W|$)|virtual reality/i.test(item.title));
  } else if (genre === 'JAV') {
    items = items.filter(
      (item) => item.indexer === 'Sukebei' || /(?:^|\W)jav(?:\W|$)/i.test(item.title)
    );
  }

  return items.slice(skip, skip + 100);
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
    }),
    'utf8'
  ).toString('base64url');
  return `${MASTER_ADULT_ID_PREFIX}${payload}`;
}

export function decodeAdultId(id: string): AdultTorrentItem | null {
  if (!id.startsWith(MASTER_ADULT_ID_PREFIX)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(id.slice(MASTER_ADULT_ID_PREFIX.length), 'base64url').toString('utf8')
    ) as { h?: string; t?: string; s?: number; i?: string; n?: number; p?: string; u?: string };
    if (!payload.t) return null;
    if (payload.h && !/^[a-f0-9]{40}$/i.test(payload.h)) return null;
    if (!payload.h && !payload.u) return null;
    return {
      hash: payload.h?.toLowerCase(),
      title: payload.t,
      size: Number(payload.s ?? 0),
      indexer: payload.i ?? 'Adult',
      seeders: Number(payload.n ?? 0),
      poster: payload.p,
      detailUrl: payload.u,
    };
  } catch {
    return null;
  }
}
