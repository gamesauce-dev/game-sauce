import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-pl-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'pladmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'pl-admin-password-1';

let server, base, adminTok, bobTok, db, ids = {};
const get = async (p, tok) => {
  const res = await fetch(base + p, { headers: { Authorization: `Bearer ${tok}` } });
  return { status: res.status, body: await res.json().catch(() => null), res };
};
const login = async (u, p) => (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('pladmin', 'pl-admin-password-1');
  await fetch(`${base}/api/auth/users`, { method: 'POST', headers: { Authorization: `Bearer ${adminTok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'plbob', password: 'bob-password-12345', role: 'user' }) });
  bobTok = await login('plbob', 'bob-password-12345');

  const nes = db.prepare("SELECT id FROM platforms WHERE slug = 'nes'").get().id;
  const ps1 = db.prepare("SELECT id FROM platforms WHERE slug = 'ps1'").get().id;
  const ins = (t, plat, sha) => db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1) VALUES (?,?,?,?,'x',1,?)").run(t, t, `${sha}.nes`, plat, sha).lastInsertRowid;
  ids = { one: ins('One', nes, 'pl1'), two: ins('Two', nes, 'pl2'), three: ins('Three', nes, 'pl3'), noplay: ins('No Core', ps1, 'pl4') };
});
after(() => { server?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

const adminId = () => db.prepare("SELECT id FROM users WHERE username = 'pladmin'").get().id;
const bobId = () => db.prepare("SELECT id FROM users WHERE username = 'plbob'").get().id;
const play = (romId, userId, kind = 'play') => db.prepare("INSERT INTO downloads (rom_id, bytes, user_id, kind) VALUES (?, 1, ?, ?)").run(romId, userId, kind);

test('recently played: newest first, one entry per game, with play counts', async () => {
  play(ids.one, adminId()); play(ids.two, adminId()); play(ids.one, adminId()); play(ids.three, adminId());
  const r = await get('/api/roms/recently-played', adminTok);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map((x) => x.title), ['Three', 'One', 'Two'], 'ordered by most recent play, games not repeated');
  assert.equal(r.body.items.find((x) => x.title === 'One').plays, 2);
  assert.ok(r.body.items.every((x) => x.playable), 'tiles can show their play button');
});

test("one user's plays never appear for another user", async () => {
  assert.deepEqual((await get('/api/roms/recently-played', bobTok)).body.items, []);
  play(ids.two, bobId());
  const bob = (await get('/api/roms/recently-played', bobTok)).body.items;
  assert.deepEqual(bob.map((x) => x.title), ['Two']);
  assert.equal(bob[0].plays, 1, 'bob sees only his own play count');
  assert.equal((await get('/api/roms/recently-played', adminTok)).body.items.find((x) => x.title === 'Two').plays, 1);
});

test('downloads are not plays, and hidden / missing / no-longer-playable games are left out', async () => {
  play(ids.three, bobId(), 'download');
  assert.ok(!(await get('/api/roms/recently-played', bobTok)).body.items.some((x) => x.title === 'Three'), 'a download is not a play');

  play(ids.noplay, adminId());
  db.prepare("INSERT OR IGNORE INTO hidden_roms (user_id, rom_id) VALUES ((SELECT id FROM users WHERE username = ?), ?)").run(process.env.GAMESAUCE_ADMIN_USER, ids.two);
  db.prepare("UPDATE roms SET missing = 1 WHERE id = ?").run(ids.three);
  let titles = (await get('/api/roms/recently-played', adminTok)).body.items.map((x) => x.title);
  assert.deepEqual(titles, ['One'], 'hidden, missing and core-less games are filtered out');

  db.prepare("DELETE FROM hidden_roms WHERE rom_id = ?").run(ids.two);
  db.prepare("UPDATE roms SET missing = 0 WHERE id IN (?, ?)").run(ids.two, ids.three);
  db.prepare("UPDATE roms SET play_override = 0 WHERE id = ?").run(ids.one);
  titles = (await get('/api/roms/recently-played', adminTok)).body.items.map((x) => x.title);
  assert.ok(!titles.includes('One'), 'a game switched off for browser play drops out');
});

test('the limit is respected and capped; sign-in is required', async () => {
  assert.equal((await get('/api/roms/recently-played?limit=1', adminTok)).body.items.length, 1);
  assert.ok((await get('/api/roms/recently-played?limit=9999', adminTok)).body.items.length <= 50);
  const anon = await fetch(`${base}/api/roms/recently-played`);
  assert.equal(anon.status, 401);
});
