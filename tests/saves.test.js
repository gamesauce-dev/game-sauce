import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-saves-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'savadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'sav-admin-password-1';
process.env.GAMESAUCE_MAX_STATES = '3';

let server, base, adminTok, userTok, romId;
const call = async (p, { method = 'GET', body, tok = adminTok, raw } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : {}), Authorization: `Bearer ${tok}` },
    body: raw || (body ? JSON.stringify(body) : undefined)
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const login = async (u, p) => (await (await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p })
})).json()).token;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('savadmin', 'sav-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'bob', password: 'bob-password-12345', role: 'user' } });
  userTok = await login('bob', 'bob-password-12345');
  const db = (await import('../src/db.js')).default;
  const plat = db.prepare('SELECT id FROM platforms LIMIT 1').get().id;
  romId = db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1) VALUES ('T','t','t.nes',?,'x',1,'abc')").run(plat).lastInsertRowid;
});
after(() => { server?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('saves are per-user, capped, and battery is single-slot', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await call(`/api/roms/${romId}/saves?kind=state&core=nes`, { method: 'POST', raw: Buffer.from('state' + i) });
    assert.equal(r.status, 201);
  }
  let list = (await call(`/api/roms/${romId}/saves`)).body.items;
  assert.equal(list.length, 3, 'capped at MAX_STATES');

  await call(`/api/roms/${romId}/saves?kind=battery`, { method: 'POST', raw: Buffer.from('b1') });
  await call(`/api/roms/${romId}/saves?kind=battery`, { method: 'POST', raw: Buffer.from('b2') });
  list = (await call(`/api/roms/${romId}/saves`)).body.items;
  assert.equal(list.filter((s) => s.kind === 'battery').length, 1);

  // other user sees nothing and cannot fetch/delete admin's rows
  assert.deepEqual((await call(`/api/roms/${romId}/saves`, { tok: userTok })).body.items, []);
  const sid = list[0].id;
  assert.equal((await call(`/api/roms/${romId}/saves/${sid}/file`, { tok: userTok })).status, 404);
  assert.equal((await call(`/api/roms/${romId}/saves/${sid}`, { method: 'DELETE', tok: userTok })).body.removed, 0);
  const file = await call(`/api/roms/${romId}/saves/${sid}/file`);
  assert.equal(file.status, 200);

  assert.equal((await call(`/api/roms/${romId}/saves/${sid}`, { method: 'DELETE' })).body.removed, 1);
});

test('clear-covers: admin only, dry-run first, touches only that platform', async () => {
  const db = (await import('../src/db.js')).default;
  const mame = db.prepare("SELECT id FROM platforms WHERE slug = 'mame'").get().id;
  const nes = db.prepare("SELECT id FROM platforms WHERE slug = 'nes'").get().id;
  const ins = (plat, sha) => db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, cover_url) VALUES ('x','x','x.zip',?,'p',1,?, 'http://c/x.jpg')").run(plat, sha).lastInsertRowid;
  const a = ins(mame, 'cc1'), b = ins(nes, 'cc2');
  assert.equal((await call('/api/roms/clear-covers', { method: 'POST', body: { platform: 'mame' }, tok: userTok })).status, 403);
  assert.equal((await call('/api/roms/clear-covers', { method: 'POST', body: { platform: 'mame' } })).body.would_clear, 1);
  assert.equal((await call('/api/roms/clear-covers', { method: 'POST', body: { platform: 'mame', dry_run: false } })).body.cleared, 1);
  assert.equal(db.prepare('SELECT cover_url FROM roms WHERE id = ?').get(a).cover_url, null);
  assert.equal(db.prepare('SELECT cover_url FROM roms WHERE id = ?').get(b).cover_url, 'http://c/x.jpg');
});

test('MAME browser-play cutoff: old/unknown year playable, newer not; other platforms unaffected', async () => {
  const { playableCore, MAME_PLAY_MAX_YEAR } = await import('../src/routes/roms.js');
  assert.equal(MAME_PLAY_MAX_YEAR, 1990);
  assert.equal(playableCore('mame', 1982), 'mame');
  assert.equal(playableCore('mame', 1990), 'mame');
  assert.equal(playableCore('mame', 1991), null);
  assert.equal(playableCore('mame', 2008), null);
  assert.equal(playableCore('mame', null), 'mame', 'unknown year stays allowed');
  assert.equal(playableCore('nes', 2008), 'nes', 'cutoff is MAME-only');
  assert.equal(playableCore('ps1', 1998), null);
});

test('per-game play override: wins over year cutoff, only where a core exists', async () => {
  const { playableCore } = await import('../src/routes/roms.js');
  assert.equal(playableCore('mame', 2008, 1), 'mame', 'forced on beats the cutoff');
  assert.equal(playableCore('mame', 1982, 0), null, 'forced off beats the default');
  assert.equal(playableCore('mame', 2008, null), null);
  assert.equal(playableCore('ps1', 1998, 1), null, 'no core, no play');

  const db = (await import('../src/db.js')).default;
  const mame = db.prepare("SELECT id FROM platforms WHERE slug = 'mame'").get().id;
  const ps1 = db.prepare("SELECT id FROM platforms WHERE slug = 'ps1'").get().id;
  const ins = (plat, sha, year) => db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, release_year) VALUES ('p','p','p.zip',?,'x',1,?,?)").run(plat, sha, year).lastInsertRowid;
  const a = ins(mame, 'po1', 2008), b = ins(ps1, 'po2', 1998);

  let d = (await call(`/api/roms/${a}`)).body;
  assert.equal(d.playable, null); assert.equal(d.play_capable, true); assert.equal(d.play_default, false);
  assert.equal((await call(`/api/roms/${a}/play-override`, { method: 'POST', body: { value: true } })).status, 200);
  d = (await call(`/api/roms/${a}`)).body;
  assert.equal(d.playable, 'mame'); assert.equal(d.play_override, 1);
  assert.equal((await call(`/api/roms/${a}/play-override`, { method: 'POST', body: { value: null } })).status, 200);
  assert.equal((await call(`/api/roms/${a}`)).body.playable, null);

  assert.equal((await call(`/api/roms/${b}/play-override`, { method: 'POST', body: { value: true } })).status, 400);
  assert.equal((await call(`/api/roms/${b}`)).body.play_capable, false);
  assert.equal((await call(`/api/roms/${a}/play-override`, { method: 'POST', body: { value: 'x' } })).status, 400);
});
