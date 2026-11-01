import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-stats-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'sadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 's-admin-password-1';
process.env.GAMESAUCE_SLOW_MS = '0'; // log every request, so a "slow" one can be seen in a test

let server, base, db, adminTok, memberTok;
const call = async (p, { token = adminTok, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (u, p) => (await call('/api/auth/login', { token: null, method: 'POST', body: { username: u, password: p } })).body.token;
let n = 0;
const rom = (title, extra = '') => Number(db.prepare(`INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1, ${extra ? extra.split('=')[0] : 'region'})
  VALUES ((SELECT id FROM platforms WHERE slug = 'snes'), ?, ?, ?, '/nowhere/x', 3, ?, ?)`).run(title, title.toLowerCase(), `${title}.sfc`, `st${String(++n).padStart(6, '0')}`, extra ? extra.split('=')[1] : null).lastInsertRowid);

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('sadmin', 's-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'smember', password: 's-member-pass-12', role: 'user' } });
  memberTok = await login('smember', 's-member-pass-12');
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('Stats are admin-only', async () => {
  assert.equal((await call('/api/admin/stats', { token: memberTok })).status, 403);
  assert.equal((await call('/api/admin/stats', { token: null })).status, 401);
});

test('Stats count matched games from every provider, not just two', async () => {
  const a = rom('Matched By LaunchBox'), b = rom('Matched By IGDB'), c = rom('Matched By DAT'), d = rom('Only A Filename');
  db.prepare("UPDATE roms SET meta_source = 'launchbox' WHERE id = ?").run(a);
  db.prepare("UPDATE roms SET meta_source = 'igdb' WHERE id = ?").run(b);
  db.prepare("UPDATE roms SET meta_source = 'dat' WHERE id = ?").run(c);
  db.prepare("UPDATE roms SET meta_source = 'filename' WHERE id = ?").run(d);
  const s = (await call('/api/admin/stats')).body;
  assert.equal(s.roms, 4);
  assert.equal(s.with_metadata, 3, 'the old figure only counted ScreenScraper and TheGamesDB, so it showed 0 here');
  assert.equal(s.filename_only, 1);
  assert.deepEqual(s.by_source.map((x) => x.source).sort(), ['dat', 'filename', 'igdb', 'launchbox']);
});

test('Stats: orphans, covers, hidden, platforms, sources, most active user', async () => {
  const x = rom('Hidden One');
  await call(`/api/roms/${x}/hide`, { method: 'POST', body: {} });
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'sadmin'").get().id;
  const memberId = db.prepare("SELECT id FROM users WHERE username = 'smember'").get().id;
  const ins = db.prepare("INSERT INTO downloads (rom_id, bytes, user_id, kind) VALUES (?, 0, ?, 'play')");
  ins.run(x, memberId); ins.run(x, memberId); ins.run(x, adminId);
  const s = (await call('/api/admin/stats')).body;
  assert.equal(s.orphans, 5, 'none of the test games has a source folder');
  assert.equal(s.no_covers, 5);
  assert.equal(s.with_covers, 0);
  assert.ok(s.hidden >= 1);
  assert.equal(s.platforms, 1);
  assert.equal(s.sources, 0);
  assert.equal(s.users, 2);
  assert.equal(s.plays, 3);
  assert.equal(s.most_active_user.username, 'smember');
  assert.equal(s.most_active_user.plays, 2);
  assert.equal(s.most_played_game.title, 'Hidden One');
});

test('slow requests carry a start and an end time', async () => {
  await call('/api/roms?limit=1');
  const r = (await call('/api/admin/slow-requests')).body;
  assert.ok(r.entries.length > 0);
  const e = r.entries[0];
  assert.ok(!Number.isNaN(Date.parse(e.started_at)) && !Number.isNaN(Date.parse(e.ended_at)));
  assert.ok(Date.parse(e.ended_at) >= Date.parse(e.started_at));
  assert.equal(Date.parse(e.ended_at) - Date.parse(e.started_at), e.ms);
});

test('Settings groups: "System health", Stats and a Covers panel inside Library tools', () => {
  const ui = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(ui, /label: 'System health'/);
  assert.match(ui, /id: 'coverage',\s+label: 'Stats'/);
  assert.match(ui, /modules: \['dat', 'names', 'duplicates', 'covers'\]/);
  assert.doesNotMatch(ui, /label: 'Health & coverage'/);
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const stats = html.slice(html.indexOf('id="mod-coverage"'), html.indexOf('id="mod-covers"'));
  assert.doesNotMatch(stats, /enrich-missing-covers/, 'the buttons moved out of Stats');
  assert.match(html.slice(html.indexOf('id="mod-covers"'), html.indexOf('id="mod-db"')), /enrich-missing-covers[\s\S]*check-ss-systems/);
});
