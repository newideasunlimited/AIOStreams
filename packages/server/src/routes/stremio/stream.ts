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
const RADIO_BROWSER_BASE = 'https://de1.api.radio-browser.info';
const MASTER_RADIO_ID_PREFIX = 'masterradio:';

router.use(trackResource('stream'));

interface StreamParams {
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

async function getLiveTvStreams(id: string): Promise<LiveTvStream[]> {
  const item = (await getLiveTvItems()).find((candidate) => candidate.id === id);
  return (item?.streams ?? [])
    .filter((stream) => Boolean(stream.url) && !/audio/i.test(stream.name ?? ''))
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
  return matched >= Math.min(3, Math.max(1, Math.ceil(wanted.length * 0.45)));
}

async function fetchAdultHtml(url: string, referer?: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': DIRECT_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      ...(referer ? { Referer: referer } : {}),
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
    const query = normaliseTitleWords(title).slice(0, 8).join(' ');
    if (!query) return [];
    const searchUrl = `https://www.xvideos.com/?k=${encodeURIComponent(query)}`;
    const html = await fetchAdultHtml(searchUrl, 'https://www.xvideos.com/');
    if (!html) return [];

    const links = [
      ...new Set(
        [...html.matchAll(/href=["'](\/video[^"'#?\s]+)["']/gi)].map(
          (match) => match[1]
        )
      ),
    ].slice(0, 5);

    for (const path of links) {
      const detailUrl = new URL(path, 'https://www.xvideos.com').toString();
      const detail = await fetchAdultHtml(detailUrl, 'https://www.xvideos.com/');
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
    const payload = decodeMediaPayload(req.params.token);
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
        const streams = candidates.map((stream) => ({
          name: `Master • ${stream.name || 'Live TV'}`,
          title: stream.description || 'Live TV',
          url: mediaRelayUrl(req, stream.url!),
          behaviorHints: { notWebReady: false },
        }));
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
