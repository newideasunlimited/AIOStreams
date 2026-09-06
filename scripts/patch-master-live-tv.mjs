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

  const endpoint = mode === 'compatibility' ? '/proxy/stream' : '/proxy/hls/manifest.m3u8';
  const url = new URL(endpoint, \`${'${base}'}/\`);
  url.searchParams.set('d', destination);
  const password = process.env.MEDIAFLOW_API_PASSWORD;
  if (password) url.searchParams.set('api_password', password);
  url.searchParams.set('h_user-agent', DIRECT_USER_AGENT);
  if (mode === 'compatibility') {
    url.searchParams.set('transcode', 'true');
  } else {
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
`function liveTvPosterUrl(id: string): string | undefined {
  const base = publicBaseUrl();
  return base
    ? \`${'${base}'}/builtins/master-native/live-tv-poster/${'${encodeURIComponent(id)}'}.svg\`
    : undefined;
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
  'Live TV poster fallback'
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

replaceOnce(
`router.get('/poster/:id.svg', (req: Request, res: Response) => {`,
`router.get('/live-tv-poster/:id.svg', (req: Request, res: Response) => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = decodeURIComponent(rawId || '');
  void findLiveTvItem(id).then((item) => {
    const title = (item?.name || 'Live TV').slice(0, 60);
    const escaped = title
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
    res.type('image/svg+xml').send(\`
      <svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
        <rect width="600" height="900" fill="#111827"/>
        <rect x="36" y="36" width="528" height="828" rx="28" fill="#1f2937"/>
        <text x="300" y="300" text-anchor="middle" font-family="sans-serif" font-size="62" font-weight="700" fill="#ffffff">LIVE</text>
        <text x="300" y="385" text-anchor="middle" font-family="sans-serif" font-size="62" font-weight="700" fill="#ffffff">TV</text>
        <text x="300" y="560" text-anchor="middle" font-family="sans-serif" font-size="27" fill="#d1d5db">${'${escaped}'}</text>
      </svg>
    \`);
  }).catch(() => res.status(404).end());
});

router.get('/poster/:id.svg', (req: Request, res: Response) => {`,
  'Live TV poster route'
);

fs.writeFileSync(path, source);
console.log('Applied Master Live TV source/proxy/catalog-order patch with stable IDs.');
