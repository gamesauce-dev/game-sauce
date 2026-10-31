import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-hideall-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'hadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'h-admin-password-1';

let server, base, db, adminTok, memberTok, secretId, plainId, file;
const call = async (p, { token = adminTok, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (u, p) => (await call('/api/auth/login', { token: null, method: 'POST', body: { username: u, password: p } })).body.token;
const titles = (r) => r.body.items.map((i) => i.title).sort();

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('hadmin', 'h-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'hmember', password: 'h-member-pass-12', role: 'user' } });
  memberTok = await login('hmember', 'h-member-pass-12');
  file = path.join(TMP, 'secret.sfc'); fs.writeFileSync(file, 'rom');
  const ins = (title, sha) => db.prepare(`INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1)
    VALUES ((SELECT id FROM platforms WHERE slug = 'snes'), ?, ?, ?, ?, 3, ?)`).run(title, title.toLowerCase(), `${title}.sfc`, file, sha).lastInsertRowid;
  secretId = Number(ins('Secret Game', 'ha000001')); plainId = Number(ins('Plain Game', 'ha000002'));
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('only an admin can hide a game from everyone', async () => {
  assert.equal((await call(`/api/roms/${secretId}/hide-all`, { token: memberTok, method: 'POST', body: { hidden: true } })).status, 403);
  assert.equal((await call('/api/roms/bulk/hide-all', { token: memberTok, method: 'POST', body: { ids: [secretId] } })).status, 403);
  assert.equal(db.prepare('SELECT hidden_all FROM roms WHERE id = ?').get(secretId).hidden_all, 0);
});

test('hidden from everyone: gone for members everywhere, still there for the admin', async () => {
  assert.equal((await call(`/api/roms/${secretId}/hide-all`, { method: 'POST', body: { hidden: true } })).status, 200);
  assert.deepEqual(titles(await call('/api/roms?limit=50', { token: memberTok })), ['Plain Game']);
  assert.equal((await call('/api/roms?limit=50&hidden=all', { token: memberTok })).body.items.some((i) => i.title === 'Secret Game'), false, 'asking for hidden=all does not reveal it');
  assert.equal((await call('/api/roms?limit=50&hidden=only', { token: memberTok })).body.items.length, 0);
  assert.equal((await call(`/api/roms/${secretId}`, { token: memberTok })).status, 404, 'opening it by number');
  assert.equal((await call(`/api/roms/${secretId}/download`, { token: memberTok })).status, 404, 'downloading it');
  assert.equal((await call(`/api/roms/${secretId}/cover`, { token: memberTok })).status, 404);
  assert.equal((await call(`/api/roms/${secretId}/play`, { token: memberTok })).status, 404, 'playing it');
  assert.equal((await call(`/api/roms/${secretId}/favorite`, { token: memberTok, method: 'POST', body: {} })).status, 404);
  // the admin still sees it, in the normal list marked, and in the Hidden filter
  assert.ok((await call('/api/roms?limit=50&hidden=only')).body.items.some((i) => i.title === 'Secret Game'));
  assert.equal((await call(`/api/roms/${secretId}`)).body.hidden_all, 1);
  assert.ok(!(await call('/api/roms?limit=50')).body.items.some((i) => i.title === 'Secret Game'), 'out of the admin\'s normal list too, so what members see matches');
});

test('counts for members leave it out; the admin\'s Hidden count includes it', async () => {
  assert.equal((await call('/api/stats', { token: memberTok })).body.library.roms, 1);
  assert.equal((await call('/api/roms/facets', { token: memberTok })).body.stats.roms, 1);
  assert.equal((await call('/api/platforms', { token: memberTok })).body.items.find((p) => p.slug === 'snes').count, 1);
  assert.equal((await call('/api/platforms')).body.items.find((p) => p.slug === 'snes').count, 2);
  assert.equal((await call('/api/roms/facets')).body.stats.hidden, 1);
});

test('collections and the recent row do not give it away', async () => {
  const c = (await call('/api/collections', { method: 'POST', body: { name: 'Mixed' } })).body;
  await call(`/api/collections/${c.id}/roms`, { method: 'POST', body: { rom_ids: [secretId, plainId] } });
  const asMember = await call(`/api/collections/${c.id}`, { token: memberTok });
  assert.deepEqual((asMember.body.items || asMember.body.roms || []).map((i) => i.title), ['Plain Game']);
  assert.ok(!(await call('/api/stats', { token: memberTok })).body.recent.some((r) => r.title === 'Secret Game'));
});

test('showing it again, and the bulk route', async () => {
  assert.equal((await call(`/api/roms/${secretId}/hide-all`, { method: 'POST', body: { hidden: false } })).status, 200);
  assert.deepEqual(titles(await call('/api/roms?limit=50', { token: memberTok })), ['Plain Game', 'Secret Game']);
  const b = await call('/api/roms/bulk/hide-all', { method: 'POST', body: { ids: [secretId, plainId], hidden: true } });
  assert.equal(b.body.changed, 2);
  assert.deepEqual((await call('/api/roms?limit=50', { token: memberTok })).body.items, []);
  await call('/api/roms/bulk/hide-all', { method: 'POST', body: { ids: [secretId, plainId], hidden: false } });
  assert.equal((await call('/api/roms?limit=50', { token: memberTok })).body.items.length, 2);
});

test('personal hiding is unchanged: it hides only for the person who did it', async () => {
  await call(`/api/roms/${plainId}/hide`, { token: memberTok, method: 'POST', body: {} });
  assert.deepEqual(titles(await call('/api/roms?limit=50', { token: memberTok })), ['Secret Game']);
  assert.deepEqual(titles(await call('/api/roms?limit=50')), ['Plain Game', 'Secret Game'], 'the admin still sees it');
});
