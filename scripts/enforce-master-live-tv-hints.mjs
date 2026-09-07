import fs from 'node:fs';

const files = [
  'packages/server/src/routes/stremio/stream.ts',
  'packages/server/src/routes/builtins/master-native.ts',
];

for (const path of files) {
  let source = fs.readFileSync(path, 'utf8');

  // Live TV is HLS/live transport, not a plain MP4. Stremio's stream spec says
  // these URLs must be marked notWebReady=true so the client does not attempt
  // the raw HTML media-element/direct-src playback path on TV platforms.
  source = source.replace(
    /(name:\s*`Master[^\n]*?(?:Direct|Compatible Stream|TV Compatible|HLS Proxy|Relay Fallback)[^\n]*`[\s\S]{0,260}?notWebReady:\s*)false/g,
    '$1true'
  );

  fs.writeFileSync(path, source);
}

const installed = fs.readFileSync(files[0], 'utf8');
const liveBlock = installed.match(/if \(id\.startsWith\('ustv-'\)\)[\s\S]*?if \(id\.startsWith\(MASTER_RADIO_ID_PREFIX\)\)/)?.[0] ?? '';
if (!liveBlock || /notWebReady:\s*false/.test(liveBlock)) {
  throw new Error('Live TV transport hint enforcement failed: installed stream route still contains notWebReady=false');
}

console.log('Enforced Stremio notWebReady=true for all Master Live TV transports.');
