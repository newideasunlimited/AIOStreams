import assert from 'node:assert/strict';

// AIOStreams runtime settings are intentionally unavailable until the config
// store has initialised. Mirror the real server startup order here so QA tests
// the product instead of tripping the module-load guard.
const { initialiseConfig } = await import(
  '../packages/core/dist/config/index.js'
);
await initialiseConfig();

const { MasterNativePreset } = await import(
  '../packages/core/dist/presets/masterNative.js'
);

const fakeUserData = {
  services: [
    {
      id: 'realdebrid',
      enabled: true,
      credentials: { apiKey: 'qa-real-debrid-token' },
    },
  ],
  checkOwned: true,
  cacheAndPlay: 'cached',
  autoRemoveDownloads: false,
};

const addons = await MasterNativePreset.generateAddons(fakeUserData, {
  name: 'Master QA',
  timeout: 7000,
});
assert.equal(addons.length, 1, 'Master Native should generate exactly one addon');

const url = new URL(addons[0].manifestUrl);
const parts = url.pathname.split('/').filter(Boolean);
const encodedConfig = parts.at(-2);
assert.ok(encodedConfig, 'Master Native manifest URL should contain an encoded config');

const decodedConfig = JSON.parse(
  Buffer.from(encodedConfig, 'base64url').toString('utf8')
);
assert.equal(decodedConfig.services?.length, 1, 'Real-Debrid should be injected into Master Native config');
assert.equal(decodedConfig.services?.[0]?.id, 'realdebrid');
assert.equal(
  decodedConfig.services?.[0]?.credential,
  'qa-real-debrid-token',
  'Real-Debrid credential should survive preset generation'
);
assert.equal(decodedConfig.checkOwned, true);

const noDebrid = await MasterNativePreset.generateAddons(
  {
    services: [],
    checkOwned: true,
    autoRemoveDownloads: false,
  },
  { name: 'Master QA No Debrid', timeout: 7000 }
);
assert.equal(
  noDebrid.length,
  1,
  'Master Native must remain available without debrid so Porn/Live TV/Radio cannot disappear'
);

console.log('Master preset QA passed: config injection and no-debrid manifest generation are intact.');
