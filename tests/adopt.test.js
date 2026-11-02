import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-adopt-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'aadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'a-admin-password-1';

let server, base, db, tok, dir;
const call = async (p, { method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  tok = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'aadmin', password: 'a-admin-password-1' }) })).json()).token;
  dir = path.join(TMP, 'genesis'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'Animaniacs (USA).md'), 'animaniacs-bytes-'.repeat(8));
  fs.writeFileSync(path.join(dir, 'Other Game (USA).md'), 'other-bytes-'.repeat(8));
});
after(async () => { await new Promise((r) => server?.close(r)); db?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('a locked game whose source was removed is reconnected when a source scans its folder again', async () => {
  const s1 = await call('/api/sources', { method: 'POST', body: { name: 'genesis', path: dir, platform_hint: 'genesis' } });
  assert.ok(s1.body.id, JSON.stringify(s1.body));
  await call(`/api/sources/${s1.body.id}/scan`, { method: 'POST', body: {} });
  const row = () => db.prepare("SELECT * FROM roms WHERE filename = 'Animaniacs (USA).md'").get();
  const id = row().id;
  assert.equal(row().source_id, s1.body.id);
  // lock it (Keep), then remove the source and its games: the locked one survives with no source
  db.prepare('UPDATE roms SET keep_override = 1 WHERE id = ?').run(id);
  assert.equal((await call(`/api/sources/${s1.body.id}?remove_roms=1`, { method: 'DELETE' })).status, 200);
  assert.equal(row().source_id, null, 'it is now "not in any source"');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM roms WHERE filename = 'Other Game (USA).md'").get().n, 0, 'the unlocked game went with the source');
  assert.equal((await call('/api/roms?orphan=only&hidden=all&system=all')).body.total, 1);
  // the folder is added again and scanned
  const s2 = await call('/api/sources', { method: 'POST', body: { name: 'genesis', path: dir, platform_hint: 'genesis' } });
  await call(`/api/sources/${s2.body.id}/scan`, { method: 'POST', body: {} });
  const back = row();
  assert.equal(back.id, id, 'the same entry came back, not a new one');
  assert.equal(back.source_id, s2.body.id, 'attached to the new source');
  assert.equal(back.keep_override, 1, 'and still locked');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM roms WHERE filename = 'Animaniacs (USA).md'").get().n, 1, 'no duplicate');
  assert.equal((await call('/api/roms?orphan=only&hidden=all&system=all')).body.total, 0, 'nothing is left "not in any source"');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM roms WHERE filename = 'Other Game (USA).md'").get().n, 1, 'the unlocked game was added fresh');
});

test('a game with no source whose file is NOT under the scanned folder is left alone', async () => {
  const f = path.join(TMP, 'elsewhere.md'); fs.writeFileSync(f, 'elsewhere-bytes-'.repeat(8));
  const id = Number(db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, source_path, in_place, size_bytes, sha1, keep_override) VALUES ((SELECT id FROM platforms WHERE slug = 'genesis'), 'Elsewhere', 'elsewhere', 'elsewhere.md', ?, ?, 1, 3, 'ad000009', 1)").run(f, f).lastInsertRowid);
  const src = db.prepare("SELECT id FROM sources LIMIT 1").get();
  await call(`/api/sources/${src.id}/scan`, { method: 'POST', body: {} });
  assert.equal(db.prepare('SELECT source_id FROM roms WHERE id = ?').get(id).source_id, null, 'still not in any source: no scanned folder holds it');
});

test('the wording says what the filter is', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /⛁ No source<\/button>/); assert.match(app, /label: 'Not in any source'/);
  assert.doesNotMatch(html + app, /Orphaned \(no source\)/);
});
