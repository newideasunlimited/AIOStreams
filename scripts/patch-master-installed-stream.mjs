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
  "import { trackResource } from '../../middlewares/analytics.js';\nimport { getPriorityLiveTvStreams } from './master-native-resources.js';",
  'priority stream import'
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

fs.writeFileSync(path, source);
console.log('Applied installed Master stream priority patch.');
