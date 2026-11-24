// Hiding a game from a Home tile (Recently added, Continue playing) takes the tile off the row and the server leaves it out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-homenav-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'hnadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'hn-admin-password-1';

let server, base, db, adminTok, memberTok;
const call = async (p, { token = adminTok, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (u, p) => (await call('/api/auth/login', { token: null, method: 'POST', body: { username: u, password: p } })).body.token;
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('hnadmin', 'hn-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'hnmember', password: 'hn-member-pass-12', role: 'user' } });
  memberTok = await login('hnmember', 'hn-member-pass-12');
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('Recently added leaves out a game this person hid (and a member hiding it does not touch the admin)', async () => {
  const add = (t, f, sha) => Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, meta_source) VALUES (?,?,?,(SELECT id FROM platforms WHERE slug = 'snes'),?,1,?, 'filename')").run(t, t.toLowerCase(), f, path.join(TMP, f), sha).lastInsertRowid);
  const a = add('Home Tile A', 'a.sfc', 'hn1'), b = add('Home Tile B', 'b.sfc', 'hn2');
  const ids = async (token) => (await call('/api/stats', { token })).body.recent.map((r) => r.id);
  assert.ok((await ids(memberTok)).includes(a));
  assert.equal((await call(`/api/roms/${a}/hide`, { token: memberTok, method: 'POST' })).body.hidden, 1);
  const mine = await ids(memberTok);
  assert.ok(!mine.includes(a), 'hidden by this member: not in their Recently added');
  assert.ok(mine.includes(b));
  assert.ok((await ids(adminTok)).includes(a), 'a member hiding a game is personal');
  // the Library agrees
  const lib = (await call('/api/roms?limit=50', { token: memberTok })).body.items.map((r) => r.id);
  assert.ok(!lib.includes(a));
  // the admin's Hide is for everyone: gone from the member's row too
  await call(`/api/roms/${b}/hide`, { method: 'POST' });
  assert.ok(!(await ids(memberTok)).includes(b));
});

test('the details Hide button takes the tile off the Home rows', () => {
  const app = read('public/app.js');
  const i = app.indexOf("[data-act=\"hide\"]', drawer).addEventListener");
  assert.ok(i > 0);
  assert.match(app.slice(i, i + 400), /dropFromHomeRows\(id\)/);
  assert.match(app, /function dropFromHomeRows\(id\)[\s\S]{0,200}#mh-recent[\s\S]{0,120}#mh-played/);
});

