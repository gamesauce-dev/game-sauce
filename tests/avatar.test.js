import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-avatar-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'avadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'ava-admin-password-1';

let server, base, token, ids = [];

const call = async (p, { method = 'GET', body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'avadmin', password: 'ava-admin-password-1' })
  });
  token = (await login.json()).token;

  // Three ROMs via upload, so the suite does not depend on the seeded library.
  const fd = new FormData();
  for (const name of ['Alpha (USA).sfc', 'Beta (USA).sfc', 'Gamma (USA).sfc']) {
    fd.append('roms', new Blob([`content-of-${name}`]), name);
  }
  fd.append('enrich', 'false');
  const upload = await fetch(`${base}/api/roms/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd
  });
  ids = (await upload.json()).created.map((r) => r.id);
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  const { db } = await import('../src/db.js');
  db.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
const send = (buf, name = 'a.png') => { const fd = new FormData(); fd.append('avatar', new Blob([buf]), name); return fetch(`${base}/api/auth/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd }); };

test('upload, view, list and remove a profile picture', async () => {
  const me0 = await call('/api/auth/me');
  assert.equal(me0.body.user.avatar_v, null);
  const up = await send(PNG);
  assert.equal(up.status, 200);
  const { avatar_v } = await up.json();
  assert.ok(avatar_v);
  const me = await call('/api/auth/me');
  assert.equal(me.body.user.avatar_v, avatar_v);
  const img = await fetch(`${base}/api/auth/avatar/${me.body.user.id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const users = await call('/api/auth/users');
  assert.equal(users.body.items[0].avatar_v, avatar_v);
  const del = await call('/api/auth/avatar', { method: 'DELETE' });
  assert.equal(del.status, 200);
  const gone = await fetch(`${base}/api/auth/avatar/${me.body.user.id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(gone.status, 404);
});

test('non-images and big files are refused; signed-out can not read pictures', async () => {
  assert.equal((await send(Buffer.from('<svg onload=alert(1)></svg>'.repeat(3)), 'x.svg')).status, 400);
  assert.equal((await send(Buffer.concat([PNG, Buffer.alloc(1100 * 1024)]))).status, 400);
  const anon = await fetch(`${base}/api/auth/avatar/1`);
  assert.equal(anon.status, 401);
});
