// Smaller protections: guessing a current password, what the server says to people, member actions the pages never offered, and input that ends up on a page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-hardening-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'hdadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'hd-admin-password-1';
process.env.GAMESAUCE_LOGIN_MAX_FAILURES = '4';

let server, base, db, admin, member, memberId, realFetch, asked;
const call = async (p, { token = admin, method = 'GET', body, headers = {}, raw } = {}) => {
  const res = await realFetch(base + p, { method, headers: { ...(body || raw ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, body: json };
};
const login = (username, password) => call('/api/auth/login', { token: null, method: 'POST', body: { username, password } });

before(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (base && url.startsWith(base)) return realFetch(u, o);
    asked.push(url);
    return new Response(JSON.stringify({ tag_name: 'v1', assets: [] }), { status: 200 });
  };
  asked = [];
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await login('hdadmin', 'hd-admin-password-1')).body.token;
  memberId = (await call('/api/auth/users', { method: 'POST', body: { username: 'hdmember', password: 'hd-member-pass-12', role: 'user' } })).body.id;
  member = (await login('hdmember', 'hd-member-pass-12')).body.token;
});
after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections(); await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

const change = (token, current, next = 'hd-changed-pass-34') => call('/api/auth/password', { token, method: 'POST', body: { current_password: current, new_password: next } });

test('guessing the current password locks after a few tries, without locking the sign-in', async () => {
  const got = [];
  for (let i = 0; i < 7; i++) got.push((await change(member, `wrong-guess-${i}x`)).status);
  assert.deepEqual(got, [401, 401, 401, 401, 429, 429, 429]);
  assert.equal((await change(member, 'hd-member-pass-12')).status, 429, 'even the right one waits');
  assert.equal((await login('hdmember', 'hd-member-pass-12')).status, 200, 'the owner can still sign in: someone with a stolen session cannot lock them out');
  // an admin's reset lifts it
  assert.equal((await call(`/api/auth/users/${memberId}/password`, { method: 'POST', body: { password: 'hd-member-pass-56' } })).status, 200);
  member = (await login('hdmember', 'hd-member-pass-56')).body.token;
  const together = await Promise.all(Array.from({ length: 20 }, (_, i) => change(member, `burst-${i}x`)));
  assert.equal(together.filter((r) => r.status === 401).length, 4, 'sent all at once, no more tries than one by one');
  await call(`/api/auth/users/${memberId}/password`, { method: 'POST', body: { password: 'hd-member-pass-78' } });
  member = (await login('hdmember', 'hd-member-pass-78')).body.token;
  for (let i = 0; i < 3; i++) await change(member, `slip-${i}x`);
  const ok = await change(member, 'hd-member-pass-78', 'hd-member-pass-90');
  assert.equal(ok.status, 200, 'a few slips and then the right one works');
  member = ok.body.token;
});

test('only someone who knows the password is told an account is disabled', async () => {
  const id = (await call('/api/auth/users', { method: 'POST', body: { username: 'hdgone', password: 'hd-gone-pass-123', role: 'user' } })).body.id;
  await call(`/api/auth/users/${id}`, { method: 'PATCH', body: { disabled: true } });
  assert.equal((await login('hdgone', 'wrong-password-1')).body.error, (await login('hdnobody', 'wrong-password-1')).body.error);
  const right = await login('hdgone', 'hd-gone-pass-123');
  assert.equal(right.status, 401); assert.equal(right.body.error, 'That account is disabled');
});

test('a broken cookie is just no sign-in', async () => {
  const r = await call('/api/auth/me', { token: null, headers: { Cookie: 'gamesauce_session=%E0%A4%A' } });
  assert.equal(r.status, 200, r.text); assert.equal(r.body.authenticated, false);
});

test('an unexpected fault is described to the admin only', async () => {
  db.prepare('ALTER TABLE collections RENAME TO collections_away').run();
  try {
    const m = await call('/api/collections', { token: member });
    assert.equal(m.status, 500); assert.equal(m.body.error, 'Internal error');
    assert.match((await call('/api/collections')).body.error, /collections/, 'the admin gets the reason');
  } finally { db.prepare('ALTER TABLE collections_away RENAME TO collections').run(); }
});

test('health tells strangers and members only that the server is up', async () => {
  for (const token of [null, member]) { const r = await call('/api/health', { token }); assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true }); }
  assert.ok('roms' in (await call('/api/health')).body, 'the admin keeps the figures');
});

test('a change from a page with no origin of its own is refused, unless the browser says it is this site', async () => {
  const post = (headers) => call('/api/collections', { token: member, method: 'POST', body: { name: `c${Math.random()}` }, headers });
  assert.equal((await post({ Origin: 'null' })).status, 403);
  assert.equal((await post({ Origin: 'null', 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await post({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' })).status, 201);
  assert.equal((await post({})).status, 201, 'programs that send no Origin still work');
});

test('a platform colour must be a colour', async () => {
  for (const accent of ['red" onmouseover="x', '#12', 'url(https://x.test)', '#1234567']) {
    assert.equal((await call('/api/platforms/snes', { method: 'PATCH', body: { accent } })).status, 400, accent);
    assert.equal((await call('/api/platforms', { method: 'POST', body: { slug: `bad${accent.length}`, name: 'Bad', accent } })).status, 400, accent);
  }
  for (const accent of ['#abc', '#A1B2C3']) assert.equal((await call('/api/platforms/snes', { method: 'PATCH', body: { accent } })).status, 200, accent);
  assert.equal((await call('/api/platforms/snes', { method: 'PATCH', body: { accent: '' } })).body.accent, '#6b7280', 'empty means the plain grey');
});

test('a member cannot send the server to look for a Library video, or hurry the release checks', async () => {
  const rom = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes) VALUES ('H', 'h', 'h.sfc', (SELECT id FROM platforms WHERE slug = 'snes'), 'x', 1)").run().lastInsertRowid);
  for (const [query, body] of [['', { kind: 'rom', id: rom }], [`?kind=rom&id=${rom}`, { force: true }], [`?kind=physical&id=1`, { kind: 'rom', id: rom }]]) {
    assert.equal((await call(`/api/videos/fetch${query}`, { token: member, method: 'POST', body })).status, 403, query + JSON.stringify(body));
  }
  assert.equal((await call('/api/videos/fetch', { method: 'POST', body: { kind: 'rom', id: rom } })).status, 400, 'the admin gets as far as "no video source is set up"');

  asked = [];
  await call('/api/emulators/latest/snes', { token: member });
  assert.equal(asked.length, 1, 'a member sees releases like anyone');
  db.prepare("UPDATE metadata_cache SET fetched_at = datetime('now', '-1 hour') WHERE key LIKE 'ghrel:%'").run();
  (await import('../src/routes/emulators.js'))._resetReleaseCache();
  await call('/api/emulators/latest/snes?refresh=1', { token: member });
  assert.equal(asked.length, 1, '?refresh=1 from a member does nothing extra');
  await call('/api/emulators/latest/snes?refresh=1');
  assert.equal(asked.length, 2, 'from the admin it asks again');
  assert.match(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), /<div class="emu-refresh-bar admin-only">/, 'and only the admin sees the button');
});

test('page code escapes quotes of both kinds, and the player escapes what a save says about itself', () => {
  for (const f of ['reports.js', 'charts.js', 'modern.js']) {
    for (const line of fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').split('\n')) {
      if (/const esc = .*&amp;/.test(line)) assert.ok(line.includes('&#39;'), `${f}: ${line.slice(0, 80)}`);
    }
  }
  const player = fs.readFileSync(new URL('../public/ejs-player.html', import.meta.url), 'utf8');
  assert.match(player, /'<div class="warn">⚠ ' \+ esc\(mismatch\(s\)\)/);
});
