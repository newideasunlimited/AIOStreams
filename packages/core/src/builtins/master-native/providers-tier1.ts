/*
 * Tier-one Master Native providers.
 *
 * Provider strategies are adapted from the Apache-2.0 Magnetio project
 * (peterdsp/Magnetio). Implementations stay dependency-free and bounded so
 * individual provider failures cannot stall the full Master response.
 */

export type Tier1TorrentCandidate = {
  hash?: string;
  title?: string;
  seeders?: number;
  size?: number;
  indexer: string;
};

const TIMEOUT_MS = 4500;

const DOMAINS = {
  leetx: ['https://1337x.to', 'https://1337x.st', 'https://1337x.gd'],
  glotorrents: ['https://glodls.to', 'https://gtso.cc'],
  torrentgalaxy: ['https://torrentgalaxy.one', 'https://torrentgalaxy.to'],
  torrentdownloads: ['https://torrentdownload.info', 'https://torrentdownloads.pro'],
};

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36 Master-Addon/1.1',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Master-Addon/1.1', Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

async function firstWorking(domains: string[], builder: (base: string) => string): Promise<{ base: string; html: string }> {
  let lastError: unknown;
  for (const base of domains) {
    try {
      return { base, html: await fetchText(builder(base)) };
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
    .replace(/&gt;/g, '>');
}

function strip(value: string): string {
  return decode(value.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function hashFrom(value: string): string | undefined {
  return decode(value).match(/(?:xt=urn:btih:|\/)([a-fA-F0-9]{40})(?:\b|[/?&#])/i)?.[1]?.toLowerCase();
}

function parseSize(text: string): number {
  const match = [...text.matchAll(/([\d.]+)\s*(B|KB|MB|GB|TB)\b/gi)].at(-1);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]);
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
  };
  return Number.isFinite(value) ? Math.round(value * (multipliers[match[2].toLowerCase()] ?? 1)) : 0;
}

function numberNear(text: string, label: string): number {
  const a = text.match(new RegExp(`${label}[^0-9]{0,20}([\\d,]+)`, 'i'));
  const b = text.match(new RegExp(`([\\d,]+)[^A-Za-z]{0,10}${label}`, 'i'));
  const raw = a?.[1] ?? b?.[1];
  return raw ? Number.parseInt(raw.replace(/,/g, ''), 10) || 0 : 0;
}

function dedupe(items: Tier1TorrentCandidate[]): Tier1TorrentCandidate[] {
  const map = new Map<string, Tier1TorrentCandidate>();
  for (const item of items) {
    if (!item.hash || !item.title) continue;
    const current = map.get(item.hash);
    if (!current || (item.seeders ?? 0) > (current.seeders ?? 0)) map.set(item.hash, item);
  }
  return [...map.values()];
}

function links(html: string, pattern: RegExp, limit = 12): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(pattern)) {
    const href = decode(match[1]);
    if (!found.includes(href)) found.push(href);
    if (found.length >= limit) break;
  }
  return found;
}

async function detailsToCandidates(
  urls: string[],
  indexer: string,
  titlePattern: RegExp
): Promise<Tier1TorrentCandidate[]> {
  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      const html = await fetchText(url);
      const magnet = html.match(/href=["'](magnet:\?[^"']+)["']/i)?.[1] ?? '';
      const hash = hashFrom(magnet);
      if (!hash) return null;
      const titleMatch = html.match(titlePattern);
      const title = titleMatch ? strip(titleMatch[1]) : decode(url.split('/').filter(Boolean).at(-1) ?? '');
      if (!title) return null;
      const text = strip(html);
      return {
        hash,
        title,
        seeders: numberNear(text, 'seed(?:er)?s?'),
        size: parseSize(text),
        indexer,
      } satisfies Tier1TorrentCandidate;
    })
  );
  return settled.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
}

export async function search1337x(query: string, mediaType: string): Promise<Tier1TorrentCandidate[]> {
  if (!query) return [];
  const category = mediaType === 'movie' ? 'Movies' : 'TV';
  const { base, html } = await firstWorking(
    DOMAINS.leetx,
    (domain) => `${domain}/category-search/${encodeURIComponent(query)}/${category}/1/`
  );
  const detailPaths = links(html, /<a[^>]+href=["']([^"']*\/torrent\/[^"']+)["'][^>]*>/gi, 10);
  const urls = detailPaths.map((href) => (href.startsWith('http') ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`));
  return dedupe(await detailsToCandidates(urls, '1337x', /<h1[^>]*>([\s\S]*?)<\/h1>/i));
}

export async function searchGloTorrents(query: string, mediaType: string): Promise<Tier1TorrentCandidate[]> {
  if (!query) return [];
  const cat = mediaType === 'movie' ? '1' : '41';
  const { html } = await firstWorking(DOMAINS.glotorrents, (base) => {
    const url = new URL(`${base}/search_results.php`);
    url.searchParams.set('search', query);
    url.searchParams.set('cat', cat);
    url.searchParams.set('incldead', '0');
    url.searchParams.set('sort', 'seeders');
    url.searchParams.set('order', 'desc');
    return url.toString();
  });
  const results: Tier1TorrentCandidate[] = [];
  for (const match of html.matchAll(/href=["'](magnet:\?[^"']+)["']/gi)) {
    const hash = hashFrom(match[1]);
    if (!hash) continue;
    const block = html.slice(Math.max(0, match.index! - 2200), Math.min(html.length, match.index! + 900));
    const titleMatches = [...block.matchAll(/<a[^>]+href=["'][^"']+(?:details|torrent)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)];
    const title = titleMatches.length ? strip(titleMatches.at(-1)![1]) : undefined;
    if (!title) continue;
    const text = strip(block);
    results.push({ hash, title, seeders: numberNear(text, 'seed(?:er)?s?'), size: parseSize(text), indexer: 'GloTorrents' });
    if (results.length >= 25) break;
  }
  return dedupe(results);
}

export async function searchTorrentGalaxy(query: string, mediaType: string): Promise<Tier1TorrentCandidate[]> {
  if (!query) return [];
  const cat = mediaType === 'movie' ? '3' : '41';
  const { html } = await firstWorking(DOMAINS.torrentgalaxy, (base) => {
    const url = new URL(`${base}/torrents.php`);
    url.searchParams.set('search', query);
    url.searchParams.set('cat', cat);
    url.searchParams.set('sort', 'seeders');
    url.searchParams.set('order', 'desc');
    return url.toString();
  });
  const results: Tier1TorrentCandidate[] = [];
  for (const match of html.matchAll(/href=["'](magnet:\?[^"']+)["']/gi)) {
    const hash = hashFrom(match[1]);
    if (!hash) continue;
    const block = html.slice(Math.max(0, match.index! - 2200), Math.min(html.length, match.index! + 900));
    const titleMatch = [...block.matchAll(/<a[^>]+class=["'][^"']*txlight[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)].at(-1);
    const title = titleMatch ? strip(titleMatch[1]) : undefined;
    if (!title) continue;
    const text = strip(block);
    results.push({ hash, title, seeders: numberNear(text, 'seed(?:er)?s?'), size: parseSize(text), indexer: 'TorrentGalaxy' });
    if (results.length >= 25) break;
  }
  return dedupe(results);
}

export async function searchTorrentDownloads(query: string, mediaType: string): Promise<Tier1TorrentCandidate[]> {
  if (!query) return [];
  const cat = mediaType === 'movie' ? '4' : '8';
  const { base, html } = await firstWorking(DOMAINS.torrentdownloads, (domain) => {
    const url = new URL(`${domain}/search/`);
    url.searchParams.set('search', query);
    url.searchParams.set('cat', cat);
    return url.toString();
  });
  const direct: Tier1TorrentCandidate[] = [];
  for (const match of html.matchAll(/href=["'](magnet:\?[^"']+)["']/gi)) {
    const hash = hashFrom(match[1]);
    if (!hash) continue;
    const block = html.slice(Math.max(0, match.index! - 1800), Math.min(html.length, match.index! + 800));
    const titleMatch = [...block.matchAll(/<a[^>]+href=["'][^"']+torrent[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)].at(-1);
    const title = titleMatch ? strip(titleMatch[1]) : undefined;
    if (title) direct.push({ hash, title, seeders: numberNear(strip(block), 'seed(?:er)?s?'), size: parseSize(strip(block)), indexer: 'TorrentDownloads' });
  }
  if (direct.length) return dedupe(direct).slice(0, 25);

  const detailPaths = links(html, /<a[^>]+href=["']([^"']*(?:torrent|download)[^"']+)["'][^>]*>/gi, 10);
  const urls = detailPaths.map((href) => (href.startsWith('http') ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`));
  return dedupe(await detailsToCandidates(urls, 'TorrentDownloads', /<h1[^>]*>([\s\S]*?)<\/h1>/i));
}

export async function searchTheRarBG(query: string, mediaType: string): Promise<Tier1TorrentCandidate[]> {
  if (!query) return [];
  const cat = mediaType === 'movie' ? 'Movies' : 'TV';
  const base = 'https://therarbg.com';
  const html = await fetchText(`${base}/get-posts/order:-se:category:${cat}:keywords:${encodeURIComponent(query)}/`);
  const paths = links(html, /<a[^>]+href=["']([^"']+)["'][^>]*>/gi, 40)
    .filter((href) => /torrent|post|detail/i.test(href))
    .slice(0, 10);
  const urls = paths.map((href) => (href.startsWith('http') ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`));
  return dedupe(await detailsToCandidates(urls, 'TheRarBG', /<h1[^>]*>([\s\S]*?)<\/h1>/i));
}

export async function searchSubsPlease(title: string, episode?: number): Promise<Tier1TorrentCandidate[]> {
  if (!title) return [];
  const url = new URL('https://subsplease.org/api/');
  url.searchParams.set('f', 'search');
  url.searchParams.set('tz', 'UTC');
  url.searchParams.set('s', title);
  const data = await fetchJson<Record<string, any>>(url.toString());
  const results: Tier1TorrentCandidate[] = [];
  for (const entry of Object.values(data ?? {})) {
    if (!entry || !Array.isArray(entry.downloads)) continue;
    const ep = Number.parseInt(String(entry.episode ?? '').replace(/v\d+$/i, ''), 10);
    if (episode !== undefined && Number.isFinite(ep) && ep !== episode) continue;
    for (const download of entry.downloads) {
      const magnet = String(download?.magnet ?? '');
      const hash = hashFrom(magnet);
      if (!hash) continue;
      const dn = magnet.match(/[?&]dn=([^&]+)/i)?.[1];
      const releaseTitle = dn ? decodeURIComponent(dn.replace(/\+/g, ' ')) : `${entry.show ?? title} - ${entry.episode ?? ''} ${download?.res ?? ''}p`;
      const xl = magnet.match(/[?&]xl=(\d+)/i)?.[1];
      results.push({ hash, title: releaseTitle.trim(), seeders: 0, size: xl ? Number(xl) : 0, indexer: 'SubsPlease' });
    }
  }
  return dedupe(results);
}
