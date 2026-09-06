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
  const exact = html.match(
    new RegExp(`EP\\.video\\.player\\.${key}\\s*=\\s*['\"]([^'\"]+)['\"]\\s*;`, 'i')
  )?.[1];
  if (exact) return exact;

  return (
    html.match(new RegExp(`${key}\\s*[:=]\\s*['\"]([^'\"]+)['\"]`, 'i'))?.[1] ?? ''
  );
}

function responseCookieHeader(response: Response): string | undefined {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const values = headers.getSetCookie?.() ?? [];
  const raw = values.length > 0 ? values : [response.headers.get('set-cookie') ?? ''];
  const cookies = raw
    .flatMap((value) => value.split(/,(?=[^;,]+=)/g))
    .map((value) => value.split(';', 1)[0]?.trim())
    .filter((value): value is string => Boolean(value));
  return cookies.length > 0 ? cookies.join('; ') : undefined;
}

async function fetchVideoPayload(
  videoId: string,
  hash: string,
  referer: string,
  cookie: string | undefined,
  embed: boolean
) {
  const xhr = new URL(
    `https://www.eporner.com/xhr/video/${encodeURIComponent(videoId)}`
  );
  xhr.searchParams.set('hash', hash);
  xhr.searchParams.set('domain', 'www.eporner.com');
  xhr.searchParams.set('pixelRatio', '2');
  xhr.searchParams.set('playerWidth', '0');
  xhr.searchParams.set('playerHeight', '0');
  xhr.searchParams.set('fallback', 'false');
  xhr.searchParams.set('embed', embed ? 'true' : 'false');
  xhr.searchParams.set('supportedFormats', 'hls,dash,h265,vp9,av1,mp4');
  xhr.searchParams.set('_', String(Date.now()));

  const response = await fetch(xhr.toString(), {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json,text/plain,*/*',
      Referer: referer,
      Origin: 'https://www.eporner.com',
      'X-Requested-With': 'XMLHttpRequest',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return null;
  try {
    return (await response.json()) as {
      available?: boolean;
      sources?: Record<string, Record<string, { src?: string; labelShort?: string }>>;
    };
  } catch {
    return null;
  }
}

function streamsFromPayload(
  payload: {
    available?: boolean;
    sources?: Record<string, Record<string, { src?: string; labelShort?: string }>>;
  } | null,
  referer: string
): DirectStream[] {
  if (!payload || payload.available === false || !payload.sources) return [];

  const streams: DirectStream[] = [];
  const hls = payload.sources.hls;
  const autoHls = hls?.auto?.src;
  if (autoHls && /^https?:\/\//i.test(autoHls)) {
    streams.push({ url: autoHls, name: 'EPorner HLS Auto', referer });
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

async function fetchXvideosHtml(
  url: string,
  cookie?: string,
  referer = 'https://www.xvideos.com/'
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: referer,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return '';
  return response.text();
}

async function resolveXvideosFallback(title: string): Promise<DirectStream[]> {
  try {
    const query = normaliseWords(title).slice(0, 5).join(' ');
    if (!query) return [];

    const root = await fetch('https://www.xvideos.com/', {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    const cookie = root.ok ? responseCookieHeader(root) : undefined;

    const searchUrl = `https://www.xvideos.com/?k=${encodeURIComponent(query)}`;
    const searchHtml = await fetchXvideosHtml(searchUrl, cookie);
    if (!searchHtml) return [];

    const links = [
      ...new Set(
        [...searchHtml.matchAll(/href=["'](\/video(?:\.|\/)[^"'#?\s]+)["']/gi)].map(
          (match) => match[1]
        )
      ),
    ].slice(0, 10);

    for (const path of links) {
      const detailUrl = new URL(path, 'https://www.xvideos.com').toString();
      const html = await fetchXvideosHtml(detailUrl, cookie, searchUrl);
      if (!html) continue;

      const pageTitle =
        html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
        html.match(/<title>([^<]+)<\/title>/i)?.[1] ??
        '';
      if (pageTitle && !likelySameTitle(title, pageTitle)) continue;

      const urls = [
        html.match(/html5player\.setVideoHLS\(['"]([^'"]+)['"]\)/i)?.[1],
        html.match(/html5player\.setVideoUrlHigh\(['"]([^'"]+)['"]\)/i)?.[1],
        html.match(/html5player\.setVideoUrlLow\(['"]([^'"]+)['"]\)/i)?.[1],
        html.match(/["']contentUrl["']\s*:\s*["']([^"']+)["']/i)?.[1],
      ].filter((value): value is string => Boolean(value && /^https?:\/\//i.test(value)));

      const unique = [...new Set(urls)];
      if (unique.length > 0) {
        return unique.map((url, index) => ({
          url,
          name: index === 0 ? 'XVideos HLS' : `XVideos ${index + 1}`,
          referer: detailUrl,
        }));
      }
    }
  } catch {
    // EPorner remains primary; this is a resilience fallback only.
  }
  return [];
}

export async function resolveEpornerCurrent(
  item: AdultTorrentItem
): Promise<DirectStream[]> {
  if (!item.detailUrl) return [];

  try {
    const page = await fetch(item.detailUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        Referer: 'https://www.eporner.com/',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    if (page.ok) {
      const html = await page.text();
      const rawHash = parsePlayerValue(html, 'hash');
      const videoId = parsePlayerValue(html, 'vid') || item.sourceId || '';

      if (/^[a-f0-9]{32}$/i.test(rawHash) && videoId) {
        const referer = page.url || item.detailUrl;
        const cookie = responseCookieHeader(page);
        const hash = calcHash(rawHash);

        const normal = await fetchVideoPayload(videoId, hash, referer, cookie, false);
        let streams = streamsFromPayload(normal, referer);
        if (streams.length > 0) return streams;

        const embedded = await fetchVideoPayload(videoId, hash, referer, cookie, true);
        streams = streamsFromPayload(embedded, referer);
        if (streams.length > 0) return streams;
      }
    }
  } catch {
    // Continue to the independent direct-provider fallback below.
  }

  return resolveXvideosFallback(item.title);
}
