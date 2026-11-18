import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-hashjob-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'hadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'h-admin-password-1';
delete process.env.GAMESAUCE_HASH_MODE;

let server, base, adminTok, userTok, db, hj;
const call = async (p, { method = 'GET', body, token = adminTok } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  hj = await import('../src/lib/hashjob.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  adminTok = await login('hadmin', 'h-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'sam', password: 'sam-password-123', role: 'user' } });
  userTok = await login('sam', 'sam-password-123');
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('inWindow: a daytime window, one that crosses midnight, and equal times (the whole day)', () => {
  const at = (h, m = 0) => new Date(2026, 10, 19, h, m);
  assert.equal(hj.inWindow('01:00', '07:00', at(3)), true);
  assert.equal(hj.inWindow('01:00', '07:00', at(7)), false, 'the end is not inside');
  assert.equal(hj.inWindow('01:00', '07:00', at(12)), false);
  assert.equal(hj.inWindow('22:00', '06:00', at(23, 30)), true);
  assert.equal(hj.inWindow('22:00', '06:00', at(2)), true);
  assert.equal(hj.inWindow('22:00', '06:00', at(12)), false);
  assert.equal(hj.inWindow('08:00', '08:00', at(3)), true);
});

test('the settings are for the admin only, have defaults, and refuse nonsense', async () => {
  assert.equal((await call('/api/admin/hashing', { token: userTok })).status, 403);
  const s = (await call('/api/admin/hashing')).body;
  assert.deepEqual([s.mode, s.window_start, s.window_end], ['background', '01:00', '07:00']);
  assert.match(s.server_time, /^\d\d:\d\d$/); assert.ok(s.server_tz, 'the page can say what the server clock reads, since the window uses it');
  assert.equal((await call('/api/admin/hashing', { method: 'PUT', body: { mode: 'whenever' } })).status, 400);
  assert.equal((await call('/api/admin/hashing', { method: 'PUT', body: { window_start: '25:00' } })).status, 400);
  const saved = (await call('/api/admin/hashing', { method: 'PUT', body: { mode: 'overnight', window_start: '23:30', window_end: '05:15' } })).body;
  assert.deepEqual([saved.mode, saved.window_start, saved.window_end], ['overnight', '23:30', '05:15']);
  await call('/api/admin/hashing', { method: 'PUT', body: { mode: 'background' } });
});

test('a scan adds the games at once without reading them; the background job then fingerprints them and removes the duplicate', async () => {
  const dir = path.join(TMP, 'roms-a'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Alpha (USA).sfc'), 'alpha bytes');
  fs.writeFileSync(path.join(dir, 'Beta (USA).sfc'), 'beta bytes');
  fs.writeFileSync(path.join(dir, 'Beta copy (USA).sfc'), 'beta bytes');   // the same bytes under another name
  const src = (await call('/api/sources', { method: 'POST', body: { path: dir, platform_hint: 'snes' } })).body.id;
  const scan = await call(`/api/sources/${src}/scan`, { method: 'POST', body: {} });
  assert.equal(scan.status, 200); assert.equal(scan.body.added, 3, 'all three are in the library straight away');
  await hj.hashJobIdle();
  const rows = db.prepare('SELECT title, sha1 FROM roms WHERE source_id = ? ORDER BY title').all(src);
  assert.equal(rows.length, 2, 'the duplicate was removed once the fingerprints were known');
  assert.ok(rows.every((r) => /^[0-9a-f]{40}$/.test(r.sha1)));
  const st = (await call('/api/admin/hashing')).body;
  assert.equal(st.pending, 0); assert.equal(st.running, false); assert.equal(st.duplicates_removed, 1);
});

test('inline mode still fingerprints during the scan, as before', async () => {
  await call('/api/admin/hashing', { method: 'PUT', body: { mode: 'inline' } });
  const dir = path.join(TMP, 'roms-b'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Gamma (USA).sfc'), 'gamma bytes');
  const src = (await call('/api/sources', { method: 'POST', body: { path: dir, platform_hint: 'snes' } })).body.id;
  await call(`/api/sources/${src}/scan`, { method: 'POST', body: {} });
  assert.match(db.prepare('SELECT sha1 FROM roms WHERE source_id = ?').get(src).sha1, /^[0-9a-f]{40}$/, 'hashed during the scan itself');
  await call('/api/admin/hashing', { method: 'PUT', body: { mode: 'background' } });
});

test('overnight mode waits outside its window, Run now ignores the window, and Stop ends a run', async () => {
  const now = new Date(), later = new Date(now.getTime() + 2 * 3600e3), end = new Date(now.getTime() + 3 * 3600e3);
  await call('/api/admin/hashing', { method: 'PUT', body: { mode: 'overnight', window_start: hhmm(later), window_end: hhmm(end) } });
  const dir = path.join(TMP, 'roms-c'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Delta (USA).sfc'), 'delta bytes');
  const src = (await call('/api/sources', { method: 'POST', body: { path: dir, platform_hint: 'snes' } })).body.id;
  await call(`/api/sources/${src}/scan`, { method: 'POST', body: {} });
  await hj.hashJobIdle();
  assert.equal(db.prepare('SELECT sha1 FROM roms WHERE source_id = ?').get(src).sha1, null, 'outside the window nothing is read');
  const waiting = (await call('/api/admin/hashing')).body;
  assert.equal(waiting.pending, 1); assert.equal(waiting.waiting_for_window, true); assert.equal(waiting.running, false);
  await call('/api/admin/hashing/run', { method: 'POST' });
  await hj.hashJobIdle();
  assert.match(db.prepare('SELECT sha1 FROM roms WHERE source_id = ?').get(src).sha1, /^[0-9a-f]{40}$/, 'Run now fingerprints it');
  assert.equal((await call('/api/admin/hashing/stop', { method: 'POST' })).status, 200);
  await call('/api/admin/hashing', { method: 'PUT', body: { mode: 'background' } });
});

test('a file that cannot be read is marked and left alone; a changed file is fingerprinted again', async () => {
  const dir = path.join(TMP, 'roms-d'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'Epsilon (USA).sfc'); fs.writeFileSync(f, 'epsilon one');
  const src = (await call('/api/sources', { method: 'POST', body: { path: dir, platform_hint: 'snes' } })).body.id;
  await call(`/api/sources/${src}/scan`, { method: 'POST', body: {} });
  await hj.hashJobIdle();
  const first = db.prepare('SELECT id, sha1 FROM roms WHERE source_id = ?').get(src).sha1;
  fs.writeFileSync(f, 'epsilon two, longer');
  await call(`/api/sources/${src}/scan`, { method: 'POST', body: {} });
  await hj.hashJobIdle();
  const second = db.prepare('SELECT sha1 FROM roms WHERE source_id = ?').get(src).sha1;
  assert.ok(second && second !== first, 'the new content has a new fingerprint');
  // a game whose file is gone
  const gone = db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, source_path, source_id, size_bytes, meta_source) VALUES ((SELECT id FROM platforms WHERE slug = 'snes'), 'Ghost', 'ghost', 'Ghost.sfc', ?, ?, ?, 1, 'filename')")
    .run(path.join(dir, 'Ghost.sfc'), path.join(dir, 'Ghost.sfc'), src).lastInsertRowid;
  await call('/api/admin/hashing/run', { method: 'POST' });
  await hj.hashJobIdle();
  assert.equal(db.prepare('SELECT hash_failed FROM roms WHERE id = ?').get(gone).hash_failed, 1);
  assert.equal((await call('/api/admin/hashing')).body.pending, 0, 'it is not waiting any more');
  assert.equal((await call('/api/admin/hashing')).body.unreadable, 1);
});

test('files over the size limit are skipped, and come back when the limit is raised or removed', async () => {
  const dir = path.join(TMP, 'roms-e'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Big (USA).sfc'), 'x'.repeat(3000));
  const src = (await call('/api/sources', { method: 'POST', body: { path: dir, platform_hint: 'snes' } })).body.id;
  // the limit is in whole GB, so a "big" game is made by recording a size bigger than the real file
  await call('/api/admin/hashing', { method: 'PUT', body: { max_gb: 1 } });
  const file = path.join(dir, 'Big (USA).sfc');
  db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, source_path, source_id, size_bytes, meta_source) VALUES ((SELECT id FROM platforms WHERE slug = 'snes'), 'Big', 'big', 'Big (USA).sfc', ?, ?, ?, ?, 'filename')")
    .run(file, file, src, 5 * 1024 ** 3);
  await call('/api/admin/hashing/run', { method: 'POST' }); await hj.hashJobIdle();
  const row = db.prepare('SELECT sha1, hash_failed FROM roms WHERE source_id = ?').get(src);
  assert.deepEqual([row.sha1, row.hash_failed], [null, 3], 'too big: no fingerprint, marked as skipped');
  const st = (await call('/api/admin/hashing')).body;
  assert.equal(st.skipped_large, 1); assert.equal(st.pending, 0); assert.equal(st.max_gb, 1);
  assert.equal((await call('/api/admin/hashing', { method: 'PUT', body: { max_gb: -2 } })).status, 400);
  await call('/api/admin/hashing', { method: 'PUT', body: { max_gb: 0 } });   // no limit: it waits again, and is fingerprinted
  await hj.hashJobIdle();
  await call('/api/admin/hashing/run', { method: 'POST' }); await hj.hashJobIdle();
  assert.match(db.prepare('SELECT sha1 FROM roms WHERE source_id = ?').get(src).sha1, /^[0-9a-f]{40}$/);
});

test('Stop ends a read at once, leaves the game waiting, and nothing restarts by itself until Run now', async () => {
  const dir = path.join(TMP, 'roms-f'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Huge (USA).sfc'); fs.writeFileSync(file, Buffer.alloc(120 * 1024 * 1024, 7));
  const src = (await call('/api/sources', { method: 'POST', body: { path: dir, platform_hint: 'snes' } })).body.id;
  const id = db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, source_path, source_id, size_bytes, meta_source) VALUES ((SELECT id FROM platforms WHERE slug = 'snes'), 'Huge', 'huge', 'Huge (USA).sfc', ?, ?, ?, ?, 'filename')")
    .run(file, file, src, 120 * 1024 * 1024).lastInsertRowid;
  const { hashFile } = await import('../src/lib/hash.js');
  await assert.rejects(hashFile(file, { shouldStop: () => true }), (e) => e.stopped === true, 'a read can be told to stop part-way');
  await call('/api/admin/hashing/run', { method: 'POST' });
  await call('/api/admin/hashing/stop', { method: 'POST' });
  await hj.hashJobIdle();
  const row = db.prepare('SELECT sha1, hash_failed FROM roms WHERE id = ?').get(id);
  assert.deepEqual([row.sha1, row.hash_failed], [null, 0], 'stopped, not failed: it is still waiting');
  assert.equal((await call('/api/admin/hashing')).body.paused, true);
  hj.startHashJob();   // what the once-a-minute check does
  await hj.hashJobIdle();
  assert.equal(db.prepare('SELECT sha1 FROM roms WHERE id = ?').get(id).sha1, null, 'Stop is not undone by the scheduler');
  await call('/api/admin/hashing/run', { method: 'POST' }); await hj.hashJobIdle();
  assert.match(db.prepare('SELECT sha1 FROM roms WHERE id = ?').get(id).sha1, /^[0-9a-f]{40}$/, 'Run now carries on');
  assert.equal((await call('/api/admin/hashing')).body.paused, false);
});

test('In overnight mode Stop holds only until the window is over; the next night starts again by itself', async () => {
  const dir = path.join(TMP, 'roms-g'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Night (USA).sfc'); fs.writeFileSync(file, 'night bytes');
  const src = (await call('/api/sources', { method: 'POST', body: { path: dir, platform_hint: 'snes' } })).body.id;
  const id = db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, source_path, source_id, size_bytes, meta_source) VALUES ((SELECT id FROM platforms WHERE slug = 'snes'), 'Night', 'night', 'Night (USA).sfc', ?, ?, ?, 11, 'filename')").run(file, file, src).lastInsertRowid;
  const now = new Date(), a = hhmm(new Date(now.getTime() - 60_000)), b = hhmm(new Date(now.getTime() + 3600e3));
  await call('/api/admin/hashing', { method: 'PUT', body: { mode: 'overnight', window_start: a, window_end: b } });   // the window is open now
  await hj.hashJobIdle();
  await call('/api/admin/hashing/stop', { method: 'POST' });
  assert.equal((await call('/api/admin/hashing')).body.paused, true, 'stopped inside the window');
  const later = new Date(now.getTime() + 2 * 3600e3), end = new Date(now.getTime() + 3 * 3600e3);
  await call('/api/admin/hashing', { method: 'PUT', body: { mode: 'overnight', window_start: hhmm(later), window_end: hhmm(end) } });   // the window has closed
  hj.startHashJob();   // the once-a-minute check, outside the window
  assert.equal((await call('/api/admin/hashing')).body.paused, false, 'the pause ended with the window');
  assert.ok(id);
  await call('/api/admin/hashing', { method: 'PUT', body: { mode: 'background' } });
  await hj.hashJobIdle();
});

test('a game without fingerprints is still a normal game: the play and download routes never need them', () => {
  for (const f of ['src/routes/roms.js']) {
    const src = read(f);
    const i = src.indexOf("router.get('/:id/download'");
    assert.ok(i > 0, 'a download route');
    assert.ok(!/sha1/.test(src.slice(i, i + 1500)), 'the download route does not use the fingerprint');
  }
  assert.ok(read('src/server.js').includes('startHashScheduler()'));
});
