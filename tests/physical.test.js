import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-physical-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'padmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'p-admin-password-1';

let server, base, adminTok, annTok, db, phys, adminId;
const call = async (p, { method = 'GET', body, token = adminTok } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  phys = await import('../src/lib/physical.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  adminTok = await login('padmin', 'p-admin-password-1');
  adminId = db.prepare("SELECT id FROM users WHERE username = 'padmin'").get().id;
  await call('/api/auth/users', { method: 'POST', body: { username: 'ann', password: 'ann-password-12', role: 'user' } });
  annTok = await login('ann', 'ann-password-12');
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('platform names in a CSV resolve to Library platforms (slugs, names, short names, common spellings)', () => {
  assert.equal(phys.resolvePlatform('SNES'), 'snes');
  assert.equal(phys.resolvePlatform('Super Nintendo'), 'snes');
  assert.equal(phys.resolvePlatform('Mega Drive'), 'genesis');
  assert.equal(phys.resolvePlatform('Sega Genesis / Mega Drive'), 'genesis');
  assert.equal(phys.resolvePlatform('PSX'), 'ps1');
  assert.equal(phys.resolvePlatform('PS2'), 'ps2');
  assert.equal(phys.resolvePlatform('Xbox 360'), 'xbox360');
  assert.equal(phys.resolvePlatform('PS5 Pro'), 'ps5');
  assert.equal(phys.resolvePlatform('Game Boy Advance'), 'gba');
  assert.equal(phys.resolvePlatform('not a console'), null);
  assert.equal(phys.resolvePlatform(''), null);
});

const CSV = 'Platform,Game,Region,Notes\nSNES,Super Mario World,PAL,boxed\nMega Drive,Sonic the Hedgehog,,\nPS2,Gran Turismo 4,PAL,\nSNES,Super Mario World,PAL,duplicate row\nAmiga 9000,Nope,,\nPS2,,,\n';

test('import: the preview saves nothing; applying adds, counts repeats and skips, and a re-import changes nothing', async () => {
  const pre = await call('/api/physical/import', { method: 'POST', body: { csv: CSV } });
  assert.equal(pre.status, 200);
  assert.equal(pre.body.applied, false); assert.equal(pre.body.games, 3); assert.equal(pre.body.added, 3);
  assert.equal(pre.body.duplicates, 1); assert.equal(pre.body.skipped, 2);
  assert.ok(pre.body.problems.some((p) => /Unknown platform/.test(p.reason)));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM physical_games').get().n, 0);

  const ok = await call('/api/physical/import', { method: 'POST', body: { csv: CSV, apply: true } });
  assert.equal(ok.body.added, 3);
  await phys.matchJobIdle();
  const again = await call('/api/physical/import', { method: 'POST', body: { csv: CSV, apply: true } });
  assert.equal(again.body.added, 0); assert.equal(again.body.unchanged, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM physical_games').get().n, 3);
});

test('import: a CSV without the right columns is refused with a plain reason', async () => {
  const r = await call('/api/physical/import', { method: 'POST', body: { csv: 'Foo,Bar\n1,2\n' } });
  assert.equal(r.status, 400); assert.match(r.body.error, /Platform, Game/);
  assert.equal((await call('/api/physical/import', { method: 'POST', body: { csv: '' } })).status, 400);
});

test('listing: platform chips with counts, platform filter, search, sort and letters', async () => {
  const info = (await call('/api/physical')).body;
  assert.deepEqual(info.platforms.map((p) => p.slug).sort(), ['genesis', 'ps2', 'snes']);
  assert.equal(info.counts.total, 3);
  assert.ok(info.platforms.every((p) => p.family && p.name), 'family and name come from the Library platform table');
  const snes = (await call('/api/physical/games?platforms=snes')).body;
  assert.equal(snes.total, 1); assert.equal(snes.items[0].title, 'Super Mario World');
  assert.equal((await call('/api/physical/games?platforms=snes,ps2')).body.total, 2);
  assert.equal((await call('/api/physical/games?q=sonic')).body.total, 1);
  assert.equal((await call('/api/physical/games?q=pal')).body.total, 2, 'search reads the region');
  const all = (await call('/api/physical/games')).body;
  assert.deepEqual(all.items.map((g) => g.title), ['Gran Turismo 4', 'Sonic the Hedgehog', 'Super Mario World']);
  assert.equal(all.letters.G, 1); assert.equal(all.letters.S, 2);
  assert.equal((await call('/api/physical/games?letter=G')).body.total, 1);
});

test('each person has their own shelf', async () => {
  assert.equal((await call('/api/physical/games', { token: annTok })).body.total, 0);
  const mine = (await call('/api/physical/games')).body.items[0];
  assert.equal((await call(`/api/physical/games/${mine.id}`, { token: annTok })).status, 404);
  assert.equal((await call(`/api/physical/games/${mine.id}`, { method: 'DELETE', token: annTok })).status, 404);
  assert.equal((await call(`/api/physical/games/${mine.id}`, { method: 'PATCH', token: annTok, body: { title: 'Mine now' } })).status, 404);
});

test('adding by hand, editing, favouriting and removing', async () => {
  assert.equal((await call('/api/physical/games', { method: 'POST', body: { platform: 'zzz', title: 'X' } })).status, 400);
  const g = await call('/api/physical/games', { method: 'POST', body: { platform: 'Game Boy', title: 'Tetris', region: 'EU', year: 1989 } });
  assert.equal(g.status, 201); assert.equal(g.body.platform, 'gb'); assert.equal(g.body.release_year, 1989);
  assert.equal((await call('/api/physical/games', { method: 'POST', body: { platform: 'gb', title: 'tetris', region: 'eu' } })).status, 409, 'the same game twice');
  const up = await call(`/api/physical/games/${g.body.id}`, { method: 'PATCH', body: { favourite: true, notes: 'Boxed, manual', rating: 4, genre: 'Puzzle' } });
  assert.equal(up.status, 200); assert.equal(up.body.favourite, true); assert.equal(up.body.rating, 4);
  assert.equal((await call(`/api/physical/games/${g.body.id}`, { method: 'PATCH', body: { rating: 9 } })).status, 400);
  assert.equal((await call('/api/physical/games?favourites=1')).body.total, 1);
  assert.equal((await call(`/api/physical/games/${g.body.id}`, { method: 'DELETE' })).body.removed, true);
  assert.equal((await call(`/api/physical/games/${g.body.id}`)).status, 404);
  await phys.matchJobIdle();
});

test('a chosen match fills the details and the cover; clearing it empties them again', async () => {
  const g = (await call('/api/physical/games?q=sonic')).body.items[0];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const cacheImpl = async () => { const f = path.join(TMP, 'cover.png'); fs.writeFileSync(f, png); return f; };
  const m = await phys.applyMatch(adminId, g.id, { title: 'Sonic The Hedgehog', developer: 'Sonic Team', publisher: 'Sega', genre: 'Platformer', release_year: 1991, players: 1, rating: 4.2, description: 'A fast blue hedgehog.', cover_url: 'http://x/y.png', source: 'thegamesdb' }, { cacheImpl });
  assert.equal(m.matched, true); assert.equal(m.developer, 'Sonic Team'); assert.equal(m.release_year, 1991); assert.equal(m.has_cover, true);
  assert.equal(m.title, 'Sonic the Hedgehog', 'the person\'s own title is kept');
  const res = await fetch(base + m.cover_url, { headers: { Authorization: 'Bearer ' + adminTok } });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type') || '', /image\/png/);
  assert.equal((await fetch(base + m.cover_url, { headers: { Authorization: 'Bearer ' + annTok } })).status, 404, 'a cover is only served to its owner');
  assert.equal((await call('/api/physical/games?nocover=1')).body.total, 2);
  const cleared = await call(`/api/physical/games/${g.id}/match`, { method: 'DELETE' });
  assert.equal(cleared.body.matched, false); assert.equal(cleared.body.has_cover, false); assert.equal(cleared.body.developer, null);
});

test('the route takes the candidate the identify search returns', async () => {
  const g = (await call('/api/physical/games?q=gran')).body.items[0];
  assert.equal((await call(`/api/physical/games/${g.id}/match`, { method: 'POST', body: {} })).status, 400);
  const r = await call(`/api/physical/games/${g.id}/match`, { method: 'POST', body: { candidate: { title: 'Gran Turismo 4', publisher: 'Sony', release_year: 2004, source: 'igdb' } } });
  assert.equal(r.status, 200); assert.equal(r.body.publisher, 'Sony'); assert.equal(r.body.meta_source, 'igdb'); assert.equal(r.body.matched, true);
});

test('the background lookup finds a match, and stamps games nothing was found for so they are not asked again', async () => {
  await phys.matchJobIdle();
  db.prepare('DELETE FROM physical_games').run();
  const stub = { enrichImpl: async () => null, cacheImpl: async () => null };
  phys.addPhysical(adminId, { platform: 'snes', title: 'Found Game' }); phys.addPhysical(adminId, { platform: 'snes', title: 'Lost Game' });
  await phys.matchJobIdle();   // the run the two adds started (real providers, none configured in a test)
  db.prepare('UPDATE physical_games SET meta_source = NULL, meta_tried_at = NULL, cover_path = NULL').run();
  const asked = [];
  const enrichImpl = async ({ title, platform }) => { asked.push(`${platform.slug}:${title}`); return title === 'Found Game' ? { title, publisher: 'Nintendo', release_year: 1992, source: 'stub' } : null; };
  phys.startMatchJob({ ...stub, enrichImpl });
  await phys.matchJobIdle();
  assert.deepEqual(asked.sort(), ['snes:Found Game', 'snes:Lost Game']);
  const rows = Object.fromEntries(db.prepare('SELECT title, meta_source, meta_tried_at, publisher FROM physical_games').all().map((r) => [r.title, r]));
  assert.equal(rows['Found Game'].meta_source, 'stub'); assert.equal(rows['Found Game'].publisher, 'Nintendo');
  assert.equal(rows['Lost Game'].meta_source, null); assert.ok(rows['Lost Game'].meta_tried_at);
  asked.length = 0;
  phys.startMatchJob({ ...stub, enrichImpl }); await phys.matchJobIdle();
  assert.deepEqual(asked, [], 'nothing is asked twice');
  phys.startMatchJob({ retry: true, ...stub, enrichImpl }); await phys.matchJobIdle();
  assert.deepEqual(asked, ['snes:Lost Game'], 'retry asks about the ones nothing was found for');
});

test('replace removes shelf games the file no longer lists, only on platforms the file names', async () => {
  await phys.matchJobIdle();
  db.prepare('DELETE FROM physical_games').run();
  await call('/api/physical/import', { method: 'POST', body: { csv: 'Platform,Game\nSNES,A\nSNES,B\nPS2,C\n', apply: true } });
  await phys.matchJobIdle();
  const r = await call('/api/physical/import', { method: 'POST', body: { csv: 'Platform,Game\nSNES,A\n', apply: true, replace: true } });
  assert.equal(r.body.removed, 1);
  assert.deepEqual(db.prepare('SELECT title FROM physical_games ORDER BY title').all().map((x) => x.title), ['A', 'C']);
  await phys.matchJobIdle();
});

const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('the Physical page: nav entries, view, CSV destination choice, shelf and tiles, and the app wiring', () => {
  const html = read('public/index.html'), app = read('public/app.js'), ph = read('public/physical.js'), css = read('public/physical.css'), modern = read('public/modern.js');
  assert.match(html, /data-view="physical"/); assert.match(html, /id="view-physical"/); assert.match(html, /href="\/physical\.css/);
  for (const id of ['ph-chips', 'ph-q', 'ph-sort', 'ph-shelf', 'ph-tiles', 'ph-letters']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /data-ph-view="tiles"/); assert.match(html, /data-ph-view="shelf"/);
  // CSV tools: one box, a Digital / Physical choice
  assert.match(html, /name="dgc-dest" value="digital"/); assert.match(html, /name="dgc-dest" value="physical"/);
  assert.match(app, /\/physical\/import/); assert.match(app, /physical\.importSummary/);
  // wired into the app like Digital: view switch, details window state, previous / next, saved view, Modern bar
  assert.match(app, /import \* as physical from '\.\/physical\.js'/); assert.match(app, /if \(view === 'physical'\) physical\.load\(\);/);
  assert.match(app, /return physical\.step\(dir\);/); assert.match(app, /state\.openPhysical = null; physical\.forgetOpen\(\);/);
  assert.match(app, /'digital', 'physical'\]\.includes\(saved\.view\)/);
  assert.match(modern, /view: 'physical', icon: 'physical-shelf'/); assert.ok(fs.existsSync(new URL('../public/modern/icons/physical-shelf.svg', import.meta.url)));
  assert.match(read('public/styles.css'), /body\.play-only \.nav-item\[data-view="physical"\]/);
  // chips mirror the Library's (families, then platforms of the open family, several at once); identify uses the Library's search
  assert.match(ph, /data-ph-chip-fam/); assert.match(ph, /data-ph-chip-plat/); assert.match(ph, /'\/metadata\/search'/); assert.match(ph, /\/physical\/games\/\$\{id\}\/match/);
  // the shelf: spines that pull out and turn to show the cover, plates by platform, no cover fetched until a game is opened
  assert.match(ph, /classList\.add\('is-open'\)/); assert.match(css, /\.ph-spine\.is-open \{ width: 118px;/); assert.match(css, /@keyframes ph-drop/);
  assert.match(css, /prefers-reduced-motion/); assert.match(ph, /ROWS_AT_A_TIME/);
  const spine = ph.slice(ph.indexOf('function spineHtml'), ph.indexOf('const rowHtml'));
  assert.ok(spine.length > 200 && !spine.includes('<img'), 'the spine markup holds no picture: covers load only for the opened game');
});
