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
  assert.equal(hl.hours, 1.5); assert.equal(hl.launch_url, null, 'no launch link until the play switch is on'); assert.match(hl.cover_url, /steamstatic\.com\/steam\/apps\/220\//);
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

test('marks: favourite, hidden and play are per person, survive a refresh, and Remove clears them', async () => {
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'dadmin'").get().id;
  await call('/api/digital/steam', { method: 'PUT', body: { steam_id: ID, key: KEY } });
  const good = async () => ({ ok: true, status: 200, json: async () => ({ response: { games: [
    { appid: 220, name: 'Half-Life 2', playtime_forever: 90 }, { appid: 400, name: 'Portal', playtime_forever: 10 }, { appid: 620, name: 'Portal 2', playtime_forever: 0 } ] } }) });
  await steam.syncSteam(adminId, good);
  const mark = (appId, field, value, token) => call(`/api/digital/games/steam/${appId}/mark`, { method: 'PUT', body: { field, value }, token });
  assert.equal((await mark(220, 'favourite', true)).status, 200);
  assert.equal((await mark(400, 'hidden', true)).status, 200);
  assert.equal((await mark(220, 'play', true)).status, 200);
  assert.equal((await mark(999, 'favourite', true)).status, 404, 'a game that is not in your list');
  assert.equal((await mark(220, 'nonsense', true)).status, 400);
  await call('/api/auth/users', { method: 'POST', body: { username: 'bob', password: 'bob-password-12', role: 'user' } });
  const bobTok = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'bob-password-12' }) })).json()).token;
  assert.equal((await mark(220, 'favourite', true, bobTok)).status, 404, 'another person cannot mark it (not in their list)');
  let l = (await call('/api/digital/games')).body.items;
  assert.deepEqual(l.map((g) => g.name), ['Half-Life 2', 'Portal 2'], 'hidden games are left out');
  assert.equal(l[0].favourite, 1); assert.equal(l[0].launch_url, 'steam://rungameid/220'); assert.equal(l[1].launch_url, null);
  assert.deepEqual((await call('/api/digital/games?favourites=1')).body.items.map((g) => g.name), ['Half-Life 2']);
  assert.deepEqual((await call('/api/digital/games?hidden=only')).body.items.map((g) => g.name), ['Portal']);
  assert.equal((await call('/api/digital/games?hidden=show')).body.items.length, 3);
  assert.deepEqual((await call('/api/digital')).body.counts, { total: 3, visible: 2, favourites: 1, installed: 1, hidden: 1, nocover: 0 });
  // a refresh replaces the list but keeps the marks
  await steam.syncSteam(adminId, good);
  l = (await call('/api/digital/games?hidden=show')).body.items;
  assert.equal(l.find((g) => g.name === 'Half-Life 2').favourite, 1); assert.equal(l.find((g) => g.name === 'Portal').hidden, 1); assert.equal(l.find((g) => g.name === 'Half-Life 2').play, 1);
  // un-marking works
  await mark(400, 'hidden', false);
  assert.equal((await call('/api/digital/games')).body.items.length, 3);
  // Remove clears everything, marks included
  await call('/api/digital/steam', { method: 'DELETE' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM digital_marks WHERE user_id = ?').get(adminId).n, 0);
  assert.equal((await call('/api/digital/games')).body.total, 0);
});

test('store details: reduced to plain fields, cached, shared, a missing page is remembered, and the route is private', async () => {
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'dadmin'").get().id;
  await call('/api/digital/steam', { method: 'PUT', body: { steam_id: ID, key: KEY } });
  await steam.syncSteam(adminId, async () => ({ ok: true, status: 200, json: async () => ({ response: { games: [
    { appid: 220, name: 'Half-Life 2', playtime_forever: 90 }, { appid: 555, name: 'Delisted Thing', playtime_forever: 0 } ] } }) }));
  let calls = 0;
  const store = async (url) => {
    calls++;
    const id = new URL(url).searchParams.get('appids');
    if (id === '220') return { ok: true, status: 200, json: async () => ({ 220: { success: true, data: { name: 'Half-Life 2', short_description: 'Gordon <b>Freeman</b> &amp; friends.<br>Again.', developers: ['Valve'], publishers: ['Valve'], release_date: { date: '16 Nov, 2004' }, genres: [{ description: 'Action' }], metacritic: { score: 96 }, is_free: false, price_overview: { final_formatted: 'A$9.95' }, header_image: 'https://x/h.jpg', screenshots: [{ path_thumbnail: 'https://x/s1.jpg' }], platforms: { windows: true, mac: false, linux: true } } } }) };
    return { ok: true, status: 200, json: async () => ({ [id]: { success: false } }) };
  };
  const d = await steam.getDetails('220', store);
  assert.equal(d.description, 'Gordon Freeman & friends.\nAgain.', 'tags removed, entities decoded');
  assert.deepEqual(d.developers, ['Valve']); assert.equal(d.metacritic, 96); assert.equal(d.price, 'A$9.95'); assert.deepEqual(d.platforms, ['windows', 'linux']);
  assert.equal(calls, 1);
  await steam.getDetails('220', store); assert.equal(calls, 1, 'second look comes from the cache');
  assert.equal(await steam.getDetails('555', store), null, 'a game with no store page gives null'); assert.equal(calls, 2);
  assert.equal(await steam.getDetails('555', store), null); assert.equal(calls, 2, 'and that is remembered for a day');
  await assert.rejects(() => steam.getDetails('abc', store), /Bad app id/);
  // Steam down: the cached copy still serves, an unknown game gets a plain message
  db.prepare("UPDATE digital_details SET fetched_at = datetime('now', '-40 days') WHERE app_id = '220'").run();
  assert.equal((await steam.getDetails('220', async () => { throw new Error('offline'); })).name, 'Half-Life 2', 'stale copy beats an error');
  await assert.rejects(() => steam.getDetails('999', async () => { throw new Error('offline'); }), /could not be reached/);
  await assert.rejects(() => steam.getDetails('998', async () => ({ ok: false, status: 429 })), /slow down/);
  // the route: only games in your own list; details come back with the game and its marks
  db.prepare("INSERT OR REPLACE INTO digital_details (store, app_id, json, found) VALUES ('steam', '220', ?, 1)").run(JSON.stringify({ name: 'Half-Life 2', description: 'cached' }));
  const r = await call('/api/digital/games/steam/220');
  assert.equal(r.status, 200); assert.equal(r.body.game.name, 'Half-Life 2'); assert.equal(r.body.details.description, 'cached'); assert.match(r.body.game.cover_fallback_url, /header\.jpg$/);
  assert.equal((await call('/api/digital/games/steam/220', { token: annTok })).status, 401, 'signed-out/other tokens are refused');
  assert.equal((await call('/api/digital/games/steam/424242')).status, 404, 'not in your list');
  await call('/api/digital/steam', { method: 'DELETE' });
});

test('search matches genres and developers from the cached store details; letters are counted and filterable', async () => {
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'dadmin'").get().id;
  await call('/api/digital/steam', { method: 'PUT', body: { steam_id: ID, key: KEY } });
  await steam.syncSteam(adminId, async () => ({ ok: true, status: 200, json: async () => ({ response: { games: [
    { appid: 1, name: 'Alpha Quest', playtime_forever: 60 }, { appid: 2, name: 'Beta Strike', playtime_forever: 0 }, { appid: 3, name: '7 Days', playtime_forever: 5 }, { appid: 4, name: 'Another One', playtime_forever: 1 } ] } }) }));
  db.prepare("INSERT OR REPLACE INTO digital_details (store, app_id, json, found) VALUES ('steam', '1', ?, 1)").run(JSON.stringify({ genres: ['RPG', 'Action'], developers: ['Valve'] }));
  db.prepare("INSERT OR REPLACE INTO digital_details (store, app_id, json, found) VALUES ('steam', '2', ?, 1)").run(JSON.stringify({ genres: ['Shooter'], developers: ['Other Studio'] }));
  const names = async (q) => (await call('/api/digital/games?q=' + encodeURIComponent(q))).body.items.map((g) => g.name);
  assert.deepEqual(await names('rpg'), ['Alpha Quest'], 'a genre finds the game');
  assert.deepEqual(await names('shooter'), ['Beta Strike']);
  assert.deepEqual(await names('valve'), ['Alpha Quest'], 'a developer too');
  assert.deepEqual(await names('beta'), ['Beta Strike'], 'the name still works');
  assert.deepEqual(await names('nothing-like-this'), []);
  assert.deepEqual(await names('100%'), [], 'a percent sign is just text');
  const r = (await call('/api/digital/games')).body;
  assert.deepEqual(r.letters, { A: 2, B: 1, '#': 1 }, 'digits go under #');
  assert.deepEqual((await call('/api/digital/games?letter=A')).body.items.map((g) => g.name), ['Alpha Quest', 'Another One']);
  assert.deepEqual((await call('/api/digital/games?letter=%23')).body.items.map((g) => g.name), ['7 Days']);
  assert.equal((await call('/api/digital/games?letter=A')).body.letters.A, 2, 'counts stay those of the whole filtered list');
  await call('/api/digital/steam', { method: 'DELETE' });
});

test('Installed filter: only games with the play switch on, counted for the chip', async () => {
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'dadmin'").get().id;
  await call('/api/digital/steam', { method: 'PUT', body: { steam_id: ID, key: KEY } });
  await steam.syncSteam(adminId, async () => ({ ok: true, status: 200, json: async () => ({ response: { games: [
    { appid: 11, name: 'One', playtime_forever: 1 }, { appid: 12, name: 'Two', playtime_forever: 1 }, { appid: 13, name: 'Three', playtime_forever: 1 } ] } }) }));
  const mark = (id, field, value) => call(`/api/digital/games/steam/${id}/mark`, { method: 'PUT', body: { field, value } });
  await mark(11, 'play', true); await mark(12, 'play', true); await mark(12, 'hidden', true);
  assert.deepEqual((await call('/api/digital/games?installed=1')).body.items.map((g) => g.name), ['One'], 'a hidden game is not listed unless Show hidden');
  assert.deepEqual((await call('/api/digital/games?installed=1&hidden=show')).body.items.map((g) => g.name), ['One', 'Two']);
  assert.equal((await call('/api/digital')).body.counts.installed, 1);
  assert.equal((await call('/api/digital/games')).body.items.length, 2, 'without the chip everything visible is listed');
  await call('/api/digital/steam', { method: 'DELETE' });
});

test('filing: "The Darkness II" sorts and counts under D, not T (names, letters and the letter filter agree)', async () => {
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'dadmin'").get().id;
  await call('/api/digital/steam', { method: 'PUT', body: { steam_id: ID, key: KEY } });
  await steam.syncSteam(adminId, async () => ({ ok: true, status: 200, json: async () => ({ response: { games: [
    { appid: 1, name: 'The Darkness II', playtime_forever: 1 }, { appid: 2, name: 'Dota 2', playtime_forever: 1 }, { appid: 3, name: 'Doom', playtime_forever: 1 },
    { appid: 4, name: 'A Hat in Time', playtime_forever: 1 }, { appid: 5, name: 'Terraria', playtime_forever: 1 }, { appid: 6, name: '7 Days to Die', playtime_forever: 1 } ] } }) }));
  const order = (await call('/api/digital/games')).body.items.map((g) => g.name);
  assert.deepEqual(order, ['7 Days to Die', 'The Darkness II', 'Doom', 'Dota 2', 'A Hat in Time', 'Terraria'].sort((a, b) => steam.fileKey(a).localeCompare(steam.fileKey(b), 'en', { numeric: true })));
  assert.ok(order.indexOf('The Darkness II') < order.indexOf('Doom'), 'The Darkness II comes before Doom (D-a-r)');
  assert.ok(order.indexOf('A Hat in Time') > order.indexOf('Dota 2') && order.indexOf('A Hat in Time') < order.indexOf('Terraria'), 'A Hat in Time files under H');
  const r = (await call('/api/digital/games')).body;
  assert.deepEqual(r.letters, { '#': 1, D: 3, H: 1, T: 1 });
  assert.deepEqual((await call('/api/digital/games?letter=D')).body.items.map((g) => g.name), ['The Darkness II', 'Doom', 'Dota 2']);
  assert.deepEqual((await call('/api/digital/games?letter=T')).body.items.map((g) => g.name), ['Terraria']);
  await call('/api/digital/steam', { method: 'DELETE' });
});
