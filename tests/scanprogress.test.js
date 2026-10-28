import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-prog-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'progadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'prog-admin-password-1';

let server, base, tok, dir;
const call = async (p, { method = 'GET', body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${tok}` },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await (await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'progadmin', password: 'prog-admin-password-1' })
  })).json()).token;
  dir = path.join(TMP, 'mame'); fs.mkdirSync(dir);
  for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(dir, `game${i}.zip`), 'content-' + i + 'x'.repeat(2000));
  fs.writeFileSync(path.join(dir, 'dupe.zip'), 'content-5' + 'x'.repeat(2000)); // same bytes as game5
  fs.writeFileSync(path.join(dir, 'notes.7z'), 'ignored by MAME');
});
after(() => { server?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('scan reports live progress, survives a duplicate, ignores non-zip for MAME', async () => {
  const src = (await call('/api/sources', { method: 'POST', body: { path: dir, platform_hint: 'mame' } })).body;
  const scan = call(`/api/sources/${src.id}/scan`, { method: 'POST', body: {} });
  const seen = [];
  for (let i = 0; i < 200; i++) {
    const p = (await call(`/api/sources/${src.id}/scan/progress`)).body;
    if (p.phase !== 'idle') seen.push(p);
    if (p.phase === 'done') break;
    await new Promise((r) => setTimeout(r, 5));
  }
  const res = (await scan).body;
  assert.equal(res.added, 120, 'all unique zips imported, duplicate skipped');
  assert.equal(res.failed, 0);
  assert.equal(res.found, 121, '.7z ignored for MAME');
  assert.ok(seen.length > 0, 'progress was observable');
  assert.equal((await call(`/api/sources/${src.id}/scan/progress`)).body.phase, 'done');
});

test('rescan clears a stale missing flag on an unchanged file', async () => {
  const db = (await import('../src/db.js')).default;
  const d2 = path.join(TMP, 'stale'); fs.mkdirSync(d2);
  fs.writeFileSync(path.join(d2, 'Some Game (USA).32x'), 'stale-' + 'y'.repeat(3000));
  const src = (await call('/api/sources', { method: 'POST', body: { path: d2, platform_hint: 'sega32x' } })).body;
  await call(`/api/sources/${src.id}/scan`, { method: 'POST', body: {} });
  const row = db.prepare('SELECT id FROM roms WHERE source_id = ?').get(src.id);
  db.prepare('UPDATE roms SET missing = 1 WHERE id = ?').run(row.id); // as if the drive was offline during a scan
  const r = (await call(`/api/sources/${src.id}/scan`, { method: 'POST', body: {} })).body;
  assert.equal(r.added, 0);
  assert.equal(db.prepare('SELECT missing FROM roms WHERE id = ?').get(row.id).missing, 0);
});
