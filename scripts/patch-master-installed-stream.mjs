import fs from 'node:fs';

const path = 'packages/server/src/routes/stremio/stream.ts';
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Installed stream patch failed: ${label} target not found`);
  }
  source = source.replace(before, after);
}

replaceOnce(
  "import { trackResource } from '../../middlewares/analytics.js';",
  "import { trackResource } from '../../middlewares/analytics.js';\nimport { fetchRadioBrowserJson } from '../../utils/radio-browser.js';\nimport { getPriorityLiveTvStreams } from './master-native-resources.js';",
  'Master helper imports'
);

replaceOnce(
`async function getLiveTvStreams(id: string): Promise<LiveTvStream[]> {
  const item = (await getLiveTvItems()).find((candidate) => candidate.id === id);
  let streams: LiveTvStream[] = [];`,
`async function getLiveTvStreams(id: string): Promise<LiveTvStream[]> {
  const priority = getPriorityLiveTvStreams(id);
  if (priority && priority.length > 0) {
    return priority
      .filter((stream) => Boolean(stream.url))
      .sort((a, b) => tvStreamScore(b) - tvStreamScore(a))
      .slice(0, 12);
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
  'Radio Browser discovery/failover'
);

fs.writeFileSync(path, source);
console.log('Applied installed Master stream priority/radio failover patch.');
