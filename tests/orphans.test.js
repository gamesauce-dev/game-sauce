// What an orphan is, and which files each way of removing games may delete. Everything here is in a temporary library.
// An orphan is a game that was scanned from one of your own folders and has lost its source. A game added through Add ROMs never had one:
// game-sauce holds its only copy, so nothing that tidies orphans may touch it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-orphans-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'oadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'o-admin-password-1';

let server, base, db, token, cwd;
const call = async (p, { method = 'GET', body } = {}) => {
  const json = body && !(body instanceof FormData);
  const res = await fetch(base + p, { method, headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: json ? JSON.stringify(body) : body });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const row = (filename) => db.prepare('SELECT * FROM roms WHERE filename = ?').get(filename);
let made = 0;
async function upload(name) {
  const fd = new FormData();
  fd.append('roms', new Blob([`uploaded bytes ${++made}`]), name); fd.append('platform', 'snes'); fd.append('enrich', 'false');
  assert.equal((await call('/api/roms/upload', { method: 'POST', body: fd })).status, 201, name);
  const r = row(name);
  assert.ok(fs.existsSync(r.storage_path), 'the stored copy is there');
  return r;
}
/** A game scanned from the user's own folder, whose source is then removed with its games kept. */
async function scannedThenSourceRemoved(name) {
  const dir = fs.mkdtempSync(path.join(TMP, 'own-')); fs.writeFileSync(path.join(dir, name), `scanned bytes ${++made}`);
  const src = (await call('/api/sources', { method: 'POST', body: { name: `Folder ${made}`, path: dir, platform_hint: 'snes' } })).body;
  await call(`/api/sources/${src.id}/scan`, { method: 'POST', body: {} });
  for (let i = 0; i < 100 && !row(name); i++) await new Promise((r) => setTimeout(r, 100));
  await call(`/api/sources/${src.id}?remove_roms=0`, { method: 'DELETE' });
  return row(name);
}

before(async () => {
  cwd = process.cwd();
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await call('/api/auth/login', { method: 'POST', body: { username: 'oadmin', password: 'o-admin-password-1' } })).body.token;
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('a game added through Add ROMs is not an orphan: not listed, not counted, and Delete orphans leaves it and its file alone', async () => {
  const up = await upload('Uploaded Game.sfc');
  const lost = await scannedThenSourceRemoved('Lost Game.sfc');

  const listed = (await call('/api/roms?orphan=only&hidden=all&limit=50')).body.items.map((r) => r.filename);
  assert.deepEqual(listed, ['Lost Game.sfc']);
  assert.equal((await call('/api/stats')).body.library.orphaned, 1, 'the sidebar count');
  const facets = (await call('/api/roms/facets')).body.stats;
  assert.equal(facets.orphaned, 1, 'the Database maintenance count');
  assert.equal(facets.imported_or_seed, 1, 'uploads are counted on their own line');
  const dry = (await call('/api/roms', { method: 'DELETE' })).body;
  assert.equal(dry.orphans, 1);

  // even asked to delete files, the purge removes only the lost entry, and no game file at all
  const done = (await call('/api/roms?dry_run=0&delete_file=1', { method: 'DELETE' })).body;
  assert.equal(done.deleted, 1); assert.equal(done.files_deleted, 0);
  assert.equal(row('Lost Game.sfc'), undefined);
  assert.ok(fs.existsSync(lost.storage_path), 'the file in your own folder stays');
  assert.ok(row('Uploaded Game.sfc'), 'the upload is still in the library');
  assert.ok(fs.existsSync(up.storage_path), 'and so is its file');
});

test('keep_file keeps the stored copy of an upload, one game or several at once', async () => {
  const one = await upload('Keep One.sfc'), two = await upload('Keep Two.sfc');
  const single = (await call(`/api/roms/${one.id}?keep_file=1`, { method: 'DELETE' })).body;
  assert.equal(single.file_deleted, false); assert.ok(fs.existsSync(one.storage_path));
  const bulk = (await call('/api/roms/bulk/delete', { method: 'POST', body: { ids: [two.id], keep_file: true } })).body;
  assert.equal(bulk.deleted, 1); assert.equal(bulk.files_deleted, 0); assert.ok(fs.existsSync(two.storage_path));
});

test('deleting an upload on purpose still removes its stored copy, as the confirmation says', async () => {
  const one = await upload('Gone One.sfc'), two = await upload('Gone Two.sfc');
  assert.equal((await call(`/api/roms/${one.id}`, { method: 'DELETE' })).body.file_deleted, true);
  assert.equal((await call('/api/roms/bulk/delete', { method: 'POST', body: { ids: [two.id] } })).body.files_deleted, 1);
  assert.ok(!fs.existsSync(one.storage_path) && !fs.existsSync(two.storage_path));
});

test('deleting a scanned game never touches the file in your folder, one or several at once', async () => {
  const one = await scannedThenSourceRemoved('Own One.sfc'), two = await scannedThenSourceRemoved('Own Two.sfc');
  assert.equal((await call(`/api/roms/${one.id}`, { method: 'DELETE' })).body.file_deleted, false);
  assert.equal((await call('/api/roms/bulk/delete', { method: 'POST', body: { ids: [two.id] } })).body.files_deleted, 0);
  assert.ok(fs.existsSync(one.storage_path) && fs.existsSync(two.storage_path));
});

test('Delete missing removes entries only: a file that has come back is left on disk', async () => {
  const up = await upload('Flagged Missing.sfc');
  db.prepare('UPDATE roms SET missing = 1 WHERE id = ?').run(up.id);
  assert.equal((await call('/api/roms/missing?dry_run=0', { method: 'DELETE' })).body.deleted, 1);
  assert.ok(fs.existsSync(up.storage_path));
});

test('the Delete orphans popup has one question, and Cancel stops it', () => {
  const app = fs.readFileSync(path.join(cwd, 'public', 'app.js'), 'utf8');
  const a = app.indexOf("$('#db-purge-orphans')?.addEventListener"), handler = app.slice(a, app.indexOf('async function loadSettingsOld', a));
  assert.equal(handler.split('confirmDialog(').length - 1, 1);
  assert.doesNotMatch(handler, /checkLabel|delete_file/);
  assert.match(handler, /if \(!ok\) return;\s+try \{\s+const r = await api\('\/roms\?dry_run=0', \{ method: 'DELETE' \}\);/);
});

test('Database maintenance shows its counts, with uploads on a line of their own', () => {
  const app = fs.readFileSync(path.join(cwd, 'public', 'app.js'), 'utf8'), html = fs.readFileSync(path.join(cwd, 'public', 'index.html'), 'utf8');
  const fn = app.slice(app.indexOf('function renderDbTools(facets)'), app.indexOf('async function loadLibraryOrphans'));
  for (const [, id] of fn.matchAll(/\$\('#([\w-]+)'\)/g)) assert.ok(html.includes(`id="${id}"`), `${id}: it used to wait for an element the page does not have`);
  assert.match(fn, /Added through Add ROMs/);
});

