import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-dlpolicy-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'dpadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'dp-admin-password-1';

let server, base, db, adminTok, memberTok, romId;
const ROM_BYTES = Buffer.from('not really a rom, just bytes');

const call = async (p, { token, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json().catch(() => null) : await res.arrayBuffer() };
};
const login = async (u, p) => (await call('/api/auth/login', { method: 'POST', body: { username: u, password: p } })).body.token;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('dpadmin', 'dp-admin-password-1');
  await call('/api/auth/users', { method: 'POST', token: adminTok, body: { username: 'dpmember', password: 'dp-member-pass-12', role: 'user' } });
  memberTok = await login('dpmember', 'dp-member-pass-12');

  const file = path.join(TMP, 'game.nes');
  fs.writeFileSync(file, ROM_BYTES);
  const nes = db.prepare("SELECT id FROM platforms WHERE slug = 'nes'").get().id;
  romId = db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1) VALUES ('Test Game','test game','game.nes',?,?,?,'dp1')")
    .run(nes, file, ROM_BYTES.length).lastInsertRowid;
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('by default members cannot download ROM files, admins can', async () => {
  assert.equal((await call('/api/auth/policy', { token: memberTok })).body.members_can_download, false);
  const m = await call(`/api/roms/${romId}/download`, { token: memberTok });
  assert.equal(m.status, 403);
  assert.match(m.body.error, /turned off for member accounts/);
  const a = await call(`/api/roms/${romId}/download`, { token: adminTok });
  assert.equal(a.status, 200);
  assert.equal(Buffer.from(a.body).toString(), ROM_BYTES.toString(), 'the admin gets the real file');
});

test('a refused download is not counted as a download', async () => {
  const n = () => db.prepare("SELECT COUNT(*) AS n FROM downloads WHERE kind = 'download'").get().n;
  const before = n();
  await call(`/api/roms/${romId}/download`, { token: memberTok });
  assert.equal(n(), before);
});

test('/me tells the interface whether to show the Download button', async () => {
  assert.equal((await call('/api/auth/me', { token: memberTok })).body.user.can_download, false);
  assert.equal((await call('/api/auth/me', { token: adminTok })).body.user.can_download, true);
});

test('members can still play in the browser while downloads are off', async () => {
  const r = await call(`/api/roms/${romId}/play/game.nes`, { token: memberTok });
  assert.notEqual(r.status, 403, 'play is not blocked by the download switch');
});

test('only an admin can flip the switch, and it must be a real boolean', async () => {
  assert.equal((await call('/api/auth/policy', { method: 'PUT', token: memberTok, body: { members_can_download: true } })).status, 403);
  assert.equal((await call('/api/auth/policy', { method: 'PUT', token: adminTok, body: { members_can_download: 'yes' } })).status, 400);
  assert.equal((await call('/api/auth/policy', { token: memberTok })).body.members_can_download, false, 'still off');
});

test('turning it on lets members download, turning it off stops them again', async () => {
  const on = await call('/api/auth/policy', { method: 'PUT', token: adminTok, body: { members_can_download: true } });
  assert.equal(on.body.members_can_download, true);
  assert.equal((await call(`/api/roms/${romId}/download`, { token: memberTok })).status, 200);
  assert.equal((await call('/api/auth/me', { token: memberTok })).body.user.can_download, true);

  await call('/api/auth/policy', { method: 'PUT', token: adminTok, body: { members_can_download: false } });
  assert.equal((await call(`/api/roms/${romId}/download`, { token: memberTok })).status, 403);
});

test('the switch survives a restart (it is stored, not in memory)', async () => {
  await call('/api/auth/policy', { method: 'PUT', token: adminTok, body: { members_can_download: true } });
  const { membersCanDownload } = await import('../src/lib/policy.js');
  assert.equal(membersCanDownload(), true);
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key = 'policy.members_can_download'").get().value, '1');
});

test('changes are audited in plain English', async () => {
  const log = await call('/api/auth/audit?limit=20', { token: adminTok });
  const row = log.body.items.find((e) => e.action === 'policy.changed');
  assert.ok(row, 'policy change is in the audit log');
  assert.match(row.summary, /ROM downloads for members/);
});

test('anonymous requests are refused', async () => {
  assert.equal((await call(`/api/roms/${romId}/download`)).status, 401);
  assert.equal((await call('/api/auth/policy')).status, 401);
});

/* ───────────────────── per-person downloads ───────────────────── */

test('a personal "always allowed" beats the server default, and "never" beats it the other way', async () => {
  await call('/api/auth/policy', { method: 'PUT', token: adminTok, body: { members_can_download: false } });
  const users = (await call('/api/auth/users', { token: adminTok })).body.items;
  const mem = users.find((u) => u.username === 'dpmember');
  assert.equal(mem.download, 'default', 'new members follow the default');
  assert.ok(!('download_override' in mem), 'the raw column is not exposed');

  // default off + personal allow -> can download
  let r = await call(`/api/auth/users/${mem.id}`, { method: 'PATCH', token: adminTok, body: { download: 'allow' } });
  assert.equal(r.status, 200); assert.equal(r.body.download, 'allow');
  assert.equal((await call(`/api/roms/${romId}/download`, { token: memberTok })).status, 200);
  assert.equal((await call('/api/auth/me', { token: memberTok })).body.user.can_download, true);

  // default on + personal deny -> cannot
  await call('/api/auth/policy', { method: 'PUT', token: adminTok, body: { members_can_download: true } });
  r = await call(`/api/auth/users/${mem.id}`, { method: 'PATCH', token: adminTok, body: { download: 'deny' } });
  assert.equal(r.body.download, 'deny');
  assert.equal((await call(`/api/roms/${romId}/download`, { token: memberTok })).status, 403);
  assert.equal((await call('/api/auth/me', { token: memberTok })).body.user.can_download, false);

  // back to default: follows the (now on) switch again
  await call(`/api/auth/users/${mem.id}`, { method: 'PATCH', token: adminTok, body: { download: 'default' } });
  assert.equal((await call(`/api/roms/${romId}/download`, { token: memberTok })).status, 200);
  await call('/api/auth/policy', { method: 'PUT', token: adminTok, body: { members_can_download: false } });
  assert.equal((await call(`/api/roms/${romId}/download`, { token: memberTok })).status, 403);
});

test('the personal setting takes effect straight away, without signing out and in', async () => {
  const mem = (await call('/api/auth/users', { token: adminTok })).body.items.find((u) => u.username === 'dpmember');
  await call(`/api/auth/users/${mem.id}`, { method: 'PATCH', token: adminTok, body: { download: 'allow' } });
  assert.equal((await call(`/api/roms/${romId}/download`, { token: memberTok })).status, 200);
  await call(`/api/auth/users/${mem.id}`, { method: 'PATCH', token: adminTok, body: { download: 'default' } });
  assert.equal((await call(`/api/roms/${romId}/download`, { token: memberTok })).status, 403);
});

test('only admins can change it, only valid values are accepted, admins always can download', async () => {
  const users = (await call('/api/auth/users', { token: adminTok })).body.items;
  const mem = users.find((u) => u.username === 'dpmember');
  const adm = users.find((u) => u.username === 'dpadmin');
  assert.equal((await call(`/api/auth/users/${mem.id}`, { method: 'PATCH', token: memberTok, body: { download: 'allow' } })).status, 403, 'a member cannot grant themselves access');
  assert.equal((await call(`/api/auth/users/${mem.id}`, { method: 'PATCH', token: adminTok, body: { download: 'sometimes' } })).status, 400);
  await call(`/api/auth/users/${adm.id}`, { method: 'PATCH', token: adminTok, body: { download: 'deny' } });
  assert.equal((await call(`/api/roms/${romId}/download`, { token: adminTok })).status, 200, 'an admin is never locked out of downloads');
  await call(`/api/auth/users/${adm.id}`, { method: 'PATCH', token: adminTok, body: { download: 'default' } });
});

test('personal download changes are audited in plain English', async () => {
  const mem = (await call('/api/auth/users', { token: adminTok })).body.items.find((u) => u.username === 'dpmember');
  await call(`/api/auth/users/${mem.id}`, { method: 'PATCH', token: adminTok, body: { download: 'deny' } });
  const log = (await call('/api/auth/audit?limit=10', { token: adminTok })).body.items;
  const row = log.find((e) => e.action === 'user.updated' && /downloads never allowed/.test(e.summary));
  assert.ok(row, 'summary says what changed: ' + log.map((e) => e.summary).slice(0, 3).join(' | '));
  await call(`/api/auth/users/${mem.id}`, { method: 'PATCH', token: adminTok, body: { download: 'default' } });
});
