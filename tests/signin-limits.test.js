// Sign-in limits: what a stranger can make the server store, and how often they may guess, including behind a reverse proxy.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-signin-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'siadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'si-admin-password-1';
process.env.GAMESAUCE_TRUST_PROXY = '1';
process.env.GAMESAUCE_LOGIN_MAX_FAILURES = '4';
process.env.GAMESAUCE_LOGIN_MAX_FAILURES_PER_ADDRESS = '7';
process.env.GAMESAUCE_LOGIN_MAX_FAILURES_PER_USER = '10';

const servers = [];
let base, db, createApp;
const listen = async (app) => { const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); }); servers.push(s); return `http://127.0.0.1:${s.address().port}`; };
const login = async (username, password = 'wrong-password-1', { xff, at = base, headers = {} } = {}) => {
  const res = await fetch(`${at}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(xff ? { 'X-Forwarded-For': xff } : {}), ...headers }, body: JSON.stringify({ username, password }) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};
const statuses = async (n, fn) => { const out = []; for (let i = 0; i < n; i++) out.push((await fn(i)).status); return out; };
const count = (sql) => db.prepare(sql).get().n;

before(async () => {
  const mod = await import('../src/app.js');
  createApp = mod.createApp;
  const { app } = await mod.prepareApp();
  db = (await import('../src/db.js')).default;
  base = await listen(app);
});
beforeEach(() => { db.prepare('DELETE FROM login_attempts').run(); });
after(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('a huge or very long username is refused and nothing of it is stored', async () => {
  const rows = () => count('SELECT COUNT(*) AS n FROM audit_log') + count('SELECT COUNT(*) AS n FROM login_attempts');
  const had = rows();
  assert.equal((await login('A'.repeat(1_000_000))).status, 413, 'a body far bigger than any sign-in');
  for (const name of ['A'.repeat(65), 'B'.repeat(5000), '', 'bad\u0001name']) assert.equal((await login(name)).status, 401, JSON.stringify(name.slice(0, 10)));
  assert.equal(rows(), had, 'nothing was written');
  assert.equal((await login('siadmin', 'si-admin-password-1')).status, 200, 'a normal sign-in still works');
});

test('the audit log cuts over-long values, and keeps only the newest failed sign-ins', async () => {
  const { audit } = await import('../src/auth.js');
  audit({ username: 'x'.repeat(5000) }, `GET /${'a'.repeat(5000)}`, { target: 't'.repeat(5000), ip: '9'.repeat(5000) });
  const long = db.prepare('SELECT MAX(length(username)) AS u, MAX(length(action)) AS a, MAX(length(target)) AS t, MAX(length(ip)) AS i FROM audit_log').get();
  assert.ok(long.u <= 64 && long.a <= 300 && long.t <= 200 && long.i <= 64, JSON.stringify(long));

  const add = db.prepare("INSERT INTO audit_log (username, action) VALUES (?, 'login.failed')");
  db.transaction(() => { for (let i = 0; i < 10_050; i++) add.run(`old${i}`); })();
  const others = count("SELECT COUNT(*) AS n FROM audit_log WHERE action <> 'login.failed'");
  await login('newest-failure', 'wrong-password-1', { xff: '203.0.113.200' });
  assert.equal(count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login.failed'"), 10_000);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE username = 'newest-failure'").get(), 'the newest is kept');
  assert.ok(count("SELECT COUNT(*) AS n FROM audit_log WHERE action <> 'login.failed'") >= others, 'the rest of the history is untouched');
});

test('old sign-in failure counters are removed', async () => {
  db.prepare("INSERT INTO login_attempts (key, failures, last_failure) VALUES ('stale|1.2.3.4', 3, datetime('now', '-2 days'))").run();
  await login('someone', 'wrong-password-1', { xff: '203.0.113.201' });
  assert.ok(!db.prepare("SELECT 1 FROM login_attempts WHERE key = 'stale|1.2.3.4'").get());
});

test('behind a trusted proxy, only the address the proxy added counts', async () => {
  const got = await statuses(8, (i) => login('siadmin', 'wrong-password-1', { xff: `198.51.100.${i}, 203.0.113.9` }));
  assert.deepEqual(got, [401, 401, 401, 401, 429, 429, 429, 429]);
  assert.equal(db.prepare("SELECT ip FROM audit_log WHERE action = 'login.failed' ORDER BY id DESC LIMIT 1").get().ip, '203.0.113.9', 'and it is the one recorded');
  assert.equal((await login('siadmin', 'si-admin-password-1', { xff: '203.0.113.10' })).status, 200, 'someone at another address is not locked out');
});

test('without the setting, the forwarded header is ignored altogether', async () => {
  delete process.env.GAMESAUCE_TRUST_PROXY;
  const at = await listen(createApp());
  process.env.GAMESAUCE_TRUST_PROXY = '1';
  assert.deepEqual(await statuses(5, (i) => login('siadmin', 'wrong-password-1', { at, xff: `198.51.100.${i}` })), [401, 401, 401, 401, 429]);
});

test('with two proxies set, the address two steps back counts', async () => {
  process.env.GAMESAUCE_PROXY_HOPS = '2';
  const at = await listen(createApp());
  delete process.env.GAMESAUCE_PROXY_HOPS;
  assert.deepEqual(await statuses(5, (i) => login('siadmin', 'wrong-password-1', { at, xff: `198.51.100.${i}, 203.0.113.30, 10.0.0.${i}` })), [401, 401, 401, 401, 429]);
});

test('one address cannot go on guessing by changing the username', async () => {
  const got = await statuses(10, (i) => login(`guess${i}`, 'wrong-password-1', { xff: '203.0.113.40' }));
  assert.deepEqual(got, [401, 401, 401, 401, 401, 401, 401, 429, 429, 429]);
  assert.equal((await login('siadmin', 'si-admin-password-1', { xff: '203.0.113.40' })).status, 429, 'that address waits, even with the right password');
  assert.equal((await login('siadmin', 'si-admin-password-1', { xff: '203.0.113.41' })).status, 200, 'another does not');
  // the lock and its count lapse
  db.prepare("UPDATE login_attempts SET locked_until = datetime('now', '-1 minute'), last_failure = datetime('now', '-16 minutes')").run();
  assert.deepEqual(await statuses(2, (i) => login(`again${i}`, 'wrong-password-1', { xff: '203.0.113.40' })), [401, 401]);
});

test('signing in with an account of your own does not reset your address count', async () => {
  await statuses(6, (i) => login(`g${i}`, 'wrong-password-1', { xff: '203.0.113.50' }));
  assert.equal((await login('siadmin', 'si-admin-password-1', { xff: '203.0.113.50' })).status, 200);
  assert.deepEqual(await statuses(2, (i) => login(`h${i}`, 'wrong-password-1', { xff: '203.0.113.50' })), [401, 429]);
});

test('one username cannot be guessed from endless addresses, and an admin reset lifts the lock', async () => {
  const admin = (await login('siadmin', 'si-admin-password-1', { xff: '203.0.113.60' })).body.token;
  const send = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }, body: JSON.stringify(body) });
  const made = await (await send('/api/auth/users', { username: 'sivictim', password: 'si-victim-pass-12', role: 'user' })).json();
  const got = await statuses(12, (i) => login(i % 2 ? 'SIVICTIM' : 'sivictim', 'wrong-password-1', { xff: `192.0.2.${i}` }));
  assert.deepEqual(got, [...Array(10).fill(401), 429, 429]);
  assert.equal((await send(`/api/auth/users/${made.id}/password`, { password: 'si-victim-pass-34' })).status, 200);
  assert.equal((await login('sivictim', 'si-victim-pass-34', { xff: '192.0.2.100' })).status, 200);
});

test('sending many guesses at once gets no more tries than sending them one by one', async () => {
  const same = await Promise.all(Array.from({ length: 25 }, () => login('siadmin', 'wrong-password-1', { xff: '203.0.113.70' })));
  assert.equal(same.filter((r) => r.status === 401).length, 4, 'one name');
  const many = await Promise.all(Array.from({ length: 25 }, (_, i) => login(`burst${i}`, 'wrong-password-1', { xff: '203.0.113.71' })));
  assert.equal(many.filter((r) => r.status === 401).length, 7, 'many names');
  assert.equal((await login('siadmin', 'si-admin-password-1', { xff: '203.0.113.72' })).status, 200, 'nothing is left counted as in progress');
});
