import { Router, Request, Response, NextFunction } from 'express';
import {
  MasterNativeAddon,
  fromUrlSafeBase64,
  decodeAdultId,
  encodeAdultId,
  fetchAdultCatalog,
  resolveAdultItem,
  resolveAdultDirectStreams,
  MASTER_ADULT_GENRES,
  MASTER_ADULT_CATALOG_ID,
  MASTER_ADULT_ID_PREFIX,
  config as appConfig,
  type AdultTorrentItem,
} from '@aiostreams/core';

const router: Router = Router();
const EPORNER_BASE = 'https://www.eporner.com';
const DIRECT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const MASTER_LIVE_TV_CATALOG_ID = 'master-live-tv';
const MASTER_RADIO_CATALOG_ID = 'master-radio';
const MASTER_RADIO_ID_PREFIX = 'masterradio:';
const USA_TV_CATALOG_URL =
  'https://raw.githubusercontent.com/yowmamasita/usa-tv-next/main/catalog/tv/all.json';
const RADIO_BROWSER_BASE = 'https://de1.api.radio-browser.info';
const LIVE_TV_GENRES = [
  'Local',
  'News',
  'Sports',
  'Entertainment',
  'Premium',
  'Lifestyle',
  'Kids',
  'Documentaries',
  'Music',
  'Latino',
] as const;
const RADIO_GENRES = [
  'Rock',
  'Pop',
  'Jazz',
  'Classical',
  'Country',
  'Electronic',
  'Hip Hop',
  'Alternative',
  'Talk',
  'News',
] as const;

interface ManifestParams {
  encodedConfig?: string;
}

function createAddon(encodedConfig: string | undefined, clientIp?: string) {
  return new MasterNativeAddon(
    encodedConfig
      ? JSON.parse(fromUrlSafeBase64(encodedConfig))
      : undefined,
    clientIp
  );
}

function publicBaseUrl(): string {
  return appConfig.bootstrap.baseUrl?.replace(/\/$/, '') || '';
}

function posterUrl(id: string): string | undefined {
  const base = publicBaseUrl();
  return base
    ? `${base}/builtins/master-native/poster/${encodeURIComponent(id)}.svg`
    : undefined;
}

function adultMeta(item: AdultTorrentItem) {
  const id = encodeAdultId(item);
  const fallbackDescription = `${item.indexer}${item.seeders ? ` • ${item.seeders} seeders` : ''}${
    item.size ? ` • ${(item.size / 1024 ** 3).toFixed(2)} GB` : ''
  }`;
  return {
    id,
    type: 'movie',
    name: item.title,
    description: item.description || fallbackDescription,
    poster: item.poster || posterUrl(id),
    background: item.poster,
    posterShape: item.poster ? 'landscape' : 'poster',
    genres: item.tags ?? [],
    runtime: item.duration,
    website: item.detailUrl,
    behaviorHints: { adult: true },
  };
}

function parseExtras(extra?: string) {
  const params = new URLSearchParams(extra ?? '');
  return {
    skip: Math.max(0, Number(params.get('skip') ?? 0) || 0),
    search: params.get('search') || undefined,
    genre: params.get('genre') || undefined,
  };
}

async function getAdultCatalog(extra?: string) {
  const { skip, search, genre } = parseExtras(extra);
  const effectiveSearch = !search && !genre ? 'all' : search;
  const items = await fetchAdultCatalog(effectiveSearch, genre, skip);
  return items.map(adultMeta);
}

type LiveTvStream = {
  url?: string;
  name?: string;
  description?: string;
  behaviorHints?: Record<string, unknown>;
};
type LiveTvMeta = {
  id?: string;
  name?: string;
  type?: string;
  poster?: string;
  logo?: string;
  genre?: string;
  genres?: string[];
  country?: string;
  streams?: LiveTvStream[];
};

let liveTvCache: { expires: number; metas: LiveTvMeta[] } | undefined;

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

function liveTvMeta(item: LiveTvMeta) {
  return {
    id: item.id,
    type: 'tv',
    name: item.name || 'Live TV',
    poster: item.poster || item.logo,
    background: item.poster || item.logo,
    posterShape: 'poster',
    genres: item.genres ?? (item.genre ? [item.genre] : []),
    description: [item.country, item.genre].filter(Boolean).join(' • ') || 'Live TV',
  };
}

async function getLiveTvCatalog(extra?: string) {
  const { skip, search, genre } = parseExtras(extra);
  let items = await getLiveTvItems();
  if (genre) {
    items = items.filter((item) =>
      (item.genres ?? [item.genre ?? '']).some(
        (value) => value.toLowerCase() === genre.toLowerCase()
      )
    );
  }
  if (search) {
    const q = search.toLowerCase();
    items = items.filter((item) => item.name?.toLowerCase().includes(q));
  }
  return items.slice(skip, skip + 80).map(liveTvMeta);
}

async function findLiveTvItem(id: string): Promise<LiveTvMeta | undefined> {
  return (await getLiveTvItems()).find((item) => item.id === id);
}

type RadioStation = {
  stationuuid?: string;
  name?: string;
  url?: string;
  url_resolved?: string;
  favicon?: string;
  tags?: string;
  country?: string;
  countrycode?: string;
  codec?: string;
  bitrate?: number;
  votes?: number;
  clickcount?: number;
  lastcheckok?: number;
};

function radioMeta(station: RadioStation) {
  const id = `${MASTER_RADIO_ID_PREFIX}${station.stationuuid}`;
  const genres = (station.tags ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
  const detail = [
    station.country,
    station.codec,
    station.bitrate ? `${station.bitrate} kbps` : undefined,
  ]
    .filter(Boolean)
    .join(' • ');
  return {
    id,
    type: 'other',
    name: station.name || 'Radio Station',
    poster: station.favicon || undefined,
    background: station.favicon || undefined,
    posterShape: 'square',
    genres,
    description: detail || 'Internet radio',
  };
}

async function fetchRadioStations(extra?: string): Promise<RadioStation[]> {
  const { skip, search, genre } = parseExtras(extra);
  const url = search || genre
    ? new URL(`${RADIO_BROWSER_BASE}/json/stations/search`)
    : new URL(`${RADIO_BROWSER_BASE}/json/stations/topclick/100`);
  if (search) url.searchParams.set('name', search);
  if (genre) url.searchParams.set('tag', genre.toLowerCase());
  url.searchParams.set('hidebroken', 'true');
  url.searchParams.set('limit', '80');
  url.searchParams.set('offset', String(skip));
  url.searchParams.set('order', 'clickcount');
  url.searchParams.set('reverse', 'true');

  const response = await fetch(url.toString(), {
    headers: { 'User-Agent': 'Master-Addon/2.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Radio Browser returned ${response.status}`);
  const stations = (await response.json()) as RadioStation[];
  return (Array.isArray(stations) ? stations : []).filter(
    (station) =>
      station.stationuuid &&
      station.name &&
      (station.url_resolved || station.url) &&
      station.lastcheckok !== 0
  );
}

async function getRadioCatalog(extra?: string) {
  return (await fetchRadioStations(extra)).map(radioMeta);
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

function epornerHashToken(hex: string): string {
  if (!/^[a-f0-9]{32}$/i.test(hex)) return '';
  let out = '';
  for (let offset = 0; offset < 32; offset += 8) {
    out += Number.parseInt(hex.slice(offset, offset + 8), 16).toString(36);
  }
  return out;
}

function epornerPlayerValue(html: string, key: 'hash' | 'vid'): string {
  const exact = html.match(
    new RegExp(`EP\\.video\\.player\\.${key}\\s*=\\s*['\"]([^'\"]+)['\"]\\s*;`, 'i')
  )?.[1];
  if (exact) return exact;
  return (
    html.match(new RegExp(`${key}\\s*[:=]\\s*['\"]([^'\"]+)['\"]`, 'i'))?.[1] ?? ''
  );
}

function qualityRank(value: string): number {
  const match = value.match(/(2160|1440|1080|720|480|360|240)p?/i);
  return Number(match?.[1] ?? 0);
}

async function resolveCurrentEpornerStreams(
  item: AdultTorrentItem
): Promise<Array<{ url: string; name: string; referer?: string }>> {
  if (item.indexer !== 'EPorner' || !item.detailUrl) return [];

  try {
    const pageResponse = await fetch(item.detailUrl, {
      headers: {
        'User-Agent': DIRECT_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        Referer: EPORNER_BASE,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (!pageResponse.ok) return [];

    const html = await pageResponse.text();
    const rawHash = epornerPlayerValue(html, 'hash');
    const videoId = epornerPlayerValue(html, 'vid') || item.sourceId || '';
    const hash = epornerHashToken(rawHash);
    const referer = pageResponse.url || item.detailUrl;
    if (!hash || !videoId) return [];

    const xhr = new URL(`${EPORNER_BASE}/xhr/video/${encodeURIComponent(videoId)}`);
    xhr.searchParams.set('hash', hash);
    xhr.searchParams.set('domain', 'www.eporner.com');
    xhr.searchParams.set('pixelRatio', '2');
    xhr.searchParams.set('playerWidth', '0');
    xhr.searchParams.set('playerHeight', '0');
    xhr.searchParams.set('fallback', 'false');
    xhr.searchParams.set('embed', 'false');
    xhr.searchParams.set('supportedFormats', 'hls,dash,h265,vp9,av1,mp4');
    xhr.searchParams.set('_', String(Date.now()));

    const videoResponse = await fetch(xhr.toString(), {
      headers: {
        'User-Agent': DIRECT_USER_AGENT,
        Accept: 'application/json,*/*;q=0.8',
        Referer: referer,
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!videoResponse.ok) return [];

    const video = (await videoResponse.json()) as {
      available?: boolean;
      sources?: Record<string, Record<string, { src?: string; labelShort?: string }>>;
    };
    if (video.available === false || !video.sources) return [];

    const seen = new Set<string>();
    const streams: Array<{ url: string; name: string; referer?: string }> = [];
    const hls = video.sources.hls;
    if (hls?.auto?.src && /^https?:\/\//i.test(hls.auto.src)) {
      seen.add(hls.auto.src);
      streams.push({ url: hls.auto.src, name: 'EPorner HLS Auto', referer });
    }
    for (const [kind, formats] of Object.entries(video.sources)) {
      if (!formats || typeof formats !== 'object') continue;
      for (const [formatId, format] of Object.entries(formats)) {
        const streamUrl = format?.src;
        if (!streamUrl || !/^https?:\/\//i.test(streamUrl) || seen.has(streamUrl)) continue;
        seen.add(streamUrl);
        streams.push({
          url: streamUrl,
          name: `EPorner ${format.labelShort || formatId || kind || 'Watch'}`,
          referer,
        });
      }
    }
    return streams.sort((a, b) => qualityRank(b.name) - qualityRank(a.name));
  } catch {
    return [];
  }
}

function getStremioManifest(addon: MasterNativeAddon) {
  const manifest = addon.getManifest();
  const baseCatalogs = (manifest.catalogs ?? []).map((catalog) =>
    catalog.id === MASTER_ADULT_CATALOG_ID
      ? {
          ...catalog,
          type: 'movie',
          name: 'Porn',
          extra: [
            { name: 'skip' },
            { name: 'search' },
            {
              name: 'genre',
              options: [...MASTER_ADULT_GENRES],
              isRequired: false,
            },
          ],
        }
      : catalog
  );
  const baseResources = manifest.resources.map((resource) => {
    if (typeof resource === 'string') return resource;
    if (!resource.types?.includes('adult')) return resource;
    return {
      ...resource,
      types: resource.types.map((type) => (type === 'adult' ? 'movie' : type)),
    };
  });

  return {
    ...manifest,
    types: [
      ...new Set([
        ...(manifest.types ?? []).map((type) => (type === 'adult' ? 'movie' : type)),
        'tv',
        'other',
      ]),
    ],
    catalogs: [
      ...baseCatalogs,
      {
        type: 'tv',
        id: MASTER_LIVE_TV_CATALOG_ID,
        name: 'Live TV',
        extra: [
          { name: 'skip' },
          { name: 'search' },
          { name: 'genre', options: [...LIVE_TV_GENRES], isRequired: false },
        ],
      },
      {
        type: 'other',
        id: MASTER_RADIO_CATALOG_ID,
        name: 'Radio',
        extra: [
          { name: 'skip' },
          { name: 'search' },
          { name: 'genre', options: [...RADIO_GENRES], isRequired: false },
        ],
      },
    ],
    resources: [
      ...baseResources,
      {
        name: 'catalog',
        types: ['tv'],
        idPrefixes: [MASTER_LIVE_TV_CATALOG_ID],
      },
      { name: 'meta', types: ['tv'], idPrefixes: ['ustv-'] },
      { name: 'stream', types: ['tv'], idPrefixes: ['ustv-'] },
      {
        name: 'catalog',
        types: ['other'],
        idPrefixes: [MASTER_RADIO_CATALOG_ID],
      },
      { name: 'meta', types: ['other'], idPrefixes: [MASTER_RADIO_ID_PREFIX] },
      { name: 'stream', types: ['other'], idPrefixes: [MASTER_RADIO_ID_PREFIX] },
    ],
    behaviorHints: {
      ...(manifest.behaviorHints ?? {}),
      adult: true,
      p2p: true,
    },
  };
}

router.get(
  '/:encodedConfig/manifest.json',
  async (req: Request<ManifestParams>, res: Response, next: NextFunction) => {
    const { encodedConfig } = req.params;
    try {
      const addon = createAddon(encodedConfig, req.userIp);
      res.json(getStremioManifest(addon));
    } catch (error) {
      next(error);
    }
  }
);

interface ResourceParams {
  encodedConfig?: string;
  type: string;
  id: string;
}

interface CatalogParams extends ResourceParams {
  extra?: string;
}

async function handleCatalog(
  req: Request<CatalogParams>,
  res: Response,
  next: NextFunction
) {
  const { encodedConfig, type, id, extra } = req.params;
  try {
    if (id === MASTER_ADULT_CATALOG_ID) {
      res.json({ metas: await getAdultCatalog(extra) });
      return;
    }
    if (id === MASTER_LIVE_TV_CATALOG_ID) {
      res.json({ metas: await getLiveTvCatalog(extra) });
      return;
    }
    if (id === MASTER_RADIO_CATALOG_ID) {
      res.json({ metas: await getRadioCatalog(extra) });
      return;
    }

    const addon = createAddon(encodedConfig, req.userIp);
    const metas = await addon.getCatalog(type, id, extra);
    res.json({ metas });
  } catch (error) {
    next(error);
  }
}

router.get('/:encodedConfig/catalog/:type/:id.json', handleCatalog);
router.get('/:encodedConfig/catalog/:type/:id/:extra.json', handleCatalog);

router.get(
  '/:encodedConfig/meta/:type/:id.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    const { encodedConfig, type, id } = req.params;
    try {
      if (id.startsWith(MASTER_ADULT_ID_PREFIX)) {
        const item = decodeAdultId(id);
        res.json({ meta: item ? adultMeta(item) : null });
        return;
      }
      if (id.startsWith('ustv-')) {
        const item = await findLiveTvItem(id);
        res.json({ meta: item ? liveTvMeta(item) : null });
        return;
      }
      if (id.startsWith(MASTER_RADIO_ID_PREFIX)) {
        const station = await getRadioStation(id);
        res.json({ meta: station ? radioMeta(station) : null });
        return;
      }

      const addon = createAddon(encodedConfig, req.userIp);
      const meta = await addon.getMeta(type, id);
      res.json({ meta });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:encodedConfig/stream/:type/:id.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    const { encodedConfig, type, id } = req.params;
    try {
      if (id.startsWith(MASTER_ADULT_ID_PREFIX)) {
        const item = decodeAdultId(id);
        if (!item) {
          res.json({ streams: [] });
          return;
        }

        if (item.sourceKind === 'direct') {
          let directStreams =
            item.indexer === 'EPorner'
              ? await resolveCurrentEpornerStreams(item)
              : await resolveAdultDirectStreams(item);
          if (item.indexer === 'EPorner' && directStreams.length === 0) {
            directStreams = await resolveAdultDirectStreams(item);
          }

          const streams = directStreams.map((stream) => ({
            name: `Master • ${stream.name}`,
            title: item.title,
            url: stream.url,
            behaviorHints: {
              notWebReady: false,
              bingeGroup: `master-adult-direct-${item.indexer}-${item.sourceId || 'video'}`,
              proxyHeaders: {
                request: {
                  'User-Agent': DIRECT_USER_AGENT,
                  ...(stream.referer ? { Referer: stream.referer } : {}),
                },
              },
            },
          }));
          res.json({ streams });
          return;
        }

        const resolved = await resolveAdultItem(item);
        if (!resolved?.hash) {
          res.json({ streams: [] });
          return;
        }

        const resolvedId = encodeAdultId(resolved);
        const addon = createAddon(encodedConfig, req.userIp);
        let debridStreams: any[] = [];
        try {
          debridStreams = await addon.getStreams('adult', resolvedId);
        } catch {
          debridStreams = [];
        }

        res.json({
          streams: [
            {
              name: 'Master • Direct Torrent',
              title: `${resolved.title}\n${resolved.indexer}${resolved.seeders ? ` • ${resolved.seeders} seeders` : ''}`,
              infoHash: resolved.hash,
              behaviorHints: { bingeGroup: `master-adult-${resolved.hash}` },
            },
            ...debridStreams,
          ],
        });
        return;
      }

      if (id.startsWith('ustv-')) {
        const item = await findLiveTvItem(id);
        const streams = (item?.streams ?? []).filter((stream) => stream.url).map((stream) => ({
          name: stream.name || 'Live TV',
          title: stream.description || item?.name || 'Live TV',
          url: stream.url,
          behaviorHints: { ...(stream.behaviorHints ?? {}), notWebReady: true },
        }));
        res.json({ streams });
        return;
      }

      if (id.startsWith(MASTER_RADIO_ID_PREFIX)) {
        const station = await getRadioStation(id);
        const url = station?.url_resolved || station?.url;
        res.json({
          streams: url
            ? [
                {
                  name: 'Master • Radio',
                  title: station?.name || 'Radio Station',
                  url,
                  behaviorHints: { notWebReady: false },
                },
              ]
            : [],
        });
        return;
      }

      const addon = createAddon(encodedConfig, req.userIp);
      const streams = await addon.getStreams(type, id);
      res.json({ streams });
    } catch (error) {
      next(error);
    }
  }
);

router.get('/poster/:id.svg', (req: Request, res: Response) => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = decodeURIComponent(rawId || '');
  const item = decodeAdultId(id);
  const title = (item?.title || 'Adult').slice(0, 110);
  const escaped = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const words = escaped.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > 24 && current) {
      lines.push(current);
      current = word;
      if (lines.length === 4) break;
    } else {
      current = next;
    }
  }
  if (current && lines.length < 5) lines.push(current);

  const tspans = lines
    .map((line, index) => `<tspan x="300" dy="${index === 0 ? 0 : 52}">${line}</tspan>`)
    .join('');

  res.type('image/svg+xml').send(`
    <svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
      <rect width="600" height="900" fill="#171722"/>
      <rect x="36" y="36" width="528" height="828" rx="28" fill="#242435"/>
      <text x="300" y="165" text-anchor="middle" font-family="sans-serif" font-size="34" font-weight="700" fill="#ffffff">MASTER</text>
      <text x="300" y="220" text-anchor="middle" font-family="sans-serif" font-size="25" fill="#b8b8c8">ADULT</text>
      <text x="300" y="410" text-anchor="middle" font-family="sans-serif" font-size="31" fill="#ffffff">${tspans}</text>
      <text x="300" y="805" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#9c9caf">${item?.indexer || 'Local source'}</text>
    </svg>
  `);
});

export default router;
