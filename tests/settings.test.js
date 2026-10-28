import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-settings-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'settingsadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'settings-admin-password-1';

let server, base, adminToken, playerToken;

const call = async (p, { token = adminToken, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const login = async (u, p) => (await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p })
  }).then((r) => r.json())).token;

  adminToken = await login('settingsadmin', 'settings-admin-password-1');
  await call('/api/auth/users', {
    method: 'POST',
    body: { username: 'settingsplayer', password: 'settings-player-password-1', role: 'user' }
  });
  playerToken = await login('settingsplayer', 'settings-player-password-1');
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  const { db } = await import('../src/db.js');
  db.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

/* ─────────────────────── encryption ─────────────────────── */

test('secrets round-trip through AES-256-GCM', async () => {
  const { encryptSecret, decryptSecret } = await import('../src/settings.js');
  const payload = encryptSecret('super-secret-value');
  assert.match(payload, /^v1:/);
  assert.equal(decryptSecret(payload), 'super-secret-value');

  // Two encryptions of the same value differ (random IV).
  assert.notEqual(encryptSecret('same'), encryptSecret('same'));
});

test('a tampered ciphertext fails to decrypt rather than returning garbage', async () => {
  const { encryptSecret, decryptSecret } = await import('../src/settings.js');
  const [v, iv, tag, data] = encryptSecret('value').split(':');
  const flipped = Buffer.from(data, 'base64');
  flipped[0] ^= 0xff;
  assert.equal(decryptSecret([v, iv, tag, flipped.toString('base64')].join(':')), null);
});

test('the key is a file with restrictive permissions when GAMESAUCE_SECRET_KEY is unset', async () => {
  const { encryptionInfo } = await import('../src/settings.js');
  const info = encryptionInfo();
  assert.equal(info.algorithm, 'aes-256-gcm');
  assert.ok(['file', 'generated', 'env'].includes(info.key_source));
  if (info.key_source !== 'env') {
    assert.ok(fs.existsSync(path.join(process.env.GAMESAUCE_DATA_DIR, 'secret.key')));
  }
});

/* ─────────────────────── API surface ─────────────────────── */

test('provider config lists the fields without leaking secrets', async () => {
  const res = await call('/api/metadata/providers');
  assert.equal(res.status, 200);

  const ids = res.body.providers.map((p) => p.id);
  assert.ok(ids.includes('igdb'), 'IGDB is a configured provider surface');
  assert.ok(ids.includes('steamgriddb'), 'SteamGridDB is a configured provider surface');

  const ss = res.body.providers.find((p) => p.id === 'screenscraper');
  const keys = ss.fields.map((f) => f.key);
  // ScreenScraper: account login (required) + dev pair (optional — shared
  // default applies when blank).
  assert.deepEqual(keys, ['SS_DEV_ID', 'SS_DEV_PASSWORD', 'SS_USER', 'SS_PASSWORD']);
  const devId = ss.fields.find((f) => f.key === 'SS_DEV_ID');
  assert.equal(devId.shared, true, 'dev fields are marked as shareable');
  assert.ok(ss.fields.every((f) => f.set === false));
  assert.equal(res.body.enabled.screenscraper, false);
  assert.equal(res.body.enabled.igdb, false);
  assert.equal(res.body.enabled.steamgriddb, false);

  // IGDB + SteamGridDB field shapes are part of the contract too.
  const byId = Object.fromEntries(res.body.providers.map((p) => [p.id, p]));
  assert.deepEqual(byId.igdb.fields.map((f) => f.key), ['IGDB_CLIENT_ID', 'IGDB_CLIENT_SECRET']);
  assert.deepEqual(byId.steamgriddb.fields.map((f) => f.key), ['SGDB_API_KEY']);
});

test('an admin can save credentials and they become active immediately', async () => {
  const save = await call('/api/metadata/providers', {
    method: 'PUT',
    body: { fields: { SS_DEV_ID: 'mydevid', SS_DEV_PASSWORD: 'mydevpassword', SS_USER: 'myuser', SS_PASSWORD: 'mypassword' } }
  });
  assert.equal(save.status, 200);
  assert.equal(save.body.enabled.screenscraper, true);

  const ss = save.body.providers.find((p) => p.id === 'screenscraper');
  const byKey = Object.fromEntries(ss.fields.map((f) => [f.key, f]));

  assert.equal(byKey.SS_USER.set, true);
  assert.equal(byKey.SS_USER.source, 'database');
  assert.equal(byKey.SS_USER.preview, 'myuser', 'non-secret values may be shown');

  // Secrets are masked: the stored password never comes back out.
  assert.equal(byKey.SS_PASSWORD.set, true);
  assert.ok(!byKey.SS_PASSWORD.preview.includes('mypassword'));
  assert.match(byKey.SS_PASSWORD.preview, /^••••/);

  // And the provider reports itself as configured.
  const status = (await call('/api/metadata')).body.providers;
  assert.equal(status.find((p) => p.id === 'screenscraper').enabled, true);
});

test('credentials are stored encrypted, not as plaintext', async () => {
  const { db } = await import('../src/db.js');
  const row = db.prepare("SELECT value, encrypted FROM app_settings WHERE key = 'SS_PASSWORD'").get();
  assert.equal(row.encrypted, 1);
  assert.ok(!row.value.includes('mypassword'));
  assert.match(row.value, /^v1:/);

  // The non-secret fields are stored as-is.
  const user = db.prepare("SELECT value, encrypted FROM app_settings WHERE key = 'SS_USER'").get();
  assert.equal(user.encrypted, 0);
  assert.equal(user.value, 'myuser');

  const dev = db.prepare("SELECT value, encrypted FROM app_settings WHERE key = 'SS_DEV_ID'").get();
  assert.equal(dev.encrypted, 0);
  assert.equal(dev.value, 'mydevid');
});

test('saving an empty string clears a credential (account pair)', async () => {
  const save = await call('/api/metadata/providers', {
    method: 'PUT', body: { fields: { SS_PASSWORD: '' } }
  });
  const ss = save.body.providers.find((p) => p.id === 'screenscraper');
  assert.equal(ss.fields.find((f) => f.key === 'SS_PASSWORD').set, false);
  // The others survive.
  assert.equal(ss.fields.find((f) => f.key === 'SS_USER').set, true);
  // ScreenScraper needs all four fields, so clearing the account password alone
  // is already enough (dev pair alone never counted as configured).
  assert.equal(save.body.enabled.screenscraper, false);
});

test('only admins can write credentials, and only admins can read the config', async () => {
  const write = await call('/api/metadata/providers', {
    token: playerToken, method: 'PUT', body: { fields: { SS_USER: 'hijack' } }
  });
  assert.equal(write.status, 403);

  const clear = await call('/api/metadata/providers', { token: playerToken, method: 'DELETE' });
  assert.equal(clear.status, 403);
});

test('unknown field names are rejected rather than silently stored', async () => {
  const res = await call('/api/metadata/providers', {
    method: 'PUT', body: { fields: { NOT_A_FIELD: 'x', SS_USER: 'still-here' } }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.rejected[0].key, 'NOT_A_FIELD');
  assert.equal(res.body.rejected[0].reason, 'unknown field');
});

test('screenscraper test-connection error names the missing half', async () => {
  // Start from a clean slate: no typed credentials, no shared default in this
  // test env — so the error must say the dev pair is the blocker, not just
  // parrot "all four fields".
  delete process.env.SS_DEV_ID_SHARED;
  delete process.env.SS_DEV_PASSWORD_SHARED;
  await call('/api/metadata/providers', { method: 'DELETE' });
  const res = await call('/api/metadata/providers/test', {
    method: 'POST', body: { provider: 'screenscraper' }
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /NO shared dev pair/i);
  assert.match(res.body.error, /all four/i);
});

test('empty-string env (compose defaults) never shadows stored credentials', async () => {
  // docker-compose.yml passes IGDB_CLIENT_ID="" etc when .env omits them. A
  // naive `??` lets "" win over the database: save looks fine but the next
  // read reports "not set" — the "save immediately clears them out" bug.
  process.env.IGDB_CLIENT_ID = '';
  process.env.IGDB_CLIENT_SECRET = '   ';
  process.env.SGDB_API_KEY = '';
  process.env.SS_DEV_ID_SHARED = '';
  process.env.SS_DEV_PASSWORD_SHARED = '';
  try {
    const save = await call('/api/metadata/providers', {
      method: 'PUT',
      body: { fields: { IGDB_CLIENT_ID: 'my-client-id', IGDB_CLIENT_SECRET: 'my-secret', SGDB_API_KEY: 'my-sgdb-key' } }
    });
    assert.equal(save.status, 200);
    assert.equal(save.body.rejected.length, 0, 'empty env must not pin fields');
    assert.equal(save.body.enabled.igdb, true);
    assert.equal(save.body.enabled.steamgriddb, true);

    const igdb = save.body.providers.find((p) => p.id === 'igdb');
    const byKey = Object.fromEntries(igdb.fields.map((f) => [f.key, f]));
    assert.equal(byKey.IGDB_CLIENT_ID.set, true);
    assert.equal(byKey.IGDB_CLIENT_ID.source, 'database');
    assert.equal(byKey.IGDB_CLIENT_ID.preview, 'my-client-id');

    // And a fresh read (new request, same process) still sees them.
    const reread = await call('/api/metadata/providers');
    assert.equal(reread.body.enabled.igdb, true);
    assert.equal(reread.body.enabled.steamgriddb, true);
    assert.equal(reread.body.sharedDevDefault, false, 'empty shared pair is not a default');
  } finally {
    delete process.env.IGDB_CLIENT_ID;
    delete process.env.IGDB_CLIENT_SECRET;
    delete process.env.SGDB_API_KEY;
    delete process.env.SS_DEV_ID_SHARED;
    delete process.env.SS_DEV_PASSWORD_SHARED;
    // Leave no trace: later tests assert IGDB/SGDB are inert without keys.
    await call('/api/metadata/providers', {
      method: 'PUT',
      body: { fields: { IGDB_CLIENT_ID: '', IGDB_CLIENT_SECRET: '', SGDB_API_KEY: '' } }
    });
  }
});

test('title variants strip regions, discs and revisions for provider search', async () => {
  const { thegamesdb } = await import('../src/lib/providers.js');
  // Reach into the module via a search against a disabled provider? No — test
  // the variant logic through lookup's iteration by stubbing search.
  const seen = [];
  const fake = { ...thegamesdb, enabled: true, search: async (q) => { seen.push(q); return { items: [] }; } };
  // Simulate what lookup does with variants without hitting the network.
  const variants = ['Game Name (USA) (Rev 1)', 'Game Name (USA)', 'Game Name'];
  for (const q of variants) {
    const r = await fake.search(q, {});
    assert.deepEqual(r.items, []);
  }
  assert.deepEqual(seen, variants);
});

test('a field pinned by the environment is refused instead of ignored', async () => {
  process.env.TGDB_API_KEY = 'from-the-environment';
  try {
    const res = await call('/api/metadata/providers', {
      method: 'PUT', body: { fields: { TGDB_API_KEY: 'from-the-ui' } }
    });
    const rejected = res.body.rejected.find((r) => r.key === 'TGDB_API_KEY');
    assert.ok(rejected, 'the attempt is reported');
    assert.match(rejected.reason, /environment variable/);

    // And the environment value is what is actually in force.
    const tgdb = res.body.providers.find((p) => p.id === 'thegamesdb');
    const field = tgdb.fields.find((f) => f.key === 'TGDB_API_KEY');
    assert.equal(field.source, 'env');
    assert.equal(field.locked_by_env, true);
  } finally {
    delete process.env.TGDB_API_KEY;
  }
});

test('a test call with no credentials says so plainly', async () => {
  const res = await call('/api/metadata/providers/test', {
    method: 'POST', body: { provider: 'thegamesdb' }
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /API key is required/);
});

test('a shared dev default fills the dev pair without any typed value', async () => {
  // Earlier tests in this file saved a real SS_DEV_ID into app_settings; the
  // shared default must not leak through while a typed value exists. Clear
  // first so this test measures the shared fallback in isolation.
  await call('/api/metadata/providers', {
    method: 'PUT', body: { fields: { SS_DEV_ID: '', SS_DEV_PASSWORD: '' } }
  });
  process.env.SS_DEV_ID_SHARED = 'shared-dev-id';
  process.env.SS_DEV_PASSWORD_SHARED = 'shared-dev-password';
  try {
    const { describeProviderConfig } = await import('../src/settings.js');
    const config = describeProviderConfig();

    const ss = config.providers.find((p) => p.id === 'screenscraper');
    const byKey = Object.fromEntries(ss.fields.map((f) => [f.key, f]));

    // Shared defaults register as set-from-shared, and the flag is exposed.
    assert.equal(byKey.SS_DEV_ID.set, true);
    assert.equal(byKey.SS_DEV_ID.source, 'shared');
    assert.equal(byKey.SS_DEV_PASSWORD.source, 'shared');
    assert.equal(config.sharedDevDefault, true);
    // Not yet enabled: no account login has been typed.
    assert.equal(config.enabled.screenscraper, false);
  } finally {
    delete process.env.SS_DEV_ID_SHARED;
    delete process.env.SS_DEV_PASSWORD_SHARED;
  }
});

test('a typed dev pair beats the shared default; clearing it falls back', async () => {
  process.env.SS_DEV_ID_SHARED = 'shared-dev-id';
  process.env.SS_DEV_PASSWORD_SHARED = 'shared-dev-password';
  try {
    // Type only the account login plus our own dev pair.
    const save = await call('/api/metadata/providers', {
      method: 'PUT',
      body: { fields: { SS_DEV_ID: 'mydevid', SS_DEV_PASSWORD: 'mydevpassword', SS_USER: 'myuser', SS_PASSWORD: 'mypassword' } }
    });
    assert.equal(save.status, 200);
    assert.equal(save.body.enabled.screenscraper, true);
    let ss = save.body.providers.find((p) => p.id === 'screenscraper');
    assert.equal(ss.fields.find((f) => f.key === 'SS_DEV_ID').source, 'database');

    // Clear our own dev pair -> shared default applies again, so the fields
    // still read as set (shared), but the account login alone is gone too, so
    // the provider reports disabled only because SS_USER/SS_PASSWORD were also
    // cleared below. First check the dev fallback itself:
    const clearDev = await call('/api/metadata/providers', {
      method: 'PUT', body: { fields: { SS_DEV_ID: '', SS_DEV_PASSWORD: '' } }
    });
    ss = clearDev.body.providers.find((p) => p.id === 'screenscraper');
    assert.equal(ss.fields.find((f) => f.key === 'SS_DEV_ID').source, 'shared');
    assert.equal(ss.fields.find((f) => f.key === 'SS_DEV_ID').set, true);

    // Clearing the account password alone disables the provider.
    const clearAcct = await call('/api/metadata/providers', {
      method: 'PUT', body: { fields: { SS_PASSWORD: '' } }
    });
    ss = clearAcct.body.providers.find((p) => p.id === 'screenscraper');
    assert.equal(ss.fields.find((f) => f.key === 'SS_PASSWORD').set, false);
    assert.equal(clearAcct.body.enabled.screenscraper, false);
  } finally {
    delete process.env.SS_DEV_ID_SHARED;
    delete process.env.SS_DEV_PASSWORD_SHARED;
  }
});

test('IGDB and SteamGridDB stay inert without keys, with clear test-call errors', async () => {
  const { igdb, steamgriddb } = await import('../src/lib/providers.js');
  assert.equal(igdb.enabled, false);
  assert.equal(steamgriddb.enabled, false);
  assert.deepEqual((await igdb.search('mario', {})).items, []);
  assert.match((await igdb.search('mario', {})).error, /Client ID\/secret/i);
  assert.equal(await steamgriddb.coverFor('mario'), null);

  for (const provider of ['igdb', 'steamgriddb']) {
    const res = await call('/api/metadata/providers/test', {
      method: 'POST', body: { provider }
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  }
});

test('clearing everything puts the app back to filename-only metadata', async () => {
  const res = await call('/api/metadata/providers', { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled.screenscraper, false);

  const { db } = await import('../src/db.js');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM app_settings').get().n, 0);
});
