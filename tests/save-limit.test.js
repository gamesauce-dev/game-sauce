// Each account has a set amount of room for browser-play saves. Full means new saves are refused (nothing is thrown away to make room),
// and each person can see all of their own saves in one place and delete them.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-savelimit-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'sladmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'sl-admin-password-1';
process.env.GAMESAUCE_MAX_STATES = '3';

const KB = 1024, MB = 1024 * KB;
let server, base, db, tok = {}, ids = {}, games = [];
const call = async (p, { method = 'GET', body, as = 'admin', raw } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: `Bearer ${tok[as]}`, ...(raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* bytes */ }
  return { status: res.status, body: json };
};
const save = (as, rom, kb, kind = 'state') => call(`/api/roms/${rom}/saves?kind=${kind}`, { as, method: 'POST', raw: Buffer.alloc(kb * KB, 1) });
const mine = async (as) => (await call('/api/saves', { as })).body;
const setLimit = (mb) => call('/api/auth/policy', { method: 'PUT', body: { save_quota_mb: mb } });
const filesOf = (uid) => { const d = path.join(TMP, 'storage', 'saves', String(uid)); return fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).filter((f) => /\.(state|sav|png)$/.test(String(f))).length : 0; };

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok.admin = await login('sladmin', 'sl-admin-password-1');
  for (const u of ['slann', 'slben']) {
    await call('/api/auth/users', { method: 'POST', body: { username: u, password: `${u}-password-12`, role: 'user' } });
    tok[u] = await login(u, `${u}-password-12`);
  }
  for (const u of ['sladmin', 'slann', 'slben']) ids[u] = db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
  const plat = db.prepare("SELECT id FROM platforms WHERE slug = 'nes'").get().id;
  for (const t of ['First', 'Second']) games.push(Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1) VALUES (?, ?, ?, ?, ?, 1, ?)").run(t, t, `${t}.nes`, plat, `x-${t}`, `sha-${t}`).lastInsertRowid));
});
beforeEach(async () => {
  for (const u of ['sladmin', 'slann', 'slben']) for (const s of (await mine(u === 'sladmin' ? 'admin' : u)).items) await call(`/api/saves/${s.id}`, { as: u === 'sladmin' ? 'admin' : u, method: 'DELETE' });
  db.prepare('UPDATE roms SET hidden_all = 0').run();
  db.prepare('UPDATE users SET play_only = 0').run();
  await setLimit(1024);
});
after(async () => { server?.closeAllConnections(); await new Promise((r) => server?.close(r)); db?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ } });

test('each account has 1 GB unless the admin says otherwise, and only the admin can say', async () => {
  const db2 = db.prepare("DELETE FROM app_settings WHERE key = 'saves.quota_mb'"); db2.run();
  const { saveQuotaReset } = await import('../src/lib/policy.js'); saveQuotaReset();
  assert.deepEqual(await mine('slann'), { used: 0, limit: 1024 * MB, items: [] });
  assert.equal((await call('/api/auth/policy', { as: 'slann', method: 'PUT', body: { save_quota_mb: 5000 } })).status, 403);
  for (const bad of [0, -1, 1.5, '20', 2_000_000, null]) assert.equal((await setLimit(bad)).status, 400, String(bad));
  assert.equal((await setLimit(2048)).body.save_quota_mb, 2048);
  assert.equal((await mine('slann')).limit, 2048 * MB);
});

test('when it is full a new save is refused, nothing is thrown away, and other accounts are not affected', async () => {
  await setLimit(1);
  assert.equal((await save('slann', games[0], 600)).status, 201);
  const r = await save('slann', games[1], 600);
  assert.equal(r.status, 413);
  assert.equal(r.body.code, 'save_space_full');
  assert.match(r.body.error, /save space is full/i); assert.match(r.body.error, /1 MB/); assert.match(r.body.error, /My saves/);
  assert.equal(filesOf(ids.slann), 1, 'no file is left behind by the refused one');
  const out = await mine('slann');
  assert.equal(out.used, 600 * KB); assert.equal(out.items.length, 1);
  assert.equal((await save('slben', games[1], 600)).status, 201);
  await call(`/api/saves/${out.items[0].id}`, { as: 'slann', method: 'DELETE' });
  assert.equal((await save('slann', games[1], 600)).status, 201, 'deleting makes room');
});

test('an in-game save that is no bigger than the one it replaces is always taken, even over the limit', async () => {
  assert.equal((await save('slann', games[0], 900, 'battery')).status, 201);
  assert.equal((await save('slann', games[1], 900)).status, 201);
  await setLimit(1);   // lowered under what is already there: nothing is removed
  assert.equal((await mine('slann')).items.length, 2);
  assert.equal((await save('slann', games[0], 900, 'battery')).status, 201);
  assert.equal((await save('slann', games[0], 800, 'battery')).status, 201);
  assert.equal((await save('slann', games[0], 850, 'battery')).status, 413);
  const battery = (await mine('slann')).items.find((s) => s.kind === 'battery');
  assert.equal(battery.total_bytes, 800 * KB, 'the one that was there is kept');
});

test('at the ten-per-game kind of cap, the room the oldest state gives back counts', async () => {
  await setLimit(1);
  for (let i = 0; i < 3; i++) assert.equal((await save('slann', games[0], 300)).status, 201);
  assert.equal((await save('slann', games[0], 300)).status, 201, 'the fourth replaces the oldest, so it takes no more room');
  assert.equal((await save('slann', games[0], 500)).status, 413);
  assert.equal((await mine('slann')).items.length, 3, 'and the refused one took nothing with it');
});

test('screenshots count too', async () => {
  await setLimit(1);
  const id = (await save('slann', games[0], 900)).body.id;
  const shot = (kb) => call(`/api/roms/${games[0]}/saves/${id}/screenshot`, { as: 'slann', method: 'PUT', raw: Buffer.alloc(kb * KB, 2) });
  assert.equal((await shot(200)).status, 413);
  assert.equal((await shot(100)).status, 200);
  assert.equal((await mine('slann')).used, 1000 * KB);
  assert.equal((await mine('slann')).items[0].total_bytes, 1000 * KB);
});

test('My saves lists only your own, and lets you delete one for a game you can no longer open, without naming it', async () => {
  await save('slann', games[0], 10); await save('slann', games[1], 20); await save('slben', games[0], 5);
  db.prepare('UPDATE roms SET hidden_all = 1 WHERE id = ?').run(games[1]);
  const out = await mine('slann');
  assert.equal(out.items.length, 2); assert.equal(out.used, 30 * KB);
  const open = out.items.find((s) => s.rom_id === games[0]), shut = out.items.find((s) => s.rom_id === null);
  assert.equal(open.title, 'First'); assert.ok(open.platform);
  assert.equal(shut.title, null); assert.equal(shut.platform, null);
  assert.ok(!JSON.stringify(out).includes('Second'));
  const others = (await mine('slben')).items[0].id;
  assert.equal((await call(`/api/saves/${others}`, { as: 'slann', method: 'DELETE' })).status, 404, 'not somebody else\'s');
  assert.equal((await call(`/api/saves/${others}`, { as: 'admin', method: 'DELETE' })).status, 404, 'not even for the admin');
  assert.equal((await call(`/api/saves/${shut.id}`, { as: 'slann', method: 'DELETE' })).status, 200);
  assert.equal((await mine('slann')).items.length, 1);
  assert.equal(filesOf(ids.slann), 1, 'the file went with it');
  for (const odd of ['abc', '1.0', '0']) assert.equal((await call(`/api/saves/${odd}`, { as: 'slann', method: 'DELETE' })).status, 404, odd);
});

test('a play-only account can see and delete its saves too', async () => {
  await save('slann', games[0], 10);
  db.prepare('UPDATE users SET play_only = 1 WHERE id = ?').run(ids.slann);
  const out = await call('/api/saves', { as: 'slann' });
  assert.equal(out.status, 200);
  assert.equal((await call(`/api/saves/${out.body.items[0].id}`, { as: 'slann', method: 'DELETE' })).status, 200);
});

test('the pages say so: My saves in Settings, the admin\'s limit, and the player gives the reason', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.match(read('public/index.html'), /id="mod-saves"/);
  assert.match(read('public/index.html'), /id="policy-save-quota"/);
  assert.match(read('public/app.js'), /\{ id: 'saves', label: 'My saves'/);
  assert.match(read('public/ejs-player.html'), /save_space_full/);
});
