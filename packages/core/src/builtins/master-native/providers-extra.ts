/*
 * Additional Master Native providers.
 *
 * Provider strategies are adapted from the Apache-2.0 Magnetio project
 * (peterdsp/Magnetio). These implementations intentionally avoid adding
 * new runtime dependencies and use bounded fetch timeouts so a dead index
 * cannot hold the Master stream response hostage.
 */

export type ExtraTorrentCandidate = {
  hash?: string;
  title?: string;
  seeders?: number;
  size?: number;
  indexer: string;
};

const PROVIDER_TIMEOUT_MS = 4500;

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36 Master-Addon/1.0',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(value: string): string {
  return htmlDecode(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function extractInfoHash(value: string): string | undefined {
  return value.match(/(?:xt=urn:btih:|\/)([a-fA-F0-9]{40})(?:\b|[/?&#])/i)?.[1]?.toLowerCase();
}

function parseSize(text: string): number {
  const matches = [...text.matchAll(/([\d.]+)\s*(B|KB|MB|GB|TB)\b/gi)];
  const match = matches.at(-1);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
  };
  return Number.isFinite(value) ? Math.round(value * (multiplier[unit] ?? 1)) : 0;
}

function parseLabeledNumber(text: string, label: string): number {
  const match = text.match(new RegExp(`([\\d,]+)\\s*${label}`, 'i'));
  return match ? Number.parseInt(match[1].replace(/,/g, ''), 10) || 0 : 0;
}

function dedupe(results: ExtraTorrentCandidate[]): ExtraTorrentCandidate[] {
  const byHash = new Map<string, ExtraTorrentCandidate>();
  for (const item of results) {
    if (!item.hash) continue;
    const current = byHash.get(item.hash);
    if (!current || (item.seeders ?? 0) > (current.seeders ?? 0)) {
      byHash.set(item.hash, item);
    }
  }
  return [...byHash.values()];
}

export async function searchBitsearch(query: string): Promise<ExtraTorrentCandidate[]> {
  if (!query) return [];
  const url = new URL('https://bitsearch.eu/search');
  url.searchParams.set('q', query);
  url.searchParams.set('sort', 'seeders');

  const html = await fetchText(url.toString());
  const results: ExtraTorrentCandidate[] = [];

  const magnetRegex = /<a[^>]+href=["'](magnet:\?[^"']+)["'][^>]*>/gi;
  for (const magnetMatch of html.matchAll(magnetRegex)) {
    const magnet = htmlDecode(magnetMatch[1]);
    const hash = extractInfoHash(magnet);
    if (!hash) continue;

    const start = Math.max(0, magnetMatch.index! - 2500);
    const end = Math.min(html.length, magnetMatch.index! + 1200);
    const card = html.slice(start, end);
    const titleMatch = [...card.matchAll(/<a[^>]+href=["']\/torrent\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi)].at(-1);
    const title = titleMatch ? stripTags(titleMatch[1]) : undefined;
    if (!title) continue;
    const text = stripTags(card);

    results.push({
      hash,
      title,
      seeders: parseLabeledNumber(text, 'seeders?'),
      size: parseSize(text),
      indexer: 'Bitsearch',
    });
    if (results.length >= 30) break;
  }

  return dedupe(results);
}

export async function searchBTDig(query: string): Promise<ExtraTorrentCandidate[]> {
  if (!query) return [];
  const url = new URL('https://btdig.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('order', '0');

  const html = await fetchText(url.toString());
  const results: ExtraTorrentCandidate[] = [];
  const blocks = html.split(/<div[^>]+class=["'][^"']*one_result[^"']*["'][^>]*>/i).slice(1);

  for (const block of blocks.slice(0, 40)) {
    const segment = block.slice(0, block.search(/<div[^>]+class=["'][^"']*one_result/i) > 0
      ? block.search(/<div[^>]+class=["'][^"']*one_result/i)
      : Math.min(block.length, 7000));
    const titleMatch = segment.match(/<div[^>]+class=["'][^"']*torrent_name[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const magnetMatch = segment.match(/href=["'](magnet:\?[^"']+)["']/i);
    const hash = extractInfoHash(magnetMatch?.[1] ?? titleMatch?.[1] ?? '');
    const title = titleMatch ? stripTags(titleMatch[2]) : undefined;
    if (!hash || !title) continue;

    results.push({
      hash,
      title,
      seeders: 0,
      size: parseSize(stripTags(segment)),
      indexer: 'BTDig',
    });
  }

  return dedupe(results);
}

export async function searchBT4G(query: string): Promise<ExtraTorrentCandidate[]> {
  if (!query) return [];
  const url = `https://bt4gprx.com/search/${encodeURIComponent(query)}/byseeders/1`;
  const html = await fetchText(url);
  const results: ExtraTorrentCandidate[] = [];

  const magnetRegex = /href=["'](magnet:\?[^"']+)["']/gi;
  for (const magnetMatch of html.matchAll(magnetRegex)) {
    const hash = extractInfoHash(htmlDecode(magnetMatch[1]));
    if (!hash) continue;
    const start = Math.max(0, magnetMatch.index! - 2600);
    const end = Math.min(html.length, magnetMatch.index! + 1200);
    const block = html.slice(start, end);
    const titleMatches = [...block.matchAll(/<(?:h5|a)[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>|<a[^>]+class=["'][^"']*item-title[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)];
    const lastTitle = titleMatches.at(-1);
    const title = lastTitle ? stripTags(lastTitle[1] ?? lastTitle[2] ?? '') : undefined;
    if (!title) continue;
    const text = stripTags(block);

    results.push({
      hash,
      title,
      seeders: parseLabeledNumber(text, 'seeders?'),
      size: parseSize(text),
      indexer: 'BT4G',
    });
    if (results.length >= 30) break;
  }

  return dedupe(results);
}
