import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-lock-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'ladmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'l-admin-password-1';

let server, base, db, tok, memberTok;
const call = async (p, { method = 'GET', body, token } = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || tok) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const ids = [];
before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok = await login('ladmin', 'l-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'lmember', password: 'l-member-password-1', role: 'user' } });
  memberTok = await login('lmember', 'l-member-password-1');
  const plat = db.prepare("SELECT id FROM platforms WHERE slug = 'genesis'").get().id;
  for (let i = 0; i < 4; i++) {
    const f = path.join(TMP, 'g' + i + '.md'); fs.writeFileSync(f, 'x' + i);
    ids.push(Number(db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, source_path, in_place, size_bytes, sha1) VALUES (?, ?, ?, ?, ?, ?, 1, 2, ?)").run(plat, 'Lock Game ' + i, 'lock game ' + i, 'g' + i + '.md', f, f, 'lk0000' + i).lastInsertRowid));
  }
});
after(async () => { await new Promise((r) => server?.close(r)); db?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('lock several games, find them with the Locked filter, unlock them in bulk, then delete them', async () => {
  const lk = await call('/api/roms/bulk/lock', { method: 'POST', body: { ids: [ids[0], ids[1], ids[2]], locked: true } });
  assert.equal(lk.status, 200); assert.equal(lk.body.changed, 3);
  assert.equal((await call('/api/roms/bulk/lock', { method: 'POST', body: { ids: [ids[0]], locked: true } })).body.changed, 0, 'already locked: nothing changes');
  const list = await call('/api/roms?locked=1&hidden=all&system=all&limit=50');
  assert.equal(list.body.total, 3); assert.deepEqual(list.body.items.map((r) => r.id).sort(), [ids[0], ids[1], ids[2]].sort());
  // a hidden locked game is still found
  db.prepare('UPDATE roms SET hidden_all = 1 WHERE id = ?').run(ids[2]);
  assert.equal((await call('/api/roms?locked=1&hidden=all&system=all')).body.total, 3);
  // locked games refuse deletion
  const del1 = await call('/api/roms/bulk/delete', { method: 'POST', body: { ids: [ids[0], ids[3]], delete_file: false, keep_file: true } });
  assert.equal(del1.body.deleted, 1, 'only the unlocked one went');
  assert.ok(db.prepare('SELECT 1 FROM roms WHERE id = ?').get(ids[0]), 'the locked game is still there');
  // unlock in bulk, then they delete
  const un = await call('/api/roms/bulk/lock', { method: 'POST', body: { ids: [ids[0], ids[1], ids[2]], locked: false } });
  assert.equal(un.body.changed, 3);
  assert.equal(db.prepare('SELECT keep_override FROM roms WHERE id = ?').get(ids[0]).keep_override, null, 'back to automatic');
  assert.equal((await call('/api/roms?locked=1&hidden=all&system=all')).body.total, 0);
  const del2 = await call('/api/roms/bulk/delete', { method: 'POST', body: { ids: [ids[0], ids[1], ids[2]], keep_file: true } });
  assert.equal(del2.body.deleted, 3);
});

test('members cannot lock or unlock, and the Locked filter does nothing for them', async () => {
  assert.equal((await call('/api/roms/bulk/lock', { method: 'POST', token: memberTok, body: { ids: [1], locked: true } })).status, 403);
  const plat = db.prepare("SELECT id FROM platforms WHERE slug = 'genesis'").get().id;
  const id = Number(db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, source_path, in_place, size_bytes, sha1, keep_override) VALUES (?, 'Secret Lock', 'secret lock', 's.md', '/x/s.md', '/x/s.md', 1, 2, 'lk99999', 1)").run(plat).lastInsertRowid);
  const mine = await call('/api/roms?locked=1&limit=500', { token: memberTok });
  assert.ok(mine.body.items.some((r) => r.id === id), 'the filter is ignored for a member (they see the normal list)');
  assert.equal((await call('/api/roms/bulk/lock', { method: 'POST', body: { ids: [] } })).status, 400);
});

test('the page has the Locked filter and the bulk Lock / Unlock button', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /data-toggle="locked"/); assert.match(html, /id="bulk-lock-btn"/);
  assert.match(app, /\/roms\/bulk\/lock/); assert.match(app, /params\.set\('locked', '1'\)/);
});
