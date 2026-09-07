import fs from 'node:fs';

const path = 'packages/server/src/routes/stremio/stream.ts';
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(before, after, label) {
  if (!source.includes(before)) throw new Error(`Installed stream patch failed: ${label} target not found`);
  source = source.replace(before, after);
}

replaceOnce(
  "import { trackResource } from '../../middlewares/analytics.js';",
  "import { trackResource } from '../../middlewares/analytics.js';\nimport { fetchRadioBrowserJson } from '../../utils/radio-browser.js';\nimport { getPriorityLiveTvStreams } from './master-native-resources.js';",
  'Master helper imports'
);

replaceOnce(
`function mediaRelayUrl(req: Request, url: string, referer?: string): string {
  return \`${'${mediaRelayBase(req)}'}/${'${encodeMediaPayload({ u: url, ...(referer ? { r: referer } : {}) })}'}\`;
}`,
`function mediaRelayUrl(req: Request, url: string, referer?: string): string {
  return \`${'${mediaRelayBase(req)}'}/${'${encodeMediaPayload({ u: url, ...(referer ? { r: referer } : {}) })}'}\`;
}

function publicMediaflowBaseUrl(): string | undefined {
  const explicit = process.env.MEDIAFLOW_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\\/$/, '');
  const configured = appConfig.bootstrap.baseUrl;
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    url.port = process.env.MEDIAFLOW_PUBLIC_PORT || '8888';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\\/$/, '');
  } catch {
    return undefined;
  }
}

function mediaflowLiveTvUrl(destination: string, mode: 'transcoded-stream' | 'hls'): string | undefined {
  const base = publicMediaflowBaseUrl();
  if (!base) return undefined;
  const endpoint = mode === 'transcoded-stream' ? '/proxy/stream' : '/proxy/hls/manifest.m3u8';
  const url = new URL(endpoint, \`${'${base}'}/\`);
  url.searchParams.set('d', destination);
  const password = process.env.MEDIAFLOW_API_PASSWORD;
  if (password) url.searchParams.set('api_password', password);
  url.searchParams.set('h_user-agent', DIRECT_USER_AGENT);
  if (mode === 'transcoded-stream') url.searchParams.set('transcode', 'true');
  if (mode === 'hls') {
    url.searchParams.set('force_playlist_proxy', 'true');
    url.searchParams.set('start_offset', '-18');
  }
  return url.toString();
}`,
  'MediaFlow installed playback helpers'
);

replaceOnce(
`async function getLiveTvStreams(id: string): Promise<LiveTvStream[]> {
  const item = (await getLiveTvItems()).find((candidate) => candidate.id === id);
  let streams: LiveTvStream[] = [];`,
`async function getLiveTvStreams(id: string): Promise<LiveTvStream[]> {
  const priority = getPriorityLiveTvStreams(id);
  if (priority && priority.length > 0) {
    return priority.filter((stream) => Boolean(stream.url)).sort((a, b) => tvStreamScore(b) - tvStreamScore(a)).slice(0, 12);
  }
  const item = (await getLiveTvItems()).find((candidate) => candidate.id === id);
  let streams: LiveTvStream[] = [];`,
  'priority live stream lookup'
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
  const uuid = id.startsWith(MASTER_RADIO_ID_PREFIX) ? id.slice(MASTER_RADIO_ID_PREFIX.length) : id;
  if (!uuid) return undefined;
  try {
    const stations = await fetchRadioBrowserJson<RadioStation[]>(\`/json/stations/byuuid/${'${encodeURIComponent(uuid)}'}\`);
    return Array.isArray(stations) ? stations[0] : undefined;
  } catch {
    return undefined;
  }
}`,
  'Radio Browser discovery/failover'
);

replaceOnce(
`    if (id.startsWith('ustv-')) {
      try {
        const candidates = await getLiveTvStreams(id);
        const streams = candidates.map((stream, index) => {
          const label = friendlyLiveTvLabel(stream, index);
          return {
            name: \`Master • ${'${label}'}\`,
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
    }`,
`    if (id.startsWith('ustv-')) {
      try {
        const candidates = await getLiveTvStreams(id);
        const streams = candidates.flatMap((stream, index) => {
          if (!stream.url) return [];
          const label = friendlyLiveTvLabel(stream, index);
          const transcodedStream = mediaflowLiveTvUrl(stream.url, 'transcoded-stream');
          const hlsProxy = mediaflowLiveTvUrl(stream.url, 'hls');
          return [
            transcodedStream ? { name: \`Master • ${'${label}'} • Compatible Stream\`, title: label, url: transcodedStream, behaviorHints: { notWebReady: false } } : undefined,
            hlsProxy ? { name: \`Master • ${'${label}'} • HLS Proxy\`, title: label, url: hlsProxy, behaviorHints: { notWebReady: false } } : undefined,
            { name: \`Master • ${'${label}'} • Relay Fallback\`, title: label, url: mediaRelayUrl(req, stream.url), behaviorHints: { notWebReady: false } },
          ].filter(Boolean);
        });
        res.status(200).json({ streams } as any);
        return;
      } catch (error) {
        logger.error('Master Live TV stream resolution failed', error);
        res.status(200).json({ streams: [] } as any);
        return;
      }
    }`,
  'installed Live TV MediaFlow playback'
);

fs.writeFileSync(path, source);
console.log('Applied installed Master stream priority/radio/live-MediaFlow patch.');
