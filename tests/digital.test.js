import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-digital-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'dadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'd-admin-password-1';

let server, base, adminTok, annTok, db, steam;
const KEY = 'ABCDEF0123456789ABCDEF0123456789';
const ID = '76561197960287930';
const call = async (p, { method = 'GET', body, token = adminTok } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  steam = await import('../src/lib/steam.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  adminTok = await login('dadmin', 'd-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'ann', password: 'ann-password-12', role: 'user' } });
  annTok = await login('ann', 'ann-password-12');
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('parseSteamId accepts the number or a profile link; key shape is checked', () => {
  assert.equal(steam.parseSteamId(ID), ID);
  assert.equal(steam.parseSteamId(`https://steamcommunity.com/profiles/${ID}/`), ID);
  assert.equal(steam.parseSteamId('gabelogannewell'), null);
  assert.equal(steam.parseSteamId('123'), null);
  assert.ok(steam.looksLikeKey(KEY)); assert.ok(!steam.looksLikeKey('short')); assert.ok(!steam.looksLikeKey(KEY + 'x'));
});

test('saving: bad input is refused with a plain reason; the key is stored encrypted and never returned', async () => {
  assert.equal((await call('/api/digital/steam', { method: 'PUT', body: { steam_id: 'nope', key: KEY } })).status, 400);
  assert.equal((await call('/api/digital/steam', { method: 'PUT', body: { steam_id: ID, key: 'tooshort' } })).status, 400);
  assert.equal((await call('/api/digital/steam', { method: 'PUT', body: { steam_id: ID } })).status, 400, 'no key and none saved');
  const r = await call('/api/digital/steam', { method: 'PUT', body: { steam_id: ID, key: KEY } });
  assert.equal(r.status, 200); assert.equal(r.body.connected, true); assert.equal(r.body.steam_id, ID);
  assert.ok(!JSON.stringify(r.body).includes(KEY), 'the key is never sent back');
  const row = db.prepare("SELECT key_enc FROM digital_accounts WHERE store = 'steam'").get();
  assert.ok(row.key_enc.startsWith('v1:') && !row.key_enc.includes(KEY), 'stored encrypted');
  assert.ok(!JSON.stringify((await call('/api/digital')).body).includes(KEY));
  // the audit trail names the store, not the key
  const audit = JSON.stringify((await call('/api/auth/audit?limit=50')).body);
  assert.ok(!audit.includes(KEY));
});

test('sync: Steam answers are stored per person; private profile and refused key give clear messages', async () => {
  const good = async () => ({ ok: true, status: 200, json: async () => ({ response: { game_count: 2, games: [
    { appid: 220, name: 'Half-Life 2', playtime_forever: 90, rtime_last_played: 1700000000 },
    { appid: 400, name: 'Portal', playtime_forever: 0 } ] } }) });
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'dadmin'").get().id;
  const r = await steam.syncSteam(adminId, good);
  assert.equal(r.count, 2);
  const list = (await call('/api/digital/games')).body;
  assert.equal(list.total, 2);
  const hl = list.items.find((g) => g.name === 'Half-Life 2');
  assert.equal(hl.hours, 1.5); assert.equal(hl.launch_url, 'steam://rungameid/220'); assert.match(hl.cover_url, /steamstatic\.com\/steam\/apps\/220\//);
  assert.equal((await call('/api/digital/games?sort=hours')).body.items[0].name, 'Half-Life 2');
  assert.equal((await call('/api/digital/games?q=portal')).body.items.length, 1);
  assert.equal((await call('/api/digital/games', { token: annTok })).body.total, 0, 'Ann sees none of the admin\'s games');
  // a private profile returns an empty response
  await assert.rejects(() => steam.syncSteam(adminId, async () => ({ ok: true, status: 200, json: async () => ({ response: {} }) })), /Game details.*Public/);
  assert.equal((await call('/api/digital/games')).body.total, 2, 'a failed sync keeps the last good list');
  await assert.rejects(() => steam.syncSteam(adminId, async () => ({ ok: false, status: 403, json: async () => ({}) })), /refused the key/);
  assert.match((await call('/api/digital')).body.steam.last_error, /refused/);
  await assert.rejects(() => steam.syncSteam(adminId, async () => { throw new Error('offline'); }), /could not be reached/);
});

test('private to the person: another member has their own account; removing clears the list; deleting a user clears their data', async () => {
  assert.equal((await call('/api/digital', { token: annTok })).body.steam.connected, false);
  assert.equal((await call('/api/digital/steam/sync', { method: 'POST', token: annTok })).status, 400, 'no key yet');
  await call('/api/digital/steam', { method: 'PUT', token: annTok, body: { steam_id: ID, key: KEY } });
  const annId = db.prepare("SELECT id FROM users WHERE username = 'ann'").get().id;
  db.prepare("INSERT INTO digital_games (user_id, store, app_id, name, minutes) VALUES (?, 'steam', '10', 'Counter-Strike', 60)").run(annId);
  assert.equal((await call('/api/digital/games', { token: annTok })).body.total, 1);
  assert.equal((await call('/api/digital/games')).body.total, 2, 'the admin list is unchanged');
  const rm = await call('/api/digital/steam', { method: 'DELETE' });
  assert.equal(rm.body.connected, false);
  assert.equal((await call('/api/digital/games')).body.total, 0);
  assert.equal((await call('/api/digital/games', { token: annTok })).body.total, 1, 'Ann keeps hers');
  const { deleteUser } = await import('../src/auth.js');
  deleteUser(annId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM digital_games WHERE user_id = ?').get(annId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM digital_accounts WHERE user_id = ?').get(annId).n, 0);
});

test('signed-out requests are refused', async () => {
  assert.equal((await fetch(base + '/api/digital')).status, 401);
  assert.equal((await fetch(base + '/api/digital/games')).status, 401);
});
