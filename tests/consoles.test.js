import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-consoles-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'cadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'c-admin-password-1';

let server, base, adminTok, annTok, db, consoles;
const call = async (p, { method = 'GET', body, token = adminTok } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const CSV = [
  'Platform,Game,Country',
  'PS5,Astro Bot,Australia',
  'PlayStation 4,"Ratchet & Clank",AU',
  'Xbox Series X|S,Halo Infinite,United States',
  'Xbox One,Forza Horizon 5,uk',
  'XBOX 360,Halo Infinite,United States',
  'PS5,Astro Bot,Australia',
  'Switch,Mario Kart 8,Japan',
  'PS4,,AU'
].join('\r\n');

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  consoles = await import('../src/lib/consoles.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  adminTok = await login('cadmin', 'c-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'cann', password: 'cann-password-12', role: 'user' } });
  annTok = await login('cann', 'cann-password-12');
});
after(async () => {
  await consoles?.detailsJobIdle();
  server?.close(); try { db?.close(); } catch { /* shared */ }
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('platform names, countries, ids and store links', () => {
  for (const [t, s] of [['PS4', 'ps4'], ['PlayStation 4', 'ps4'], ['Sony PlayStation 5', 'ps5'], ['ps5', 'ps5'], ['Xbox', 'xbox'], ['Xbox One', 'xbox'], ['Xbox 360', 'xbox'], ['Xbox Series X|S', 'xbox'], ['XSX', 'xbox'], ['Switch', null], ['', null]]) assert.equal(consoles.storeFor(t), s, t);
  for (const [t, p] of [['Xbox', 'xbox'], ['XBOX', 'xbox'], ['Microsoft Xbox', 'xbox'], ['Xbox 360', 'x360'], ['XBOX360', 'x360'], ['X360', 'x360'], ['Xbox One', 'xone'], ['XBOX ONE X', 'xone'], ['XB1', 'xone'],
    ['Xbox Series X|S', 'xsx'], ['XBOX SERIES X|S', 'xsx'], ['X|S', 'xsx'], ['Xbox Series X', 'xsx'], ['XSX', 'xsx']]) assert.deepEqual(consoles.platformFor(t), { store: 'xbox', platform: p }, t);
  assert.deepEqual(consoles.platformFor('PS5'), { store: 'ps5', platform: null });
  assert.deepEqual(consoles.countryFor('Australia'), { code: 'AU', name: 'Australia', locale: 'en-au' });
  assert.equal(consoles.countryFor('au').code, 'AU'); assert.equal(consoles.countryFor('UK').code, 'GB'); assert.equal(consoles.countryFor('USA').code, 'US');
  assert.deepEqual(consoles.countryFor('Atlantis'), { code: null, name: 'Atlantis', locale: null });
  assert.equal(consoles.countryFor(''), null);
  assert.equal(consoles.appIdFor('Ratchet & Clank: Rift Apart'), 'ratchet-and-clank-rift-apart');
  assert.equal(consoles.appIdFor('Pokémon'), 'pokemon');
  assert.equal(consoles.storeUrl('ps5', 'Astro Bot', 'AU'), 'https://store.playstation.com/en-au/search/Astro%20Bot');
  assert.equal(consoles.storeUrl('xbox', 'Halo', 'GB'), 'https://www.xbox.com/en-GB/search/results/games?q=Halo');
  assert.equal(consoles.storeUrl('ps4', 'X', null), 'https://store.playstation.com/en-us/search/X');
});

test('a provider record becomes the details window shape', () => {
  const d = consoles.mapRecord({ title: 'Astro Bot', developer: 'Team Asobi', publisher: 'Sony; SIE', genre: 'Platform, Adventure', release_year: 2024, rating: 4.6, description: 'A &amp; B', cover_url: 'https://x/c.jpg', media: { box2d: 'https://x/c.jpg', screenshot: 'https://x/s.jpg' }, source: 'igdb' }, 'ps5');
  assert.equal(d.name, 'Astro Bot'); assert.deepEqual(d.developers, ['Team Asobi']); assert.deepEqual(d.publishers, ['Sony', 'SIE']);
  assert.deepEqual(d.genres, ['Platform', 'Adventure']); assert.equal(d.release, '2024'); assert.equal(d.description, 'A & B');
  assert.deepEqual(d.screenshots, ['https://x/s.jpg']); assert.equal(d.cover_url, 'https://x/c.jpg'); assert.equal(d.matched_platform, 'ps5');
  assert.equal(consoles.mapRecord(null), null); assert.equal(consoles.mapRecord({ error: 'x' }), null);
});

test('lookup tries each platform of the store and prefers a match with a cover', async () => {
  const asked = [];
  const fake = async ({ platform }) => { asked.push(platform.slug); return platform.slug === 'ps5' ? { title: 'No art' } : { title: 'Art', cover_url: 'https://x/a.jpg' }; };
  const r = await consoles.lookupConsoleGame('ps5', 'Something', fake);
  assert.deepEqual(asked, ['ps5', 'ps4']); assert.equal(r.details.name, 'Art');
  const none = await consoles.lookupConsoleGame('xbox', 'Nothing', async () => null);
  assert.equal(none.details, null);
});

test('import: header required, preview saves nothing, apply adds, duplicates and bad rows are reported', async () => {
  const bad = await call('/api/digital/consoles/import', { method: 'POST', body: { csv: 'a,b\n1,2' } });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /Platform, Game, Country/);
  assert.equal((await call('/api/digital/consoles/import', { method: 'POST', body: { csv: CSV }, token: annTok })).status, 403, 'CSV tools are for admins');

  const pre = await call('/api/digital/consoles/import', { method: 'POST', body: { csv: CSV } });
  assert.equal(pre.status, 200); assert.equal(pre.body.applied, false);
  assert.equal(pre.body.games, 5); assert.equal(pre.body.added, 5); assert.equal(pre.body.duplicates, 1); assert.equal(pre.body.skipped, 2);
  assert.deepEqual(pre.body.by_store, { ps4: 1, ps5: 1, xbox: 3 });
  assert.ok(pre.body.problems.some((p) => /Unknown platform "Switch"/.test(p.reason)));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM digital_games WHERE store != 'steam'").get().n, 0, 'preview saved nothing');

  const r = await call('/api/digital/consoles/import', { method: 'POST', body: { csv: CSV, apply: true } });
  assert.equal(r.body.applied, true); assert.equal(r.body.added, 5);
  await consoles.detailsJobIdle();
  const again = await call('/api/digital/consoles/import', { method: 'POST', body: { csv: CSV, apply: true } });
  assert.equal(again.body.added, 0); assert.equal(again.body.unchanged, 5, 'importing the same file twice adds nothing');
  await consoles.detailsJobIdle();
  const country = db.prepare("SELECT country FROM digital_games WHERE store = 'xbox' AND app_id = 'forza-horizon-5-xone'").get().country;
  assert.equal(country, 'GB');
  const plats = db.prepare("SELECT app_id, platform FROM digital_games WHERE store = 'xbox' ORDER BY app_id").all();
  assert.deepEqual(plats, [{ app_id: 'forza-horizon-5-xone', platform: 'xone' }, { app_id: 'halo-infinite-x360', platform: 'x360' }, { app_id: 'halo-infinite-xsx', platform: 'xsx' }], 'the same title on two consoles is two games');
});

test('list, chips, marks and the details window for console games; no play button', async () => {
  const info = (await call('/api/digital')).body;
  assert.deepEqual(info.stores.map((s) => [s.store, s.label]), [['ps4', 'PlayStation 4'], ['ps5', 'PlayStation 5'], ['xbox', 'Xbox']]);
  assert.ok(info.details_job && 'running' in info.details_job);
  const ps5 = (await call('/api/digital/games?store=ps5')).body;
  assert.equal(ps5.total, 1); assert.equal(ps5.items[0].name, 'Astro Bot'); assert.equal(ps5.items[0].launch_url, null); assert.equal(ps5.items[0].country, 'AU');
  assert.equal((await call('/api/digital/games/ps5/astro-bot/mark', { method: 'PUT', body: { field: 'play', value: true } })).status, 400);
  assert.equal((await call('/api/digital/games/ps5/astro-bot/mark', { method: 'PUT', body: { field: 'favourite', value: true } })).status, 200);
  assert.equal((await call('/api/digital/games?favourites=1')).body.total, 1);
  const d = (await call('/api/digital/games/ps5/astro-bot')).body;
  assert.equal(d.game.store_label, 'PlayStation 5'); assert.equal(d.game.country_name, 'Australia');
  assert.equal(d.game.store_url, 'https://store.playstation.com/en-au/search/Astro%20Bot');
  assert.equal(d.details, null, 'no provider is set up in the tests, so nothing is found');
  assert.equal((await call('/api/digital/games/ps5/astro-bot', { token: annTok })).status, 404, 'another member does not see it');
  assert.equal((await call('/api/digital/games?store=ps5', { token: annTok })).body.total, 0);
});

test('a found cover is served to its owner only, and shows on the tile', async () => {
  const img = path.join(TMP, 'storage', 'cover-test.png');
  fs.mkdirSync(path.dirname(img), { recursive: true });
  fs.writeFileSync(img, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  await consoles.refreshConsoleDetails('xbox', 'halo-infinite-xsx', 'Halo Infinite', { platform: 'xsx', enrichImpl: async () => ({ title: 'Halo Infinite', developer: '343 Industries', cover_url: 'https://x/h.jpg', source: 'igdb' }), cacheImpl: async () => img });
  const tile = (await call('/api/digital/games?store=xbox')).body.items.find((g) => g.app_id === 'halo-infinite-xsx');
  assert.match(tile.cover_url, /^\/api\/digital\/cover\/xbox\/halo-infinite-xsx\?v=cover-test\.png$/);
  const res = await fetch(base + tile.cover_url, { headers: { Authorization: 'Bearer ' + adminTok } });
  assert.equal(res.status, 200);
  assert.equal((await fetch(base + tile.cover_url, { headers: { Authorization: 'Bearer ' + annTok } })).status, 404);
  const d = (await call('/api/digital/games/xbox/halo-infinite-xsx')).body;
  assert.equal(d.game.platform, 'xsx'); assert.equal(d.game.store_label, 'Xbox Series X|S');
  assert.deepEqual(d.details.developers, ['343 Industries']); assert.equal(d.game.cover_url, tile.cover_url);
});

test('replace removes games no longer in the file, only for platforms in the file; one game can be removed', async () => {
  const r = await call('/api/digital/consoles/import', { method: 'POST', body: { csv: 'Platform Name,Game Title\nXbox Series X|S,Halo Infinite', apply: true, replace: true } });
  assert.equal(r.body.removed, 2, 'the Xbox 360 and Xbox One games are not in the file');
  await consoles.detailsJobIdle();
  const stores = Object.fromEntries((await call('/api/digital')).body.stores.map((s) => [s.store, s.count]));
  assert.deepEqual(stores, { ps4: 1, ps5: 1, xbox: 1 });
  assert.equal((await call('/api/digital/games/ps4/ratchet-and-clank', { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/digital/games/ps4/ratchet-and-clank', { method: 'DELETE' })).status, 404);
  assert.equal((await call('/api/digital/games/steam/220', { method: 'DELETE' })).status, 400, 'Steam games come from Steam');
});

test('page: chips, badges, details window and the CSV tools box', () => {
  const app = read('public/app.js'), html = read('public/index.html'), css = read('public/modern.css');
  assert.match(html, /id="dgc-file"/); assert.match(html, /id="dgc-preview"/); assert.match(html, /id="dgc-apply"/); assert.match(html, /id="dgc-replace"/);
  assert.match(app, /function initConsoleImport\(/); assert.match(app, /\/digital\/consoles\/import/);
  assert.match(app, /data-store="\$\{esc\(g\.store\)\}"/);
  assert.match(app, /\/digital\/consoles\/details/);
  assert.match(css, /\.dg-badge:not\(\[data-store="steam"\]\)/);
});

test('Modern: the import box buttons are icons (Preview reuses preview-2, Import games uses csv-import); the icon follows the theme colour', () => {
  const js = read('public/modern.js'), svg = read('public/modern/icons/csv-import.svg');
  assert.match(js, /\['#dgc-preview', 'preview-2'\]/); assert.match(js, /\['#dgc-apply', 'csv-import'\]/);
  assert.match(svg, /stroke="currentColor"/); assert.doesNotMatch(svg, /#000|<style|<title/);
});

test('Xbox consoles: each is looked up as its own Library platform, and older Xbox rows are taken over by the next import', async () => {
  const asked = {};
  for (const p of ['x360', 'xone', 'xsx', 'xbox']) { asked[p] = []; await consoles.lookupConsoleGame('xbox', 'Halo', async (q) => { asked[p].push(q.platform.slug); return null; }, p); }
  assert.deepEqual(asked, { x360: ['xbox360'], xone: ['xboxone', 'xboxseries'], xsx: ['xboxseries', 'xboxone'], xbox: ['xbox'] });
  assert.equal(consoles.platformLabel('xbox', 'xsx'), 'Xbox Series X|S'); assert.equal(consoles.platformLabel('xbox', null), 'Xbox'); assert.equal(consoles.platformLabel('ps4'), 'PlayStation 4');
  // A row from before consoles were told apart: plain id, no console.
  const uid = db.prepare("SELECT id FROM users WHERE username = 'cadmin'").get().id;
  db.prepare("INSERT INTO digital_games (user_id, store, app_id, name) VALUES (?, 'xbox', 'gears-5', 'Gears 5')").run(uid);
  const pre = await call('/api/digital/consoles/import', { method: 'POST', body: { csv: 'Platform,Game\nXbox One,Gears 5\nXbox Series X|S,Gears 5' } });
  assert.equal(pre.body.updated, 1, 'the old row is adopted'); assert.equal(pre.body.added, 1, 'the second console is a new game');
  await call('/api/digital/consoles/import', { method: 'POST', body: { csv: 'Platform,Game\nXbox One,Gears 5\nXbox Series X|S,Gears 5', apply: true } });
  await consoles.detailsJobIdle();
  const rows = db.prepare("SELECT app_id, platform FROM digital_games WHERE store = 'xbox' AND name = 'Gears 5' ORDER BY app_id").all();
  assert.deepEqual(rows, [{ app_id: 'gears-5', platform: 'xone' }, { app_id: 'gears-5-xsx', platform: 'xsx' }]);
});

test('the badges: XBOX, XBOX 360, XBOX ONE and X|S on the one Xbox chip', () => {
  const app = read('public/app.js');
  assert.match(app, /xsx: \{ label: 'Xbox Series X\|S', short: 'X\|S' \}/);
  assert.match(app, /x360: \{ label: 'Xbox 360', short: 'XBOX 360' \}/);
  assert.match(app, /xone: \{ label: 'Xbox One', short: 'XBOX ONE' \}/);
  assert.match(app, /data-platform="\$\{esc\(g\.platform \|\| 'xbox'\)\}"/);
  for (const f of ['public/styles.css', 'public/modern.css']) for (const p of ['x360', 'xone', 'xsx']) assert.match(read(f), new RegExp(`data-platform="${p}"`), f);
  assert.match(read('public/index.html'), /<code>Platform<\/code>, <code>Game<\/code> and <code>Country<\/code>/);
});
