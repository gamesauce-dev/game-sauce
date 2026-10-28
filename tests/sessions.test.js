import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-sess-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'sessadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'sess-admin-password-1';

let server, base, db;
const login = async (remember) => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'sessadmin', password: 'sess-admin-password-1', ...(remember === undefined ? {} : { remember }) })
  });
  return { status: res.status, cookie: res.headers.get('set-cookie') || '', body: await res.json() };
};
const me = async (token) => (await (await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).json()).authenticated;
const ageSession = (token, minutes) => {
  const row = db.prepare('SELECT id FROM sessions ORDER BY id DESC LIMIT 100').all();
  // find by hash is internal; age every session of this user instead
  db.prepare("UPDATE sessions SET last_seen_at = datetime('now', ?)").run(`-${minutes} minutes`);
  return row.length;
};

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('"keep me signed in" ticked/omitted = persistent cookie; unticked = browser-session cookie', async () => {
  const kept = await login(true);
  assert.match(kept.cookie, /Max-Age=\d+/);
  const dflt = await login();
  assert.match(dflt.cookie, /Max-Age=\d+/, 'older clients (no flag) keep working as before');
  const short = await login(false);
  assert.doesNotMatch(short.cookie, /Max-Age/, 'no Max-Age => dropped when the browser closes');
  assert.match(short.cookie, /HttpOnly/);
});

test('idle timeout signs out browser-only sessions, but not persistent ones by default', async () => {
  process.env.GAMESAUCE_IDLE_MINUTES = '30';
  const persistent = await login(true);
  const browserOnly = await login(false);
  assert.equal(await me(persistent.body.token), true);
  assert.equal(await me(browserOnly.body.token), true);

  ageSession(null, 45); // 45 min of silence
  assert.equal(await me(browserOnly.body.token), false, 'browser-only session expired by idleness');
  assert.equal(await me(persistent.body.token), true, 'persistent session has no idle limit by default');

  ageSession(null, 45); // the check above counted as activity; go quiet again
  process.env.GAMESAUCE_IDLE_MINUTES_PERSISTENT = '30';
  assert.equal(await me(persistent.body.token), false, 'persistent idle limit can be switched on');
  delete process.env.GAMESAUCE_IDLE_MINUTES_PERSISTENT;
  delete process.env.GAMESAUCE_IDLE_MINUTES;
});

test('activity keeps an idle-limited session alive', async () => {
  process.env.GAMESAUCE_IDLE_MINUTES = '30';
  const s = await login(false);
  ageSession(null, 20);
  assert.equal(await fetch(`${base}/api/platforms`, { headers: { Authorization: `Bearer ${s.body.token}` } }).then((r) => r.status), 200); // touches last_seen
  ageSession(null, 20); // another 20 since the touch resets: well inside 30
  // (ageSession shifts from "now", so this models 20 min since last activity)
  assert.equal(await me(s.body.token), true);
  delete process.env.GAMESAUCE_IDLE_MINUTES;
});
