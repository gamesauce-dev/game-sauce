import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-names-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'nmadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'nm-admin-password-1';

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
    body: JSON.stringify({ username: 'nmadmin', password: 'nm-admin-password-1' })
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

const CSV = 'rom_name,clone_of,full_game_name,short_game_name,year,manufacturer\n'
  + 'alpha.zip,,"Alpha (World, set 1)",Alpha Quest,1991,Acme\n'
  + 'beta.zip,,Beta (bootleg),"Beta, The Game",1992,bootleg\n'
  + 'nothere.zip,,X,Nope,1990,X\n';
const post = (apply) => { const fd = new FormData(); fd.append('csv', new Blob([CSV]), 'n.csv'); fd.append('platform', 'snes'); if (apply) fd.append('apply', '1'); return fetch(`${base}/api/roms/bulk/import-names`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd }).then(async (r) => ({ status: r.status, body: await r.json() })); };

test('CSV name import: preview changes nothing, apply renames matching files only', async () => {
  const up = new FormData();
  for (const n of ['alpha.zip', 'beta.zip', 'gamma.zip']) up.append('roms', new Blob([`x-${n}`]), n);
  up.append('platform', 'snes'); up.append('enrich', 'false');
  const created = (await (await fetch(`${base}/api/roms/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: up })).json()).created;
  assert.equal(created.length, 3);
  const prev = await post(false);
  assert.equal(prev.status, 200);
  assert.equal(prev.body.csv_rows, 3);
  assert.equal(prev.body.matched, 2);
  assert.equal(prev.body.roms_on_platform - prev.body.matched, prev.body.unmatched);
  assert.equal((await call(`/api/roms/${created[0].id}`)).body.title, created[0].title, 'preview saved nothing');
  const ap = await post(true);
  assert.equal(ap.body.applied, true);
  const titles = (await call('/api/roms?limit=50')).body.items.map((r) => r.title);
  assert.ok(titles.includes('Alpha Quest'));
  assert.ok(titles.includes('Beta, The Game'), 'quoted comma survives');
  assert.ok(!titles.includes('Nope'));
});

test('CSV name import: bad column and non-admin are refused', async () => {
  const fd = new FormData(); fd.append('csv', new Blob(['a,b\n1,2\n']), 'n.csv'); fd.append('platform', 'snes');
  const bad = await fetch(`${base}/api/roms/bulk/import-names`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  assert.equal(bad.status, 400);
  const anon = await fetch(`${base}/api/roms/bulk/import-names`, { method: 'POST', body: fd });
  assert.equal(anon.status, 401);
});
