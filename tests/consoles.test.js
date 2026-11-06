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
  'PS3,Uncharted 2,AU',
  'Switch 2,Mario Kart World,Japan',
  'Sega Saturn,Nights,Japan',
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
  for (const [t, s] of [['PS4', 'playstation'], ['PlayStation 4', 'playstation'], ['Sony PlayStation 5', 'playstation'], ['ps3', 'playstation'], ['Xbox', 'xbox'], ['Xbox One', 'xbox'], ['Xbox 360', 'xbox'], ['Xbox Series X|S', 'xbox'], ['XSX', 'xbox'], ['Switch', 'nintendo'], ['Nintendo 3DS', 'nintendo'], ['Sega Saturn', null], ['', null]]) assert.equal(consoles.storeFor(t), s, t);
  for (const [t, p] of [['Xbox', 'xbox'], ['XBOX', 'xbox'], ['Microsoft Xbox', 'xbox'], ['Xbox 360', 'x360'], ['XBOX360', 'x360'], ['X360', 'x360'], ['Xbox One', 'xone'], ['XBOX ONE X', 'xone'], ['XB1', 'xone'],
    ['Xbox Series X|S', 'xsx'], ['XBOX SERIES X|S', 'xsx'], ['X|S', 'xsx'], ['Xbox Series X', 'xsx'], ['XSX', 'xsx']]) assert.deepEqual(consoles.platformFor(t), { store: 'xbox', platform: p }, t);
  for (const [t, p] of [['PS3', 'ps3'], ['PlayStation 3', 'ps3'], ['PS4', 'ps4'], ['Sony PlayStation 4 Pro', 'ps4'], ['PS5', 'ps5'], ['PlayStation 5', 'ps5']]) assert.deepEqual(consoles.platformFor(t), { store: 'playstation', platform: p }, t);
  for (const [t, p] of [['Switch 2', 'switch2'], ['Nintendo Switch 2', 'switch2'], ['Switch', 'switch'], ['Nintendo Switch', 'switch'], ['Switch Lite', 'switch'], ['Switch OLED', 'switch'], ['Wii', 'wii'], ['Nintendo Wii', 'wii'],
    ['Wii U', 'wiiu'], ['WiiU', 'wiiu'], ['3DS', '3ds'], ['Nintendo 3DS', '3ds'], ['New 3DS XL', '3ds'], ['2DS', '3ds'], ['DS', 'ds'], ['Nintendo DS', 'ds'], ['NDS', 'ds'], ['DSi', 'ds'], ['DS Lite', 'ds']]) assert.deepEqual(consoles.platformFor(t), { store: 'nintendo', platform: p }, t);
  assert.deepEqual(consoles.countryFor('Australia'), { code: 'AU', name: 'Australia', locale: 'en-au' });
  assert.equal(consoles.countryFor('au').code, 'AU'); assert.equal(consoles.countryFor('UK').code, 'GB'); assert.equal(consoles.countryFor('USA').code, 'US');
  assert.deepEqual(consoles.countryFor('Atlantis'), { code: null, name: 'Atlantis', locale: null });
  assert.equal(consoles.countryFor(''), null);
  assert.equal(consoles.appIdFor('Ratchet & Clank: Rift Apart'), 'ratchet-and-clank-rift-apart');
  assert.equal(consoles.appIdFor('Pokémon'), 'pokemon');
  assert.equal(consoles.storeUrl('playstation', 'Astro Bot', 'AU'), 'https://store.playstation.com/en-au/search/Astro%20Bot');
  assert.equal(consoles.storeUrl('nintendo', 'Zelda', 'AU'), null);
  assert.equal(consoles.storeUrl('xbox', 'Halo', 'GB'), 'https://www.xbox.com/en-GB/search/results/games?q=Halo');
  assert.equal(consoles.storeUrl('playstation', 'X', null), 'https://store.playstation.com/en-us/search/X');
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
  const r = await consoles.lookupConsoleGame('playstation', 'Something', fake, 'ps5');
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
  assert.equal(pre.body.games, 7); assert.equal(pre.body.added, 7); assert.equal(pre.body.duplicates, 1); assert.equal(pre.body.skipped, 2);
  assert.deepEqual(pre.body.by_store, { playstation: 3, nintendo: 1, xbox: 3 });
  assert.ok(pre.body.problems.some((p) => /Unknown platform "Sega Saturn"/.test(p.reason)));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM digital_games WHERE store != 'steam'").get().n, 0, 'preview saved nothing');

  const r = await call('/api/digital/consoles/import', { method: 'POST', body: { csv: CSV, apply: true } });
  assert.equal(r.body.applied, true); assert.equal(r.body.added, 7);
  await consoles.detailsJobIdle();
  const again = await call('/api/digital/consoles/import', { method: 'POST', body: { csv: CSV, apply: true } });
  assert.equal(again.body.added, 0); assert.equal(again.body.unchanged, 7, 'importing the same file twice adds nothing');
  await consoles.detailsJobIdle();
  const country = db.prepare("SELECT country FROM digital_games WHERE store = 'xbox' AND app_id = 'forza-horizon-5-xone'").get().country;
  assert.equal(country, 'GB');
  const plats = db.prepare("SELECT app_id, platform FROM digital_games WHERE store = 'xbox' ORDER BY app_id").all();
  assert.deepEqual(plats, [{ app_id: 'forza-horizon-5-xone', platform: 'xone' }, { app_id: 'halo-infinite-x360', platform: 'x360' }, { app_id: 'halo-infinite-xsx', platform: 'xsx' }], 'the same title on two consoles is two games');
});

test('list, chips, marks and the details window for console games; no play button', async () => {
  const info = (await call('/api/digital')).body;
  assert.deepEqual(info.stores.map((s) => [s.store, s.label]), [['nintendo', 'Nintendo'], ['playstation', 'PlayStation'], ['xbox', 'Xbox']]);
  assert.ok(info.details_job && 'running' in info.details_job);
  const psn = (await call('/api/digital/games?store=playstation')).body, ps5 = { items: psn.items.filter((g) => g.platform === 'ps5') };
  assert.equal(psn.total, 3); assert.equal(ps5.items.length, 1); assert.equal(ps5.items[0].name, 'Astro Bot'); assert.equal(ps5.items[0].app_id, 'astro-bot-ps5'); assert.equal(ps5.items[0].launch_url, null); assert.equal(ps5.items[0].country, 'AU');
  assert.equal((await call('/api/digital/games/playstation/astro-bot-ps5/mark', { method: 'PUT', body: { field: 'play', value: true } })).status, 400);
  assert.equal((await call('/api/digital/games/playstation/astro-bot-ps5/mark', { method: 'PUT', body: { field: 'favourite', value: true } })).status, 200);
  assert.equal((await call('/api/digital/games?favourites=1')).body.total, 1);
  const d = (await call('/api/digital/games/playstation/astro-bot-ps5')).body;
  assert.equal(d.game.store_label, 'PlayStation 5'); assert.equal(d.game.country_name, 'Australia');
  assert.equal(d.game.store_url, 'https://store.playstation.com/en-au/search/Astro%20Bot');
  assert.equal(d.details, null, 'no provider is set up in the tests, so nothing is found');
  assert.equal((await call('/api/digital/games/playstation/astro-bot-ps5', { token: annTok })).status, 404, 'another member does not see it');
  assert.equal((await call('/api/digital/games?store=playstation', { token: annTok })).body.total, 0);
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
  assert.deepEqual(stores, { nintendo: 1, playstation: 3, xbox: 1 });
  assert.equal((await call('/api/digital/games/playstation/ratchet-and-clank-ps4', { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/digital/games/playstation/ratchet-and-clank-ps4', { method: 'DELETE' })).status, 404);
  assert.equal((await call('/api/digital/games/steam/220', { method: 'DELETE' })).status, 400, 'Steam games come from Steam');
});

test('page: chips, badges, details window and the CSV tools box', () => {
  const app = read('public/app.js'), html = read('public/index.html'), css = read('public/modern.css');
  assert.match(html, /id="dgc-file"/); assert.match(html, /id="dgc-preview"/); assert.match(html, /id="dgc-apply"/); assert.match(html, /id="dgc-replace"/);
  assert.match(app, /function initConsoleImport\(/); assert.match(app, /\/digital\/consoles\/import/);
  assert.match(app, /data-store="\$\{esc\(g\.store\)\}"/);
  assert.match(app, /playstation: \{ label: 'PlayStation'/); assert.match(app, /nintendo: \{ label: 'Nintendo'/);
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
  assert.equal(consoles.platformLabel('xbox', 'xsx'), 'Xbox Series X|S'); assert.equal(consoles.platformLabel('xbox', null), 'Xbox'); assert.equal(consoles.platformLabel('playstation', 'ps4'), 'PlayStation 4'); assert.equal(consoles.platformLabel('playstation'), 'PlayStation'); assert.equal(consoles.platformLabel('nintendo', '3ds'), 'Nintendo 3DS'); assert.equal(consoles.platformLabel('xbox', 'ps4'), 'Xbox');
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
  assert.match(app, /data-platform="\$\{esc\(g\.platform \|\| \(g\.store === 'xbox' \? 'xbox' : ''\)\)\}"/);
  for (const f of ['public/styles.css', 'public/modern.css']) for (const p of ['x360', 'xone', 'xsx']) assert.match(read(f), new RegExp(`data-platform="${p}"`), f);
  assert.match(read('public/index.html'), /<code>Platform<\/code>, <code>Game<\/code> and <code>Country<\/code>/);
});

test('PlayStation and Nintendo: one chip each, a badge per console, each console looked up as its own Library platform', async () => {
  const app = read('public/app.js');
  for (const [k, short] of [['ps3', 'PS3'], ['ps4', 'PS4'], ['ps5', 'PS5'], ['switch2', 'SWITCH 2'], ['switch', 'SWITCH'], ['wii', 'WII'], ['wiiu', 'WII U'], ["'3ds'", '3DS'], ['ds', 'DS']]) {
    assert.match(app, new RegExp(`${k}: \\{ label: '[^']+', short: '${short}' \\}`), k);
    assert.equal(consoles.CONSOLE_PLATFORMS[k.replace(/'/g, '')].badge, short);
  }
  for (const f of ['public/styles.css', 'public/modern.css']) for (const p of ['ps3', 'ps4', 'ps5', 'switch2', 'switch', 'wii', 'wiiu', '3ds', 'ds']) assert.match(read(f), new RegExp(`data-platform="${p}"`), f + ' ' + p);
  const asked = {};
  for (const [store, p] of [['playstation', 'ps3'], ['nintendo', 'switch2'], ['nintendo', 'wiiu'], ['nintendo', '3ds'], ['nintendo', 'ds'], ['nintendo', 'wii']]) {
    asked[p] = []; await consoles.lookupConsoleGame(store, 'X', async (q) => { asked[p].push(q.platform.slug); return null; }, p);
  }
  assert.deepEqual(asked, { ps3: ['ps3'], switch2: ['switch2', 'switch'], wiiu: ['wiiu'], '3ds': ['3ds'], ds: ['nds'], wii: ['wii'] });
  const html = read('public/index.html');
  for (const t of ['PS3', 'Switch 2', 'Wii U', '3DS', '<b>DS</b>', 'Nintendo']) assert.ok(html.includes(t), t);
});

test('migration: PlayStation 4 and 5 games move to the one PlayStation store with their marks and details', async () => {
  const { mergePlaystationStores } = await import('../src/migrations.js');
  const uid = db.prepare("SELECT id FROM users WHERE username = 'cadmin'").get().id;
  db.prepare("INSERT INTO digital_games (user_id, store, app_id, name) VALUES (?, 'ps4', 'bloodborne', 'Bloodborne'), (?, 'ps5', 'bloodborne', 'Bloodborne')").run(uid, uid);
  db.prepare("INSERT INTO digital_marks (user_id, store, app_id, favourite) VALUES (?, 'ps4', 'bloodborne', 1)").run(uid);
  db.prepare("INSERT INTO digital_details (store, app_id, json, found) VALUES ('ps5', 'bloodborne', '{}', 1)").run();
  mergePlaystationStores(); mergePlaystationStores();   // running it again changes nothing
  const rows = db.prepare("SELECT store, app_id, platform FROM digital_games WHERE name = 'Bloodborne' ORDER BY app_id").all();
  assert.deepEqual(rows, [{ store: 'playstation', app_id: 'bloodborne-ps4', platform: 'ps4' }, { store: 'playstation', app_id: 'bloodborne-ps5', platform: 'ps5' }]);
  assert.equal(db.prepare("SELECT favourite FROM digital_marks WHERE store = 'playstation' AND app_id = 'bloodborne-ps4'").get().favourite, 1);
  assert.ok(db.prepare("SELECT 1 FROM digital_details WHERE store = 'playstation' AND app_id = 'bloodborne-ps5'").get());
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM digital_games WHERE store IN ('ps4', 'ps5')").get().n, 0);
  db.prepare("DELETE FROM digital_games WHERE name = 'Bloodborne'").run();
});

test('disc / cartridge switch: console games only, private, kept in the list; the tile uses the Platforms icons', async () => {
  const mk = (store, id, value, token) => call(`/api/digital/games/${store}/${id}/mark`, { method: 'PUT', body: { field: 'physical', value }, token });
  assert.equal((await mk('playstation', 'astro-bot-ps5', true)).status, 200);
  assert.equal((await mk('nintendo', 'mario-kart-world-switch2', true)).status, 200);
  assert.equal((await mk('steam', '220', true)).status, 400, 'Steam games have no disc switch');
  assert.equal((await mk('playstation', 'astro-bot-ps5', true, annTok)).status, 404, 'not another member\'s game');
  const on = (await call('/api/digital/games')).body.items.filter((g) => g.physical).map((g) => g.app_id).sort();
  assert.deepEqual(on, ['astro-bot-ps5', 'mario-kart-world-switch2']);
  assert.equal((await mk('playstation', 'astro-bot-ps5', false)).body.physical, 0);
  const app = read('public/app.js');
  assert.match(app, /DG_CARTRIDGE = new Set\(\['switch2', 'switch', '3ds', 'ds'\]\)/); assert.match(app, /data-dg-mark="physical"/);
  assert.match(app, /platformIconSvg\(\{ icon: type \}/);
  assert.match(read('public/styles.css'), /\.dg-media\.on/);
});

test('CSV Media column: DISC / CART switch the icon on, DIGITAL off, empty leaves it', async () => {
  const csv = 'Platform,Game,Country,Media\nPS5,Returnal,AU,DISC\nSwitch,Metroid Dread,AU,cart\nXbox One,Sea of Thieves,AU,\nPS5,Astro Bot,AU,DIGITAL\nPS4,Bloodborne,AU,maybe';
  const mark = (id) => db.prepare("SELECT physical FROM digital_marks WHERE app_id = ?").get(id)?.physical;
  await call('/api/digital/consoles/import', { method: 'POST', body: { csv: 'Platform,Game\nPS5,Astro Bot', apply: true } });
  await call('/api/digital/games/playstation/astro-bot-ps5/mark', { method: 'PUT', body: { field: 'physical', value: true } });
  const pre = await call('/api/digital/consoles/import', { method: 'POST', body: { csv } });
  assert.equal(pre.body.physical_on, 2); assert.equal(pre.body.physical_off, 1);
  assert.ok(pre.body.problems.some((p) => /Media "maybe" not understood/.test(p.reason)));
  assert.equal(mark('returnal-ps5'), undefined, 'preview saves nothing');
  await call('/api/digital/consoles/import', { method: 'POST', body: { csv, apply: true } });
  await consoles.detailsJobIdle();
  assert.equal(mark('returnal-ps5'), 1); assert.equal(mark('metroid-dread-switch'), 1); assert.equal(mark('astro-bot-ps5'), 0);
  assert.equal(mark('sea-of-thieves-xone'), undefined, 'empty leaves it alone');
  await call('/api/digital/games/playstation/returnal-ps5/mark', { method: 'PUT', body: { field: 'physical', value: false } });
  await call('/api/digital/consoles/import', { method: 'POST', body: { csv: 'Platform,Game,Country,Media\nPS5,Returnal,AU,', apply: true } });
  assert.equal(mark('returnal-ps5'), 0, 'a re-import with the cell empty does not change a hand-set switch');
  assert.match(read('public/index.html'), /<code>Media<\/code>/);
});
