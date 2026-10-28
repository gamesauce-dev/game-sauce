import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-hide-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'hideadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'hide-admin-password-1';

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
    body: JSON.stringify({ username: 'hideadmin', password: 'hide-admin-password-1' })
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

test('hidden ROMs are excluded from the library by default', async () => {
  const before = await call('/api/roms');
  assert.equal(before.body.total, 3);

  const res = await call(`/api/roms/${ids[0]}/hide`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.body.hidden, 1);

  const after = await call('/api/roms');
  assert.equal(after.body.total, 2, 'the hidden ROM disappears from the default listing');
  assert.ok(!after.body.items.some((r) => r.id === ids[0]));
});

test('hidden=only is the filter that finds them again', async () => {
  const only = await call('/api/roms?hidden=only');
  assert.equal(only.body.total, 1);
  assert.equal(only.body.items[0].id, ids[0]);
  assert.equal(only.body.items[0].hidden, 1);

  // hidden=all shows everything, for admin-style views.
  const all = await call('/api/roms?hidden=all');
  assert.equal(all.body.total, 3);
});

test('a hidden ROM can be unhidden and reappears', async () => {
  const res = await call(`/api/roms/${ids[0]}/hide`, { method: 'POST', body: { hidden: false } });
  assert.equal(res.body.hidden, 0);
  assert.equal((await call('/api/roms')).body.total, 3);
});

test('the endpoint toggles when no value is given', async () => {
  const first = await call(`/api/roms/${ids[1]}/hide`, { method: 'POST' });
  assert.equal(first.body.hidden, 1);
  const second = await call(`/api/roms/${ids[1]}/hide`, { method: 'POST' });
  assert.equal(second.body.hidden, 0);
});

test('hiding in bulk works and reports how many changed', async () => {
  const res = await call('/api/roms/bulk/hide', { method: 'POST', body: { ids: [ids[0], ids[1]] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, 2);

  assert.equal((await call('/api/roms')).body.total, 1);
  assert.equal((await call('/api/roms?hidden=only')).body.total, 2);
});

test('hidden and favourite are independent', async () => {
  await call(`/api/roms/${ids[2]}/favorite`, { method: 'POST' });
  await call(`/api/roms/${ids[2]}/hide`, { method: 'POST' });

  const favs = await call('/api/roms?favorite=1');
  assert.equal(favs.body.total, 0, 'a favourited but hidden ROM is not in the default favourite view');

  const favsAll = await call('/api/roms?favorite=1&hidden=all');
  assert.equal(favsAll.body.total, 1);
  assert.equal(favsAll.body.items[0].favorite, 1);
  assert.equal(favsAll.body.items[0].hidden, 1);
});

test('facets report a hidden count', async () => {
  const facets = await call('/api/roms/facets');
  assert.equal(facets.body.stats.hidden, 3);
});
