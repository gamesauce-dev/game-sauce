import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-reports-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'rpadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'rp-admin-password-1';

let server, base, adminTok, userTok, db, reports;
const call = async (p, token = adminTok) => {
  const res = await fetch(base + p, { headers: { Authorization: 'Bearer ' + token } });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let n = 0;
const rom = (slug, title, extra = {}) => {
  const p = db.prepare('SELECT id FROM platforms WHERE slug = ?').get(slug);
  n++;
  db.prepare('INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1, genre, release_year, description, cover_path, is_system) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(p.id, title, title.toLowerCase(), `${title}.rom`, `/x/${n}`, 1, `sha${n}`, extra.genre ?? null, extra.year ?? null, extra.description ?? null, extra.cover ?? null, extra.system ? 1 : 0);
};

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  reports = await import('../src/lib/reports.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  adminTok = await login('rpadmin', 'rp-admin-password-1');
  await fetch(base + '/api/auth/users', { method: 'POST', headers: { Authorization: 'Bearer ' + adminTok, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sam', password: 'sam-password-123', role: 'user' }) });
  userTok = await login('sam', 'sam-password-123');
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('titleKey: the same game under different spellings gets one key, and sequels stay apart', () => {
  const k = reports.titleKey;
  assert.equal(k('Prince of Persia: The Sands of Time (USA)'), k('The Prince of Persia - Sands of Time [Rev A]'));
  assert.equal(k('Pokémon & Friends'), 'pokemon and friends');
  assert.notEqual(k('Resident Evil 4'), k('Resident Evil 5'));
  assert.equal(k('(USA)'), '');
});

test('Reports are for the admin only', async () => {
  assert.equal((await call('/api/admin/reports', userTok)).status, 403);
  assert.equal((await call('/api/admin/reports')).status, 200);
});

test('Reports count the collection: totals, platforms, genres, years and completeness; System items are left out', async () => {
  rom('snes', 'Alpha', { genre: 'Action, RPG', year: 1994, description: 'd', cover: '/c.png' });
  rom('snes', 'Beta', { genre: 'Action', year: 1994 });
  rom('nes', 'Gamma', { genre: 'Puzzle', year: 1990, description: 'd' });
  rom('nes', 'BIOS thing', { system: true });
  const r = (await call('/api/admin/reports')).body;
  assert.equal(r.totals.roms, 3); assert.equal(r.totals.all, 3); assert.equal(r.totals.platforms, 2);
  assert.equal(r.totals.complete, 1); assert.equal(r.totals.with_cover, 1);
  assert.equal(r.platforms.find((p) => p.label === 'Super Nintendo').count, 2);
  assert.equal(r.genres.find((g) => g.label === 'Action').count, 2);
  assert.equal(r.genres.find((g) => g.label === 'RPG').count, 1);
  assert.equal(r.years.find((y) => y.label === '1994').count, 2);
  const snes = r.completeness.find((c) => c.label === 'Super Nintendo');
  assert.deepEqual([snes.complete, snes.no_cover, snes.no_desc, snes.neither], [1, 0, 0, 1]);
  assert.deepEqual(r.platforms.map((p) => p.count), [...r.platforms.map((p) => p.count)].sort((a, b) => b - a), 'ranked biggest first');
});

test('The same game on several platforms of one generation is listed; different generations are not', async () => {
  rom('ps2', 'Prince of Persia: The Sands of Time');
  rom('gamecube', 'Prince of Persia - The Sands of Time (USA)');
  rom('xbox', 'The Prince of Persia Sands of Time');
  rom('ps3', 'Prince of Persia: The Sands of Time');   // a later generation on its own: not a group
  rom('ps2', 'Only on PS2');
  rom('snes', 'Sonic Twice'); rom('snes', 'Sonic Twice (Europe)');   // two files on ONE platform: not a cross-platform game
  const cp = (await call('/api/admin/reports')).body.cross_platform;
  const pop = cp.groups.filter((g) => /Prince of Persia/i.test(g.title));
  assert.equal(pop.length, 1, 'one group');
  assert.equal(pop[0].gen, 6);
  assert.deepEqual(pop[0].platforms.map((p) => p.name).sort(), ['Microsoft Xbox', 'Nintendo GameCube', 'Sony PlayStation 2']);
  assert.ok(!cp.groups.some((g) => /Only on PS2|Sonic Twice/.test(g.title)));
  assert.equal(cp.by_generation.find((g) => g.gen === 6).count, 1);
});

test('One console is one platform whichever library it is in, and Digital takes the Library platform name', async () => {
  db.prepare("UPDATE platforms SET name = 'XBOX 360' WHERE slug = 'xbox360'").run();   // a Library platform renamed (here in capitals)
  rom('xbox360', 'Far Cry 3');
  const uid = db.prepare("SELECT id FROM users WHERE username = 'rpadmin'").get().id;
  db.prepare("INSERT INTO digital_games (user_id, store, app_id, name, platform) VALUES (?, 'xbox', 'fc3', 'Far Cry 3', 'x360')").run(uid);
  db.prepare("INSERT INTO digital_games (user_id, store, app_id, name, platform) VALUES (?, 'playstation', 'fc3p', 'Far Cry 3 Standard Edition', 'ps3')").run(uid);
  const r = (await call('/api/admin/reports')).body;
  const x = r.platforms.filter((p) => /xbox 360/i.test(p.label));
  assert.equal(x.length, 1, 'one Xbox 360 entry, not two');
  assert.equal(x[0].label, 'XBOX 360'); assert.equal(x[0].roms >= 1 && x[0].digital >= 1, true, 'the ROM and the Digital game are both in it');
  const g = r.cross_platform.groups.find((y) => /far cry 3/i.test(y.title));
  assert.ok(g, 'Far Cry 3 is on two platforms of generation 7 (an edition word does not split it)');
  assert.deepEqual(g.platforms.map((p) => p.name).sort(), ['Sony PlayStation 3', 'XBOX 360'].sort());
  assert.deepEqual(g.platforms.find((p) => p.name === 'XBOX 360').kinds, ['digital', 'roms']);
});

test('Check a title says what the report knows about a game, and is for the admin only', async () => {
  assert.equal((await call('/api/admin/reports/find?q=far', userTok)).status, 403);
  const { items } = (await call('/api/admin/reports/find?q=far%20cry')).body;
  assert.ok(items.length >= 3 && items.every((i) => i.gen === 7));
  assert.ok(items.every((i) => i.same_generation === 1), 'each copy is also on one other platform of its generation');
  assert.deepEqual((await call('/api/admin/reports/find?q=x')).body.items, [], 'too short a search gives nothing');
});

test('Every generation keeps its games in the same-game list, however many earlier ones there are', async () => {
  const add = db.transaction(() => { for (let i = 0; i < 1050; i++) { rom('snes', `Bulk ${i}`); rom('genesis', `Bulk ${i}`); } rom('ps5', 'Late Game'); rom('xboxseries', 'Late Game'); });
  add();
  const cp = (await call('/api/admin/reports')).body.cross_platform;
  assert.ok(cp.by_generation.find((g) => g.gen === 4).count >= 1050);
  assert.ok(cp.groups.some((g) => g.gen === 9 && g.title === 'Late Game'), 'a generation 9 game is not cut off by the 1,000+ groups before it');
});

test('A part of a completeness bar opens that platform in the Library with the same gap: no description is a Library filter, and the bar carries the platform', async () => {
  const withoutDesc = db.prepare("SELECT COUNT(*) AS n FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE p.slug = 'snes' AND r.is_system = 0 AND (r.description IS NULL OR TRIM(r.description) = '')").get().n;
  const list = (await call('/api/roms?platform=snes&desc=0&limit=5000')).body;
  assert.equal(list.total ?? list.items?.length, withoutDesc, 'desc=0 lists exactly the games with no description');
  const all = (await call('/api/roms?platform=snes&limit=5000')).body;
  assert.ok((all.total ?? all.items.length) > withoutDesc, 'and not every game');
  const row = (await call('/api/admin/reports')).body.completeness.find((c) => c.label === 'Super Nintendo');
  assert.equal(row.slug, 'snes');
  const app = read('public/app.js'), rep = read('public/reports.js');
  assert.ok(app.includes("params.set('desc', '0')") && app.includes("label: 'No description'") && rep.includes("data-seg"));
});

test('A daily snapshot is written once a day and comes back as history', async () => {
  db.prepare('DELETE FROM report_snapshots').run();   // earlier requests in this file already wrote today's row
  const a = (await call('/api/admin/reports')).body;
  assert.equal(a.history.length, 1);
  assert.equal(a.history[0].day, new Date().toISOString().slice(0, 10));
  assert.equal(a.history[0].all, a.totals.all);
  await call('/api/admin/reports');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_snapshots').get().n, 1, 'asking again does not add a second row for the day');
  assert.equal(reports.recordSnapshot(), false);
});

test('The Reports tab is wired into Settings, with charts that need no library', () => {
  const app = read('public/app.js'), html = read('public/index.html'), srv = read('src/server.js');
  assert.ok(app.includes("id: 'reports'") && app.includes("modules: ['health', 'coverage', 'reports']") && app.includes("id === 'reports'"));
  assert.ok(html.includes('id="mod-reports"') && html.includes('/reports.css'));
  assert.ok(srv.includes('startSnapshotTimer()'));
  const charts = read('public/charts.js');
  assert.ok(!/import .* from ['"]https?:/.test(charts) && !/cdn\./.test(charts), 'no outside library');
  for (const f of ['rankedCard', 'donutCard', 'stackedCard', 'columnsCard', 'sameGameCard']) assert.ok(charts.includes(`export function ${f}`), f);
});
