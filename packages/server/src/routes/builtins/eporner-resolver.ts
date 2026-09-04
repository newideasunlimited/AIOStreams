import type { AdultTorrentItem } from '@aiostreams/core';

type DirectStream = {
  url: string;
  name: string;
  referer?: string;
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function calcHash(hex: string): string {
  let out = '';
  for (let i = 0; i < 32; i += 8) {
    out += Number.parseInt(hex.slice(i, i + 8), 16).toString(36);
  }
  return out;
}

function qualityRank(label: string): number {
  const m = label.match(/(2160|1440|1080|720|480|360|240)p?/i);
  return Number(m?.[1] ?? 0);
}

export async function resolveEpornerCurrent(
  item: AdultTorrentItem
): Promise<DirectStream[]> {
  if (!item.detailUrl || !item.sourceId) return [];

  const page = await fetch(item.detailUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      Referer: 'https://www.eporner.com/',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!page.ok) return [];

  const html = await page.text();
  const rawHash = html.match(/hash\s*[:=]\s*["']([\da-f]{32})["']/i)?.[1];
  if (!rawHash) return [];

  const xhr = new URL(`https://www.eporner.com/xhr/video/${encodeURIComponent(item.sourceId)}`);
  xhr.searchParams.set('hash', calcHash(rawHash));
  xhr.searchParams.set('device', 'generic');
  xhr.searchParams.set('domain', 'www.eporner.com');
  xhr.searchParams.set('fallback', 'false');

  const response = await fetch(xhr.toString(), {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json,text/plain,*/*',
      Referer: item.detailUrl,
      'X-Requested-With': 'XMLHttpRequest',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return [];

  const payload = (await response.json()) as {
    available?: boolean;
    sources?: Record<string, Record<string, { src?: string }>>;
  };
  if (payload.available === false || !payload.sources) return [];

  const streams: DirectStream[] = [];
  for (const [kind, group] of Object.entries(payload.sources)) {
    if (!group || typeof group !== 'object') continue;
    for (const [formatId, format] of Object.entries(group)) {
      const url = format?.src;
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const label = kind.toLowerCase() === 'hls' ? `${formatId} HLS` : formatId;
      streams.push({
        url,
        name: `EPorner ${label}`,
        referer: item.detailUrl,
      });
    }
  }

  const seen = new Set<string>();
  return streams
    .filter((stream) => {
      if (seen.has(stream.url)) return false;
      seen.add(stream.url);
      return true;
    })
    .sort((a, b) => qualityRank(b.name) - qualityRank(a.name));
}
