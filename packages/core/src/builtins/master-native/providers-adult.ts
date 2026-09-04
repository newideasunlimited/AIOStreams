/*
 * Native adult torrent catalog/search providers for Master Add-On.
 *
 * This implementation is independent and uses public torrent indexes directly.
 * It intentionally avoids copying code from unlicensed adult Stremio addons.
 */

export const MASTER_ADULT_ID_PREFIX = 'aiostreams::adult.';
export const MASTER_ADULT_CATALOG_ID = 'master-adult';

export type AdultTorrentItem = {
  hash: string;
  title: string;
  seeders: number;
  size: number;
  indexer: string;
};

const TIMEOUT_MS = 4500;

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36 Master-Addon/1.3',
      Accept: 'application/json,text/xml,application/xml,text/html;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
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
  const match = text.match(/([\d.,]+)\s*(B|KB|MB|GB|TB)\b/i);
  if (!match) return 0;
  const value = Number.parseFloat(match[1].replace(',', '.'));
  const units: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
  };
  return Number.isFinite(value)
    ? Math.round(value * (units[match[2].toLowerCase()] ?? 1))
    : 0;
}

function dedupe(items: AdultTorrentItem[]): AdultTorrentItem[] {
  const byHash = new Map<string, AdultTorrentItem>();
  for (const item of items) {
    if (!/^[a-f0-9]{40}$/i.test(item.hash) || !item.title) continue;
    const key = item.hash.toLowerCase();
    const current = byHash.get(key);
    if (!current || item.seeders > current.seeders) {
      byHash.set(key, { ...item, hash: key });
    }
  }
  return [...byHash.values()].sort((a, b) => b.seeders - a.seeders);
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

export async function fetchAdultCatalog(
  search?: string,
  genre?: string,
  skip = 0
): Promise<AdultTorrentItem[]> {
  const effectiveSearch =
    genre === 'VR' ? [search, 'VR'].filter(Boolean).join(' ') : search;

  const settled = await Promise.allSettled([
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
    ) as { h?: string; t?: string; s?: number; i?: string; n?: number };
    if (!payload.h || !/^[a-f0-9]{40}$/i.test(payload.h) || !payload.t) return null;
    return {
      hash: payload.h.toLowerCase(),
      title: payload.t,
      size: Number(payload.s ?? 0),
      indexer: payload.i ?? 'Adult',
      seeders: Number(payload.n ?? 0),
    };
  } catch {
    return null;
  }
}
