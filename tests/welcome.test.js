import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-welcome-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'wadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'w-admin-password-1';

let server, base, db, adminTok, memberTok;
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
  adminTok = await login('wadmin', 'w-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'wmember', password: 'w-member-pass-12', role: 'user' } });
  memberTok = await login('wmember', 'w-member-pass-12');
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('an account made after the tour existed starts with the tour not seen; /me says so', async () => {
  assert.equal((await call('/api/auth/me', { token: memberTok })).body.user.welcomed, false);
  assert.equal((await call('/api/auth/me')).body.user.welcomed, false, 'the first admin is new too');
});

test('finishing or skipping marks it seen, and it can be switched back on', async () => {
  assert.equal((await call('/api/auth/welcomed', { token: memberTok, method: 'POST', body: { done: true } })).body.welcomed, true);
  assert.equal((await call('/api/auth/me', { token: memberTok })).body.user.welcomed, true);
  assert.equal((await call('/api/auth/me')).body.user.welcomed, false, 'one person finishing does not affect another');
  assert.equal((await call('/api/auth/welcomed', { token: memberTok, method: 'POST', body: { done: false } })).body.welcomed, false);
  assert.equal((await call('/api/auth/welcomed', { token: null, method: 'POST', body: {} })).status, 401);
});

test('accounts that existed before the tour was added are treated as already welcomed', async () => {
  // Simulate an old database: no column yet, one existing user.
  const old = (await import('better-sqlite3')).default(':memory:');
  old.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)");
  old.exec("INSERT INTO users (username) VALUES ('veteran')");
  if (!old.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'welcomed')) {
    old.exec('ALTER TABLE users ADD COLUMN welcomed INTEGER NOT NULL DEFAULT 0');
    old.exec('UPDATE users SET welcomed = 1');
  }
  old.exec("INSERT INTO users (username) VALUES ('newcomer')");
  assert.deepEqual(old.prepare('SELECT username, welcomed FROM users ORDER BY id').all(), [{ username: 'veteran', welcomed: 1 }, { username: 'newcomer', welcomed: 0 }]);
  old.close();
});

test('only an admin can switch a game\'s browser play on or off', async () => {
  const id = db.prepare(`INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1)
    VALUES ((SELECT id FROM platforms WHERE slug = 'snes'), 'Test Game', 'test game', 'Test Game.sfc', '/nowhere/x.sfc', 1, 'welc000001')`).run().lastInsertRowid;
  assert.equal((await call(`/api/roms/${id}/play-override`, { token: memberTok, method: 'POST', body: { value: false } })).status, 403);
  assert.equal((await call(`/api/roms/${id}/play-override`, { method: 'POST', body: { value: false } })).status, 200);
  assert.equal(db.prepare('SELECT play_override FROM roms WHERE id = ?').get(id).play_override, 0);
});

test('signing in reports whether the tour was seen, so the app can show it straight away', async () => {
  await call('/api/auth/users', { method: 'POST', body: { username: 'wlogin', password: 'w-login-pass-123', role: 'user' } });
  const first = await call('/api/auth/login', { token: null, method: 'POST', body: { username: 'wlogin', password: 'w-login-pass-123' } });
  assert.equal(first.body.user.welcomed, false);
  await call('/api/auth/welcomed', { token: first.body.token, method: 'POST', body: { done: true } });
  const again = await call('/api/auth/login', { token: null, method: 'POST', body: { username: 'wlogin', password: 'w-login-pass-123' } });
  assert.equal(again.body.user.welcomed, true);
});

test('the DAT list is quick on a real-sized library (the game -> DAT entry link is indexed)', async () => {
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'roms'").all().map((r) => r.name);
  assert.ok(idx.includes('idx_roms_dat_entry'), 'roms.dat_entry_id needs an index or the DAT list scans every game for every entry');
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM roms r WHERE r.dat_entry_id IN (SELECT id FROM dat_entries WHERE datfile_id = 1)').all().map((r) => r.detail).join(' | ');
  assert.match(plan, /idx_roms_dat_entry/, 'the count uses the index: ' + plan);
  assert.equal(Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value), 18);
});
