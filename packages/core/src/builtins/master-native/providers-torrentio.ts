/*
 * Torrentio-compatibility provider pack for Master Native.
 *
 * Scraping strategies for KickassTorrents, Nyaa and Rutor are adapted from
 * peterdsp/Magnetio (Apache-2.0). MagnetDL and TokyoTosho are independently
 * implemented from their public search/RSS interfaces.
 */

export type TorrentioTorrentCandidate = {
  hash?: string;
  title?: string;
  seeders?: number;
  size?: number;
  indexer: string;
};

const TIMEOUT_MS = 4500;

const KAT_DOMAINS = ['https://katcr.to', 'https://kickasstorrents.to'];
const MAGNETDL_DOMAINS = ['https://magnetdl.co', 'https://magnetdl.io'];
const TOKYO_TOSHO_DOMAINS = ['https://www.tokyotosho.info', 'https://tokyotosho.info'];

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36 Master-Addon/1.3',
      Accept: 'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function firstWorking(
  domains: string[],
  builder: (base: string) => string
): Promise<{ base: string; text: string }> {
  let lastError: unknown;
  for (const base of domains) {
    try {
      return { base, text: await fetchText(builder(base)) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('all provider domains failed');
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
  return decode(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function hashFrom(value: string): string | undefined {
  return decode(value).match(/(?:xt=urn:btih:|\/)([a-fA-F0-9]{40})(?:\b|[/?&#])/i)?.[1]?.toLowerCase();
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
  return Number.isFinite(value) ? Math.round(value * (units[match[2].toLowerCase()] ?? 1)) : 0;
}

function dedupe(items: TorrentioTorrentCandidate[]): TorrentioTorrentCandidate[] {
  const byHash = new Map<string, TorrentioTorrentCandidate>();
  for (const item of items) {
    if (!item.hash || !item.title) continue;
    const current = byHash.get(item.hash);
    if (!current || (item.seeders ?? 0) > (current.seeders ?? 0)) byHash.set(item.hash, item);
  }
  return [...byHash.values()];
}

function parseHtmlRows(html: string, indexer: string): TorrentioTorrentCandidate[] {
  const results: TorrentioTorrentCandidate[] = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const block = row[1];
    const magnet = block.match(/href=["'](magnet:\?[^"']+)["']/i)?.[1];
    const hash = magnet ? hashFrom(magnet) : undefined;
    if (!hash) continue;

    const titleMatches = [
      ...block.matchAll(/<a[^>]+class=["'][^"']*(?:cellMainLink|detLink|torrentname)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi),
    ];
    const fallbackLinks = [...block.matchAll(/<a[^>]+href=["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/gi)];
    const title = strip(titleMatches.at(-1)?.[1] ?? fallbackLinks.at(-1)?.[1] ?? '');
    if (!title || /^magnet$/i.test(title)) continue;

    const text = strip(block);
    const numbers = [...text.matchAll(/\b(\d{1,7})\b/g)].map((m) => Number(m[1]));
    results.push({
      hash,
      title,
      seeders: numbers.length >= 2 ? numbers.at(-2) ?? 0 : 0,
      size: parseSize(text),
      indexer,
    });
    if (results.length >= 30) break;
  }
  return dedupe(results);
}

export async function searchKickass(query: string): Promise<TorrentioTorrentCandidate[]> {
  if (!query) return [];
  const { text } = await firstWorking(
    KAT_DOMAINS,
    (base) => `${base}/usearch/${encodeURIComponent(query)}/`
  );
  return parseHtmlRows(text, 'KickassTorrents');
}

export async function searchMagnetDL(query: string, mediaType: string): Promise<TorrentioTorrentCandidate[]> {
  if (!query) return [];
  const category = mediaType === 'movie' ? 'movies' : 'tv';
  const { base, text } = await firstWorking(MAGNETDL_DOMAINS, (domain) => {
    const url = new URL(`${domain}/${category}/`);
    url.searchParams.set('q', query);
    return url.toString();
  });

  const results: TorrentioTorrentCandidate[] = [];
  for (const match of text.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decode(match[1]);
    if (!/\/file\//i.test(href) && !/\/download\//i.test(href)) continue;
    const title = strip(match[2]);
    if (!title) continue;
    try {
      const detailUrl = href.startsWith('http') ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`;
      const detail = await fetchText(detailUrl);
      const magnet = detail.match(/href=["'](magnet:\?[^"']+)["']/i)?.[1] ?? '';
      const hash = hashFrom(magnet);
      if (!hash) continue;
      const pageTitle = strip(detail.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? title);
      const pageText = strip(detail);
      const seedMatch = pageText.match(/seed(?:er)?s?\D{0,20}([\d,]+)/i);
      results.push({
        hash,
        title: pageTitle,
        seeders: seedMatch ? Number(seedMatch[1].replace(/,/g, '')) : 0,
        size: parseSize(pageText),
        indexer: 'MagnetDL',
      });
      if (results.length >= 10) break;
    } catch {
      // One detail page must not sink the provider.
    }
  }
  return dedupe(results);
}

export async function searchNyaa(query: string): Promise<TorrentioTorrentCandidate[]> {
  if (!query) return [];
  const url = new URL('https://nyaa.si/');
  url.searchParams.set('page', 'rss');
  url.searchParams.set('q', query);
  url.searchParams.set('c', '1_2');
  url.searchParams.set('f', '0');
  url.searchParams.set('s', 'seeders');
  url.searchParams.set('o', 'desc');
  const xml = await fetchText(url.toString());

  const results: TorrentioTorrentCandidate[] = [];
  for (const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = item[1];
    const title = strip(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    const hash = strip(block.match(/<(?:nyaa:)?infoHash>([\s\S]*?)<\/(?:nyaa:)?infoHash>/i)?.[1] ?? '').toLowerCase();
    if (!/^[a-f0-9]{40}$/i.test(hash) || !title) continue;
    const seeders = Number(strip(block.match(/<(?:nyaa:)?seeders>([\s\S]*?)<\/(?:nyaa:)?seeders>/i)?.[1] ?? '0')) || 0;
    const sizeText = strip(block.match(/<(?:nyaa:)?size>([\s\S]*?)<\/(?:nyaa:)?size>/i)?.[1] ?? '');
    results.push({ hash, title, seeders, size: parseSize(sizeText), indexer: 'Nyaa' });
  }
  return dedupe(results).slice(0, 30);
}

export async function searchTokyoTosho(query: string): Promise<TorrentioTorrentCandidate[]> {
  if (!query) return [];
  const { text: xml } = await firstWorking(TOKYO_TOSHO_DOMAINS, (base) => {
    const url = new URL(`${base}/rss.php`);
    url.searchParams.set('terms', query);
    return url.toString();
  });

  const results: TorrentioTorrentCandidate[] = [];
  for (const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = item[1];
    const title = strip(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    const candidates = [
      block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? '',
      block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1] ?? '',
      block,
    ];
    const hash = candidates.map(hashFrom).find(Boolean);
    if (!hash || !title) continue;
    results.push({ hash, title, seeders: 0, size: 0, indexer: 'TokyoTosho' });
  }
  return dedupe(results).slice(0, 30);
}

export async function searchRutor(query: string): Promise<TorrentioTorrentCandidate[]> {
  if (!query) return [];
  const html = await fetchText(`http://rutor.info/search/0/0/0/${encodeURIComponent(query)}`);
  return parseHtmlRows(html, 'Rutor');
}
