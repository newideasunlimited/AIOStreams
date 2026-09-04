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

function parsePlayerValue(html: string, key: 'hash' | 'vid'): string {
  // EPorner's player page exposes these exact assignments. This matches the
  // working MIT OnlyPorn provider rather than guessing from the public API id.
  const exact = html.match(
    new RegExp(`EP\\.video\\.player\\.${key}\\s*=\\s*['\"]([^'\"]+)['\"]\\s*;`, 'i')
  )?.[1];
  if (exact) return exact;

  // Keep a tolerant fallback for minor page-script formatting changes.
  return (
    html.match(new RegExp(`${key}\\s*[:=]\\s*['\"]([^'\"]+)['\"]`, 'i'))?.[1] ?? ''
  );
}

export async function resolveEpornerCurrent(
  item: AdultTorrentItem
): Promise<DirectStream[]> {
  if (!item.detailUrl) return [];

  const page = await fetch(item.detailUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      Referer: 'https://www.eporner.com/',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  });
  if (!page.ok) return [];

  const html = await page.text();
  const rawHash = parsePlayerValue(html, 'hash');
  const videoId = parsePlayerValue(html, 'vid') || item.sourceId || '';
  if (!/^[a-f0-9]{32}$/i.test(rawHash) || !videoId) return [];

  const referer = page.url || item.detailUrl;
  const xhr = new URL(
    `https://www.eporner.com/xhr/video/${encodeURIComponent(videoId)}`
  );
  xhr.searchParams.set('hash', calcHash(rawHash));
  xhr.searchParams.set('domain', 'www.eporner.com');
  xhr.searchParams.set('pixelRatio', '2');
  xhr.searchParams.set('playerWidth', '0');
  xhr.searchParams.set('playerHeight', '0');
  xhr.searchParams.set('fallback', 'false');
  xhr.searchParams.set('embed', 'false');
  xhr.searchParams.set('supportedFormats', 'hls,dash,h265,vp9,av1,mp4');
  xhr.searchParams.set('_', String(Date.now()));

  const response = await fetch(xhr.toString(), {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json,text/plain,*/*',
      Referer: referer,
      'X-Requested-With': 'XMLHttpRequest',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return [];

  const payload = (await response.json()) as {
    available?: boolean;
    sources?: Record<string, Record<string, { src?: string; labelShort?: string }>>;
  };
  if (payload.available === false || !payload.sources) return [];

  const streams: DirectStream[] = [];
  const hls = payload.sources.hls;
  const autoHls = hls?.auto?.src;
  if (autoHls && /^https?:\/\//i.test(autoHls)) {
    streams.push({
      url: autoHls,
      name: 'EPorner HLS Auto',
      referer,
    });
  }

  const mp4 = payload.sources.mp4;
  if (mp4) {
    for (const [formatId, format] of Object.entries(mp4)) {
      if (!format?.src || !/^https?:\/\//i.test(format.src)) continue;
      streams.push({
        url: format.src,
        name: `EPorner ${format.labelShort || formatId}`,
        referer,
      });
    }
  }

  // Some responses put usable sources under newer codec groups. Preserve them
  // as additional fallbacks after the canonical HLS/MP4 paths.
  for (const [kind, group] of Object.entries(payload.sources)) {
    if (kind === 'hls' || kind === 'mp4' || !group) continue;
    for (const [formatId, format] of Object.entries(group)) {
      if (!format?.src || !/^https?:\/\//i.test(format.src)) continue;
      streams.push({
        url: format.src,
        name: `EPorner ${format.labelShort || `${formatId} ${kind}`}`,
        referer,
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
