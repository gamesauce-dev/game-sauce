import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-rs-test-'));
const DATA = path.join(TMP, 'data');
const STORAGE = path.join(TMP, 'storage');
process.env.GAMESAUCE_DATA_DIR = DATA;
process.env.GAMESAUCE_STORAGE_DIR = STORAGE;
process.env.GAMESAUCE_RATE_LIMIT_HEAVY = '0'; // these tests make many restore calls in a second
process.env.GAMESAUCE_ADMIN_USER = 'rsadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'rs-admin-password-1';
process.env.GAMESAUCE_BACKUP_DIR = path.join(TMP, 'backups');
process.env.GAMESAUCE_RESTART = 'manual'; // never let a test kill the test runner

let server, base, tok, db;
const hdr = () => ({ Authorization: `Bearer ${tok}` });
const jcall = async (p, { method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...hdr(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const upload = async (buf, name = 'b.tar.gz') => {
  const fd = new FormData();
  fd.append('backup', new Blob([buf]), name);
  const res = await fetch(`${base}/api/backup/restore/inspect`, { method: 'POST', headers: hdr(), body: fd });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const download = async () => Buffer.from(await (await fetch(`${base}/api/backup/download`, { headers: hdr() })).arrayBuffer());

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'rsadmin', password: 'rs-admin-password-1' }) })).json()).token;
});
after(() => { server?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

const addRom = (title, sha) => {
  const plat = db.prepare("SELECT id FROM platforms WHERE slug = 'nes'").get().id;
  return db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1) VALUES (?,?,?,?,'x',1,?)").run(title, title.toLowerCase(), `${sha}.nes`, plat, sha).lastInsertRowid;
};

const ensureKey = () => { const k = path.join(DATA, 'secret.key'); if (!fs.existsSync(k)) fs.writeFileSync(k, Buffer.alloc(32, 9)); };

test('inspect reports what is in a backup and changes nothing', async () => {
  ensureKey();
  addRom('Before Backup', 'rs1');
  const archive = await download();
  addRom('After Backup', 'rs2'); // added after the backup was taken
  const romsNow = db.prepare('SELECT COUNT(*) n FROM roms').get().n;

  const r = await upload(archive);
  assert.equal(r.status, 200);
  assert.equal(r.body.counts.roms, romsNow - 1, 'counts come from the backup, not the live data');
  assert.equal(r.body.current_counts.roms, romsNow);
  assert.equal(r.body.manifest.app_version.length > 0, true);
  assert.equal(r.body.key_in_backup, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM roms').get().n, romsNow, 'live data untouched');
  assert.ok(!fs.existsSync(path.join(DATA, 'restore-pending.json')), 'nothing scheduled yet');
});

test('bad uploads are rejected with a clear message, and leave nothing behind', async () => {
  assert.equal((await upload(Buffer.from('this is not a backup at all'))).status, 400);
  assert.equal((await upload(zlib.gzipSync(Buffer.from('plain gzip, not a tar')))).status, 400);

  const good = await download();
  const truncated = good.subarray(0, Math.floor(good.length / 2));
  const t = await upload(truncated);
  assert.equal(t.status, 400, 'a half-downloaded backup is refused');
  assert.match(t.body.error, /backup/i);

  const noFile = await fetch(`${base}/api/backup/restore/inspect`, { method: 'POST', headers: hdr(), body: new FormData() });
  assert.equal(noFile.status, 400);
  assert.ok(!fs.existsSync(path.join(DATA, 'restore-upload')) || fs.readdirSync(path.join(DATA, 'restore-upload')).length === 0, 'temporary upload removed');
});

test('a backup from a newer database version is refused', async () => {
  const { stageRestore } = await import('../src/lib/restore.js');
  const Database = (await import('better-sqlite3')).default;
  // Build a doctored copy of a real backup whose database claims a far-future schema.
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(TMP, 'fut-'));
  ensureKey();
  fs.writeFileSync(path.join(dir, 'b.tar.gz'), await download());
  assert.equal(spawnSync('tar', ['-xzf', path.join(dir, 'b.tar.gz'), '-C', dir]).status, 0);
  const d = new Database(path.join(dir, 'gamesauce.db'));
  d.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
  d.pragma('wal_checkpoint(TRUNCATE)'); d.close();
  assert.equal(spawnSync('tar', ['-czf', path.join(dir, 'new.tar.gz'), '-C', dir, 'manifest.json', 'gamesauce.db', 'secret.key']).status, 0);
  const r = await upload(fs.readFileSync(path.join(dir, 'new.tar.gz')));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /newer game-sauce/);
  assert.ok(typeof stageRestore === 'function');
});

test('apply needs the typed confirmation and a valid token, and takes a safety backup', async () => {
  const staged = (await upload(await download())).body;
  assert.equal((await jcall('/api/backup/restore/apply', { method: 'POST', body: { token: staged.token } })).status, 400, 'no RESTORE typed');
  assert.equal((await jcall('/api/backup/restore/apply', { method: 'POST', body: { token: '../../etc', confirm: 'RESTORE' } })).status, 400);
  assert.equal((await jcall('/api/backup/restore/apply', { method: 'POST', body: { token: 'a'.repeat(32), confirm: 'RESTORE' } })).status, 404);

  const listBk = () => (fs.existsSync(process.env.GAMESAUCE_BACKUP_DIR) ? fs.readdirSync(process.env.GAMESAUCE_BACKUP_DIR) : []);
  const before = listBk().length;
  const r = await jcall('/api/backup/restore/apply', { method: 'POST', body: { token: staged.token, confirm: 'RESTORE' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.restarting, false, 'manual-restart mode: the test process is not killed');
  assert.equal(listBk().length, before + 1, 'a safety backup was written');
  assert.ok(listBk().includes(r.body.safety_backup), 'and it is the one reported');
  assert.ok(fs.existsSync(path.join(DATA, 'restore-pending.json')));
  await jcall('/api/backup/restore/cancel', { method: 'POST', body: {} });
  assert.ok(!fs.existsSync(path.join(DATA, 'restore-pending.json')), 'cancel clears the pending restore');
});

test('restore endpoints are admin-only', async () => {
  await jcall('/api/auth/users', { method: 'POST', body: { username: 'rsbob', password: 'bob-password-12345', role: 'user' } });
  const t2 = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'rsbob', password: 'bob-password-12345' }) })).json()).token;
  for (const [m, p] of [['GET', '/restore/status'], ['POST', '/restore/apply'], ['POST', '/restore/cancel'], ['POST', '/restore/inspect']]) {
    const res = await fetch(`${base}/api/backup${p}`, { method: m, headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' }, body: m === 'POST' ? '{}' : undefined });
    assert.equal(res.status, 403, `${m} ${p}`);
  }
});

/* The real thing: a separate server process, restored through the API, restarted, and checked. */
test('end to end: restore through the API, restart the server, the old data is back and the new data is set aside', async () => {
  const e2e = fs.mkdtempSync(path.join(TMP, 'e2e-'));
  const env = {
    ...process.env, GAMESAUCE_DATA_DIR: path.join(e2e, 'data'), GAMESAUCE_STORAGE_DIR: path.join(e2e, 'storage'),
    GAMESAUCE_BACKUP_DIR: path.join(e2e, 'backups'), GAMESAUCE_RESTART: 'exit',
    GAMESAUCE_ADMIN_USER: 'e2e', GAMESAUCE_ADMIN_PASSWORD: 'e2e-admin-password-1', HOST: '127.0.0.1', PORT: '0'
  };
  const start = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...env, PORT: String(18000 + Math.floor(Math.random() * 1500)) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (d) => { out += d; const m = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/); if (m) resolve({ p, port: m[1], log: () => out }); };
    p.stdout.on('data', onData); p.stderr.on('data', (d) => { out += d; });
    p.once('exit', (c) => reject(new Error(`server exited early (${c}): ${out}`)));
    setTimeout(() => reject(new Error('server did not start: ' + out)), 20000);
  });
  const api = async (port, token, p, opt = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { ...opt, headers: { Authorization: `Bearer ${token}`, ...(opt.headers || {}) } });
    return { status: res.status, body: await res.json().catch(() => null), res };
  };
  const loginTo = async (port) => (await (await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'e2e', password: 'e2e-admin-password-1' }) })).json()).token;
  const Database = (await import('better-sqlite3')).default;
  const sql = (fn) => { const d = new Database(path.join(e2e, 'data', 'gamesauce.db')); try { return fn(d); } finally { d.close(); } };

  // 1. first run, with one distinctive ROM and a save file
  let s = await start();
  let token = await loginTo(s.port);
  const plat = (await api(s.port, token, '/api/platforms')).body.items.find((x) => x.slug === 'nes');
  s.p.removeAllListeners('exit'); s.p.kill(); await new Promise((r) => setTimeout(r, 600));
  sql((d) => d.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1) VALUES ('Original Game','original game','o.nes',?, 'x',1,'e2e-orig')").run(plat.id));
  fs.mkdirSync(path.join(e2e, 'storage', 'saves', '1', '1'), { recursive: true });
  fs.writeFileSync(path.join(e2e, 'storage', 'saves', '1', '1', 'orig.state'), 'ORIGINAL-SAVE');

  // 2. back up, then change the world
  s = await start(); token = await loginTo(s.port);
  const archive = Buffer.from(await (await fetch(`http://127.0.0.1:${s.port}/api/backup/download`, { headers: { Authorization: `Bearer ${token}` } })).arrayBuffer());
  s.p.removeAllListeners('exit'); s.p.kill(); await new Promise((r) => setTimeout(r, 600));
  sql((d) => { d.prepare("DELETE FROM roms WHERE sha1 = 'e2e-orig'").run(); d.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1) VALUES ('Newer Game','newer game','n.nes',?, 'x',1,'e2e-new')").run(plat.id); });
  fs.writeFileSync(path.join(e2e, 'storage', 'saves', '1', '1', 'orig.state'), 'CHANGED-SAVE');
  assert.equal(sql((d) => d.prepare("SELECT COUNT(*) n FROM roms WHERE title = 'Original Game'").get().n), 0);

  // 3. restore through the API; the server exits itself (code 75) and we play the supervisor
  s = await start(); token = await loginTo(s.port);
  const fd = new FormData(); fd.append('backup', new Blob([archive]), 'b.tar.gz');
  const insp = await api(s.port, token, '/api/backup/restore/inspect', { method: 'POST', body: fd });
  assert.equal(insp.status, 200, JSON.stringify(insp.body));
  assert.equal(insp.body.restart_supported, true);
  const exited = new Promise((resolve) => s.p.once('exit', (code) => resolve(code)));
  s.p.removeAllListeners('exit'); // (the early-exit rejection from start() is no longer relevant)
  const exited2 = new Promise((resolve) => s.p.once('exit', (code) => resolve(code)));
  const applied = await api(s.port, token, '/api/backup/restore/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: insp.body.token, confirm: 'RESTORE' }) });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.restarting, true);
  assert.equal(await exited2, 75, 'server exits with the restart code');
  void exited;
  assert.ok(fs.existsSync(path.join(e2e, 'data', 'restore-pending.json')), 'the swap is waiting for the restart');

  // 4. "supervisor" restarts it: the swap happens before the database opens
  s = await start();
  const log = s.log();
  assert.match(log, /restored from backup/);
  token = await loginTo(s.port);
  s.p.removeAllListeners('exit'); s.p.kill(); await new Promise((r) => setTimeout(r, 600));

  assert.equal(sql((d) => d.prepare("SELECT COUNT(*) n FROM roms WHERE title = 'Original Game'").get().n), 1, 'the backed-up game is back');
  assert.equal(sql((d) => d.prepare("SELECT COUNT(*) n FROM roms WHERE title = 'Newer Game'").get().n), 0, 'data added after the backup is gone');
  assert.equal(fs.readFileSync(path.join(e2e, 'storage', 'saves', '1', '1', 'orig.state'), 'utf8'), 'ORIGINAL-SAVE', 'saves restored');
  assert.ok(!fs.existsSync(path.join(e2e, 'data', 'restore-pending.json')), 'pending marker cleared');
  assert.ok(!fs.existsSync(path.join(e2e, 'data', 'restore-staging')), 'staging cleaned up');

  const kept = fs.readdirSync(path.join(e2e, 'data')).find((n) => n.startsWith('pre-restore-'));
  assert.ok(kept, 'the data that was replaced is kept, not deleted');
  const keptDb = new Database(path.join(e2e, 'data', kept, 'gamesauce.db'), { readonly: true });
  assert.equal(keptDb.prepare("SELECT COUNT(*) n FROM roms WHERE title = 'Newer Game'").get().n, 1, 'the undo copy still has the newer data');
  keptDb.close();
  assert.equal(fs.readFileSync(path.join(e2e, 'data', kept, 'saves', '1', '1', 'orig.state'), 'utf8'), 'CHANGED-SAVE');
  assert.ok(fs.readdirSync(path.join(e2e, 'backups')).length >= 1, 'a safety backup was written to the backup folder');
  assert.ok(sql((d) => d.prepare('SELECT COUNT(*) n FROM sessions').get().n) <= 1, 'old sessions were not resurrected');
});

test('restore straight from a backup in the server folder (no download / upload)', async () => {
  const saved = await jcall('/api/backup/run', { method: 'POST', body: {} });
  assert.equal(saved.status, 201);
  const name = saved.body.name;
  addRom('Added After Server Backup', 'rs-srv'); // not in the backup

  const r = await jcall('/api/backup/restore/inspect-server', { method: 'POST', body: { name } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.source_name, name);
  assert.ok(r.body.counts.roms < r.body.current_counts.roms, 'counts come from the backup, not the live data');
  assert.ok(r.body.token);

  // Names are validated: nothing outside the backup folder can be staged.
  for (const bad of ['../../etc/passwd', '..\\..\\x', 'precious.txt', '', 'game-sauce-backup-1.tar.gz']) {
    const res = await jcall('/api/backup/restore/inspect-server', { method: 'POST', body: { name: bad } });
    assert.ok([400, 404].includes(res.status), `refused: ${JSON.stringify(bad)} -> ${res.status}`);
  }
  // Admin only.
  await jcall('/api/auth/users', { method: 'POST', body: { username: 'rsbob2', password: 'bob-password-12345', role: 'user' } });
  const t2 = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'rsbob2', password: 'bob-password-12345' }) })).json()).token;
  const forbidden = await fetch(`${base}/api/backup/restore/inspect-server`, { method: 'POST', headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  assert.equal(forbidden.status, 403);

  await jcall('/api/backup/restore/cancel', { method: 'POST', body: {} });
});
