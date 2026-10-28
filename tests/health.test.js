import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-health-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'hadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'h-admin-password-1';
process.env.GAMESAUCE_SECRET_KEY = 'health-test-secret-key-do-not-leak-0123456789';

let server, base, db, adminTok, memberTok, srcDir;
const call = async (p, { token, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (u, p) => (await call('/api/auth/login', { method: 'POST', body: { username: u, password: p } })).body.token;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('hadmin', 'h-admin-password-1');
  await call('/api/auth/users', { method: 'POST', token: adminTok, body: { username: 'hmember', password: 'h-member-pass-12', role: 'user' } });
  memberTok = await login('hmember', 'h-member-pass-12');
  srcDir = path.join(TMP, 'roms-here'); fs.mkdirSync(srcDir);
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('the health report is admin-only', async () => {
  assert.equal((await call('/api/admin/health')).status, 401);
  assert.equal((await call('/api/admin/health', { token: memberTok })).status, 403);
  assert.equal((await call('/api/admin/health', { token: adminTok })).status, 200);
});

test('a fresh install reports an overall status, a summary and the core checks', async () => {
  const r = (await call('/api/admin/health', { token: adminTok })).body;
  assert.ok(['ok', 'warn', 'bad'].includes(r.status));
  const ids = r.checks.map((c) => c.id);
  for (const id of ['database', 'disk-data', 'disk-storage', 'backup', 'providers', 'encryption', 'https']) assert.ok(ids.includes(id), id);
  assert.ok(r.checks.every((c) => ['ok', 'warn', 'bad'].includes(c.status) && c.label && c.detail), 'every check is complete');
  assert.equal(r.checks.find((c) => c.id === 'database').status, 'ok');
  assert.equal(typeof r.summary.version, 'string');
  assert.ok(r.summary.schema >= 12);
  assert.equal(r.summary.users, 2);
});

test('no backup yet is a warning that says what to do', async () => {
  const b = (await call('/api/admin/health', { token: adminTok })).body.checks.find((c) => c.id === 'backup');
  assert.equal(b.status, 'warn');
  assert.match(b.detail, /No backup has been made yet/);
});

test('an unreachable source is flagged as a problem, a reachable one is not', async () => {
  const nes = db.prepare("SELECT id FROM platforms WHERE slug = 'nes'").get().id;
  db.prepare('INSERT INTO sources (name, path, platform_hint) VALUES (?, ?, ?)').run('Present', srcDir, 'nes');
  db.prepare('INSERT INTO sources (name, path, platform_hint) VALUES (?, ?, ?)').run('Unplugged', path.join(TMP, 'not-mounted'), 'nes');
  const checks = (await call('/api/admin/health', { token: adminTok })).body.checks;
  const present = checks.find((c) => c.label === 'Source: Present');
  const gone = checks.find((c) => c.label === 'Source: Unplugged');
  assert.equal(present.status, 'ok');
  assert.equal(gone.status, 'bad');
  assert.match(gone.detail, /not reachable/);
  assert.match(gone.detail, /stay in the library/);
  assert.ok(nes);
});

test('a failed automatic backup is reported, and a good one clears it', async () => {
  db.prepare("INSERT INTO meta (key, value) VALUES ('backup_last_error', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run('2026-01-01T00:00:00Z — EACCES no write access');
  let b = (await call('/api/admin/health', { token: adminTok })).body.checks.find((c) => c.id === 'backup');
  assert.equal(b.status, 'bad');
  assert.match(b.detail, /last automatic backup failed/);
  db.prepare("DELETE FROM meta WHERE key = 'backup_last_error'").run();
  const made = await call('/api/backup/run', { token: adminTok, method: 'POST' });
  assert.ok([200, 201].includes(made.status), `backup made (${made.status})`);
  b = (await call('/api/admin/health', { token: adminTok })).body.checks.find((c) => c.id === 'backup');
  assert.equal(b.status, 'ok');
  assert.match(b.detail, /1 kept on the server/);
});

test('the shareable report leaks no secrets, passwords or folder paths', async () => {
  const r = (await call('/api/admin/health', { token: adminTok })).body;
  const text = JSON.stringify(r);
  assert.ok(!text.includes('health-test-secret-key'), 'the encryption key is not in the report');
  assert.ok(!text.includes('h-admin-password-1') && !text.includes('h-member-pass-12'), 'no passwords');
  assert.ok(!text.includes(TMP.replace(/\\/g, '\\\\')) && !text.includes(TMP), 'no absolute folder paths');
  assert.ok(!/token|hash/i.test(r.diagnostics), 'no tokens or hashes');
  assert.match(r.diagnostics, /^game-sauce /);
  assert.match(r.diagnostics, /\[(OK  |WARN|FAIL)\]/);
});

test('the report changes nothing (it is read-only)', async () => {
  const count = () => db.prepare('SELECT (SELECT COUNT(*) FROM roms) + (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM sources) AS n').get().n;
  const before = count();
  await call('/api/admin/health', { token: adminTok });
  await call('/api/admin/health', { token: adminTok });
  assert.equal(count(), before);
});

test('the formatters read well', async () => {
  const { fmtBytes, fmtAge } = await import('../src/lib/health.js');
  assert.equal(fmtBytes(5 * 1024 ** 3), '5.0 GB');
  assert.equal(fmtBytes(300 * 1024 ** 2), '300 MB');
  assert.equal(fmtAge(30 * 1000), 'just now');
  assert.equal(fmtAge(10 * 60 * 1000), '10 minutes ago');
  assert.equal(fmtAge(5 * 3600 * 1000), '5 hours ago');
  assert.equal(fmtAge(5 * 24 * 3600 * 1000), '5 days ago');
});
