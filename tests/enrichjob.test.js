import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-enrichjob-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'jobadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'job-admin-password-1';

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
    body: JSON.stringify({ username: 'jobadmin', password: 'job-admin-password-1' })
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

test('metadata fetch runs as a server job: start, poll, finish; second start while running is refused', async () => {
  const idle = await call('/api/roms/bulk/enrich-job');
  assert.equal(idle.status, 200);
  assert.equal(idle.body.running, false);

  const start = await call('/api/roms/bulk/enrich-job', { method: 'POST', body: {} });
  assert.equal(start.status, 202);
  assert.equal(start.body.total, 3);

  let st;
  for (let i = 0; i < 100; i++) {
    st = (await call('/api/roms/bulk/enrich-job')).body;
    if (!st.running) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(st.running, false, 'job finishes without the browser');
  assert.equal(st.done, 3);
  assert.ok(st.finishedAt);
});

test('the job can be stopped and is admin-only', async () => {
  const res = await call('/api/roms/bulk/enrich-job', { method: 'DELETE' });
  assert.equal(res.status, 200);
  const savedToken = token; token = undefined;
  const anon = await call('/api/roms/bulk/enrich-job');
  token = savedToken;
  assert.equal(anon.status, 401);
});
