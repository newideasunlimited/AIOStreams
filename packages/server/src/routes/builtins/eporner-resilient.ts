import type { AdultTorrentItem } from '@aiostreams/core';
import { resolveEpornerCurrent } from './eporner-resolver.js';

type DirectStream = {
  url: string;
  name: string;
  referer?: string;
};

type EpornerVideo = {
  id?: string;
  title?: string;
  url?: string;
};

type EpornerSearchResponse = {
  videos?: EpornerVideo[];
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 Master-Addon/2.0';

function normaliseWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function likelySameTitle(wantedTitle: string, candidateTitle: string): boolean {
  const wanted = normaliseWords(wantedTitle);
  if (wanted.length === 0) return true;
  const candidate = new Set(normaliseWords(candidateTitle));
  const matches = wanted.filter((word) => candidate.has(word)).length;
  return matches >= Math.min(2, Math.max(1, Math.ceil(wanted.length * 0.3)));
}

async function fetchJson<T>(url: URL): Promise<T | undefined> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

async function refreshById(item: AdultTorrentItem): Promise<AdultTorrentItem | undefined> {
  if (!item.sourceId) return undefined;
  const url = new URL('https://www.eporner.com/api/v2/video/id/');
  url.searchParams.set('id', item.sourceId);
  url.searchParams.set('thumbsize', 'big');
  url.searchParams.set('format', 'json');
  const video = await fetchJson<EpornerVideo>(url);
  if (!video?.id || !video.url) return undefined;
  return {
    ...item,
    sourceId: video.id,
    title: video.title || item.title,
    detailUrl: video.url,
  };
}

async function searchReplacement(item: AdultTorrentItem): Promise<AdultTorrentItem[]> {
  const query = normaliseWords(item.title).slice(0, 7).join(' ');
  if (!query) return [];
  const url = new URL('https://www.eporner.com/api/v2/video/search/');
  url.searchParams.set('query', query);
  url.searchParams.set('per_page', '12');
  url.searchParams.set('page', '1');
  url.searchParams.set('thumbsize', 'big');
  url.searchParams.set('order', 'most-popular');
  url.searchParams.set('gay', '0');
  url.searchParams.set('lq', '1');
  url.searchParams.set('format', 'json');
  const response = await fetchJson<EpornerSearchResponse>(url);
  return (response?.videos ?? [])
    .filter(
      (video): video is Required<Pick<EpornerVideo, 'id' | 'title' | 'url'>> =>
        Boolean(video.id && video.title && video.url) && likelySameTitle(item.title, video.title!)
    )
    .slice(0, 5)
    .map((video) => ({
      ...item,
      sourceId: video.id,
      title: video.title,
      detailUrl: video.url,
    }));
}

export async function resolveEpornerResilient(
  item: AdultTorrentItem
): Promise<DirectStream[]> {
  const refreshed = await refreshById(item);
  const candidates: AdultTorrentItem[] = [];
  if (refreshed) candidates.push(refreshed);
  if (
    item.detailUrl &&
    !candidates.some((candidate) => candidate.detailUrl === item.detailUrl)
  ) {
    candidates.push(item);
  }

  for (const candidate of candidates) {
    const streams = await resolveEpornerCurrent(candidate);
    if (streams.length > 0) return streams;
  }

  // If the original video has been removed or its canonical page no longer
  // resolves, recover an equivalent current listing by title. This keeps old
  // Stremio history/library items useful instead of turning them into dead IDs.
  const replacements = await searchReplacement(item);
  for (const candidate of replacements) {
    const streams = await resolveEpornerCurrent(candidate);
    if (streams.length > 0) return streams;
  }

  // resolveEpornerCurrent already includes the independent XVideos fallback.
  // Calling it last on the original item preserves that final safety net even
  // when both EPorner metadata recovery paths fail.
  return resolveEpornerCurrent(item);
}
