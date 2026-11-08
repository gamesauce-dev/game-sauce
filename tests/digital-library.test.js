import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-digital-lib-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'dladmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'dl-admin-password-1';

let server, base, adminTok, annTok, db, consoles, adminId, annId;
const call = async (p, { method = 'GET', body, token = adminTok } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const games = async (q = '', token = adminTok) => (await call('/api/digital/games' + (q ? '?' + q : ''), { token })).body;
const titles = async (q, token) => (await games(q, token)).items.map((g) => g.name);

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  consoles = await import('../src/lib/consoles.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  adminTok = await login('dladmin', 'dl-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'ann', password: 'ann-password-12', role: 'user' } });
  annTok = await login('ann', 'ann-password-12');
  adminId = db.prepare("SELECT id FROM users WHERE username = 'dladmin'").get().id;
  annId = db.prepare("SELECT id FROM users WHERE username = 'ann'").get().id;
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

const CSV = 'Platform,Game,Country\nPS4,Bloodborne,AU\nPS5,Astro Bot,AU\nSwitch,Zelda Breath,AU\nSwitch,Mario Kart,AU\nXbox 360,Halo 3,US\nWii U,Splatoon,AU\n';
const steamRows = [['220', 'Half-Life 2', 600, 1700000000], ['400', 'Portal', 120, 1600000000], ['620', 'Portal 2', 0, null]];

test('the chips: each store with its visible count, and each console with its own', async () => {
  assert.equal((await call('/api/digital/consoles/import', { method: 'POST', body: { csv: CSV, apply: true } })).status, 200);
  await consoles.detailsJobIdle();
  const ins = db.prepare("INSERT INTO digital_games (user_id, store, app_id, name, minutes, last_played) VALUES (?, 'steam', ?, ?, ?, ?)");
  for (const [id, name, min, last] of steamRows) ins.run(adminId, id, name, min, last);
  const info = (await call('/api/digital')).body;
  const vis = Object.fromEntries(info.stores.map((s) => [s.store, s.visible]));
  assert.deepEqual(vis, { nintendo: 3, playstation: 2, steam: 3, xbox: 1 });
  const plats = Object.fromEntries(info.platforms.map((p) => [p.platform, p.count]));
  assert.deepEqual(plats, { ps4: 1, ps5: 1, switch: 2, wiiu: 1, x360: 1 });
  assert.ok(info.platforms.every((p) => p.label && p.store), 'each console has its name and its store');
  // a hidden game is not counted on the chips (the total including hidden is still `count`)
  await call('/api/digital/games/steam/620/mark', { method: 'PUT', body: { field: 'hidden', value: true } });
  const again = (await call('/api/digital')).body;
  assert.equal(again.stores.find((s) => s.store === 'steam').visible, 2); assert.equal(again.stores.find((s) => s.store === 'steam').count, 3);
  await call('/api/digital/games/steam/620/mark', { method: 'PUT', body: { field: 'hidden', value: false } });
});

test('filtering by store and by console, alone or together', async () => {
  assert.equal((await games()).total, 9);
  assert.deepEqual((await titles('stores=steam&sort=name')), ['Half-Life 2', 'Portal', 'Portal 2']);
  assert.deepEqual((await titles('stores=playstation')).sort(), ['Astro Bot', 'Bloodborne']);
  assert.deepEqual(await titles('platforms=switch'), ['Mario Kart', 'Zelda Breath']);
  assert.deepEqual((await titles('platforms=ps4,x360')).sort(), ['Bloodborne', 'Halo 3']);
  // a whole store and a single console from another store: either counts
  assert.deepEqual((await titles('stores=steam&platforms=wiiu')).sort(), ['Half-Life 2', 'Portal', 'Portal 2', 'Splatoon']);
  assert.equal((await games('stores=nope')).total, 9, 'an unknown store is ignored, not an empty list');
  assert.equal((await games('stores=xbox&platforms=ps5')).total, 2);
});

test('an older Xbox row with no console of its own counts as the Xbox console', async () => {
  db.prepare("INSERT INTO digital_games (user_id, store, app_id, name, platform) VALUES (?, 'xbox', 'fable', 'Fable', NULL)").run(adminId);
  assert.ok((await titles('platforms=xbox')).includes('Fable'));
  const info = (await call('/api/digital')).body;
  assert.equal(info.platforms.find((p) => p.platform === 'xbox').count, 1);
  db.prepare("DELETE FROM digital_games WHERE app_id = 'fable'").run();
});

test('the sorts: title both ways, platform, recently added, year; and Steam\'s own two', async () => {
  const names = await titles('sort=name'); const rev = await titles('sort=-name');
  assert.deepEqual(rev, [...names].reverse()); assert.equal(rev[0], 'Zelda Breath'); assert.equal(names[0], 'Astro Bot');
  const byPlatform = (await games('sort=platform')).items.map((g) => g.platform || g.store);
  assert.deepEqual(byPlatform, [...byPlatform].sort(), 'grouped by console (Steam, which has none, by its store)');
  assert.equal((await titles('sort=added'))[0], 'Portal 2', 'the newest first');
  // year: the details' release (a year or a date), none last; a person\'s own correction wins
  const det = db.prepare("INSERT OR REPLACE INTO digital_details (store, app_id, json, found) VALUES (?, ?, ?, 1)");
  det.run('playstation', 'bloodborne-ps4', JSON.stringify({ release: '24 Mar, 2015', genres: [] }));
  det.run('playstation', 'astro-bot-ps5', JSON.stringify({ release: '2024', genres: [] }));
  det.run('nintendo', 'mario-kart-switch', JSON.stringify({ release: '2017', genres: [] }));
  const years = await titles('sort=year');
  assert.deepEqual(years.slice(0, 3), ['Bloodborne', 'Mario Kart', 'Astro Bot']);
  assert.ok(!years.slice(0, 3).includes('Halo 3'), 'games with no year come after');
  assert.deepEqual((await titles('sort=hours&stores=steam')), ['Half-Life 2', 'Portal', 'Portal 2']);
  assert.deepEqual((await titles('sort=recent&stores=steam')), ['Half-Life 2', 'Portal', 'Portal 2']);
  assert.equal((await games('sort=bogus')).total, 9, 'an unknown sort falls back to title');
});

test('total hours come back with the list, so Steam alone can show them', async () => {
  assert.equal((await games('stores=steam')).total_hours, 12);   // 720 minutes
  assert.equal((await games('stores=playstation')).total_hours, 0);
});

test('adding a console game by hand: id or name, a duplicate is refused, Steam cannot be added', async () => {
  const a = await call('/api/digital/games', { method: 'POST', body: { platform: 'ps5', title: 'Returnal', country: 'Australia' } });
  assert.equal(a.status, 201); assert.equal(a.body.store, 'playstation'); assert.equal(a.body.platform, 'ps5'); assert.equal(a.body.app_id, 'returnal-ps5');
  const b = await call('/api/digital/games', { method: 'POST', body: { platform: 'Xbox Series X|S', title: 'Starfield' } });
  assert.equal(b.status, 201); assert.equal(b.body.store, 'xbox'); assert.equal(b.body.platform, 'xsx');
  assert.equal((await call('/api/digital/games', { method: 'POST', body: { platform: 'PS5', title: 'returnal' } })).status, 409, 'the same game on the same console');
  assert.equal((await call('/api/digital/games', { method: 'POST', body: { platform: 'ps4', title: 'Returnal' } })).status, 201, 'another console is another game');
  for (const bad of [{ platform: 'steam', title: 'X' }, { platform: 'zzz', title: 'X' }, { platform: 'ps5', title: '' }, { platform: '', title: 'X' }]) assert.equal((await call('/api/digital/games', { method: 'POST', body: bad })).status, 400, JSON.stringify(bad));
  const row = db.prepare("SELECT country FROM digital_games WHERE user_id = ? AND app_id = 'returnal-ps5'").get(adminId);
  assert.equal(row.country, 'AU');
  await consoles.detailsJobIdle();
  // anyone can add to their own list; it is theirs alone
  assert.equal((await call('/api/digital/games', { method: 'POST', body: { platform: 'switch', title: 'Hades' }, token: annTok })).status, 201);
  assert.deepEqual(await titles('', annTok), ['Hades']); assert.ok(!(await titles('')).includes('Hades'));
  await consoles.detailsJobIdle();
});

/** A PNG just big enough for the cover cache. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('editing a console game\'s details is your own: nobody else\'s list changes, and an untouched field keeps following the shared details', async () => {
  db.prepare("INSERT OR REPLACE INTO digital_details (store, app_id, json, found) VALUES ('nintendo', 'zelda-breath-switch', ?, 1)").run(JSON.stringify({ description: 'Shared text', developers: ['Nintendo'], publishers: ['Nintendo'], release: '2017', genres: ['Adventure'], rating: 4.5, screenshots: [], source: 'launchbox' }));
  // ann owns it too
  assert.equal((await call('/api/digital/games', { method: 'POST', body: { platform: 'switch', title: 'Zelda Breath' }, token: annTok })).status, 201);
  const url = '/api/digital/games/nintendo/zelda-breath-switch';
  const before = (await call(url)).body;
  assert.equal(before.custom, false); assert.equal(before.details.description, 'Shared text');
  const ed = await call(url, { method: 'PATCH', body: { description: 'My own words', genres: 'Adventure, Open world', rating: 5, developers: 'Nintendo', country: 'Japan' } });
  assert.equal(ed.status, 200); assert.equal(ed.body.custom, true);
  const mine = (await call(url)).body;
  assert.equal(mine.details.description, 'My own words'); assert.deepEqual(mine.details.genres, ['Adventure', 'Open world']); assert.equal(mine.details.rating, 5);
  assert.deepEqual(mine.details.developers, ['Nintendo']); assert.equal(mine.game.country_name, 'Japan'); assert.equal(mine.custom, true);
  const stored = JSON.parse(db.prepare("SELECT json FROM digital_user_meta WHERE user_id = ? AND app_id = 'zelda-breath-switch'").get(adminId).json);
  assert.deepEqual(Object.keys(stored).sort(), ['description', 'genres', 'rating'], 'only what differs from the shared details is kept');
  // ann sees the shared details, untouched
  const anns = (await call(url, { token: annTok })).body;
  assert.equal(anns.details.description, 'Shared text'); assert.equal(anns.custom, false); assert.notEqual(anns.game.country_name, 'Japan');
  // the shared text changes later: a field you never edited follows it, an edited one does not
  db.prepare("UPDATE digital_details SET json = ? WHERE store = 'nintendo' AND app_id = 'zelda-breath-switch'").run(JSON.stringify({ description: 'Shared text v2', developers: ['Nintendo EPD'], publishers: ['Nintendo'], release: '2017', genres: ['Adventure'], rating: 4.5, screenshots: [], source: 'launchbox' }));
  const later = (await call(url)).body.details;
  assert.equal(later.description, 'My own words'); assert.deepEqual(later.developers, ['Nintendo EPD'], 'untouched, so it follows the shared details');
  // bad input is refused; Steam has nothing to edit
  assert.equal((await call(url, { method: 'PATCH', body: { rating: 9 } })).status, 400);
  assert.equal((await call('/api/digital/games/steam/220', { method: 'PATCH', body: { description: 'x' } })).status, 400);
  assert.equal((await call('/api/digital/games/nintendo/not-mine-switch', { method: 'PATCH', body: { description: 'x' } })).status, 404);
  // putting a field back to the shared value drops the correction; clearing removes the lot
  await call(url, { method: 'PATCH', body: { description: 'Shared text v2', genres: 'Adventure', rating: 4.5 } });
  assert.equal((await call(url)).body.custom, false, 'nothing differs, so nothing is kept');
  await call(url, { method: 'PATCH', body: { description: 'again' } });
  assert.equal((await call(`${url}/match`, { method: 'DELETE' })).body.cleared, true);
  assert.equal((await call(url)).body.details.description, 'Shared text v2');
});

test('a match picked in the identify search becomes your own details and cover; the list shows your cover; clearing goes back', async () => {
  const id = 'bloodborne-ps4', url = `/api/digital/games/playstation/${id}`;
  const cacheImpl = async () => { const f = path.join(TMP, 'pick.png'); fs.writeFileSync(f, PNG); return f; };
  const r = await consoles.applyConsoleMatch(adminId, 'playstation', id, { title: 'Bloodborne', developer: 'FromSoftware; SIE', publisher: 'Sony', genre: 'Action, RPG', release_year: 2015, rating: 4.4, description: 'Hunt.', cover_url: 'http://x/c.png', source: 'igdb' }, { cacheImpl });
  assert.equal(r.custom, true);
  const d = (await call(url)).body;
  assert.equal(d.details.description, 'Hunt.'); assert.deepEqual(d.details.developers, ['FromSoftware', 'SIE']); assert.equal(d.details.release, '2015'); assert.equal(d.details.source, 'igdb'); assert.equal(d.custom, true);
  const tile = (await games('platforms=ps4')).items[0];
  assert.match(tile.cover_url, /^\/api\/digital\/cover\/playstation\/bloodborne-ps4/);
  const res = await fetch(base + tile.cover_url, { headers: { Authorization: 'Bearer ' + adminTok } });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type') || '', /image\/png/);
  assert.equal((await fetch(base + tile.cover_url, { headers: { Authorization: 'Bearer ' + annTok } })).status, 404, 'only the owner');
  assert.equal((await call(`${url}/match`, { method: 'POST', body: {} })).status, 400, 'a candidate is required');
  assert.equal((await call('/api/digital/games/steam/220/match', { method: 'POST', body: { candidate: { title: 'x' } } })).status, 400, 'Steam has no match to pick');
  assert.equal((await call(`${url}/match`, { method: 'DELETE' })).body.cleared, true);
  const back = (await games('platforms=ps4')).items[0];
  assert.ok(!back.cover_url || !back.cover_url.includes('pick'), 'back to the shared cover (or none)');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM digital_user_meta WHERE app_id = ?").get(id).n, 0);
});

test('looking one game up again asks the providers about just that game', async () => {
  const asked = [];
  const d = await consoles.lookupConsoleAgain(adminId, 'playstation', 'astro-bot-ps5', { enrichImpl: async ({ title, platform }) => { asked.push(`${platform.slug}:${title}`); return { title, publisher: 'Team Asobi', release_year: 2024, source: 'stub' }; }, cacheImpl: async () => null });
  assert.ok(d); assert.equal(asked[0], 'ps5:Astro Bot', 'its own console first'); assert.ok(asked.every((q) => /^ps[45]:Astro Bot$/.test(q)), 'only this game, on the consoles it is looked up as');
  assert.equal((await call('/api/digital/games/playstation/astro-bot-ps5/lookup', { method: 'POST', token: annTok })).status, 404, 'not another person\'s game');
});

test('removing a game takes your corrections with it, and so does deleting the person', async () => {
  const cacheImpl = async () => null;
  await consoles.applyConsoleMatch(annId, 'nintendo', 'hades-switch', { title: 'Hades', description: 'Ann\'s' }, { cacheImpl });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM digital_user_meta WHERE user_id = ?').get(annId).n, 1);
  assert.equal((await call('/api/digital/games/nintendo/hades-switch', { method: 'DELETE', token: annTok })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM digital_user_meta WHERE user_id = ?').get(annId).n, 0);
  await consoles.applyConsoleMatch(annId, 'nintendo', 'zelda-breath-switch', { title: 'Zelda', description: 'x' }, { cacheImpl });
  const { deleteUser } = await import('../src/auth.js');
  deleteUser(annId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM digital_user_meta WHERE user_id = ?').get(annId).n, 0);
});

test('the page: laid out like Physical, store and console chips, Steam hours in the heading, the new sorts, add / import / match / edit', () => {
  const html = read('public/index.html'), js = read('public/digital.js'), css = read('public/physical.css'), modern = read('public/modern.js'), app = read('public/app.js');
  // the same bar, chips and heading as Physical; no title row and no total above the search
  for (const id of ['dg-bar', 'dg-q', 'dg-sort', 'dg-toggles', 'dg-reset', 'dg-sync', 'dg-chips', 'dg-az', 'dg-letters', 'dg-top', 'dg-heading', 'dg-empty', 'dg-grid']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<div class="ph-bar" id="dg-bar">/); assert.match(html, /<nav class="ph-chips" id="dg-chips"/); assert.match(html, /<div id="dg-heading" class="lib-heading hidden">/);
  assert.doesNotMatch(html, /id="dg-total"/); assert.doesNotMatch(html.slice(html.indexOf('id="view-digital"'), html.indexOf('id="view-emulators"')), /<h1 class="page-title">/);
  assert.match(html, /data-dg-act="import"/); assert.match(html, /data-dg-act="add"/); assert.doesNotMatch(html.slice(html.indexOf('id="view-digital"'), html.indexOf('id="view-emulators"')), /data-dg-view="shelf"/, 'no shelf view in Digital');
  // chips: a store, then its consoles; the same click rules as Physical
  assert.match(js, /data-dg-chip-store/); assert.match(js, /data-dg-chip-plat/); assert.match(js, /ph-chip-plats/); assert.match(js, /'s:'|`s:\$\{s\}`/); assert.match(js, /params\.set\('stores'/); assert.match(js, /params\.set\('platforms'/);
  // Steam alone shows the hours next to the count; the sorts are Physical's with Steam's two below a divider
  assert.match(js, /steamOnly/); assert.match(js, /h played/);
  assert.match(js, /<optgroup label="Steam only"><option value="hours">Most played<\/option><option value="recent">Recently played<\/option><\/optgroup>/);
  for (const v of ['name', '-name', 'platform', 'added', 'year']) assert.match(js, new RegExp(`<option value="${v}">`), v);
  // add by hand and import, for Digital's own consoles; match and edit are for console games (a Steam game's details come from Steam)
  assert.match(js, /'\/digital\/games', \{ method: 'POST'/); assert.match(js, /'\/digital\/consoles\/import'/); assert.match(js, /isAdmin\(\)/);
  assert.match(js, /identifyBlock\(\{ idp: 'dg'/); assert.match(js, /wireIdentify\(body, \{ idp: 'dg'/); assert.match(js, /id="dg-edit"/); assert.match(js, /\/match`, \{ method: 'POST'/);
  const steam = js.slice(js.indexOf('function renderSteamDetail'), js.indexOf('function renderConsoleDetail'));
  assert.ok(!steam.includes('identifyBlock') && !steam.includes('dg-edit'), 'no match or edit for a Steam game');
  // wired in like Physical, and the old page code is gone from app.js
  assert.match(app, /import \* as digital from '\.\/digital\.js'/); assert.match(app, /digital\.initDigital\(/); assert.match(app, /return digital\.step\(dir\);/);
  assert.doesNotMatch(app, /function loadDigital|function dgRender|const dg = \{/);
  // Modern: icons in place of the text buttons, with the words as the hover text
  for (const [sel, icon] of [['[data-dg-toggle="fav"]', 'favourite'], ['[data-dg-toggle="installed"]', 'gamepad'], ['[data-dg-toggle="hidden"]', 'hidden'], ['#dg-reset', 'clear-reset-2'], ['[data-dg-act="import"]', 'csv-import'], ['[data-dg-act="add"]', 'game-add']])
    assert.ok(modern.includes(`['#view-digital ${sel}', '${icon}']`), sel);
  for (const sel of ['#dg-id-go', '#dg-edit button[type="submit"]', '#dg-add button[type="submit"]']) assert.ok(modern.includes(`['${sel}'`), sel);
  assert.match(modern, /\['#dg-sync, #steam-sync', 'fetch-games'\]/);
  assert.match(css, /\.ph-bar-end \{ margin-left: auto;/);
});

test('Physical and Digital share one identify search', () => {
  const id = read('public/identify.js'), ph = read('public/physical.js'), dg = read('public/digital.js');
  assert.match(id, /export function identifyBlock/); assert.match(id, /export function wireIdentify/); assert.match(id, /'\/metadata\/search'/);
  assert.match(ph, /from '\.\/identify\.js'/); assert.match(dg, /from '\.\/identify\.js'/);
});

test('every digital.* and physical.* that app.js calls is something the module exports', () => {
  const app = read('public/app.js');
  for (const [mod, file] of [['digital', 'public/digital.js'], ['physical', 'public/physical.js']]) {
    const src = read(file);
    const exported = new Set([...src.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map((m) => m[1]));
    for (const m of src.matchAll(/export \{([^}]*)\}/g)) for (const part of m[1].split(',')) exported.add(part.trim().split(/\s+as\s+/).pop());
    const used = [...new Set([...app.matchAll(new RegExp('\\b' + mod + '\\.(\\w+)', 'g'))].map((m) => m[1]).filter((name) => name !== 'js'))];   // 'js' is the import path ('./digital.js'), not a call
    assert.ok(used.length >= 4, `${mod}: app.js uses the module`);
    for (const name of used) assert.ok(exported.has(name), `${file} must export ${name} (app.js calls ${mod}.${name})`);
  }
});

test('chips and cover badges read the same on Physical and Digital: one shared set of names, in capitals', async () => {
  const names = await import('../public/platform-names.js');
  // Digital's names win; every other platform keeps the Library's short name; all in capitals
  assert.equal(names.platformBadge({ slug: 'switch', short_name: 'NSW' }), 'SWITCH'); assert.equal(names.platformBadge({ slug: 'wiiu', short_name: 'WiiU' }), 'WII U');
  assert.equal(names.platformBadge({ slug: 'xbox360', short_name: 'X360' }), 'XBOX 360'); assert.equal(names.platformBadge({ slug: 'xboxseries', short_name: 'XSX' }), 'X|S');
  assert.equal(names.platformBadge({ slug: 'nds', short_name: 'NDS' }), 'DS'); assert.equal(names.platformBadge({ slug: 'xbox', short_name: 'XBX' }), 'XBOX');
  assert.equal(names.platformBadge({ slug: 'snes', short_name: 'SNES' }), 'SNES'); assert.equal(names.platformBadge({ slug: 'gb', short_name: 'gb' }), 'GB');
  assert.equal(names.platformBadge({ slug: 'odd', name: 'Odd Machine' }), 'ODD MACHINE', 'falls back to the name');
  // families: the brand, in capitals (the Library files these consoles under Sony and Microsoft / Xbox)
  for (const [f, label] of [['Sony', 'PLAYSTATION'], ['Microsoft', 'XBOX'], ['Xbox', 'XBOX'], ['PlayStation', 'PLAYSTATION'], ['Nintendo', 'NINTENDO'], ['Sega', 'SEGA'], ['NEC', 'NEC'], ['Steam', 'STEAM']]) assert.equal(names.familyLabel(f), label, f);
  assert.equal(names.familyName('Sony'), 'PlayStation', 'the tooltip keeps the brand\'s own capitals');
  // Digital's own table of consoles agrees with the shared one, console by console
  const dg = read('public/digital.js');
  const rows = [...dg.matchAll(/(?:^|[ ,{])'?(\w+)'?: \{ store: '[a-z]+', label: '[^']+', short: '([^']+)', lib: '([^']+)' \}/g)];
  assert.equal(rows.length, 13, 'all thirteen consoles found');
  for (const [, id, short, lib] of rows) assert.equal(names.BADGE[lib], short, `Digital's ${id} badge is the shared name for ${lib}`);
  // both pages build their chip and badge text from it, not from the Library's short name directly
  const ph = read('public/physical.js');
  assert.match(ph, /from '\.\/platform-names\.js'/); assert.match(dg, /from '\.\/platform-names\.js'/);
  assert.doesNotMatch(ph, /short_name \|\| p\.name\)\.toUpperCase\(\)/); assert.match(ph, /platformBadge\(p\)/); assert.match(ph, /familyLabel\(f\)/); assert.match(dg, /familyLabel\(s\.label/);
});

test('No cover: console games with no picture yet (Steam covers are Steam\'s own, so never counted), with a count', async () => {
  const all = await games('');
  const covered = db.prepare("SELECT app_id FROM digital_games WHERE user_id = ? AND store != 'steam' ORDER BY id LIMIT 1").get(adminId).app_id;
  db.prepare("INSERT INTO digital_user_meta (user_id, store, app_id, cover_path, json) VALUES (?, (SELECT store FROM digital_games WHERE user_id = ? AND app_id = ? LIMIT 1), ?, '/x/cover.jpg', '{}') ON CONFLICT DO UPDATE SET cover_path = excluded.cover_path").run(adminId, adminId, covered, covered);
  const none = await games('nocover=1');
  assert.ok(none.items.length > 0 && none.items.every((g) => g.store !== 'steam' && !g.cover_url), 'only console games with no cover');
  assert.equal(none.items.some((g) => g.app_id === covered), false, 'a game with a cover is not listed');
  assert.equal((await call('/api/digital')).body.counts.nocover, none.items.length, 'the pill shows the same number');
  assert.equal(none.items.length, all.items.filter((g) => g.store !== 'steam').length - 1);
});

test('the platform box on the add forms is type-to-find, and the add forms are cleared when they close', () => {
  const ph = read('public/physical.js'), dg = read('public/digital.js'), id = read('public/identify.js');
  assert.match(id, /export function comboHtml/); assert.match(id, /export function wireCombo/); assert.match(id, /<datalist id=/);
  assert.ok(ph.includes("comboHtml({ options: platformOptions(), selected: first") && ph.includes("wireCombo(form, 'platform', platformOptions())"));
  assert.ok(dg.includes('comboHtml({ options: consoleOptions(), selected: first') && dg.includes("wireCombo(form, 'platform', consoleOptions(), 'console')"));
  assert.ok(!/<select name="platform"/.test(dg) && !ph.slice(ph.indexOf('id="ph-add"'), ph.indexOf('id="ph-add"') + 1200).includes('<select'), 'no first-letter dropdown on the add forms');
  assert.match(ph, /export function forgetOpen\(\) \{ lastAdd = /); assert.match(dg, /export function forgetOpen\(\) \{ lastAdd = /);
  assert.ok(dg.includes('data-dg-toggle="nocover"') && dg.includes("params.set('nocover', '1')") && read('public/modern.js').includes("data-dg-toggle=\"nocover\"]', 'no-covers-2'"));
});
