import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-collown-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'cadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'c-admin-password-1';

let server, base, db, adminTok, annTok, romId;
const call = async (p, { token = adminTok, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (u, p) => (await call('/api/auth/login', { token: null, method: 'POST', body: { username: u, password: p } })).body.token;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('cadmin', 'c-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'ann', password: 'ann-password-123', role: 'user' } });
  annTok = await login('ann', 'ann-password-123');
  const f = path.join(TMP, 'g.sfc'); fs.writeFileSync(f, 'rom');
  romId = Number(db.prepare(`INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1)
    VALUES ((SELECT id FROM platforms WHERE slug = 'snes'), 'Shared Game', 'shared game', 'g.sfc', ?, 3, 'cc000001')`).run(f).lastInsertRowid);
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('a collection is seen and changed only by the person who made it', async () => {
  const mine = (await call('/api/collections', { method: 'POST', body: { name: 'Admin picks' } })).body;
  assert.ok(mine.id);
  await call(`/api/collections/${mine.id}/roms`, { method: 'POST', body: { rom_ids: [romId] } });
  assert.equal((await call('/api/collections', { token: annTok })).body.items.length, 0, 'Ann sees none of the admin\'s');
  assert.equal((await call(`/api/collections/${mine.id}`, { token: annTok })).status, 404, 'cannot open it by number');
  assert.equal((await call(`/api/collections/${mine.id}/roms`, { token: annTok, method: 'POST', body: { rom_ids: [romId] } })).status, 404);
  assert.equal((await call(`/api/collections/${mine.id}/roms/${romId}`, { token: annTok, method: 'DELETE' })).status, 404);
  assert.equal((await call(`/api/collections/${mine.id}`, { token: annTok, method: 'DELETE' })).status, 404, 'cannot delete it');
  assert.equal((await call(`/api/collections/${mine.id}`, { token: annTok, method: 'PATCH', body: { name: 'mine now' } })).status, 404);
  // the admin's own list still has it, with its game, and is not shown in the game's collections for Ann
  assert.equal((await call('/api/collections')).body.items.length, 1);
  assert.equal((await call(`/api/roms/${romId}`, { token: annTok })).body.collections.length, 0);
  assert.equal((await call(`/api/roms/${romId}`)).body.collections.length, 1);
});

test('two people can each have a collection with the same name', async () => {
  const a = await call('/api/collections', { method: 'POST', body: { name: 'Favourites' } });
  const b = await call('/api/collections', { token: annTok, method: 'POST', body: { name: 'Favourites' } });
  assert.equal(a.status < 300, true); assert.equal(b.status < 300, true);
  assert.equal((await call('/api/collections', { token: annTok, method: 'POST', body: { name: 'Favourites' } })).status, 409, 'but not twice for the same person');
  assert.equal((await call('/api/collections', { token: annTok })).body.items.length, 1);
});

test('the v23 migration keeps every collection and its games, giving them to the oldest admin', async () => {
  // Rebuild the OLD shape in a scratch database and run the migration over it.
  const Database = (await import('better-sqlite3')).default;
  const old = new Database(':memory:');
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT);
    CREATE TABLE roms (id INTEGER PRIMARY KEY);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE collections (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE collection_roms (collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE, rom_id INTEGER NOT NULL REFERENCES roms(id) ON DELETE CASCADE, PRIMARY KEY (collection_id, rom_id));
    INSERT INTO users VALUES (3, 'user'), (5, 'admin'), (9, 'admin');
    INSERT INTO roms VALUES (1), (2);
    INSERT INTO collections (id, name) VALUES (7, 'Old set'), (8, 'Another');
    INSERT INTO collection_roms VALUES (7, 1), (7, 2), (8, 1);
    INSERT INTO meta VALUES ('schema_version', '22');`);
  old.pragma('foreign_keys = ON');
  const src = fs.readFileSync(new URL('../src/migrations.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('/* ── v23'));
  const run = new Function('db', block.replace(/^\/\*[\s\S]*?\*\/\n/, '')); // the v23 block only
  run(old);
  assert.equal(old.prepare('SELECT COUNT(*) n FROM collection_roms').get().n, 3, 'no game link was lost');
  assert.deepEqual(old.prepare('SELECT id, user_id FROM collections ORDER BY id').all(), [{ id: 7, user_id: 5 }, { id: 8, user_id: 5 }]);
  assert.equal(old.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '23');
  old.close();
});
