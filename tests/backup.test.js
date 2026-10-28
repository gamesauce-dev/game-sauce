import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-bk-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'bkadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'bk-admin-password-1';
process.env.GAMESAUCE_BACKUP_DIR = path.join(TMP, 'backups');

let server, base, adminTok, userTok, db, Database;
const call = async (p, { method = 'GET', body, tok = adminTok, raw = false } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${tok}` },
    body: body ? JSON.stringify(body) : undefined
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: raw || !ct.includes('json') ? Buffer.from(await res.arrayBuffer()) : await res.json() };
};
const login = async (u, p) => (await (await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p })
})).json()).token;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  Database = (await import('better-sqlite3')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('bkadmin', 'bk-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'bob', password: 'bob-password-12345', role: 'user' } });
  userTok = await login('bob', 'bob-password-12345');

  // Real content to back up: a ROM row and a save state file for the admin.
  const plat = db.prepare("SELECT id FROM platforms WHERE slug = 'nes'").get().id;
  const romId = db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1) VALUES ('Backup Me','backup me','b.nes',?,'x',1,'bk1')").run(plat).lastInsertRowid;
  await fetch(`${base}/api/roms/${romId}/saves?kind=state&core=nes`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${adminTok}` }, body: Buffer.from('SAVE-STATE-BYTES')
  });
});
after(() => { server?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

// Read the archive with the system's own tar (an independent reader of our hand-made ustar).
function extract(buf, name) {
  const dir = fs.mkdtempSync(path.join(TMP, 'x-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  const r = spawnSync('tar', ['-xzf', file, '-C', dir]);
  assert.equal(r.status, 0, `tar could not read the archive: ${r.stderr?.toString()}`);
  return dir;
}

test('backups are admin-only', async () => {
  assert.equal((await call('/api/backup', { tok: userTok })).status, 403);
  assert.equal((await call('/api/backup/download', { tok: userTok })).status, 403);
  assert.equal((await call('/api/backup/run', { method: 'POST', body: {}, tok: userTok })).status, 403);
});

test('a downloaded backup is a valid archive holding the database, key, saves and manifest', async () => {
  // secret.key is created the first time a credential is stored; make sure one exists.
  const { setSettings } = await import('../src/settings.js');
  try { setSettings({ SGDB_API_KEY: 'test-key-123' }, null); } catch { /* signature differs: fall back to a plain key file */ }
  if (!fs.existsSync(path.join(TMP, 'data', 'secret.key'))) fs.writeFileSync(path.join(TMP, 'data', 'secret.key'), Buffer.alloc(32, 7));
  const res = await call('/api/backup/download', { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /game-sauce-backup-\d{8}-\d{6}\.tar\.gz/);
  const dir = extract(res.body, 'dl.tar.gz');

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.app, 'game-sauce');
  assert.ok(manifest.schema_version >= 11);
  assert.equal(manifest.includes.imported_roms, false);
  assert.equal(manifest.includes.secret_key, true);
  assert.ok(manifest.counts.roms >= 1 && manifest.counts.users >= 2);

  // The copy opens as a real, healthy database with our data in it.
  const copy = new Database(path.join(dir, 'gamesauce.db'), { readonly: true });
  assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(copy.prepare("SELECT title FROM roms WHERE sha1 = 'bk1'").get().title, 'Backup Me');
  assert.equal(copy.prepare('SELECT COUNT(*) n FROM users').get().n, manifest.counts.users);
  copy.close();

  assert.ok(fs.existsSync(path.join(dir, 'secret.key')));
  const saves = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : saves.push(p); } })(path.join(dir, 'saves'));
  assert.ok(saves.some((p) => fs.readFileSync(p, 'utf8') === 'SAVE-STATE-BYTES'), 'the save state file is in the archive');
  assert.ok(!fs.readdirSync(path.join(TMP, 'data')).some((n) => n.startsWith('.backup-tmp')), 'temporary snapshot was cleaned up');
});

test('server-side backups: written atomically, listed, downloadable, pruned to the keep limit', async () => {
  assert.equal((await call('/api/backup/settings', { method: 'PUT', body: { interval_hours: 0, keep: 2, dir: '' } })).status, 200);
  const names = [];
  for (let i = 0; i < 4; i++) {
    const r = await call('/api/backup/run', { method: 'POST', body: {} });
    assert.equal(r.status, 201);
    names.push(r.body.name);
  }
  assert.equal(new Set(names).size, 4, 'back-to-back backups never overwrite each other');

  const list = (await call('/api/backup')).body;
  assert.equal(list.items.length, 2, 'only the newest 2 are kept');
  assert.deepEqual(list.items.map((b) => b.name), names.slice(-2).reverse());
  assert.ok(!fs.readdirSync(process.env.GAMESAUCE_BACKUP_DIR).some((n) => n.startsWith('.partial')), 'no half-written file left behind');

  const file = await call(`/api/backup/files/${list.items[0].name}`, { raw: true });
  assert.equal(file.status, 200);
  extract(file.body, 'kept.tar.gz');
  assert.ok(list.settings.last_at, 'last backup time recorded');

  assert.equal((await call(`/api/backup/files/${list.items[1].name}`, { method: 'DELETE' })).body.removed, 1);
  assert.equal((await call('/api/backup')).body.items.length, 1);
});

test('file names are validated, so nothing outside the backup folder can be read or deleted', async () => {
  fs.writeFileSync(path.join(TMP, 'precious.txt'), 'do not touch');
  for (const bad of ['..%2F..%2Fprecious.txt', '..%5Cprecious.txt', 'precious.txt', 'game-sauce-backup-1.tar.gz', 'game-sauce-backup-20260101-000000.tar.gz.evil']) {
    assert.equal((await call(`/api/backup/files/${bad}`)).status, 404, `read refused: ${bad}`);
    const del = await call(`/api/backup/files/${bad}`, { method: 'DELETE' });
    assert.ok([400, 404].includes(del.status), `delete refused: ${bad}`);
  }
  assert.equal(fs.readFileSync(path.join(TMP, 'precious.txt'), 'utf8'), 'do not touch');
});

test('settings are validated, and an unwritable folder is refused', async () => {
  const put = (b) => call('/api/backup/settings', { method: 'PUT', body: b });
  assert.equal((await put({ interval_hours: 5, keep: 7, dir: '' })).status, 400);
  assert.equal((await put({ interval_hours: 24, keep: 0, dir: '' })).status, 400);
  assert.equal((await put({ interval_hours: 24, keep: 7, dir: 'relative/path' })).status, 400);
  const blocker = path.join(TMP, 'a-file');
  fs.writeFileSync(blocker, 'x');
  assert.equal((await put({ interval_hours: 24, keep: 7, dir: path.join(blocker, 'sub') })).status, 400);
  const ok = await put({ interval_hours: 24, keep: 5, dir: path.join(TMP, 'elsewhere') });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.settings.interval_hours, 24);
  assert.equal(ok.body.settings.keep, 5);
  await put({ interval_hours: 0, keep: 7, dir: '' });
});

test('the scheduler writes a backup when one is due and not before', async () => {
  const { startBackupScheduler, getBackupSettings, listBackups } = await import('../src/lib/backup.js');
  await call('/api/backup/settings', { method: 'PUT', body: { interval_hours: 6, keep: 3, dir: '' } });
  db.prepare("INSERT INTO meta (key, value) VALUES ('backup_last_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(new Date().toISOString());
  const before = listBackups().length;
  startBackupScheduler({ checkEveryMs: 50 });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(listBackups().length, before, 'not due yet: nothing written');

  db.prepare("UPDATE meta SET value = ? WHERE key = 'backup_last_at'").run(new Date(Date.now() - 7 * 3600 * 1000).toISOString());
  for (let i = 0; i < 40 && listBackups().length === before; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(listBackups().length > before || listBackups().length === 3, 'due: a backup was written');
  assert.ok(Date.now() - Date.parse(getBackupSettings().last_at) < 60000, 'last-backup time moved forward');
  await call('/api/backup/settings', { method: 'PUT', body: { interval_hours: 0, keep: 7, dir: '' } });
});
