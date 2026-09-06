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

fs.writeFileSync(path, source);
console.log('Applied Master Live TV source/proxy patch.');
