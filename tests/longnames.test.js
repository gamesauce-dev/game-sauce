// Short and long game names: the MAME list and the name CSV fill both, each person chooses which one they see, search matches both.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-longnames-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'lnadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'ln-admin-password-1';

let server, base, db, tok, mame;
const ids = {};

const call = async (p, { method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const add = (title, filename, slug, sha) => db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, meta_source) VALUES (?,?,?,(SELECT id FROM platforms WHERE slug = ?),?,1,?, 'filename')")
  .run(title, title.toLowerCase(), filename, slug, path.join(TMP, filename), sha).lastInsertRowid;
const row = (id) => db.prepare('SELECT title, long_title, is_system, meta_source FROM roms WHERE id = ?').get(id);

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  mame = await import('../src/lib/mamenames.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lnadmin', password: 'ln-admin-password-1' }) })).json()).token;

  db.prepare("INSERT INTO platforms (slug, name, short_name, extensions) VALUES ('seganaomi2', 'Sega Naomi 2', 'N2', 'zip')").run();
  ids.initd = add('initdexp', 'initdexp.zip', 'seganaomi2', 'ln1');      // a platform the person made
  ids.pacman = add('pacman', 'pacman.zip', 'mame', 'ln2');
  ids.naomi = add('naomi', 'naomi.zip', 'naomi', 'ln3');                 // a BIOS set
  ids.plain = add('plain', 'plain.zip', 'naomi', 'ln4');                 // no brackets in its name
  ids.prov = add('From A Provider', 'provgame.zip', 'naomi', 'ln5');
  db.prepare("UPDATE roms SET meta_source = 'igdb' WHERE id = ?").run(ids.prov);   // a title a provider gave
  const nm = db.prepare('INSERT INTO mame_names (name, title, year, manufacturer, isbios, isdevice) VALUES (?,?,?,?,?,?)');
  nm.run('initdexp', 'Initial D Arcade Stage (Export)', 2002, 'Sega', 0, 0);
  nm.run('pacman', 'Pac-Man (Midway)', 1980, 'Namco', 0, 0);
  nm.run('naomi', 'Naomi Bios', 1999, 'Sega', 1, 0);
  nm.run('plain', 'Plain Game', 2001, 'Sega', 0, 0);
  nm.run('provgame', 'Provider Game (World)', 2001, 'Sega', 0, 0);
  mame.applyMameNames();
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('shortName drops the bracketed part and keeps a name that starts with one', () => {
  assert.equal(mame.shortName('Initial D Arcade Stage (Export)'), 'Initial D Arcade Stage');
  assert.equal(mame.shortName('Pac-Man'), 'Pac-Man');
  assert.equal(mame.shortName('(Bootleg) Foo'), '(Bootleg) Foo');
});

test('the MAME list gives a game its short name as the title and the full name as the long one, on a platform the person made too', () => {
  assert.deepEqual({ t: row(ids.initd).title, l: row(ids.initd).long_title }, { t: 'Initial D Arcade Stage', l: 'Initial D Arcade Stage (Export)' });
  assert.equal(row(ids.pacman).title, 'Pac-Man');
  assert.equal(row(ids.pacman).long_title, 'Pac-Man (Midway)');
  assert.equal(row(ids.plain).title, 'Plain Game');
  assert.equal(row(ids.plain).long_title, null, 'nothing to add when the two are the same');
});

test('a BIOS set is flagged System; a title a provider gave is kept, but its long name is still recorded', () => {
  assert.equal(row(ids.naomi).is_system, 1);
  assert.equal(row(ids.initd).is_system, 0);
  assert.equal(row(ids.prov).title, 'From A Provider');
  assert.equal(row(ids.prov).long_title, 'Provider Game (World)');
});

test('each person sees the short or the long name as they chose; short is the default', async () => {
  const get = async () => (await call(`/api/roms/${ids.initd}`)).body;
  let r = await get();
  assert.equal(r.title, 'Initial D Arcade Stage');
  assert.equal(r.long_title, 'Initial D Arcade Stage (Export)');
  assert.equal((await call('/api/prefs/name_style', { method: 'PUT', body: { value: 'long' } })).status, 200);
  r = await get();
  assert.equal(r.title, 'Initial D Arcade Stage (Export)');
  assert.equal(r.short_title, 'Initial D Arcade Stage', 'the edit form still edits the short one');
  const list = (await call('/api/roms?limit=50')).body;
  const inList = (list.roms || list.items || []).find((x) => x.id === ids.initd);
  assert.equal(inList.title, 'Initial D Arcade Stage (Export)');
  assert.equal((await get()).id, ids.initd);
  const plain = (await call(`/api/roms/${ids.plain}`)).body;
  assert.equal(plain.title, 'Plain Game', 'a game with no long name shows its usual name either way');
  assert.equal((await call('/api/prefs/name_style', { method: 'PUT', body: { value: 'nonsense' } })).status, 400);
  await call('/api/prefs/name_style', { method: 'PUT', body: { value: null } });
  assert.equal((await get()).title, 'Initial D Arcade Stage');
});

test('search finds a game by its long name even when the short one is shown', async () => {
  const found = (await call('/api/roms?q=Export')).body;
  assert.ok((found.roms || found.items || []).some((x) => x.id === ids.initd));
});

test('the name CSV: full_game_name becomes the long name', async () => {
  const { importNames } = await import('../src/lib/namecsv.js');
  const id = add('csvgame', 'csvgame.zip', 'naomi', 'ln6');
  const csv = 'rom_name,full_game_name,short_game_name,year,manufacturer\ncsvgame,Csv Game (Rev B),Csv Game,2003,Sega\n';
  importNames({ csvText: csv, platform: 'naomi', apply: true });
  assert.deepEqual({ t: row(id).title, l: row(id).long_title }, { t: 'Csv Game', l: 'Csv Game (Rev B)' });
});

test('editing a title by hand leaves the long name alone', async () => {
  const r = await call(`/api/roms/${ids.pacman}`, { method: 'PATCH', body: { title: 'Pac-Man Plus' } });
  assert.equal(r.status, 200);
  assert.equal(row(ids.pacman).title, 'Pac-Man Plus');
  assert.equal(row(ids.pacman).long_title, 'Pac-Man (Midway)');
});
