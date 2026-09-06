import { Router, Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  AIOStreams,
  AIOStreamResponse,
  config as appConfig,
  createLogger,
  StremioTransformer,
  decodeAdultId,
  resolveAdultDirectStreams,
  MASTER_ADULT_ID_PREFIX,
} from '@aiostreams/core';
import { resolveEpornerCurrent } from '../builtins/eporner-resolver.js';
import { trackResource } from '../../middlewares/analytics.js';

const router: Router = Router();
const logger = createLogger('server');
const DIRECT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const USA_TV_CATALOG_URL =
  'https://raw.githubusercontent.com/yowmamasita/usa-tv-next/main/catalog/tv/all.json';
const USA_TV_STREAM_BASE =
  'https://raw.githubusercontent.com/yowmamasita/usa-tv-next/main/stream/tv';
const RADIO_BROWSER_BASE = 'https://de1.api.radio-browser.info';
const MASTER_RADIO_ID_PREFIX = 'masterradio:';

router.use(trackResource('stream'));

interface StreamParams {
  [key: string]: string;
  type: string;
  id: string;
}

type MediaPayload = {
  u: string;
  r?: string;
};

type LiveTvStream = {
  url?: string;
  name?: string;
  description?: string;
};

type LiveTvMeta = {
  id?: string;
  name?: string;
  streams?: LiveTvStream[];
};

type RadioStation = {
  stationuuid?: string;
  name?: string;
  url?: string;
  url_resolved?: string;
};

let liveTvCache: { expires: number; metas: LiveTvMeta[] } | undefined;

function mediaSigningKey(): string {
  const key = process.env.SECRET_KEY;
  if (!key) throw new Error('SECRET_KEY is required for Master media relay');
  return key;
}

function encodeMediaPayload(payload: MediaPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', mediaSigningKey())
    .update(body)
    .digest('base64url');
  return `${body}.${signature}`;
}

function decodeMediaPayload(token: string): MediaPayload | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = createHmac('sha256', mediaSigningKey()).update(body).digest();
  const received = Buffer.from(signature, 'base64url');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as MediaPayload;
    const url = new URL(payload.u);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return payload;
  } catch {
    return null;
  }
}

function publicOrigin(req: Request): string {
  return (
    appConfig.bootstrap.baseUrl?.replace(/\/$/, '') ||
    `${req.protocol}://${req.get('host')}`
  );
}

function mediaRelayBase(req: Request): string {
  const stremioBase = req.baseUrl.replace(/\/stream\/?$/, '');
  return `${publicOrigin(req)}${stremioBase}/stream/master-media`;
}

function mediaRelayUrl(req: Request, url: string, referer?: string): string {
  return `${mediaRelayBase(req)}/${encodeMediaPayload({ u: url, ...(referer ? { r: referer } : {}) })}`;
}

function rewriteHlsPlaylist(req: Request, text: string, sourceUrl: string): string {
  const rewriteUrl = (value: string) => {
    try {
      return mediaRelayUrl(req, new URL(value, sourceUrl).toString(), sourceUrl);
    } catch {
      return value;
    }
  };

  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${rewriteUrl(uri)}"`);
      }
      return rewriteUrl(trimmed);
    })
    .join('\n');
}

async function getLiveTvItems(): Promise<LiveTvMeta[]> {
  if (liveTvCache && liveTvCache.expires > Date.now()) return liveTvCache.metas;
  const response = await fetch(USA_TV_CATALOG_URL, {
    headers: { 'User-Agent': 'Master-Addon/2.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`USA TV Next returned ${response.status}`);
  const payload = (await response.json()) as { metas?: LiveTvMeta[] };
  const metas = Array.isArray(payload.metas) ? payload.metas : [];
  liveTvCache = { expires: Date.now() + 15 * 60_000, metas };
  return metas;
}

function tvStreamScore(stream: LiveTvStream): number {
  const url = stream.url ?? '';
  const name = stream.name ?? '';
  let score = 0;
  if (/^https:\/\//i.test(url)) score += 5;
  if (/\.m3u8(?:\?|$)/i.test(url)) score += 5;
  if (/\bHD\b/i.test(name)) score += 3;
  if (/\bSD\b/i.test(name)) score += 2;
  if (/audio/i.test(name)) score -= 20;
  if (/%7B|%7D|\{|\}/i.test(url)) score -= 10;
  return score;
}

const LIVE_TV_MARKETS: Array<[RegExp, string]> = [
  [/\bWABC(?:DT)?\d?\b|k?abc[-_]?new[-_]?york|new[-_]?york|cbsn[-_]?ny\b|\bWCBS\b/i, 'New York'],
  [/\bKABC\b|abc[-_]?kabc[-_]?los[-_]?angeles|los[-_]?angeles|cbsn[-_]?la\b/i, 'Los Angeles'],
  [/\bWLS\b|chicago|cbsn[-_]?chi\b|\bWBBM\b/i, 'Chicago'],
  [/\bKMGH\b|\bKUSA\b|\bKCNC\b|denver/i, 'Denver'],
  [/\bKGO\b|san[-_]?francisco|cbsn[-_]?sf\b|bay[-_]?area/i, 'San Francisco'],
  [/\bWPVI\b|philadelphia|cbsn[-_]?phl\b/i, 'Philadelphia'],
  [/\bKTRK\b|houston/i, 'Houston'],
  [/\bWFAA\b|dallas|cbsn[-_]?dal\b/i, 'Dallas'],
  [/\bWSB\b|atlanta/i, 'Atlanta'],
  [/\bWCVB\b|boston|cbsn[-_]?bos\b/i, 'Boston'],
  [/\bWPLG\b|\bWFOR\b|miami|cbsn[-_]?mia\b/i, 'Miami'],
  [/\bKOMO\b|seattle/i, 'Seattle'],
  [/\bKATU\b|portland/i, 'Portland'],
  [/\bKNXV\b|\bKPHO\b|phoenix/i, 'Phoenix'],
  [/\bKVUE\b|austin/i, 'Austin'],
  [/\bKSAT\b|san[-_]?antonio/i, 'San Antonio'],
  [/\bKGT V\b|\bKGTV\b|san[-_]?diego/i, 'San Diego'],
  [/\bWXYZ\b|detroit|cbsn[-_]?det\b/i, 'Detroit'],
  [/\bKSTP\b|minneapolis|cbsn[-_]?min\b/i, 'Minneapolis'],
  [/\bKXTV\b|sacramento|cbsn[-_]?sac\b/i, 'Sacramento'],
  [/\bWTAE\b|pittsburgh|cbsn[-_]?pit\b/i, 'Pittsburgh'],
  [/\bWMAR\b|baltimore/i, 'Baltimore'],
  [/tampa[-_]?bay|tampa|\bWTVT\b/i, 'Tampa Bay'],
  [/tallahassee|\bWTXL\b/i, 'Tallahassee'],
  [/raleigh|durham|\bWTVD\b/i, 'Raleigh-Durham'],
  [/washington[-_]?dc|\bWJLA\b|\bWUSA\b/i, 'Washington, DC'],
];

function inferLiveTvMarket(stream: LiveTvStream): string | undefined {
  const haystack = `${stream.url ?? ''} ${stream.description ?? ''}`;
  for (const [pattern, market] of LIVE_TV_MARKETS) {
    if (pattern.test(haystack)) return market;
  }
  return undefined;
}

function friendlyLiveTvLabel(stream: LiveTvStream, index: number): string {
  const market = inferLiveTvMarket(stream);
  const quality = /\b(4K|UHD|FHD|HD|SD|720P|1080P)\b/i.exec(stream.name ?? '')?.[1]?.toUpperCase();
  const provider = (() => {
    const url = stream.url ?? '';
    if (/tvpass\.org/i.test(url)) return 'TVPass';
    if (/cbsnstream/i.test(url)) return 'CBS News';
    if (/abcnews-streams/i.test(url)) return 'ABC News';
    if (/uplynk/i.test(url)) return 'Uplynk';
    if (/amagi\.tv/i.test(url)) return 'Amagi';
    if (/tubi\.video/i.test(url)) return 'Tubi';
    if (/pluto\.tv/i.test(url)) return 'Pluto';
    if (/google\.com|doubleclick\.net/i.test(url)) return 'Google TV';
    return undefined;
  })();

  if (market) return [market, quality].filter(Boolean).join(' • ');
  if (provider) return [provider, quality].filter(Boolean).join(' • ');
  return [`Feed ${index + 1}`, quality].filter(Boolean).join(' • ');
}

async function getLiveTvStreams(id: string): Promise<LiveTvStream[]> {
  const item = (await getLiveTvItems()).find((candidate) => candidate.id === id);
  let streams: LiveTvStream[] = [];

  // USA TV Next publishes a per-channel stream file that is fresher and more
  // specific than the aggregate catalog. Use it first so local affiliates such
  // as WABC/KABC/CBSN-CHI keep the market clues present in their URLs.
  try {
    const response = await fetch(`${USA_TV_STREAM_BASE}/${encodeURIComponent(id)}.json`, {
      headers: { 'User-Agent': 'Master-Addon/2.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      const payload = (await response.json()) as { streams?: LiveTvStream[] };
      if (Array.isArray(payload.streams)) streams = payload.streams;
    }
  } catch {
    // Fall back to the aggregate catalog below.
  }

  if (streams.length === 0) streams = item?.streams ?? [];

  const seen = new Set<string>();
  return streams
    .filter((stream) => {
      if (!stream.url || /audio/i.test(stream.name ?? '') || seen.has(stream.url)) return false;
      seen.add(stream.url);
      return true;
    })
    .sort((a, b) => tvStreamScore(b) - tvStreamScore(a))
    .slice(0, 12);
}

async function getRadioStation(id: string): Promise<RadioStation | undefined> {
  const uuid = id.startsWith(MASTER_RADIO_ID_PREFIX)
    ? id.slice(MASTER_RADIO_ID_PREFIX.length)
    : id;
  if (!uuid) return undefined;
  const response = await fetch(
    `${RADIO_BROWSER_BASE}/json/stations/byuuid/${encodeURIComponent(uuid)}`,
    {
      headers: { 'User-Agent': 'Master-Addon/2.0' },
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!response.ok) return undefined;
  const stations = (await response.json()) as RadioStation[];
  return Array.isArray(stations) ? stations[0] : undefined;
}

function normaliseTitleWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function titlesProbablyMatch(left: string, right: string): boolean {
  const wanted = normaliseTitleWords(left);
  if (wanted.length === 0) return true;
  const candidate = new Set(normaliseTitleWords(right));
  const matched = wanted.filter((word) => candidate.has(word)).length;
  return matched >= Math.min(2, Math.max(1, Math.ceil(wanted.length * 0.3)));
}

function responseCookieHeader(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  const raw = values.length > 0 ? values : [response.headers.get('set-cookie') ?? ''];
  const cookies = raw
    .flatMap((value) => value.split(/,(?=[^;,]+=)/g))
    .map((value) => value.split(';', 1)[0]?.trim())
    .filter((value): value is string => Boolean(value));
  return cookies.length > 0 ? cookies.join('; ') : undefined;
}

async function fetchAdultHtml(url: string, referer?: string, cookie?: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': DIRECT_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(referer ? { Referer: referer } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return '';
  return response.text();
}

async function resolveXvideosFallback(
  title: string
): Promise<Array<{ url: string; name: string; referer?: string }>> {
  try {
    const query = normaliseTitleWords(title).slice(0, 5).join(' ');
    if (!query) return [];

    // Warm the site first and preserve its session cookie. Browser-based
    // implementations do this automatically; Node fetch does not.
    const root = await fetch('https://www.xvideos.com/', {
      headers: {
        'User-Agent': DIRECT_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    const cookie = root.ok ? responseCookieHeader(root) : undefined;

    const searchUrl = `https://www.xvideos.com/?k=${encodeURIComponent(query)}`;
    const html = await fetchAdultHtml(searchUrl, 'https://www.xvideos.com/', cookie);
    if (!html) return [];

    const links = [
      ...new Set(
        [...html.matchAll(/href=["'](\/video(?:\.|\/)[^"'#?\s]+)["']/gi)].map(
          (match) => match[1]
        )
      ),
    ].slice(0, 8);

    for (const path of links) {
      const detailUrl = new URL(path, 'https://www.xvideos.com').toString();
      const detail = await fetchAdultHtml(detailUrl, 'https://www.xvideos.com/', cookie);
      if (!detail) continue;

      const pageTitle =
        detail.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
        detail.match(/<title>([^<]+)<\/title>/i)?.[1] ??
        '';
      if (pageTitle && !titlesProbablyMatch(title, pageTitle)) continue;

      const urls = [
        detail.match(/html5player\.setVideoHLS\(['"]([^'"]+)['"]\)/i)?.[1],
        detail.match(/html5player\.setVideoUrlHigh\(['"]([^'"]+)['"]\)/i)?.[1],
        detail.match(/html5player\.setVideoUrlLow\(['"]([^'"]+)['"]\)/i)?.[1],
        detail.match(/["']contentUrl["']\s*:\s*["']([^"']+)["']/i)?.[1],
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
  } catch (error) {
    logger.warn('XVideos fallback resolution failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return [];
}

router.get('/master-media/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawToken = req.params.token;
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    const payload = decodeMediaPayload(token ?? '');
    if (!payload) {
      res.sendStatus(403);
      return;
    }

    const headers: Record<string, string> = {
      'User-Agent': DIRECT_USER_AGENT,
      Accept: '*/*',
    };
    if (payload.r) headers.Referer = payload.r;
    if (typeof req.headers.range === 'string') headers.Range = req.headers.range;

    const upstream = await fetch(payload.u, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!upstream.ok && upstream.status !== 206) {
      res.sendStatus(upstream.status);
      return;
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    const finalUrl = upstream.url || payload.u;
    const isHls =
      /mpegurl/i.test(contentType) ||
      /\.m3u8(?:\?|$)/i.test(finalUrl) ||
      /\.m3u8(?:\?|$)/i.test(payload.u);

    if (isHls) {
      const playlist = await upstream.text();
      res.status(upstream.status).type('application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(rewriteHlsPlaylist(req, playlist, finalUrl));
      return;
    }

    res.status(upstream.status);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as any).pipe(res);
  } catch (error) {
    next(error);
  }
});

router.get(
  '/:type/:id.json',
  async (
    req: Request<StreamParams>,
    res: Response<AIOStreamResponse>,
    next: NextFunction
  ) => {
    if (!req.userData) {
      res.status(200).json(
        StremioTransformer.createDynamicError('stream', {
          errorDescription: 'Please configure the addon first',
        })
      );
      return;
    }

    const { type, id } = req.params;

    if (id.startsWith(MASTER_ADULT_ID_PREFIX)) {
      try {
        const item = decodeAdultId(id);
        if (!item || item.sourceKind !== 'direct') {
          res.status(200).json({ streams: [] } as any);
          return;
        }

        let directStreams =
          item.indexer === 'EPorner'
            ? await resolveEpornerCurrent(item)
            : await resolveAdultDirectStreams(item);

        if (directStreams.length === 0) {
          directStreams = await resolveXvideosFallback(item.title);
        }

        const streams = directStreams.map((stream) => ({
          name: `Master • ${stream.name}`,
          title: item.title,
          url: mediaRelayUrl(req, stream.url, stream.referer),
          behaviorHints: {
            notWebReady: false,
            bingeGroup: `master-adult-direct-${item.indexer}-${item.sourceId || 'video'}`,
          },
        }));

        res.status(200).json({ streams } as any);
        return;
      } catch (error) {
        logger.error('Master adult direct stream resolution failed', error);
        res.status(200).json({ streams: [] } as any);
        return;
      }
    }

    if (id.startsWith('ustv-')) {
      try {
        const candidates = await getLiveTvStreams(id);
        const streams = candidates.map((stream, index) => {
          const label = friendlyLiveTvLabel(stream, index);
          return {
            name: `Master • ${label}`,
            title: label,
            url: mediaRelayUrl(req, stream.url!),
            behaviorHints: { notWebReady: false },
          };
        });
        res.status(200).json({ streams } as any);
        return;
      } catch (error) {
        logger.error('Master Live TV stream resolution failed', error);
        res.status(200).json({ streams: [] } as any);
        return;
      }
    }

    if (id.startsWith(MASTER_RADIO_ID_PREFIX)) {
      try {
        const station = await getRadioStation(id);
        const url = station?.url_resolved || station?.url;
        res.status(200).json({
          streams: url
            ? [
                {
                  name: 'Master • Radio',
                  title: station?.name || 'Radio Station',
                  url: mediaRelayUrl(req, url),
                  behaviorHints: { notWebReady: false },
                },
                {
                  name: 'Master • Radio (external fallback)',
                  title: station?.name || 'Radio Station',
                  externalUrl: url,
                },
              ]
            : [],
        } as any);
        return;
      } catch (error) {
        logger.error('Master Radio stream resolution failed', error);
        res.status(200).json({ streams: [] } as any);
        return;
      }
    }

    const transformer = new StremioTransformer(req.userData);

    const provideSetting = appConfig.api.provideStreamData;
    const provideStreamData =
      provideSetting === null
        ? (req.headers['user-agent']?.includes('AIOStreams/') ?? false)
        : typeof provideSetting === 'boolean'
          ? provideSetting
          : provideSetting.includes(req.requestIp || '');

    try {
      const aiostreams = await new AIOStreams(req.userData).initialise();

      const disableAutoplay = await aiostreams.shouldStopAutoPlay(type, id);

      const response = await aiostreams.getStreams(id, type);
      const streamContext = aiostreams.getStreamContext();

      if (!streamContext) {
        throw new Error('Stream context not available');
      }

      res
        .status(200)
        .json(
          await transformer.transformStreams(
            response,
            streamContext.toFormatterContext(response.data.streams),
            { provideStreamData, disableAutoplay }
          )
        );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      const errors = [
        {
          description: errorMessage,
        },
      ];
      if (transformer.showError('stream', errors)) {
        logger.error(
          `Unexpected error during stream retrieval: ${errorMessage}`,
          error
        );
        res.status(200).json(
          StremioTransformer.createDynamicError('stream', {
            errorDescription: errorMessage,
          })
        );
        return;
      }
      next(error);
    }
  }
);

export default router;
