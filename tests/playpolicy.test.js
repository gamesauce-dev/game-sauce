import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-playpolicy-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'qadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'q-admin-password-1';

let server, base, db, adminTok, memberTok, ids = {};
const call = async (p, { token = adminTok, method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (u, p) => (await call('/api/auth/login', { token: null, method: 'POST', body: { username: u, password: p } })).body.token;
const titles = async (q, tok = adminTok) => (await call(`/api/roms?limit=100&${q}`, { token: tok })).body.items.map((i) => i.title).sort();

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('qadmin', 'q-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'qmember', password: 'q-member-pass-12', role: 'user' } });
  memberTok = await login('qmember', 'q-member-pass-12');
  // CPS1/2/3 and Cave are platforms a household adds itself (the built-in list has no such entries).
  for (const [slug, name] of [['cps1', 'Capcom Play System 1'], ['cps2', 'Capcom Play System 2'], ['cps3', 'Capcom Play System 3'], ['cave', 'Cave']]) {
    await call('/api/platforms', { method: 'POST', body: { slug, name, short_name: slug.toUpperCase(), family: 'Arcade', extensions: 'zip' } });
  }
  const file = path.join(TMP, 'x.rom'); fs.writeFileSync(file, 'rom');
  const ins = (slug, title, sha, year = null) => Number(db.prepare(`INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1, release_year)
    VALUES ((SELECT id FROM platforms WHERE slug = ?), ?, ?, ?, ?, 3, ?, ?)`).run(slug, title, title.toLowerCase(), `${title}.zip`, file, sha, year).lastInsertRowid);
  ids.nes = ins('nes', 'Nes Game', 'pp01'); ids.cps2 = ins('cps2', 'Cps2 Game', 'pp02', 1996); ids.cps1 = ins('cps1', 'Cps1 Game', 'pp03', 1990);
  ids.cps3 = ins('cps3', 'Cps3 Game', 'pp04', 1997); ids.cave = ins('cave', 'Cave Game', 'pp05', 1999);
  ids.mameOld = ins('mame', 'Old Mame', 'pp06', 1982); ids.mameNew = ins('mame', 'New Mame', 'pp07', 2002);
  ids.fba = ins('fba', 'Fba Game', 'pp08', 1994); ids.ps2 = ins('ps2', 'Ps2 Game', 'pp09', 2001);
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('CPS1 and CPS2 now play; CPS3 and Cave have a core but are not offered until switched on', async () => {
  assert.deepEqual(await titles('playable=1'), ['Cps1 Game', 'Cps2 Game', 'Fba Game', 'Nes Game', 'Old Mame']);
  assert.equal((await call(`/api/roms/${ids.cps3}`)).body.playable, null);
  await call(`/api/roms/${ids.cps3}/play-override`, { method: 'POST', body: { value: true } });
  assert.equal((await call(`/api/roms/${ids.cps3}`)).body.playable, 'arcade', 'switched on: offered');
  assert.ok((await titles('playable=1')).includes('Cps3 Game'));
});

test('candidates: an admin sees every game on a platform with a core, members get the normal list', async () => {
  await call(`/api/roms/${ids.cps3}/play-override`, { method: 'POST', body: { value: null } });
  const c = await titles('playable=candidates');
  assert.deepEqual(c, ['Cave Game', 'Cps1 Game', 'Cps2 Game', 'Cps3 Game', 'Fba Game', 'Nes Game', 'New Mame', 'Old Mame'], 'includes new MAME, CPS3 and Cave; not PS2 (no core)');
  assert.deepEqual(await titles('playable=candidates', memberTok), ['Cps1 Game', 'Cps2 Game', 'Fba Game', 'Nes Game', 'Old Mame'], 'a member cannot widen the list');
  const row = (await call('/api/roms?playable=candidates&limit=100')).body.items.find((i) => i.title === 'Cave Game');
  assert.equal(row.candidate_core, 'arcade');
  assert.equal(row.playable, null, 'still not offered');
});

test('the check tool may stream a game the app does not offer yet; nobody else can', async () => {
  const quiet = { 'x-gamesauce-check': '1' };
  assert.equal((await call(`/api/roms/${ids.cave}/play/x.zip`)).status, 400, 'a normal play request is refused');
  assert.equal((await call(`/api/roms/${ids.cave}/play/x.zip`, { headers: quiet })).status, 200, 'the admin check header lets it through');
  assert.equal((await call(`/api/roms/${ids.cave}/play/x.zip`, { token: memberTok, headers: quiet })).status, 400, 'a member sending the header gets nothing extra');
  const before = db.prepare("SELECT COUNT(*) n FROM downloads WHERE kind = 'play'").get().n;
  await call(`/api/roms/${ids.cave}/play/x.zip`, { headers: quiet });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM downloads WHERE kind = 'play'").get().n, before, 'test plays are not counted');
});

test('verified-only mode: arcade games vanish until switched on, other platforms are untouched', async () => {
  assert.equal((await call('/api/auth/policy', { token: memberTok, method: 'PUT', body: { arcade_verified_only: true } })).status, 403, 'admin only');
  assert.equal((await call('/api/auth/policy', { method: 'PUT', body: { arcade_verified_only: true } })).body.arcade_verified_only, true);
  assert.deepEqual(await titles('playable=1'), ['Nes Game'], 'only the non-arcade game is left');
  assert.equal((await call(`/api/roms/${ids.cps2}`)).body.playable, null);
  assert.equal((await call(`/api/roms/${ids.cps2}/play/x.zip`, { token: memberTok })).status, 400, 'and it cannot be streamed normally');
  // the check tool still sees them as candidates, and switching one on brings it back
  assert.ok((await titles('playable=candidates')).includes('Cps2 Game'));
  await call(`/api/roms/${ids.cps2}/play-override`, { method: 'POST', body: { value: true } });
  await call(`/api/roms/${ids.mameNew}/play-override`, { method: 'POST', body: { value: true } });
  assert.deepEqual(await titles('playable=1'), ['Cps2 Game', 'Nes Game', 'New Mame'], 'verified games come back, even a new MAME one');
  assert.equal((await call(`/api/roms/${ids.cps2}/play/x.zip`, { token: memberTok })).status, 200);
  assert.equal((await call('/api/auth/policy', { method: 'PUT', body: { arcade_verified_only: false } })).body.arcade_verified_only, false);
  assert.ok((await titles('playable=1')).includes('Cps1 Game'), 'off again: the standard rules');
});

test('policy input is validated', async () => {
  assert.equal((await call('/api/auth/policy', { method: 'PUT', body: { arcade_verified_only: 'yes' } })).status, 400);
  assert.equal((await call('/api/auth/policy', { method: 'PUT', body: {} })).status, 400);
  assert.equal((await call('/api/auth/policy', { method: 'PUT', body: { members_can_download: true } })).status, 200, 'the old switch still works alone');
});
