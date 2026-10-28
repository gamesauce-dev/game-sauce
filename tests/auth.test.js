import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-auth-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'owner';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'owner-password-123';
process.env.GAMESAUCE_LOGIN_MAX_FAILURES = '3';
process.env.GAMESAUCE_LOGIN_LOCK_MINUTES = '1';

let server, base, adminToken;

const call = async (p, { token, method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};

const login = (username, password) => call('/api/auth/login', {
  method: 'POST', body: { username, password }
});

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const res = await login('owner', 'owner-password-123');
  adminToken = res.body.token;
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  const { db } = await import('../src/db.js');
  db.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

/* ─────────────────────────── first run ─────────────────────────── */

test('the admin account was created from the environment', async () => {
  const res = await login('owner', 'owner-password-123');
  assert.equal(res.status, 200);
  assert.equal(res.body.user.username, 'owner');
  assert.equal(res.body.user.role, 'admin');
  assert.ok(res.body.token.length > 20);
});

test('the session cookie is HttpOnly and SameSite', async () => {
  const res = await login('owner', 'owner-password-123');
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /gamesauce_session=/);
});

test('passwords are stored as scrypt hashes, never plaintext', async () => {
  const { db } = await import('../src/db.js');
  const row = db.prepare("SELECT password_hash FROM users WHERE username = 'owner'").get();
  assert.match(row.password_hash, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.ok(!row.password_hash.includes('owner-password-123'));
});

/* ─────────────────────────── gating ─────────────────────────── */

test('the API refuses anonymous requests', async () => {
  for (const p of ['/api/roms', '/api/stats', '/api/platforms', '/api/sources', '/api/metadata']) {
    const res = await call(p);
    assert.equal(res.status, 401, `${p} should be 401`);
    assert.equal(res.body.error, 'Sign in required');
  }
});

test('health and auth endpoints stay public', async () => {
  assert.equal((await call('/api/health')).status, 200);
  assert.equal((await call('/api/auth/me')).status, 200);
  assert.equal((await call('/api/auth/me')).body.authenticated, false);
});

test('a valid session can read the library', async () => {
  const res = await call('/api/roms', { token: adminToken });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
});

test('a forged or expired token is rejected', async () => {
  assert.equal((await call('/api/roms', { token: 'not-a-real-token' })).status, 401);
});

test('logout invalidates the token immediately', async () => {
  const session = await login('owner', 'owner-password-123');
  const token = session.body.token;
  assert.equal((await call('/api/roms', { token })).status, 200);

  await call('/api/auth/logout', { method: 'POST', token });
  assert.equal((await call('/api/roms', { token })).status, 401);
});

/* ─────────────────────── wrong credentials ─────────────────────── */

test('wrong password and unknown user give the same message', async () => {
  const wrong = await login('owner', 'wrong-password');
  const unknown = await login('ghost', 'wrong-password');
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.body.error, unknown.body.error);
});

test('repeated failures lock the account out for the window', async () => {
  const attempt = () => login('lockme', 'nope-nope-nope');
  await attempt();
  await attempt();
  const third = await attempt();
  assert.equal(third.status, 401);

  const locked = await attempt();
  assert.equal(locked.status, 429);
  assert.match(locked.body.error, /Too many failed attempts/);
});

/* ─────────────────────── user management ─────────────────────── */

test('admins can create users, who can then sign in', async () => {
  const created = await call('/api/auth/users', {
    method: 'POST', token: adminToken,
    body: { username: 'player1', password: 'player-password-1', role: 'user' }
  });
  assert.equal(created.status, 201);

  const res = await login('player1', 'player-password-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'user');
});

test('non-admins cannot reach admin endpoints', async () => {
  const session = await login('player1', 'player-password-1');
  const token = session.body.token;

  const users = await call('/api/auth/users', { token });
  assert.equal(users.status, 403);

  // Source paths and the filesystem browser are admin-only.
  const sources = await call('/api/sources', { token });
  assert.equal(sources.status, 403);

  // ...but the library itself is fine.
  assert.equal((await call('/api/roms', { token })).status, 200);
});

test('weak passwords are refused', async () => {
  const res = await call('/api/auth/users', {
    method: 'POST', token: adminToken,
    body: { username: 'weakling', password: 'short' }
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at least 10 characters/);
});

test('usernames must be sane and unique', async () => {
  const bad = await call('/api/auth/users', {
    method: 'POST', token: adminToken,
    body: { username: 'a b c', password: 'valid-password-1' }
  });
  assert.equal(bad.status, 400);

  const dupe = await call('/api/auth/users', {
    method: 'POST', token: adminToken,
    body: { username: 'player1', password: 'valid-password-1' }
  });
  assert.equal(dupe.status, 409);
});

test('disabling a user kills their sessions', async () => {
  const session = await login('player1', 'player-password-1');
  const token = session.body.token;
  const users = await call('/api/auth/users', { token: adminToken });
  const player = users.body.items.find((u) => u.username === 'player1');

  await call(`/api/auth/users/${player.id}`, {
    method: 'PATCH', token: adminToken, body: { disabled: true }
  });

  assert.equal((await call('/api/roms', { token })).status, 401);
  assert.equal((await login('player1', 'player-password-1')).status, 401);
});

test('the last admin cannot be deleted or disabled', async () => {
  const users = await call('/api/auth/users', { token: adminToken });
  const owner = users.body.items.find((u) => u.username === 'owner');

  const del = await call(`/api/auth/users/${owner.id}`, { method: 'DELETE', token: adminToken });
  assert.equal(del.status, 409);

  const disable = await call(`/api/auth/users/${owner.id}`, {
    method: 'PATCH', token: adminToken, body: { disabled: true }
  });
  assert.equal(disable.status, 409);
});

/* ─────────────────────── password change ─────────────────────── */

test('changing your own password requires the current one', async () => {
  await call('/api/auth/users', {
    method: 'POST', token: adminToken,
    body: { username: 'changer', password: 'original-password-1' }
  });
  const session = await login('changer', 'original-password-1');
  const token = session.body.token;

  const wrong = await call('/api/auth/password', {
    method: 'POST', token,
    body: { current_password: 'not-it', new_password: 'brand-new-password-1' }
  });
  assert.equal(wrong.status, 401);

  const ok = await call('/api/auth/password', {
    method: 'POST', token,
    body: { current_password: 'original-password-1', new_password: 'brand-new-password-1' }
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token, 'a fresh session is issued for this browser');

  // Old password no longer works, the new one does.
  assert.equal((await login('changer', 'original-password-1')).status, 401);
  assert.equal((await login('changer', 'brand-new-password-1')).status, 200);

  // The token used before the change is dead.
  assert.equal((await call('/api/roms', { token })).status, 401);
});

test('revoking other sessions keeps the current one', async () => {
  const first = await login('owner', 'owner-password-123');
  const second = await login('owner', 'owner-password-123');

  const res = await call('/api/auth/sessions', { method: 'DELETE', token: second.body.token });
  assert.equal(res.body.kept_current, true);

  assert.equal((await call('/api/roms', { token: first.body.token })).status, 401);
  assert.equal((await call('/api/roms', { token: second.body.token })).status, 200);

  // Re-establish the admin session for the remaining tests (the shared one was
  // revoked by this test on purpose).
  adminToken = (await login('owner', 'owner-password-123')).body.token;
});

/* ─────────────────────────── audit log ─────────────────────────── */

test('mutations are recorded in the audit log with the acting user', async () => {
  await call('/api/collections', {
    method: 'POST', token: adminToken, body: { name: 'Audited set' }
  });

  const res = await call('/api/auth/audit?limit=50', { token: adminToken });
  assert.equal(res.status, 200);

  const entry = res.body.items.find((e) => e.action.startsWith('POST /api/collections'));
  assert.ok(entry, 'collection creation is logged');
  assert.equal(entry.username, 'owner');

  const logins = res.body.items.filter((e) => e.action === 'login.success');
  assert.ok(logins.length > 0);
});

test('the audit log is admin-only', async () => {
  await call('/api/auth/users', {
    method: 'POST', token: adminToken,
    body: { username: 'nosy', password: 'nosy-password-1' }
  });
  const session = await login('nosy', 'nosy-password-1');
  assert.equal((await call('/api/auth/audit', { token: session.body.token })).status, 403);
});

test('audit entries carry plain-English summaries and filter by user/action/date', async () => {
  // Generate a few known rows first.
  await call('/api/collections', { method: 'POST', token: adminToken, body: { name: 'Audit me' } });
  await call('/api/auth/users', {
    method: 'POST', token: adminToken,
    body: { username: 'audited', password: 'audited-password-1' }
  });

  const all = await call('/api/auth/audit?limit=200', { token: adminToken });
  assert.equal(all.status, 200);
  assert.ok(all.body.items.length > 0);
  assert.ok(Array.isArray(all.body.users) && all.body.users.includes('owner'));

  const created = all.body.items.find((e) => e.action.startsWith('POST /api/collections'));
  assert.ok(created, 'collection creation is logged');
  assert.match(created.summary || '', /created collection/i);

  const userRow = all.body.items.find((e) => e.action === 'user.created' && e.target === 'audited');
  assert.ok(userRow);
  assert.match(userRow.summary || '', /created user audited/i);

  // Filter by user: nosy/owner rows only.
  const byUser = await call('/api/auth/audit?username=nosy', { token: adminToken });
  assert.ok(byUser.body.items.every((e) => (e.username || '').toLowerCase().includes('nosy')));

  // Filter by action substring.
  const byAction = await call('/api/auth/audit?action=collections', { token: adminToken });
  assert.ok(byAction.body.items.length > 0);
  assert.ok(byAction.body.items.every((e) => e.action.includes('collections')));

  // Filter by date: today matches, a far-future window matches nothing.
  const today = new Date().toISOString().slice(0, 10);
  const sinceToday = await call(`/api/auth/audit?since=${today}`, { token: adminToken });
  assert.ok(sinceToday.body.items.length > 0);
  const future = await call('/api/auth/audit?since=2999-01-01', { token: adminToken });
  assert.equal(future.body.items.length, 0);

  // Plain dates include the whole end day.
  const wholeDay = await call(`/api/auth/audit?since=${today}&until=${today}`, { token: adminToken });
  assert.ok(wholeDay.body.items.length > 0);
});

test('ROM-scoped audit rows name the game and platform', async () => {
  // Upload a throwaway ROM so there is something ROM-scoped to audit.
  const fd = new FormData();
  fd.append('roms', new Blob(['audit-snapshot-bytes']), 'Snapshot Game (USA).sfc');
  const uploaded = await fetch(`${base}/api/roms/upload`, {
    method: 'POST', body: fd, headers: { Authorization: `Bearer ${adminToken}` }
  }).then((r) => r.json());
  const created = uploaded.created?.[0];
  assert.ok(created, 'upload for audit snapshot works');
  const seeded = { id: created.id, title: created.title, platform_name: created.platform_name };

  await call(`/api/roms/${seeded.id}`, {
    method: 'PATCH', token: adminToken, body: { title: seeded.title }
  });

  const res = await call(`/api/auth/audit?action=/api/roms/${seeded.id}&limit=5`, { token: adminToken });
  assert.ok(res.body.items.length > 0);
  // The generic audit middleware snapshots the ROM before the PATCH runs, so
  // the detail carries the game + platform — the summary should name them.
  const row = res.body.items.find((e) => e.detail?.title) || res.body.items[0];
  assert.equal(row.detail?.title, seeded.title);
  assert.equal(row.detail?.platform, seeded.platform_name);
  assert.match(row.summary || '', new RegExp(`“${seeded.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}”`));
  assert.match(row.summary || '', new RegExp(seeded.platform_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
