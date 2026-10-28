import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-pwreset-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'owner';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'owner-password-123';
process.env.GAMESAUCE_LOGIN_MAX_FAILURES = '3';
process.env.GAMESAUCE_LOGIN_LOCK_MINUTES = '5';

let server, base, adminToken, adminId;

const call = async (p, { token, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = (username, password) => call('/api/auth/login', { method: 'POST', body: { username, password } });

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await login('owner', 'owner-password-123');
  adminToken = res.body.token; adminId = res.body.user.id;
});
after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  const { db } = await import('../src/db.js');
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const makeUser = async (username, password = 'first-password-1') => {
  const r = await call('/api/auth/users', { method: 'POST', token: adminToken, body: { username, password, role: 'user' } });
  assert.equal(r.status, 201);
  return r.body.id;
};

test('an admin can reset a user password: the new one works, the old one does not', async () => {
  const id = await makeUser('forgetful');
  const reset = await call(`/api/auth/users/${id}/password`, { method: 'POST', token: adminToken, body: { password: 'brand-new-pass-9' } });
  assert.equal(reset.status, 200);
  assert.equal((await login('forgetful', 'first-password-1')).status, 401);
  assert.equal((await login('forgetful', 'brand-new-pass-9')).status, 200);
});

test('a reset signs the user out everywhere', async () => {
  const id = await makeUser('signedin');
  const { body } = await login('signedin', 'first-password-1');
  assert.equal((await call('/api/roms?limit=1', { token: body.token })).status, 200);
  await call(`/api/auth/users/${id}/password`, { method: 'POST', token: adminToken, body: { password: 'another-pass-22' } });
  assert.equal((await call('/api/roms?limit=1', { token: body.token })).status, 401, 'the old session is dead');
});

test('a reset also clears a sign-in lockout from failed attempts', async () => {
  const id = await makeUser('lockedout');
  for (let i = 0; i < 3; i++) await login('lockedout', 'wrong-wrong-1');
  assert.equal((await login('lockedout', 'first-password-1')).status, 429, 'locked');
  await call(`/api/auth/users/${id}/password`, { method: 'POST', token: adminToken, body: { password: 'unlocked-pass-33' } });
  assert.equal((await login('lockedout', 'unlocked-pass-33')).status, 200, 'can sign in straight away');
});

test('the reset enforces the password rules', async () => {
  const id = await makeUser('weakling');
  for (const bad of ['short1', 'onlylettersnonumber', '1234567890123']) {
    const r = await call(`/api/auth/users/${id}/password`, { method: 'POST', token: adminToken, body: { password: bad } });
    assert.equal(r.status, 400, bad);
  }
  assert.equal((await login('weakling', 'first-password-1')).status, 200, 'password unchanged after refusals');
});

test('members cannot reset passwords, and you cannot reset your own this way', async () => {
  const a = await makeUser('member-a');
  const b = await makeUser('member-b');
  const tok = (await login('member-a', 'first-password-1')).body.token;
  assert.equal((await call(`/api/auth/users/${b}/password`, { method: 'POST', token: tok, body: { password: 'hijack-pass-123' } })).status, 403);
  assert.equal((await login('member-b', 'first-password-1')).status, 200, 'untouched');
  assert.equal((await call(`/api/auth/users/${adminId}/password`, { method: 'POST', token: adminToken, body: { password: 'self-reset-pass-1' } })).status, 409);
  assert.equal((await call('/api/auth/users/999999/password', { method: 'POST', token: adminToken, body: { password: 'ghost-user-pass-1' } })).status, 404);
  assert.ok(a);
});

test('the reset is audited with the username, never the password', async () => {
  const id = await makeUser('audited');
  await call(`/api/auth/users/${id}/password`, { method: 'POST', token: adminToken, body: { password: 'secret-never-logged-5' } });
  const log = await call('/api/auth/audit?limit=50', { token: adminToken });
  const row = log.body.items.find((e) => e.action === 'user.password_reset' && e.target === 'audited');
  assert.ok(row, 'audit row exists');
  assert.match(row.summary, /reset a password for user audited/);
  assert.ok(!JSON.stringify(log.body).includes('secret-never-logged-5'), 'the password is not in the log');
});
