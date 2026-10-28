import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-guard-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'gadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'g-admin-password-1';
process.env.GAMESAUCE_RATE_LIMIT = '40'; // small so the tests can reach it

let server, base, db, tok, guard;
const raw = (p, { method = 'GET', headers = {}, body, token = tok } = {}) => fetch(base + p, {
  method,
  headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined
});

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  guard = await import('../src/lib/guard.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await raw('/api/auth/login', { method: 'POST', body: { username: 'gadmin', password: 'g-admin-password-1' }, token: null });
  tok = (await res.json()).token;
});
beforeEach(() => guard.resetRateLimits());
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

const hostOf = () => new URL(base).host;

/* ─────────────────────────────── CSRF / origin ─────────────────────────────── */

test('a change request from another website is refused', async () => {
  const r = await raw('/api/collections', { method: 'POST', body: { name: 'evil' }, headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /another website/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'evil'").get().n, 0, 'nothing was created');
});

test('a mismatching Origin is refused even without fetch metadata', async () => {
  const r = await raw('/api/collections', { method: 'POST', body: { name: 'evil2' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('the real page (same Origin) works', async () => {
  const r = await raw('/api/collections', { method: 'POST', body: { name: 'legit' }, headers: { Origin: `http://${hostOf()}`, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(r.status, 201);
});

test('programs without Origin headers (curl, scripts, tests) still work', async () => {
  const r = await raw('/api/collections', { method: 'POST', body: { name: 'from-script' } });
  assert.equal(r.status, 201);
});

test('reading is never blocked by the origin check', async () => {
  const r = await raw('/api/roms?limit=1', { headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 200);
});

test('sign-in from another website is refused too', async () => {
  const r = await raw('/api/auth/login', { method: 'POST', token: null, body: { username: 'gadmin', password: 'g-admin-password-1' }, headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 403);
});

test('extra origins can be allowed for a reverse proxy', async () => {
  process.env.GAMESAUCE_ALLOWED_ORIGINS = 'https://games.example.org/';
  try {
    const ok = await raw('/api/collections', { method: 'POST', body: { name: 'proxied' }, headers: { Origin: 'https://games.example.org' } });
    assert.equal(ok.status, 201);
    const bad = await raw('/api/collections', { method: 'POST', body: { name: 'still-evil' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.status, 403);
  } finally { delete process.env.GAMESAUCE_ALLOWED_ORIGINS; }
});

/* ─────────────────────────────── rate limits ─────────────────────────────── */

test('the general limit returns 429 with Retry-After, then recovers', async () => {
  let blocked = null;
  for (let i = 0; i < 60 && !blocked; i++) {
    const r = await raw('/api/roms?limit=1');
    if (r.status === 429) blocked = r;
  }
  assert.ok(blocked, 'a flood is eventually refused');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.match((await blocked.json()).error, /Too many requests/);
  guard.resetRateLimits();
  assert.equal((await raw('/api/roms?limit=1')).status, 200, 'works again after the window');
});

test('limits are per user: one noisy user does not block another', async () => {
  await raw('/api/auth/users', { method: 'POST', body: { username: 'quiet', password: 'quiet-password-1', role: 'user' } });
  const quiet = (await (await raw('/api/auth/login', { method: 'POST', token: null, body: { username: 'quiet', password: 'quiet-password-1' } })).json()).token;
  for (let i = 0; i < 60; i++) await raw('/api/roms?limit=1');
  assert.equal((await raw('/api/roms?limit=1')).status, 429, 'the admin is limited');
  assert.equal((await raw('/api/roms?limit=1', { token: quiet })).status, 200, 'the other user is not');
});

test('cover art and the health check are never counted', async () => {
  for (let i = 0; i < 80; i++) {
    const h = await raw('/api/health', { token: null });
    assert.equal(h.status, 200);
  }
  assert.equal((await raw('/api/roms?limit=1')).status, 200, 'the budget is untouched');
});

test('expensive actions have a tighter cap than ordinary ones', async () => {
  // 900-based defaults scale with GAMESAUCE_RATE_LIMIT (40): metadata = round(60 * 40/900) = 3
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await raw('/api/roms/999999/refresh', { method: 'POST' })).status);
  assert.ok(statuses.includes(429), `metadata refresh gets limited early (${statuses.join(',')})`);
  assert.notEqual(statuses[0], 429, 'but the first calls go through');
  assert.equal((await raw('/api/roms?limit=1')).status, 200, 'ordinary browsing is unaffected');
});

test('the limiter forgets old requests (sliding window)', async () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(guard.hit('k', 5, t0 + i), 0);
  assert.ok(guard.hit('k', 5, t0 + 10) > 0, 'sixth call inside the minute is refused');
  assert.equal(guard.hit('k', 5, t0 + 61_000), 0, 'allowed again a minute later');
});

test('setting the limit to 0 turns the limiter off', async () => {
  const before = process.env.GAMESAUCE_RATE_LIMIT;
  process.env.GAMESAUCE_RATE_LIMIT = '0';
  try {
    for (let i = 0; i < 120; i++) assert.equal((await raw('/api/roms?limit=1')).status, 200);
  } finally { process.env.GAMESAUCE_RATE_LIMIT = before; }
});

test('a per-kind cap of 0 turns that cap off instead of blocking everything', async () => {
  process.env.GAMESAUCE_RATE_LIMIT_METADATA = '0';
  try {
    const statuses = [];
    for (let i = 0; i < 8; i++) statuses.push((await raw('/api/roms/999999/refresh', { method: 'POST' })).status);
    assert.ok(!statuses.includes(429), `no limiting (${statuses.join(',')})`);
  } finally { delete process.env.GAMESAUCE_RATE_LIMIT_METADATA; }
});
