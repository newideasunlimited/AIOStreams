import {
  MASTER_ADULT_CATALOG_ID,
  MASTER_ADULT_GENRES,
  MASTER_ADULT_ID_PREFIX,
  encodeAdultId,
  decodeAdultId,
  fetchAdultCatalog,
  config as appConfig,
  type AdultTorrentItem,
} from '@aiostreams/core';

export const MASTER_LIVE_TV_CATALOG_ID = 'master-live-tv';
export const MASTER_RADIO_CATALOG_ID = 'master-radio';
export const MASTER_RADIO_ID_PREFIX = 'masterradio:';

const USA_TV_CATALOG_URL =
  'https://raw.githubusercontent.com/yowmamasita/usa-tv-next/main/catalog/tv/all.json';
const RADIO_BROWSER_BASE = 'https://de1.api.radio-browser.info';
const MIN_ADULT_DURATION_SECONDS = 10 * 60;

export const MASTER_CATALOGS = [
  {
    type: 'tv',
    id: MASTER_LIVE_TV_CATALOG_ID,
    name: 'Live TV',
    extra: [
      { name: 'skip' },
      { name: 'search' },
      {
        name: 'genre',
        options: [
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
        ],
        isRequired: false,
      },
    ],
  },
  {
    type: 'other',
    id: MASTER_RADIO_CATALOG_ID,
    name: 'Radio',
    extra: [
      { name: 'skip' },
      { name: 'search' },
      {
        name: 'genre',
        options: [
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
        ],
        isRequired: false,
      },
    ],
  },
  {
    type: 'movie',
    id: MASTER_ADULT_CATALOG_ID,
    name: 'Porn',
    extra: [
      { name: 'skip' },
      { name: 'search' },
      { name: 'genre', options: [...MASTER_ADULT_GENRES], isRequired: false },
    ],
  },
] as const;

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

type RadioStation = {
  stationuuid?: string;
  name?: string;
  url?: string;
  url_resolved?: string;
  favicon?: string;
  tags?: string;
  country?: string;
  codec?: string;
  bitrate?: number;
  clickcount?: number;
  lastcheckok?: number;
};

export const PRIORITY_LIVE_TV_ITEMS: LiveTvMeta[] = [
  {
    id: 'ustv-priority-comedy-central',
    name: 'Comedy Central Pluto TV',
    type: 'tv',
    country: 'USA',
    genre: 'Entertainment',
    genres: ['Entertainment'],
    streams: [
      {
        url: 'https://jmp2.uk/plu-5ca671f215a62078d2ec0abf.m3u8',
        name: 'HD',
        description: 'Comedy Central • Pluto TV',
      },
    ],
  },
  {
    id: 'ustv-priority-adult-swim',
    name: 'Adult Swim Stream',
    type: 'tv',
    country: 'USA',
    genre: 'Entertainment',
    genres: ['Entertainment'],
    streams: [
      {
        url: 'https://media.cdn.adultswim.com/streams/playlists/live-stream.primary.v2.m3u8',
        name: 'HD',
        description: 'Adult Swim • Official free stream',
      },
    ],
  },
  {
    id: 'ustv-priority-phx-abc15',
    name: 'ABC15 Phoenix • KNXV',
    type: 'tv',
    country: 'USA',
    genre: 'Local',
    genres: ['Local', 'News'],
    streams: [
      {
        url: 'https://content.uplynk.com/channel/9deaf22aaa33461f9cac22e030ed00ec.m3u8',
        name: 'HD',
        description: 'Phoenix • KNXV • ABC15',
      },
      {
        url: 'https://aegis-cloudfront-1.tubi.video/e923f4ce-7229-4e01-a25e-d453993dab82/playlist.m3u8',
        name: 'HD Backup',
        description: 'Phoenix • KNXV • ABC15 • Tubi',
      },
    ],
  },
  {
    id: 'ustv-priority-phx-fox10',
    name: 'FOX 10 Phoenix • KSAZ',
    type: 'tv',
    country: 'USA',
    genre: 'Local',
    genres: ['Local', 'News'],
    streams: [
      {
        url: 'https://cdn-uw2-prod.tsv2.amagi.tv/linear/amg00488-foxdigital-ksaz-lgus/playlist.m3u8',
        name: 'HD',
        description: 'Phoenix • KSAZ • FOX 10',
      },
      {
        url: 'https://aegis-cloudfront-1.tubi.video/6bb80abf-8f73-46f3-a520-bb810d93f1d0/index.m3u8',
        name: 'HD Backup',
        description: 'Phoenix • KSAZ • FOX 10 • Tubi',
      },
    ],
  },
  {
    id: 'ustv-priority-phx-12news',
    name: '12News Phoenix • KPNX',
    type: 'tv',
    country: 'USA',
    genre: 'Local',
    genres: ['Local', 'News'],
    streams: [
      {
        url: 'https://live-manifest.production-public.tubi.io/live/68c66ccb-444f-46d4-bcbf-37511338b170/playlist.m3u8',
        name: 'HD',
        description: 'Phoenix • KPNX • 12News',
      },
      {
        url: 'https://livetv-fa.tubi.video/kpnx/live.m3u8',
        name: 'HD Backup',
        description: 'Phoenix • KPNX • 12News • Tubi',
      },
    ],
  },
  {
    id: 'ustv-priority-phx-azfamily',
    name: "Arizona's Family News • 3TV/CBS5",
    type: 'tv',
    country: 'USA',
    genre: 'Local',
    genres: ['Local', 'News'],
    streams: [
      {
        url: 'https://player-api.new.livestream.com/accounts/12643960/events/3893868/live.m3u8',
        name: 'Live',
        description: "Phoenix • Arizona's Family • KTVK/KPHO",
      },
    ],
  },
];

function parseExtras(extra?: string) {
  const params = new URLSearchParams(extra ?? '');
  return {
    skip: Math.max(0, Number(params.get('skip') ?? 0) || 0),
    search: params.get('search') || undefined,
    genre: params.get('genre') || undefined,
  };
}

function parseDurationSeconds(value?: string): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const parts = text.split(':').map(Number);
  if (parts.every(Number.isFinite)) {
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  const numericMinutes = Number(text);
  return Number.isFinite(numericMinutes) && numericMinutes > 0
    ? Math.round(numericMinutes * 60)
    : undefined;
}

function adultMeta(item: AdultTorrentItem) {
  const id = encodeAdultId(item);
  return {
    id,
    type: 'movie',
    name: item.title,
    description: item.description || item.indexer,
    poster: item.poster,
    background: item.poster,
    posterShape: item.poster ? 'landscape' : 'poster',
    genres: item.tags ?? [],
    runtime: item.duration,
    website: item.detailUrl,
    behaviorHints: { adult: true },
  };
}

function liveTvPoster(id?: string): string | undefined {
  if (!id) return undefined;
  const base = appConfig.bootstrap.baseUrl?.replace(/\/$/, '');
  return base ? `${base}/master-static/live-tv/${encodeURIComponent(id)}.svg` : undefined;
}

function liveTvMeta(item: LiveTvMeta) {
  const artwork = item.poster || item.logo || liveTvPoster(item.id);
  return {
    id: item.id,
    type: 'tv',
    name: item.name || 'Live TV',
    poster: artwork,
    background: artwork,
    posterShape: 'poster',
    genres: item.genres ?? (item.genre ? [item.genre] : []),
    description: [item.country, item.genre].filter(Boolean).join(' • ') || 'Live TV',
  };
}

function radioMeta(station: RadioStation) {
  const id = `${MASTER_RADIO_ID_PREFIX}${station.stationuuid}`;
  return {
    id,
    type: 'other',
    name: station.name || 'Radio Station',
    poster: station.favicon || undefined,
    background: station.favicon || undefined,
    posterShape: 'square',
    genres: (station.tags ?? '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 12),
    description:
      [station.country, station.codec, station.bitrate ? `${station.bitrate} kbps` : undefined]
        .filter(Boolean)
        .join(' • ') || 'Internet radio',
  };
}

let liveTvCache: { expires: number; metas: LiveTvMeta[] } | undefined;

async function getLiveTvItems(): Promise<LiveTvMeta[]> {
  if (liveTvCache && liveTvCache.expires > Date.now()) return liveTvCache.metas;
  const response = await fetch(USA_TV_CATALOG_URL, {
    headers: { 'User-Agent': 'Master-Addon/2.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`USA TV Next returned ${response.status}`);
  const payload = (await response.json()) as { metas?: LiveTvMeta[] };
  const upstream = Array.isArray(payload.metas) ? payload.metas : [];
  const priorityIds = new Set(PRIORITY_LIVE_TV_ITEMS.map((item) => item.id));
  const metas = [
    ...PRIORITY_LIVE_TV_ITEMS,
    ...upstream.filter((item) => !item.id || !priorityIds.has(item.id)),
  ];
  liveTvCache = { expires: Date.now() + 15 * 60_000, metas };
  return metas;
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

export function isMasterCatalogId(id: string): boolean {
  return [MASTER_ADULT_CATALOG_ID, MASTER_LIVE_TV_CATALOG_ID, MASTER_RADIO_CATALOG_ID].includes(
    id as any
  );
}

export async function getMasterCatalog(id: string, extra?: string) {
  if (id === MASTER_ADULT_CATALOG_ID) {
    const { skip, search, genre } = parseExtras(extra);
    const items = await fetchAdultCatalog(!search && !genre ? 'all' : search, genre, skip);
    return items
      .filter((item) => {
        if (item.sourceKind !== 'direct') return true;
        const seconds = parseDurationSeconds(item.duration);
        return seconds !== undefined && seconds >= MIN_ADULT_DURATION_SECONDS;
      })
      .map(adultMeta);
  }

  if (id === MASTER_LIVE_TV_CATALOG_ID) {
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

  if (id === MASTER_RADIO_CATALOG_ID) {
    return (await fetchRadioStations(extra)).map(radioMeta);
  }

  return undefined;
}

export async function getMasterMeta(id: string) {
  if (id.startsWith(MASTER_ADULT_ID_PREFIX)) {
    const item = decodeAdultId(id);
    return item ? adultMeta(item) : null;
  }
  if (id.startsWith('ustv-')) {
    const item = (await getLiveTvItems()).find((candidate) => candidate.id === id);
    return item ? liveTvMeta(item) : null;
  }
  if (id.startsWith(MASTER_RADIO_ID_PREFIX)) {
    const uuid = id.slice(MASTER_RADIO_ID_PREFIX.length);
    const response = await fetch(
      `${RADIO_BROWSER_BASE}/json/stations/byuuid/${encodeURIComponent(uuid)}`,
      {
        headers: { 'User-Agent': 'Master-Addon/2.0' },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!response.ok) return null;
    const stations = (await response.json()) as RadioStation[];
    return Array.isArray(stations) && stations[0] ? radioMeta(stations[0]) : null;
  }
  return undefined;
}

export function getPriorityLiveTvStreams(id: string): LiveTvStream[] | undefined {
  return PRIORITY_LIVE_TV_ITEMS.find((item) => item.id === id)?.streams;
}
