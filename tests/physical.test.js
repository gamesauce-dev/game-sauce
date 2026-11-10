import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

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
  assert.match(html, /data-ph-density="comfortable"/); assert.match(html, /data-ph-density="compact"/); assert.match(html, /data-ph-view="shelf"/); assert.match(html, /id="ph-top"/);
  assert.match(html, /id="ph-heading"/); assert.doesNotMatch(html, /id="ph-total"/, 'no total above the search: the heading carries it'); assert.doesNotMatch(html, /id="ph-views"/);
  // CSV tools: one box, a Digital / Physical choice
  assert.match(html, /name="dgc-dest" value="digital"/); assert.match(html, /name="dgc-dest" value="physical"/);
  assert.match(app, /\/physical\/import/); assert.match(app, /physical\.importSummary/);
  // wired into the app like Digital: view switch, details window state, previous / next, saved view, Modern bar
  assert.match(app, /import \* as physical from '\.\/physical\.js'/); assert.match(app, /if \(view === 'physical'\) physical\.load\(\);/);
  assert.match(app, /return physical\.step\(dir\);/); assert.match(app, /state\.openPhysical = null; physical\.forgetOpen\(\);/);
  assert.match(app, /'digital', 'physical', 'messages'\]\.includes\(saved\.view\)/);
  assert.match(modern, /view: 'physical', icon: 'physical-shelf'/); assert.ok(fs.existsSync(new URL('../public/modern/icons/physical-shelf.svg', import.meta.url)));
  assert.match(read('public/styles.css'), /body\.play-only \.nav-item\[data-view="physical"\]/);
  // chips mirror the Library's (families, then platforms of the open family, several at once); identify uses the Library's search
  assert.match(ph, /data-ph-chip-fam/); assert.match(ph, /data-ph-chip-plat/); assert.match(read('public/identify.js'), /'\/metadata\/search'/); assert.match(ph, /wireIdentify\(body, \{ idp: 'ph'/); assert.match(ph, /\/physical\/games\/\$\{id\}\/match/);
  // the shelf: spines that pull out and turn to show the cover, plates by platform, no cover fetched until a game is opened
  assert.match(ph, /classList\.add\('is-open'\)/); assert.match(css, /\.ph-spine\.is-open \{ width: var\(--ow, 118px\);/); assert.match(css, /@keyframes ph-drop/);
  assert.match(css, /prefers-reduced-motion/); assert.match(ph, /ROWS_AT_A_TIME/);
  const spine = ph.slice(ph.indexOf('function spineHtml'), ph.indexOf('const rowHtml'));
  assert.ok(spine.length > 200 && (spine.match(/<img/g) || []).length === 1 && spine.includes('class="ph-sp-art"'), 'the only picture in a spine is its own spine art: covers load only for the opened game');
});

test('Modern: the Physical page uses icons with hover words (reusing the icon set); Classic keeps its words', () => {
  const modern = read('public/modern.js'), mcss = read('public/modern.css'), ph = read('public/physical.js');
  for (const [sel, icon] of [['[data-ph-toggle="fav"]', 'favourite'], ['[data-ph-toggle="nocover"]', 'no-covers-2'], ['[data-ph-toggle="unmatched"]', 'issue'], ['[data-ph-act="lookup"]', 'fetch-metadata-3'], ['[data-ph-act="import"]', 'csv-import'], ['[data-ph-act="add"]', 'game-add'], ['#ph-id-go', 'search'], ['#ph-edit button[type="submit"]', 'save']]) {
    assert.ok(modern.includes(`['${sel.startsWith('#ph-') || sel.startsWith('#ph-edit') ? sel : '#view-physical ' + sel}', '${icon}']`), sel);
    assert.ok(fs.existsSync(new URL(`../public/modern/icons/${icon}.svg`, import.meta.url)), icon + '.svg is shipped');
  }
  for (const icon of ['grid', 'grid-condensed', 'physical-shelf', 'back-to-top']) assert.ok(mcss.includes(`url(/modern/icons/${icon}.svg)`), icon);
  assert.match(mcss, /html\[data-theme="light"\] body\.ui-modern \.ph-row \{ background: linear-gradient\(180deg, #e8e9ef, #ffffff/);
  assert.match(mcss, /body\.ui-modern \.ph-pill\[data-mi\] small \{ display: none; \}/);
  // the words are kept for Classic and become the hover text, with the counts
  assert.match(ph, /title="Favourites: only your favourites \(\$\{n\(c\.favourites\)\}\)">★ Favourites/);
  assert.match(read('public/physical.css'), /#ph-id-q \{ padding-left: 0\.7143rem; \}/);
});

test('a match brings the spine picture; it is served only to its owner, counted, filterable and cleared with the match', async () => {
  await phys.matchJobIdle();
  db.prepare('DELETE FROM physical_games').run();
  const a = phys.addPhysical(adminId, { platform: 'ps2', title: 'Spine Game' }); const b = phys.addPhysical(adminId, { platform: 'ps2', title: 'Plain Game' });
  await phys.matchJobIdle();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const seen = [];
  const cacheImpl = async (url, kind) => { seen.push(kind + ':' + url); const f = path.join(TMP, kind + '.png'); fs.writeFileSync(f, png); return f; };
  const m = await phys.applyMatch(adminId, a.id, { title: 'Spine Game', publisher: 'X', cover_url: 'http://x/c.png', media: { box2d: 'http://x/c.png', spine: 'http://x/s.png' }, source: 'launchbox' }, { cacheImpl });
  assert.deepEqual(seen.sort(), ['box2d:http://x/c.png', 'spine:http://x/s.png']);
  assert.equal(m.has_spine, true); assert.match(m.spine_url, /^\/api\/physical\/spine\/\d+/);
  const res = await fetch(base + m.spine_url, { headers: { Authorization: 'Bearer ' + adminTok } });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type') || '', /image\/png/);
  assert.equal((await fetch(base + m.spine_url, { headers: { Authorization: 'Bearer ' + annTok } })).status, 404, 'only the owner');
  assert.equal((await call('/api/physical')).body.counts.spines, 1);
  const only = (await call('/api/physical/games?spine=1')).body;
  assert.equal(only.total, 1); assert.equal(only.items[0].title, 'Spine Game');
  assert.equal((await call('/api/physical/games')).body.items.find((g) => g.title === 'Plain Game').has_spine, false);
  const cleared = await call(`/api/physical/games/${a.id}/match`, { method: 'DELETE' });
  assert.equal(cleared.body.has_spine, false); assert.equal((await call('/api/physical')).body.counts.spines, 0);
  assert.equal(b.has_spine, false);
});

test('the lookup run adds a spine to a matched game without touching its details, and asks once', async () => {
  await phys.matchJobIdle();
  db.prepare('DELETE FROM physical_games').run();
  const g = phys.addPhysical(adminId, { platform: 'snes', title: 'Edited By Hand' });
  await phys.matchJobIdle();
  db.prepare("UPDATE physical_games SET meta_source = 'manual', genre = 'My own genre', spine_path = NULL, spine_tried_at = NULL, spine_url = NULL WHERE id = ?").run(g.id);
  const providers = await import('../src/lib/providers.js');
  const realEnabled = Object.getOwnPropertyDescriptor(providers.launchbox, 'enabled');
  Object.defineProperty(providers.launchbox, 'enabled', { get: () => true, configurable: true });   // as if the LaunchBox database were downloaded
  try {
    const asked = []; let enriched = 0;
    const spineImpl = async (r) => { asked.push(r.title); return 'http://x/spine.png'; };
    const cacheImpl = async () => { const f = path.join(TMP, 'sp2.png'); fs.writeFileSync(f, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')); return f; };
    phys.startMatchJob({ spineImpl, cacheImpl, enrichImpl: async () => { enriched++; return null; } }); await phys.matchJobIdle();
    assert.deepEqual(asked, ['Edited By Hand']); assert.equal(enriched, 0, 'a matched game is not looked up again, only its spine');
    const row = db.prepare('SELECT genre, meta_source, spine_path, spine_tried_at FROM physical_games WHERE id = ?').get(g.id);
    assert.equal(row.genre, 'My own genre'); assert.equal(row.meta_source, 'manual'); assert.ok(row.spine_path && row.spine_tried_at);
    asked.length = 0; phys.startMatchJob({ spineImpl, cacheImpl }); await phys.matchJobIdle();
    assert.deepEqual(asked, [], 'asked once');
    // a game with no spine anywhere is stamped, so it is not asked again either; retry asks again
    db.prepare("UPDATE physical_games SET spine_path = NULL, spine_url = NULL, spine_tried_at = NULL WHERE id = ?").run(g.id);
    const none = async (r) => { asked.push(r.title); return null; };
    phys.startMatchJob({ spineImpl: none, cacheImpl }); await phys.matchJobIdle();
    phys.startMatchJob({ spineImpl: none, cacheImpl }); await phys.matchJobIdle();
    assert.deepEqual(asked, ['Edited By Hand'], 'stamped after one try');
    phys.startMatchJob({ retry: true, spineImpl: none, cacheImpl }); await phys.matchJobIdle();
    assert.deepEqual(asked, ['Edited By Hand', 'Edited By Hand'], 'retry asks again');
  } finally { Object.defineProperty(providers.launchbox, 'enabled', realEnabled); }
});

test('the shelf draws a real spine when there is one and the drawn spine otherwise', () => {
  const ph = read('public/physical.js'), css = read('public/physical.css'), modern = read('public/modern.js');
  assert.match(ph, /class="ph-sp-art"/); assert.match(ph, /g\.has_spine \? ' has-art' : ''/); assert.match(ph, /function onSpineLoad\(e\)/);
  assert.match(ph, /spine\.classList\.add\('art-ok'\)/); assert.match(ph, /img\.remove\(\); spine\.classList\.remove\('has-art'\)/, 'a picture that fails to load is dropped: the drawn spine stays');
  assert.match(css, /\.ph-spine\.art-ok \.ph-sp-band, \.ph-spine\.art-ok \.ph-sp-title \{ display: none; \}/);
  assert.match(ph, /data-ph-toggle="spine"/); assert.match(ph, /params\.set\('spine', '1'\)/);
  assert.ok(modern.includes("['#view-physical [data-ph-toggle=\"spine\"]', 'covers']"));
  const spine = ph.slice(ph.indexOf('function spineHtml'), ph.indexOf('const rowHtml'));
  assert.ok(spine.includes('loading="lazy"'), 'spine pictures load only as the rows come into view');
});

/** A PNG of a given size (all-black), just big enough for a header reader. */
function pngOf(w, h) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('the shape of a picture is read from its file, and recorded so the shelf can size spines and pulled-out covers exactly', async () => {
  await phys.matchJobIdle();
  const thin = path.join(TMP, 'thin.png'), tall = path.join(TMP, 'tall.png');
  fs.writeFileSync(thin, pngOf(118, 1902)); fs.writeFileSync(tall, pngOf(1164, 1893));
  assert.equal(phys.imageAspect(thin), 0.062); assert.equal(phys.imageAspect(tall), 0.6149);
  assert.equal(phys.imageAspect(path.join(TMP, 'missing.png')), null); assert.equal(phys.imageAspect(__filename_of()), null, 'not a picture');
  db.prepare('DELETE FROM physical_games').run();
  const g = phys.addPhysical(adminId, { platform: 'switch', title: 'Thin Spine' });
  await phys.matchJobIdle();
  const files = { box2d: tall, spine: thin };
  const m = await phys.applyMatch(adminId, g.id, { title: 'Thin Spine', cover_url: 'http://x/c.png', media: { box2d: 'http://x/c.png', spine: 'http://x/s.png' }, source: 'launchbox' }, { cacheImpl: async (url, kind) => files[kind] });
  assert.equal(m.spine_ar, 0.062); assert.equal(m.cover_ar, 0.6149);
  // pictures saved before shapes were recorded get theirs when the list is read, once
  db.prepare('UPDATE physical_games SET cover_ar = NULL, spine_ar = NULL WHERE id = ?').run(g.id);
  const item = (await call('/api/physical/games')).body.items.find((x) => x.id === g.id);
  assert.equal(item.spine_ar, 0.062); assert.equal(item.cover_ar, 0.6149);
  assert.equal(db.prepare('SELECT spine_ar FROM physical_games WHERE id = ?').get(g.id).spine_ar, 0.062, 'kept, not read again');
  const cleared = await call(`/api/physical/games/${g.id}/match`, { method: 'DELETE' });
  assert.equal(cleared.body.spine_ar, null); assert.equal(cleared.body.cover_ar, null);
});

function __filename_of() { return new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'); }

test('the shelf keeps every game of a platform the same size, from a per-platform table, and fits spine pictures to it', () => {
  const ph = read('public/physical.js'), css = read('public/physical.css');
  assert.match(ph, /const CASES = \{ dvd: \[190, 0\.074\]/); assert.match(ph, /switch: \[170, 0\.062\]/); assert.match(ph, /jewel: \[125, 0\.08\]/);
  // Wii, Wii U, Xbox, Xbox 360, GameCube and PS2 share one case, so they stand exactly alike
  assert.match(ph, /wii: 'dvd', wiiu: 'dvd', xbox: 'dvd', xbox360: 'dvd', gamecube: 'dvd', ps2: 'dvd'/);
  // PS3, PS4, PS5, Xbox One and Series are one height; the PlayStation cases are a little thicker than the Xbox ones
  assert.match(ph, /psbd: \[172, 0\.081\], xbbd: \[172, 0\.07\]/); assert.match(ph, /ps3: 'psbd', ps4: 'psbd', ps5: 'psbd', xboxone: 'xbbd', xboxseries: 'xbbd'/);
  assert.match(ph, /CASES\[PLATFORM_CASE\[g\.platform\]\] \|\| BOX_DEFAULT/); assert.match(ph, /S\.shapes\.get\(caseOf\(g\.platform\)\) \|\| share/);
  assert.doesNotMatch(ph.slice(ph.indexOf('function spineOf'), ph.indexOf('function buildRows')), /188 \+/, 'no per-game random height any more');
  assert.match(ph, /ht \* \(Number\(g\.cover_ar\) \|\| OPEN_DEFAULT_AR\)/);   // a pulled-out cover still opens at the cover's own shape
  assert.match(css, /\.ph-sp-art \{[^}]*object-fit: fill;/); assert.match(css, /font-size: clamp\(7px, calc\(var\(--w\) \* 0\.62\), 12\.5px\)/);
});

test('the platforms list carries every spine shape (so a kind of case is sized from the whole shelf), and a cover box takes its picture\'s shape', async () => {
  await phys.matchJobIdle();
  db.prepare('DELETE FROM physical_games').run();
  const a = phys.addPhysical(adminId, { platform: 'wii', title: 'Shape A' }), b = phys.addPhysical(adminId, { platform: 'wiiu', title: 'Shape B' }); phys.addPhysical(adminId, { platform: 'snes', title: 'No Spine' });
  await phys.matchJobIdle();
  const f1 = path.join(TMP, 'sh1.png'), f2 = path.join(TMP, 'sh2.png'); fs.writeFileSync(f1, pngOf(76, 1000)); fs.writeFileSync(f2, pngOf(70, 1000));
  const files = { spine: f1 };
  await phys.applyMatch(adminId, a.id, { title: 'Shape A', media: { spine: 'http://x/a.png' }, source: 'launchbox' }, { cacheImpl: async () => f1 });
  await phys.applyMatch(adminId, b.id, { title: 'Shape B', media: { spine: 'http://x/b.png' }, source: 'launchbox' }, { cacheImpl: async () => f2 });
  void files;
  const info = (await call('/api/physical')).body;
  const by = Object.fromEntries(info.platforms.map((p) => [p.slug, p.spine_ars]));
  assert.deepEqual(by.wii, [0.076]); assert.deepEqual(by.wiiu, [0.07]); assert.deepEqual(by.snes, []);
  // filtering the list does not change the shapes the shelf has to size by
  assert.equal((await call('/api/physical/games?platforms=snes')).body.total, 1);
  assert.deepEqual((await call('/api/physical')).body.platforms.find((p) => p.slug === 'wii').spine_ars, [0.076]);
  const ph = read('public/physical.js');
  assert.match(ph, /spineShapes\(S\.platforms\)/); assert.match(ph, /aspect-ratio:\$\{g\.cover_ar\}/);
});

test('Physical tiles are the Library\'s standard tile (one size, the cover fills it), like the ROM and Digital libraries', () => {
  const ph = read('public/physical.js'), css = read('public/physical.css');
  const tile = ph.slice(ph.indexOf('const tileHtml'), ph.indexOf('function renderTiles'));
  assert.doesNotMatch(tile, /aspect-ratio|--cover/, 'a tile takes no shape or backdrop of its own');
  assert.doesNotMatch(css, /\.ph-card \.card-cover(?!-)[^{]*\{[^}]*(aspect-ratio|object-fit|filter)/, 'nothing overrides the shared tile\'s cover box');
  // a cover is trimmed from the bottom (in the shared tile), so the logo or banner at the top always shows
  assert.match(read('public/styles.css'), /\.card-cover img \{ width: 100%; height: 100%; object-fit: cover; object-position: top;/, 'the shared tile trims a cover from the bottom, for every library');
  assert.doesNotMatch(css, /\.ph-card \.card-cover img/, 'Physical adds nothing of its own to the cover');
});

test('on the shelf, clicking a pulled-out cover puts it back: the spine slides home and the details window closes', () => {
  const ph = read('public/physical.js');
  assert.ok(ph.includes("if (S.view === 'shelf' && S.openId === id && tile.classList.contains('is-open')) {") && /ctx\.closeDrawer\(\); return;\s+\}/.test(ph), 'a game that is not a disc case goes back at once');
  // closing the window is what puts the spine back (it clears the open spine and slides the shelf back)
  const fo = ph.slice(ph.indexOf('export function forgetOpen'), ph.indexOf('/* ───────────── loading'));
  assert.match(fo, /remove\('nav-current', 'is-open'\)/); assert.match(fo, /slideShelfBack\(\)/);
  assert.match(read('public/app.js'), /physical\.forgetOpen\(\)/);
});

test('the shelves do not re-pack or jump when a game is opened or put back, even with the details window pinned', () => {
  const ph = read('public/physical.js'), css = read('public/physical.css');
  // the width the shelves are packed for is the same with the pinned window open or closed (closed: the room it will take is already left)
  assert.match(ph, /const pinReserve = \(\) => \(ctx\?\.pinned\?\.\(\) && innerWidth > 720 \?/);
  assert.match(ph, /if \(\$\('#drawer'\)\?\.classList\.contains\('hidden'\)\) w -= pinReserve\(\);/);
  assert.match(ph, /host\.style\.maxWidth = pinReserve\(\) \? `\$\{S\.packW \+ 56\}px` : ''/, 'pinned: the shelves end where the window begins, open or closed');
  // a real redraw (a genuine resize, a favourite toggled) keeps your place and does not drop every spine in again
  assert.match(ph, /const rowsNeeded = \(top\) =>/);
  assert.match(ph, /renderShelf\(rowsNeeded\(top\), false\); sc\.scrollTop = top;/, 'a resize keeps the scroll position');
  assert.match(ph, /renderShelf\(keep \? rowsNeeded\(keepTop\) : 0, !keep\)/, 'a reload that keeps your place draws down to it, without the entrance animation');
  assert.match(ph, /host\.classList\.toggle\('no-anim', !animate\)/);
  assert.match(css, /\.ph-shelf\.no-anim \.ph-spine, \.ph-shelf\.no-anim \.ph-plate \{ animation: none; \}/);
  // opening and putting back never redraw: they only mark the spine (the redraw paths above are the only callers of renderShelf)
  const open = ph.slice(ph.indexOf('function pullOut'), ph.indexOf('function markCurrent'));
  assert.doesNotMatch(open, /renderShelf\(/); assert.doesNotMatch(ph.slice(ph.indexOf('export function forgetOpen'), ph.indexOf('/* ───────────── loading')), /renderShelf\(/);
});


test('shelf, disc cases (PS2 to PS5, Xbox to Series X|S): the pulled-out cover comes to the front, then opens (manual left, disc right); any other spine, or the open case, puts it back', () => {
  const ph = read('public/physical.js'), css = read('public/physical.css');
  assert.ok(ph.includes("const DISC = new Set(['ps2', 'ps3', 'ps4', 'ps5', 'xbox', 'xbox360', 'xboxone', 'xboxseries']);"), 'exactly the disc-based platforms asked for');
  assert.ok(ph.includes('if (g && isDisc(g.platform) && CASE.id !== id) { showCase(id); return; }'), 'step 2: the pulled-out cover is clicked');
  assert.ok(ph.includes("el.addEventListener('click', onCaseClick)") && / {2}advanceCase\(\);\r?\n\}/.test(ph) && ph.includes("CASE.el.classList.add('is-open')"), 'step 3: the case in front is clicked and opens');
  assert.ok(/else ctx\.closeDrawer\(\);\s+\/\/ closing the details window puts the spine back too/.test(ph), 'the open case, clicked, goes back');
  assert.ok(ph.includes('if (CASE.id != null && CASE.id !== id) closeCase(true);'), 'another spine puts it back at any stage');
  const fo = ph.slice(ph.indexOf('export function forgetOpen'), ph.indexOf('/* ───────────── loading'));
  assert.match(fo, /closeCase\(true\)/); assert.ok(ph.includes('if (changed) closeCase(false);'), 'and so do closing the window and leaving the shelf view');
  // the open case: the cover swings away on its left edge, the manual is inside it (left), the disc is in the tray behind (right)
  for (const f of ['.ph-case.is-open .ph-case-cover { transform: scaleX(0);', '.ph-case.is-open .ph-case-inside { transform: translateX(-100%) scaleX(1);', '.ph-manual {', '.ph-disc {', '.ph-tray {']) assert.ok(css.includes(f), f);
  assert.ok(css.includes('.ph-case.is-open .ph-case-slide { transform: translateX(calc(var(--cw) / 2)); }'), 'the open pair is centred');
  assert.ok(/\.ph-case \{[^}]*z-index: 45;/.test(css), 'above the dimmed page, under the details window');
});

test('disc art: a disc game keeps its LaunchBox disc picture (cached, served only to its owner); other platforms never ask; clearing the match forgets it', async () => {
  const mk = async (platform, title) => (await call('/api/physical/games', { method: 'POST', body: { platform, title } })).body;
  const ps = await mk('ps4', 'Disc Art Test'), sn = await mk('snes', 'Cart Art Test');
  const png = path.join(TMP, 'disc.png'); fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const kinds = []; const cacheImpl = async (url, kind) => { kinds.push(kind); return png; };
  const asked = []; const discImpl = async (r) => { asked.push(r.title); return 'http://x/disc.png'; };
  assert.equal(await phys.fetchDisc(adminId, ps.id, { cacheImpl, discImpl }), true);
  assert.deepEqual(kinds, ['disc']); assert.deepEqual(asked, ['Disc Art Test']);
  const one = (await call(`/api/physical/games/${ps.id}`)).body;
  assert.equal(one.has_disc, true); assert.match(one.disc_url, /^\/api\/physical\/disc\/\d+/);
  const mine = await fetch(base + one.disc_url, { headers: { Authorization: 'Bearer ' + adminTok } });
  assert.equal(mine.status, 200);
  assert.equal((await fetch(base + `/api/physical/disc/${ps.id}`, { headers: { Authorization: 'Bearer ' + annTok } })).status, 404, 'someone else\'s shelf');
  // a disc picture that arrives with a match for a cartridge game (SNES) is ignored: only disc platforms keep one
  await phys.applyMatch(adminId, sn.id, { title: 'x', media: { disc: 'http://x/d.png' }, source: 'test' }, { cacheImpl });
  assert.equal(db.prepare('SELECT disc_path FROM physical_games WHERE id = ?').get(sn.id).disc_path, null);
  assert.deepEqual(phys.DISC_PLATFORMS, ['ps2', 'ps3', 'ps4', 'ps5', 'xbox', 'xbox360', 'xboxone', 'xboxseries']);
  assert.ok(read('public/physical.js').includes("const DISC = new Set(['ps2', 'ps3', 'ps4', 'ps5', 'xbox', 'xbox360', 'xboxone', 'xboxseries']);"), 'the shelf and the server agree on which platforms have discs');
  phys.clearMatch(adminId, ps.id);
  const cleared = db.prepare('SELECT disc_path, disc_url, disc_tried_at FROM physical_games WHERE id = ?').get(ps.id);
  assert.deepEqual(cleared, { disc_path: null, disc_url: null, disc_tried_at: null });
  // the open case shows the picture once it has loaded, and the drawn disc is the fallback
  const js = read('public/physical.js'), css = read('public/physical.css');
  assert.ok(js.includes('class=\\"ph-disc-art\\"') || js.includes('class="ph-disc-art"')); assert.ok(css.includes('.ph-disc.has-art'));
});

test('the case closes before it goes back: the cover swings shut, then the case slides to its slot, which stays empty until it arrives', () => {
  const js = read('public/physical.js'), css = read('public/physical.css');
  assert.ok(js.includes("el.classList.remove('is-open'); el.classList.add('is-closing'); setTimeout(fly, 560)"));
  assert.ok(js.includes("fill: 'forwards'") && js.includes("spine?.classList.remove('is-fore')"));
  assert.ok(js.includes(".ph-spine.is-open:not(.is-fore)"), 'the slot keeps its width until the case is home');
  assert.ok(css.includes('.ph-case.is-closing .ph-case-slide'));
});

test('shelf, disc cases: a click on the pulled-out cover still works when the details window is not pinned (its dark layer covers the cover), and on a phone the case comes first', () => {
  const ph = read('public/physical.js');
  assert.ok(ph.includes("e.target.closest?.('#scrim')") && ph.includes("document.addEventListener('click'") && ph.includes('showCase(id);\n}, true);'), 'a click on the dark layer over the open spine is a click on the cover');
  assert.ok(ph.includes("const narrow = () => matchMedia('(max-width: 720px)').matches"), 'phones are told apart from desktops');
  assert.ok(ph.includes("if (S.view === 'shelf' && narrow())") && ph.includes('closeCase(true); openDetail(id);'), 'phone: the case first, the details on its last tap');
});
