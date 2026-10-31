import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-multifolder-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'madmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'm-admin-password-1';

let server, base, db, tok;
const call = async (p, { method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const mk = (dir, name, text) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
const dirA = path.join(TMP, 'driveA', 'snes'), dirB = path.join(TMP, 'driveB', 'snes'), dirC = path.join(TMP, 'driveC', 'snes');
const titles = () => db.prepare('SELECT title, missing FROM roms ORDER BY title').all().map((r) => `${r.title}${r.missing ? ' (missing)' : ''}`);

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'madmin', password: 'm-admin-password-1' }) })).json()).token;
  mk(dirA, 'Alpha Game.sfc', 'alpha game bytes'); mk(dirB, 'Beta Game.sfc', 'beta game bytes'); mk(dirC, 'Gamma Game.sfc', 'gamma game bytes');
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('a source can take a second folder, and a scan finds the games in both', async () => {
  const s = (await call('/api/sources', { method: 'POST', body: { path: dirA, name: 'SNES', platform_hint: 'snes' } })).body;
  assert.deepEqual(s.extra_paths, []);
  const added = await call(`/api/sources/${s.id}/paths`, { method: 'POST', body: { path: dirB } });
  assert.equal(added.status, 201);
  assert.equal(added.body.extra_paths.length, 1);
  const r = (await call(`/api/sources/${s.id}/scan`, { method: 'POST', body: {} })).body;
  assert.equal(r.added, 2);
  assert.deepEqual(titles(), ['Alpha Game', 'Beta Game']);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT source_id) n FROM roms').get().n, 1, 'both in the one source');
  assert.equal((await call('/api/sources')).body.items[0].rom_count, 2);
});

test('the same folder, or a folder owned by another source, is refused', async () => {
  const s = (await call('/api/sources')).body.items[0];
  assert.equal((await call(`/api/sources/${s.id}/paths`, { method: 'POST', body: { path: dirB } })).status, 409, 'already added');
  assert.equal((await call(`/api/sources/${s.id}/paths`, { method: 'POST', body: { path: dirA } })).status, 409, "the source's own folder");
  assert.equal((await call(`/api/sources/${s.id}/paths`, { method: 'POST', body: { path: path.join(TMP, 'nope') } })).status, 400, 'does not exist');
  const s2 = (await call('/api/sources', { method: 'POST', body: { path: dirC, name: 'Other', platform_hint: 'snes' } })).body;
  assert.equal((await call(`/api/sources/${s.id}/paths`, { method: 'POST', body: { path: dirC } })).status, 409, 'belongs to another source');
  assert.equal((await call(`/api/sources/${s2.id}`, { method: 'DELETE' })).status, 200);
});

test('an unplugged second folder does NOT wipe its games; they come back when it does', async () => {
  const s = (await call('/api/sources')).body.items[0];
  fs.renameSync(path.join(TMP, 'driveB'), path.join(TMP, 'driveB-away')); // "unplug" it
  const r = (await call(`/api/sources/${s.id}/scan`, { method: 'POST', body: {} })).body;
  assert.equal(r.missing, 0, 'nothing flagged missing just because a folder is away');
  assert.deepEqual(titles(), ['Alpha Game', 'Beta Game']);
  assert.ok(r.errors >= 1, 'but the scan reports the folder it could not read');
  assert.equal((await call('/api/sources')).body.items[0].extra_paths[0].exists, false, 'and the list shows it as unreachable');
  fs.renameSync(path.join(TMP, 'driveB-away'), path.join(TMP, 'driveB'));
  assert.equal((await call(`/api/sources/${s.id}/scan`, { method: 'POST', body: {} })).body.missing, 0);
});

test('a game that is really gone from a folder that IS reachable is still flagged missing', async () => {
  const s = (await call('/api/sources')).body.items[0];
  fs.unlinkSync(path.join(dirB, 'Beta Game.sfc'));
  const r = (await call(`/api/sources/${s.id}/scan`, { method: 'POST', body: {} })).body;
  assert.equal(r.missing, 1);
  assert.deepEqual(titles(), ['Alpha Game', 'Beta Game (missing)']);
});

test('a folder nested inside another is walked once, and removing a folder keeps the games', async () => {
  const s = (await call('/api/sources')).body.items[0];
  mk(path.join(dirA, 'sub'), 'Nested Game.sfc', 'nested bytes');
  const added = await call(`/api/sources/${s.id}/paths`, { method: 'POST', body: { path: path.join(dirA, 'sub') } });
  assert.equal(added.status, 201);
  const r = (await call(`/api/sources/${s.id}/scan`, { method: 'POST', body: {} })).body;
  assert.equal(db.prepare("SELECT COUNT(*) n FROM roms WHERE title = 'Nested Game'").get().n, 1, 'one game, not two');
  const extras = (await call('/api/sources')).body.items[0].extra_paths;
  assert.equal((await call(`/api/sources/${s.id}/paths/${extras[extras.length - 1].id}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM roms WHERE title = 'Nested Game'").get().n, 1, 'its game is still in the library');
  assert.equal((await call(`/api/sources/${s.id}/paths/99999`, { method: 'DELETE' })).status, 404);
});

test('deleting a source removes its extra folders too', async () => {
  const s = (await call('/api/sources')).body.items[0];
  assert.ok(db.prepare('SELECT COUNT(*) n FROM source_paths').get().n >= 1);
  assert.equal((await call(`/api/sources/${s.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM source_paths').get().n, 0);
});
