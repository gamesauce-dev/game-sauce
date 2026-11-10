import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-relocate-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'radmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'r-admin-password-1';

let server, base, db, tok;
const call = async (p, { method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'radmin', password: 'r-admin-password-1' }) })).json()).token;
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ } });

test('a renamed folder: the source is pointed at its new place and every game keeps its entry', async () => {
  const oldDir = path.join(TMP, 'roms', 'Xbox 360'), newDir = path.join(TMP, 'roms', 'xbox360');
  fs.mkdirSync(path.join(oldDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'Halo 3 (USA).iso'), 'halo');
  fs.writeFileSync(path.join(oldDir, 'sub', 'Gears of War (USA).iso'), 'gears');
  const created = await call('/api/sources', { method: 'POST', body: { path: oldDir, platform_hint: 'xbox360' } });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await call(`/api/sources/${id}/scan`, { method: 'POST', body: { hash: false } })).status, 200);
  const before = db.prepare('SELECT id, source_path FROM roms WHERE source_id = ? ORDER BY id').all(id);
  assert.equal(before.length, 2);

  // a folder that does not hold the games is refused, and nothing changes
  fs.mkdirSync(path.join(TMP, 'roms', 'empty'), { recursive: true });
  const wrong = await call(`/api/sources/${id}/relocate`, { method: 'POST', body: { path: path.join(TMP, 'roms', 'empty') } });
  assert.equal(wrong.status, 400); assert.match(wrong.body.error, /None of this source's 2 games/);
  assert.equal((await call(`/api/sources/${id}/relocate`, { method: 'POST', body: { path: oldDir } })).status, 400, 'the same folder is not a move');

  fs.renameSync(oldDir, newDir);
  const done = await call(`/api/sources/${id}/relocate`, { method: 'POST', body: { path: newDir } });
  assert.equal(done.status, 200); assert.deepEqual({ moved: done.body.moved, found: done.body.found, not_found: done.body.not_found }, { moved: 2, found: 2, not_found: 0 });
  const after = db.prepare('SELECT id, source_path, storage_path, missing FROM roms WHERE source_id = ? ORDER BY id').all(id);
  assert.deepEqual(after.map((r) => r.id), before.map((r) => r.id), 'the same entries');
  for (const r of after) { assert.ok(r.source_path.startsWith(newDir + path.sep) && r.storage_path === r.source_path && r.missing === 0 && fs.existsSync(r.source_path)); }
  assert.ok(after.some((r) => r.source_path === path.join(newDir, 'sub', 'Gears of War (USA).iso')), 'subfolders move with it');
  assert.equal(db.prepare('SELECT path FROM sources WHERE id = ?').get(id).path, newDir);
  // a later scan finds the same games: nothing new, nothing lost
  const again = await call(`/api/sources/${id}/scan`, { method: 'POST', body: { hash: false } });
  assert.equal(again.body.added, 0); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM roms WHERE source_id = ? AND missing = 0').get(id).n, 2);
});

test('the screen: a "Folder renamed or moved?" button on each source', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes('data-act="relocate"') && app.includes('/relocate'));
});
