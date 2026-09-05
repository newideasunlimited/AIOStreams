import assert from 'node:assert/strict';

// Mirror the real server startup order: database first, then runtime config,
// then presets. The settings store reads from the database during initialisation.
const { initDb, closeDb } = await import('../packages/core/dist/db/index.js');
await initDb(process.env.DATABASE_URI || 'sqlite:///tmp/master-qa.sqlite');

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

await closeDb();
console.log('Master preset QA passed: config injection and no-debrid manifest generation are intact.');
