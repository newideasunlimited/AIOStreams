import fs from 'node:fs';

const path = 'packages/server/src/routes/builtins/master-native.ts';
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Live TV patch failed: ${label} target not found`);
  }
  source = source.replace(before, after);
}

replaceOnce(
  "} from '@aiostreams/core';",
  "} from '@aiostreams/core';\nimport { fetchRadioBrowserJson } from '../../utils/radio-browser.js';",
  'Radio Browser helper import'
);

replaceOnce(
  "const USA_TV_CATALOG_URL =\n  'https://raw.githubusercontent.com/yowmamasita/usa-tv-next/main/catalog/tv/all.json';",
  "const USA_TV_CATALOG_URL =\n  'https://raw.githubusercontent.com/yowmamasita/usa-tv-next/main/catalog/tv/all.json';\nconst USA_TV_STREAM_BASE =\n  'https://raw.githubusercontent.com/yowmamasita/usa-tv-next/main/stream/tv';",
  'USA TV stream base'
);

replaceOnce(
`function mediaflowLiveTvUrl(
  destination: string,
  mode: 'compatibility' | 'hls'
): string | undefined {
  const base = publicMediaflowBaseUrl();
  if (!base) return undefined;

  const endpoint =
    mode === 'compatibility'
      ? '/proxy/transcode/playlist.m3u8'
      : '/proxy/hls/manifest.m3u8';
  const url = new URL(endpoint, \`${'${base}'}/\`);
  url.searchParams.set('d', destination);
  const password = process.env.MEDIAFLOW_API_PASSWORD;
  if (password) url.searchParams.set('api_password', password);
  url.searchParams.set('h_user-agent', DIRECT_USER_AGENT);
  if (mode === 'hls') {
    url.searchParams.set('force_playlist_proxy', 'true');
    url.searchParams.set('start_offset', '-18');
  }
  return url.toString();
}`,
`function mediaflowLiveTvUrl(
  destination: string,
  mode: 'compatibility' | 'hls'
): string | undefined {
  const base = publicMediaflowBaseUrl();
  if (!base) return undefined;

  const endpoint =
    mode === 'compatibility'
      ? '/proxy/transcode/playlist.m3u8'
      : '/proxy/hls/manifest.m3u8';
  const url = new URL(endpoint, \`${'${base}'}/\`);
  url.searchParams.set('d', destination);
  const password = process.env.MEDIAFLOW_API_PASSWORD;
  if (password) url.searchParams.set('api_password', password);
  url.searchParams.set('h_user-agent', DIRECT_USER_AGENT);
  if (mode === 'hls') {
    url.searchParams.set('force_playlist_proxy', 'true');
    url.searchParams.set('start_offset', '-18');
  }
  return url.toString();
}`,
  'MediaFlow compatibility URL'
);

replaceOnce(
`function liveTvMeta(item: LiveTvMeta) {
  return {
    id: item.id,
    type: 'tv',
    name: item.name || 'Live TV',
    poster: item.poster || item.logo,
    background: item.poster || item.logo,
    posterShape: 'poster',`,
`function liveTvPosterUrl(_id: string): string | undefined {
  const base = publicBaseUrl();
  return base ? \`${'${base}'}/logo.png\` : undefined;
}

function liveTvMeta(item: LiveTvMeta) {
  const artwork = item.poster || item.logo || (item.id ? liveTvPosterUrl(item.id) : undefined);
  return {
    id: item.id,
    type: 'tv',
    name: item.name || 'Live TV',
    poster: artwork,
    background: artwork,
    posterShape: 'poster',`,
  'raster-safe Live TV poster fallback'
);

replaceOnce(
`async function healthyLiveTvStreams(item: LiveTvMeta): Promise<LiveTvStream[]> {
  const candidates = (item.streams ?? [])
    .filter(isUsefulLiveTvStream)
    .sort((a, b) => liveTvQualityRank(b) - liveTvQualityRank(a))
    .slice(0, MAX_LIVE_TV_PROBES);`,
`async function getLiveTvCandidateStreams(item: LiveTvMeta): Promise<LiveTvStream[]> {
  const inline = (item.streams ?? []).filter(isUsefulLiveTvStream);
  if (inline.length > 0) return inline;
  if (!item.id || !item.id.startsWith('ustv-')) return [];

  try {
    const response = await fetch(
      \`${'${USA_TV_STREAM_BASE}'}/${'${encodeURIComponent(item.id)}'}.json\`,
      {
        headers: { 'User-Agent': 'Master-Addon/2.0' },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!response.ok) return [];
    const payload = (await response.json()) as { streams?: LiveTvStream[] };
    return Array.isArray(payload.streams)
      ? payload.streams.filter(isUsefulLiveTvStream)
      : [];
  } catch {
    return [];
  }
}

async function healthyLiveTvStreams(item: LiveTvMeta): Promise<LiveTvStream[]> {
  const candidates = (await getLiveTvCandidateStreams(item))
    .sort((a, b) => liveTvQualityRank(b) - liveTvQualityRank(a))
    .slice(0, MAX_LIVE_TV_PROBES);`,
  'upstream stream resource lookup'
);

replaceOnce(
`  // Curated feeds are intentionally retained even when the origin rejects our
  // lightweight server-side probe. MediaFlow performs the real HLS fetch for
  // the client and can satisfy origins that behave differently for playback.
  if (item.id?.startsWith('ustv-priority-')) {
    return candidates.slice(0, MAX_LIVE_TV_STREAMS);
  }

  const tested = await Promise.all(
    candidates.map(async (stream) => ({
      stream,
      ok: stream.url ? await probeLiveTvUrl(stream.url) : false,
    }))
  );
  return tested
    .filter((entry) => entry.ok)
    .map((entry) => entry.stream)
    .slice(0, MAX_LIVE_TV_STREAMS);`,
`  // Do not discard channels because the addon host cannot probe an origin.
  // MediaFlow is the playback fetcher and some TV origins reject server-side probes.
  return candidates.slice(0, MAX_LIVE_TV_STREAMS);`,
  'remove destructive live TV health gate'
);

replaceOnce(
`async function fetchRadioStations(extra?: string): Promise<RadioStation[]> {
  const { skip, search, genre } = parseExtras(extra);
  const url = search || genre
    ? new URL(\`${'${RADIO_BROWSER_BASE}'}/json/stations/search\`)
    : new URL(\`${'${RADIO_BROWSER_BASE}'}/json/stations/topclick/100\`);
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
  if (!response.ok) throw new Error(\`Radio Browser returned ${'${response.status}'}\`);
  const stations = (await response.json()) as RadioStation[];
  return (Array.isArray(stations) ? stations : []).filter(
    (station) =>
      station.stationuuid &&
      station.name &&
      (station.url_resolved || station.url) &&
      station.lastcheckok !== 0
  );
}`,
`async function fetchRadioStations(extra?: string): Promise<RadioStation[]> {
  const { skip, search, genre } = parseExtras(extra);
  const params = new URLSearchParams();
  if (search) params.set('name', search);
  if (genre) params.set('tag', genre.toLowerCase());
  params.set('hidebroken', 'true');
  params.set('limit', '80');
  params.set('offset', String(skip));
  params.set('order', 'clickcount');
  params.set('reverse', 'true');
  const path = search || genre ? '/json/stations/search' : '/json/stations/topclick/100';
  const stations = await fetchRadioBrowserJson<RadioStation[]>(path, params);
  return (Array.isArray(stations) ? stations : []).filter(
    (station) =>
      station.stationuuid &&
      station.name &&
      (station.url_resolved || station.url) &&
      station.lastcheckok !== 0
  );
}`,
  'Radio Browser catalog failover'
);

replaceOnce(
`async function getRadioStation(id: string): Promise<RadioStation | undefined> {
  const uuid = id.startsWith(MASTER_RADIO_ID_PREFIX)
    ? id.slice(MASTER_RADIO_ID_PREFIX.length)
    : id;
  if (!uuid) return undefined;
  const response = await fetch(
    \`${'${RADIO_BROWSER_BASE}'}/json/stations/byuuid/${'${encodeURIComponent(uuid)}'}\`,
    {
      headers: { 'User-Agent': 'Master-Addon/2.0' },
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!response.ok) return undefined;
  const stations = (await response.json()) as RadioStation[];
  return Array.isArray(stations) ? stations[0] : undefined;
}`,
`async function getRadioStation(id: string): Promise<RadioStation | undefined> {
  const uuid = id.startsWith(MASTER_RADIO_ID_PREFIX)
    ? id.slice(MASTER_RADIO_ID_PREFIX.length)
    : id;
  if (!uuid) return undefined;
  try {
    const stations = await fetchRadioBrowserJson<RadioStation[]>(
      \`/json/stations/byuuid/${'${encodeURIComponent(uuid)}'}\`
    );
    return Array.isArray(stations) ? stations[0] : undefined;
  } catch {
    return undefined;
  }
}`,
  'Radio Browser station failover'
);

replaceOnce(
`  const baseResources = manifest.resources.map((resource) => {`,
`  const adultCatalog = baseCatalogs.find((catalog) => catalog.id === MASTER_ADULT_CATALOG_ID);
  const nonAdultBaseCatalogs = baseCatalogs.filter(
    (catalog) => catalog.id !== MASTER_ADULT_CATALOG_ID
  );
  const baseResources = manifest.resources.map((resource) => {`,
  'adult catalog ordering setup'
);

replaceOnce(
`    catalogs: [
      ...baseCatalogs,`,
`    catalogs: [
      ...nonAdultBaseCatalogs,`,
  'non-adult catalogs first'
);

replaceOnce(
`      {
        type: 'other',
        id: MASTER_RADIO_CATALOG_ID,
        name: 'Radio',
        extra: [
          { name: 'skip' },
          { name: 'search' },
          { name: 'genre', options: [...RADIO_GENRES], isRequired: false },
        ],
      },
    ],`,
`      {
        type: 'other',
        id: MASTER_RADIO_CATALOG_ID,
        name: 'Radio',
        extra: [
          { name: 'skip' },
          { name: 'search' },
          { name: 'genre', options: [...RADIO_GENRES], isRequired: false },
        ],
      },
      ...(adultCatalog ? [adultCatalog] : []),
    ],`,
  'Porn catalog last'
);

fs.writeFileSync(path, source);
console.log('Applied Master Live TV/source/radio/catalog-order patch with stable IDs.');
