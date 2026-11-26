// ROM Library age ratings: the scale and conversion, what a lookup may and may not change, inheritance between versions, remembering a rating
// apart from the game, the sources, and the admin's tools. Nothing is restricted by a rating yet.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-ratings-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'ageadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'age-admin-password-1';
process.env.GAMESAUCE_RATINGS_PAUSE_MS = '0';
for (const k of ['IGDB_CLIENT_ID', 'IGDB_CLIENT_SECRET', 'TGDB_API_KEY', 'SS_USER', 'SS_PASSWORD', 'SS_DEV_ID', 'SS_DEV_PASSWORD', 'SGDB_API_KEY']) delete process.env[k];

const scale = await import('../src/lib/ratingscale.js');

let server, base, adminToken, memberToken, db, ratings, lb;

const call = async (p, { method = 'GET', body, token = adminToken, raw = false } = {}) => {
  const form = body instanceof FormData;
  const res = await realFetch(base + p, {
    method,
    headers: { ...(body && !form ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? (form ? body : JSON.stringify(body)) : undefined
  });
  return { status: res.status, body: raw ? await res.text() : await res.json().catch(() => null) };
};

/* A pretend IGDB: what it "knows" is set by each test. Everything else (our own server) goes to the real fetch. */
const realFetch = globalThis.fetch;
let igdbGames = [];
let igdbAsked = 0;
globalThis.fetch = async (url, options) => {
  const u = String(url);
  const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.startsWith('https://id.twitch.tv/')) return json({ access_token: 'pretend', expires_in: 3600 });
  if (u.startsWith('https://api.igdb.com/')) {
    igdbAsked++;
    const asked = String(options.body).match(/search "([^"]*)"/)?.[1].toLowerCase() || '';
    return json(igdbGames.filter((g) => g.name.toLowerCase().includes(asked.split(' ')[0])));
  }
  if (/^https?:\/\/127\.0\.0\.1/.test(u)) return realFetch(url, options);
  throw new Error(`a test tried to reach ${u}`);
};
const igdbEntry = (name, ratingsList) => ({ id: Math.floor(Math.random() * 1e6), name, age_ratings: ratingsList.map(([board, label]) => ({ organization: { name: board }, rating_category: { rating: label } })) });
const useIgdb = (on) => { if (on) { process.env.IGDB_CLIENT_ID = 'x'; process.env.IGDB_CLIENT_SECRET = 'y'; } else { delete process.env.IGDB_CLIENT_ID; delete process.env.IGDB_CLIENT_SECRET; } };

let counter = 0;
/** A game put straight into the database, the way a scan would. */
function addGame(title, { platform = 'snes', filename = `${title} (${++counter}).sfc`, sha1 = null, folder = '/roms', source = null } = {}) {
  const p = db.prepare('SELECT id FROM platforms WHERE slug = ?').get(platform);
  return Number(db.prepare(`INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, source_path, size_bytes, sha1, source_id, meta_source)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'filename')`).run(p.id, title, title.toLowerCase(), filename, `${folder}/${filename}`, `${folder}/${filename}`, sha1, source).lastInsertRowid);
}
const game = async (id, token = adminToken) => (await call(`/api/roms/${id}`, { token })).body;
const age = async (id) => (await game(id)).age;
const wipe = () => { db.exec('DELETE FROM roms; DELETE FROM game_ratings; DELETE FROM rating_dirty;'); };

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  ({ db } = await import('../src/db.js'));
  ratings = await import('../src/lib/ratings.js');
  lb = await import('../src/lib/launchbox.js');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => (await call('/api/auth/login', { method: 'POST', body: { username, password }, token: null })).body.token;
  adminToken = await login('ageadmin', 'age-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'kid', password: 'kid-password-123', role: 'user' } });
  memberToken = await login('kid', 'kid-password-123');
});

beforeEach(() => { wipe(); useIgdb(false); igdbGames = []; ratings.setRatingSystem('acb'); });

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server?.close(resolve));
  lb._resetLaunchBox();
  db.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

/* ───────── the scale ───────── */

test('ratings: the labels the providers send are read, and Not Rated and Rating Pending are no rating', () => {
  const read = (board, text) => scale.levelOf(board, text);
  assert.deepEqual(['G', 'PG', 'M', 'MA 15+', 'MA15+', 'R 18+', 'RC'].map((t) => read('acb', t)), [1, 2, 3, 4, 4, 5, 6]);
  assert.deepEqual(['EC - Early Childhood', 'E - Everyone', 'E10+ - Everyone 10+', 'E10', 'T - Teen', 'M - Mature 17+', 'M - Mature', 'AO - Adult Only 18+'].map((t) => read('esrb', t)), [1, 1, 2, 2, 3, 4, 4, 5]);
  assert.deepEqual(['3', '7', '12', '16', '18'].map((t) => read('pegi', t)), [1, 2, 3, 4, 5]);
  for (const [board, text] of [['esrb', 'Not Rated'], ['esrb', 'RP - Rating Pending'], ['esrb', 'RP'], ['acb', ''], ['acb', null], ['pegi', '19'], ['usk', '18'], ['esrb', 'constructor']]) assert.equal(read(board, text), null, `${board} ${text}`);
  assert.equal(scale.ratingItem('CERO', 'Z', 'igdb'), null, 'other boards are ignored');
});

test('ratings: the setting\'s own board wins; without it, the strictest of the others', () => {
  const evidence = scale.addEvidence(null, [{ board: 'esrb', level: 4, source: 'igdb' }, { board: 'pegi', level: 5, source: 'igdb' }]);
  assert.deepEqual(scale.pickRating(evidence, 'acb'), { level: 5, board: 'pegi', source: 'igdb' });
  const withAcb = scale.addEvidence(evidence, [{ board: 'acb', level: 3, source: 'igdb' }]);
  assert.deepEqual(scale.pickRating(withAcb, 'acb'), { level: 3, board: 'acb', source: 'igdb' }, 'ACB is used even though the others are stricter');
  assert.equal(scale.pickRating(withAcb, 'pegi').level, 5);
  assert.equal(scale.addEvidence(withAcb, [{ board: 'pegi', level: 1, source: 'igdb' }]).pegi.level, 5, 'a board\'s entry only gets stricter');
});

test('ratings: typed values name their board or mean the current one', () => {
  assert.deepEqual(scale.parseTyped('ACB MA 15+', 'esrb'), { level: 4, board: 'acb', named: true });
  assert.deepEqual(scale.parseTyped('M', 'acb'), { level: 3, board: 'acb', named: false });
  assert.deepEqual(scale.parseTyped('M', 'esrb'), { level: 4, board: 'esrb', named: false });
  assert.deepEqual(scale.parseTyped('pegi 16', 'acb'), { level: 4, board: 'pegi', named: true });
  assert.equal(scale.parseTyped('RC', 'pegi').level, 6);
  assert.equal(scale.parseTyped('banana', 'acb'), null);
});

/* ───────── what may change a rating ───────── */

test('ratings: a later lookup may make a fetched rating stricter, never lower or remove it', async () => {
  const id = addGame('Alpha');
  assert.equal(await age(id), null, 'a new game is unrated');
  assert.equal(ratings.addFetched(id, [{ board: 'esrb', level: 4, source: 'launchbox' }]), true);
  assert.deepEqual(await age(id), { level: 4, label: 'MA 15+', converted: true, from: 'ESRB M', source: 'launchbox', inherited: false });
  // ACB turns up later, and is lower: the setting prefers ACB, but a rating is never lowered.
  assert.equal(ratings.addFetched(id, [{ board: 'acb', level: 3, source: 'igdb' }]), false);
  assert.equal((await age(id)).label, 'MA 15+');
  ratings.addFetched(id, [{ board: 'esrb', level: 1, source: 'igdb' }]);
  ratings.addFetched(id, []);
  assert.equal((await age(id)).level, 4);
  ratings.addFetched(id, [{ board: 'pegi', level: 5, source: 'igdb' }]);
  assert.equal((await age(id)).label, 'MA 15+', 'ACB is known by now, so the other boards say nothing');
  ratings.addFetched(id, [{ board: 'acb', level: 5, source: 'igdb' }]);
  assert.equal((await age(id)).label, 'R 18+', 'stricter is taken');
});

test('ratings: the same level from the setting\'s own board replaces a converted one', async () => {
  const id = addGame('Alpha');
  ratings.addFetched(id, [{ board: 'esrb', level: 4, source: 'launchbox' }]);
  ratings.addFetched(id, [{ board: 'acb', level: 4, source: 'igdb' }]);
  assert.deepEqual(await age(id), { level: 4, label: 'MA 15+', converted: false, from: null, source: 'igdb', inherited: false });
});

test('ratings: an admin\'s rating wins, and no lookup touches it; taking it away lets a lookup fill it again', async () => {
  const id = addGame('Alpha');
  ratings.addFetched(id, [{ board: 'acb', level: 5, source: 'igdb' }]);
  let r = await call('/api/ratings/set', { method: 'POST', body: { ids: [id], level: 2 } });
  assert.equal(r.status, 200);
  assert.deepEqual(await age(id), { level: 2, label: 'PG', converted: false, from: null, source: 'admin', inherited: false });
  assert.equal(ratings.addFetched(id, [{ board: 'acb', level: 6, source: 'igdb' }]), false);
  assert.equal((await age(id)).label, 'PG');
  r = await call('/api/ratings/set', { method: 'POST', body: { ids: [id], level: null } });
  assert.equal(await age(id), null);
  ratings.addFetched(id, [{ board: 'acb', level: 3, source: 'igdb' }]);
  assert.equal((await age(id)).label, 'M');
  assert.equal((await call('/api/ratings/set', { method: 'POST', body: { ids: [id], level: 9 } })).status, 400);
  assert.equal((await call('/api/ratings/set', { method: 'POST', body: { ids: [id] } })).status, 400, 'no level is not the same as taking it away');
});

test('ratings: only an admin changes or manages ratings; everyone sees a game\'s rating', async () => {
  const id = addGame('Alpha');
  await call('/api/ratings/set', { method: 'POST', body: { ids: [id], level: 5 } });
  for (const [p, method, body] of [['/api/ratings', 'GET'], ['/api/ratings/set', 'POST', { ids: [id], level: 1 }], ['/api/ratings/system', 'PUT', { system: 'esrb' }], ['/api/ratings/fetch', 'POST', {}], ['/api/ratings/fetch', 'DELETE'], ['/api/ratings/fetch', 'GET']]) {
    assert.equal((await call(p, { method, body, token: memberToken })).status, 403, `${method} ${p}`);
  }
  assert.equal((await game(id, memberToken)).age.label, 'R 18+', 'nothing is restricted yet: the member still gets the game');
  const edit = await call(`/api/roms/${id}`, { method: 'PATCH', body: { age_level: 1, age_board: 'acb' } });
  assert.equal(edit.status, 200);
  assert.equal((await age(id)).level, 5, 'the details form cannot set a rating');
});

/* ───────── versions ───────── */

test('ratings: an unrated version shows the strictest rating of the versions on the same platform only', async () => {
  const a = addGame('Zeta', { filename: 'Zeta (USA).sfc' }), b = addGame('Zeta', { filename: 'Zeta (Europe).sfc' }), c = addGame('Zeta', { filename: 'Zeta (Japan).sfc' });
  const other = addGame('Zeta', { platform: 'genesis', filename: 'Zeta (USA).md' });
  ratings.addFetched(a, [{ board: 'acb', level: 2, source: 'igdb' }]);
  ratings.addFetched(b, [{ board: 'acb', level: 4, source: 'igdb' }]);
  assert.deepEqual(await age(c), { level: 4, label: 'MA 15+', converted: false, from: null, source: 'igdb', inherited: true });
  assert.equal((await age(a)).label, 'PG', 'a version with its own rating keeps it');
  assert.equal(await age(other), null, 'nothing crosses platforms');
  const later = addGame('Zeta', { filename: 'Zeta (Rev 1).sfc' });
  assert.equal((await age(later)).inherited, true, 'a version added afterwards inherits too');
  await call(`/api/roms/${c}`, { method: 'PATCH', body: { title: 'Something Else' } });
  assert.equal(await age(c), null, 'retitled: no longer a version');
  db.prepare('DELETE FROM roms WHERE id = ?').run(b);
  assert.equal((await age(later)).label, 'PG', 'what is inherited follows the versions that are there');
});

/* ───────── remembered apart from the game ───────── */

test('ratings: a game removed and added again gets its rating back by file name and platform', async () => {
  const id = addGame('Alpha', { filename: 'Alpha (USA).sfc' });
  await call('/api/ratings/set', { method: 'POST', body: { ids: [id], level: 5 } });
  assert.equal((await call(`/api/roms/${id}?keep_file=1`, { method: 'DELETE' })).status, 200);
  const again = addGame('Alpha', { filename: 'ALPHA (USA).sfc' });
  assert.equal((await age(again)).source, 'admin');
  assert.equal((await age(again)).level, 5);
  assert.equal(await age(addGame('Other', { platform: 'genesis', filename: 'Alpha (USA).sfc' })), null, 'the same name on another platform is another game');
});

test('ratings: removing a source with its games and adding them again keeps the ratings', async () => {
  const src = Number(db.prepare("INSERT INTO sources (name, path) VALUES ('s', ?)").run(path.join(TMP, 'src1')).lastInsertRowid);
  const id = addGame('Alpha', { filename: 'Alpha (USA).sfc', source: src });
  ratings.addFetched(id, [{ board: 'acb', level: 4, source: 'igdb' }]);
  assert.equal((await call(`/api/sources/${src}?remove_roms=1`, { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM roms').get().n, 0);
  assert.equal((await age(addGame('Alpha', { filename: 'Alpha (USA).sfc' }))).label, 'MA 15+');
});

test('ratings: a renamed file is recognised once its fingerprint is known', async () => {
  const sha1 = 'a'.repeat(40);
  const id = addGame('Alpha', { filename: 'Alpha (USA).sfc' });
  await call('/api/ratings/set', { method: 'POST', body: { ids: [id], level: 5 } });
  db.prepare('UPDATE roms SET sha1 = ? WHERE id = ?').run(sha1, id);   // fingerprinted after it was rated
  ratings.flushRatings();
  db.prepare('DELETE FROM roms WHERE id = ?').run(id);
  const renamed = addGame('Renamed', { filename: 'totally-different.sfc' });
  assert.equal(await age(renamed), null, 'not recognised until fingerprinted');
  db.prepare('UPDATE roms SET sha1 = ? WHERE id = ?').run(sha1, renamed);
  assert.equal((await age(renamed)).level, 5);
  db.prepare('DELETE FROM roms WHERE id = ?').run(renamed);
  ratings.flushRatings();
  assert.equal((await age(addGame('Renamed', { filename: 'totally-different.sfc' }))).level, 5, 'and the new name is remembered');
});

test('ratings: a file name many games share is only recognised in its own folder', async () => {
  const a = addGame('Mild Game', { platform: 'dreamcast', filename: 'disc.gdi', folder: '/roms/dc/Mild Game' });
  await call('/api/ratings/set', { method: 'POST', body: { ids: [a], level: 1 } });
  assert.equal(await age(addGame('Rough Game', { platform: 'dreamcast', filename: 'disc.gdi', folder: '/roms/dc/Rough Game' })), null);
});

test('ratings: a game moved to another platform takes its rating with it', async () => {
  const id = addGame('Alpha', { filename: 'Alpha.bin' });
  await call('/api/ratings/set', { method: 'POST', body: { ids: [id], level: 4 } });
  await call(`/api/roms/${id}`, { method: 'PATCH', body: { platform: 'genesis' } });
  assert.equal((await age(id)).level, 4);
});

/* ───────── the setting and the admin's lists ───────── */

test('ratings: changing the classification shows that board\'s labels and prefers its ratings', async () => {
  const a = addGame('Alpha'), b = addGame('Beta'), c = addGame('Gamma');
  ratings.addFetched(a, [{ board: 'acb', level: 3, source: 'igdb' }, { board: 'esrb', level: 4, source: 'igdb' }]);
  await call('/api/ratings/set', { method: 'POST', body: { ids: [b], level: 5 } });
  await call('/api/ratings/set', { method: 'POST', body: { ids: [c], level: 6 } });
  const r = await call('/api/ratings/system', { method: 'PUT', body: { system: 'esrb' } });
  assert.equal(r.body.system, 'esrb');
  assert.deepEqual(await age(a), { level: 4, label: 'M', converted: false, from: null, source: 'igdb', inherited: false });
  assert.deepEqual(await age(b), { level: 5, label: 'AO', converted: true, from: 'ACB R 18+', source: 'admin', inherited: false });
  assert.deepEqual(await age(c), { level: 6, label: 'RC', converted: false, from: null, source: 'admin', inherited: false });
  assert.equal((await call('/api/ratings/system', { method: 'PUT', body: { system: 'usk' } })).status, 400);
});

test('ratings: the Unrated and Converted lists and the counts are the admin\'s', async () => {
  const a = addGame('Alpha'), b = addGame('Beta');
  addGame('Gamma');
  const bios = addGame('Bios');
  db.prepare('UPDATE roms SET is_system = 1 WHERE id = ?').run(bios);
  ratings.addFetched(a, [{ board: 'acb', level: 1, source: 'igdb' }]);
  ratings.addFetched(b, [{ board: 'pegi', level: 4, source: 'igdb' }]);
  const titles = async (q, token) => (await call(`/api/roms?${q}`, { token })).body.items.map((x) => x.title).sort();
  assert.deepEqual(await titles('age=unrated'), ['Gamma']);
  assert.deepEqual(await titles('age=converted'), ['Beta']);
  assert.deepEqual(await titles('age=unrated', memberToken), ['Alpha', 'Beta', 'Gamma'], 'ignored for a member');
  const s = (await call('/api/ratings')).body;
  assert.deepEqual(s.counts, { games: 3, rated: 2, unrated: 1, converted: 1, inherited: 0, by_admin: 0 });
  assert.deepEqual(s.systems.find((x) => x.id === 'acb').ratings.map((x) => x.label), ['G', 'PG', 'M', 'MA 15+', 'R 18+', 'RC']);
});

/* ───────── CSV ───────── */

const importCsv = async (csv, apply) => {
  const fd = new FormData();
  fd.append('csv', new Blob([csv]), 'a.csv');
  fd.append('platform', 'snes');
  if (apply) fd.append('apply', '1');
  return (await call('/api/roms/bulk/import-names', { method: 'POST', body: fd })).body;
};

test('ratings: the export has a rating column, and bringing it back unchanged changes nothing', async () => {
  const a = addGame('Alpha', { filename: 'Alpha.sfc' });
  addGame('Alpha', { filename: 'Alpha (Europe).sfc' });
  addGame('Beta', { filename: 'Beta.sfc' });
  ratings.addFetched(a, [{ board: 'esrb', level: 4, source: 'launchbox' }]);
  const csv = (await call('/api/roms/export/games.csv', { raw: true })).body;
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  const head = lines[0].split(',');
  assert.ok(head.includes('age_rating') && head.includes('age_rating_from'));
  assert.match(csv, /ACB MA 15\+,"launchbox, converted from ESRB M"/);
  assert.match(csv, /ACB MA 15\+,"launchbox, converted from ESRB M, inherited"/);
  const back = await importCsv(csv, true);
  assert.equal(back.age_ratings, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM game_ratings WHERE admin_level IS NOT NULL').get().n, 0, 'nothing became an admin\'s rating');
});

test('ratings: a changed cell in the CSV is the admin\'s rating; empty and unreadable cells change nothing', async () => {
  const a = addGame('Alpha', { filename: 'Alpha.sfc' }), b = addGame('Beta', { filename: 'Beta.sfc' }), c = addGame('Gamma', { filename: 'Gamma.sfc' });
  ratings.addFetched(c, [{ board: 'acb', level: 3, source: 'igdb' }]);
  const csv = 'rom_name,short_game_name,age_rating\nAlpha.sfc,Alpha,MA 15+\nBeta.sfc,Beta,banana\nGamma.sfc,Gamma,\n';
  const preview = await importCsv(csv, false);
  assert.equal(preview.age_ratings, 1);
  assert.equal(preview.bad_age_ratings, 1);
  assert.deepEqual(preview.bad_age_examples, ['banana']);
  assert.equal(await age(a), null, 'a preview saves nothing');
  await importCsv(csv, true);
  assert.deepEqual([(await age(a)).label, (await age(a)).source], ['MA 15+', 'admin']);
  assert.equal(await age(b), null);
  assert.equal((await age(c)).source, 'igdb');
});

/* ───────── the sources ───────── */

test('ratings: TheGamesDB\'s text rating is an age rating, not a score', async () => {
  const { thegamesdb } = await import('../src/lib/providers.js');
  const before_ = globalThis.fetch;
  process.env.TGDB_API_KEY = 'k';
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { games: [{ id: 1, game_title: 'Alpha', rating: 'M - Mature 17+' }, { id: 2, game_title: 'Beta', rating: 'Not Rated' }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const hits = await thegamesdb.search('Alpha', {});
    assert.equal(hits.items[0].rating, null);
    assert.deepEqual(hits.items[0].age_ratings, [{ board: 'esrb', level: 4, source: 'thegamesdb' }]);
    assert.deepEqual(hits.items[1].age_ratings, []);
  } finally { globalThis.fetch = before_; delete process.env.TGDB_API_KEY; }
});

const lbXml = (games) => `<?xml version="1.0"?><LaunchBox>${games.map(([id, name, platform, esrb]) => `<Game><Name>${name}</Name><DatabaseID>${id}</DatabaseID><Platform>${platform}</Platform>${esrb ? `<ESRB>${esrb}</ESRB>` : ''}</Game>`).join('')}</LaunchBox>`;

const runJob = async (body = {}) => {
  const started = await call('/api/ratings/fetch', { method: 'POST', body });
  if (started.status !== 200) return started;
  for (let i = 0; i < 500; i++) {
    const j = (await call('/api/ratings/fetch')).body;
    if (!j.running) return { status: 200, body: j };
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error('the job did not finish');
};

test('ratings: Fetch ratings needs a source', async () => {
  lb._resetLaunchBox();
  fs.rmSync(path.join(TMP, 'data', 'launchbox'), { recursive: true, force: true });
  addGame('Alpha');
  assert.equal((await runJob()).status, 400);
});

test('ratings: Fetch ratings asks LaunchBox and IGDB, takes only the game\'s own name, and changes nothing else', async () => {
  await lb.importLaunchBox(Readable.from([lbXml([
    [1, 'Alpha Quest', 'Super Nintendo Entertainment System', 'Not Rated'],
    [2, 'Alpha Quest', 'Super Nintendo Entertainment System', 'T - Teen'],
    [3, 'Alpha Quest', 'Sega Genesis', 'AO - Adult Only'],
    [4, 'Beta Blast 2', 'Super Nintendo Entertainment System', 'E - Everyone'],
    [5, 'Delta Force', 'Super Nintendo Entertainment System', 'M - Mature']
  ])]));
  useIgdb(true);
  igdbGames = [igdbEntry('Delta Force', [['ACB', 'M'], ['PEGI', '18'], ['CERO', 'Z']]), igdbEntry('Beta Blast 2', [['ACB', 'G']])];
  const a = addGame('Alpha Quest'), b = addGame('Beta Blast'), d = addGame('Delta Force'), mine = addGame('Delta Force Mine');
  await call('/api/ratings/set', { method: 'POST', body: { ids: [mine], level: 1 } });
  const done = (await runJob()).body;
  assert.deepEqual([done.total, done.done, done.rated, done.none, done.failed], [3, 3, 2, 1, 0], JSON.stringify(done));
  assert.deepEqual(await age(a), { level: 3, label: 'M', converted: true, from: 'ESRB T', source: 'launchbox', inherited: false });
  assert.equal(await age(b), null, 'the sequel\'s rating is not taken');
  assert.deepEqual(await age(d), { level: 3, label: 'M', converted: false, from: null, source: 'igdb', inherited: false }, 'ACB is preferred when both are found at once');
  assert.equal((await age(mine)).source, 'admin');
  const row = await game(d);
  assert.deepEqual([row.title, row.meta_source, row.cover_url ?? null, row.description], ['Delta Force', 'filename', null, null], 'ratings only');
  // Rated games are left out the next time, unless asked; asking again can only make them stricter.
  assert.equal((await runJob()).body.total, 1);
  igdbGames = [igdbEntry('Delta Force', [['ACB', 'G']])];
  await runJob({ recheck: true });
  assert.equal((await age(d)).label, 'M');
});

test('ratings: a metadata match applied to a game brings its rating; a guess at another game\'s name does not', async () => {
  const { applyMetadataRecord } = await import('../src/routes/roms.js');
  useIgdb(true);
  const own = addGame('Delta Force'), guess = addGame('Micro Racers');
  const record = (title, level) => ({ title, source: 'igdb', age_ratings: [{ board: 'acb', level, source: 'igdb' }], media: {} });
  await applyMetadataRecord(own, record('Delta Force', 2));
  assert.equal((await age(own)).label, 'PG');
  await applyMetadataRecord(guess, record('Micro Racers V4', 1));
  assert.equal(await age(guess), null, 'a looser match gives no rating');
  const pickedId = addGame('mrcrs');
  const r = await call(`/api/metadata/${pickedId}/apply`, { method: 'POST', body: { candidate: record('Micro Racers V4', 4) } });
  assert.equal(r.status, 200);
  assert.equal((await age(pickedId)).label, 'MA 15+', 'an admin picked this match by hand');
});
