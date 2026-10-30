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

test('System flag: CSV marks BIOS/device/non-arcade, they leave the library and the metadata job, and stay findable and reversible', async () => {
  const csv = 'rom_name,short_game_name,is_bios,is_device,is_arcade\nbiosx.zip,Some BIOS,yes,,\ndevx.zip,A Device,,yes,\ncompx.zip,A Computer,,,no\narcx.zip,Arcade Game,,,yes\n';
  const up = new FormData();
  for (const n of ['biosx.zip', 'devx.zip', 'compx.zip', 'arcx.zip']) up.append('roms', new Blob([`s-${n}`]), n);
  up.append('platform', 'nds'); up.append('enrich', 'false');
  await fetch(`${base}/api/roms/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: up });
  const send = (apply) => { const fd = new FormData(); fd.append('csv', new Blob([csv]), 'n.csv'); fd.append('platform', 'nds'); fd.append('flag_system', '1'); if (apply) fd.append('apply', '1'); return fetch(`${base}/api/roms/bulk/import-names`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd }).then((r) => r.json()); };
  const prev = await send(false);
  assert.equal(prev.system_files, 3, 'bios + device + the row whose is_arcade is filled in but not yes');
  assert.equal((await call('/api/roms?platform=nds&limit=50')).body.total, 4, 'preview changes nothing');
  const ap = await send(true);
  assert.equal(ap.flagged, 3);
  assert.deepEqual((await call('/api/roms?platform=nds&limit=50')).body.items.map((r) => r.title), ['Arcade Game']);
  const sys = (await call('/api/roms?platform=nds&system=only&limit=50')).body;
  assert.equal(sys.total, 3, 'the System filter finds them');
  const job = await call('/api/roms/bulk/enrich-job', { method: 'POST', body: { platform: 'nds' } });
  assert.equal(job.body.total, 1, 'only the real game is looked up');
  for (let i = 0; i < 100; i++) { if (!(await call('/api/roms/bulk/enrich-job')).body.running) break; await new Promise((r) => setTimeout(r, 100)); }
  // reversible, and hide still works on top of it
  const ids = sys.items.map((r) => r.id);
  await call('/api/roms/bulk/hide', { method: 'POST', body: { ids, hidden: true } });
  assert.equal((await call('/api/roms?platform=nds&system=only&limit=50')).body.total, 3, 'hidden System entries still show under System');
  assert.equal((await call('/api/roms/bulk/system', { method: 'POST', body: { ids, system: false } })).status, 200);
  assert.equal((await call('/api/roms?platform=nds&system=only&limit=50')).body.total, 0);
  const dl = await fetch(`${base}/api/roms/${ids[0]}/download`, { headers: { Authorization: `Bearer ${token}` } });
  assert.notEqual(dl.status, 404, 'System/hidden games can still be downloaded');
});

test('System flag: is_arcade = yes always wins over is_bios / is_device', async () => {
  const csv = 'rom_name,short_game_name,is_bios,is_device,is_arcade\ncpsx.zip,Real Fighter,yes,,yes\ndevgame.zip,Device Game,,yes,yes\njustbios.zip,Plain BIOS,yes,,no\n';
  const up = new FormData();
  for (const n of ['cpsx.zip', 'devgame.zip', 'justbios.zip']) up.append('roms', new Blob([`w-${n}`]), n);
  up.append('platform', 'n64'); up.append('enrich', 'false');
  await fetch(`${base}/api/roms/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: up });
  const fd = new FormData(); fd.append('csv', new Blob([csv]), 'n.csv'); fd.append('platform', 'n64'); fd.append('flag_system', '1'); fd.append('apply', '1');
  const r = await (await fetch(`${base}/api/roms/bulk/import-names`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })).json();
  assert.equal(r.flagged, 1, 'only the plain BIOS');
  const lib = (await call('/api/roms?platform=n64&limit=50')).body.items.map((x) => x.title).sort();
  assert.deepEqual(lib, ['Device Game', 'Real Fighter']);
});

test('hiding is personal: one person hiding a game does not hide it for anyone else', async () => {
  const up = new FormData(); up.append('roms', new Blob(['personal-hide']), 'phide.zip'); up.append('platform', 'psp'); up.append('enrich', 'false');
  const id = (await (await fetch(`${base}/api/roms/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: up })).json()).created[0].id;
  const mk = await call('/api/auth/users', { method: 'POST', body: { username: 'nmember', password: 'nm-member-pass-12', role: 'user' } });
  const mt = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nmember', password: 'nm-member-pass-12' }) })).json()).token;
  const as = (p, o = {}) => fetch(base + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mt}` }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  assert.equal((await as(`/api/roms/${id}/hide`, { method: 'POST' })).body.hidden, 1);
  assert.equal((await as('/api/roms?platform=psp&limit=50')).body.items.some((r) => r.id === id), false, 'hidden for the member');
  assert.equal((await call('/api/roms?platform=psp&limit=50')).body.items.some((r) => r.id === id), true, 'still visible to the admin');
  assert.equal((await as('/api/roms?hidden=only&limit=50')).body.items.some((r) => r.id === id), true, 'in the member Hidden filter');
  assert.equal((await call('/api/roms?hidden=only&limit=50')).body.items.some((r) => r.id === id), false, 'not in the admin Hidden filter');
  assert.equal((await as(`/api/roms/${id}/hide`, { method: 'POST' })).body.hidden, 0, 'toggles back');
});

test('System entries are hidden for everyone, admin-only to set, and a member cannot mark them', async () => {
  const csv = 'rom_name,short_game_name,is_bios,is_device,is_arcade\nsysone.zip,System One,yes,,no\nreal.zip,Real Thing,,,yes\n';
  const up = new FormData(); for (const n of ['sysone.zip', 'real.zip']) up.append('roms', new Blob([`sy-${n}`]), n); up.append('platform', 'ps2'); up.append('enrich', 'false');
  await fetch(`${base}/api/roms/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: up });
  const fd = new FormData(); fd.append('csv', new Blob([csv]), 'n.csv'); fd.append('platform', 'ps2'); fd.append('flag_system', '1'); fd.append('apply', '1');
  await fetch(`${base}/api/roms/bulk/import-names`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const mt = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nmember', password: 'nm-member-pass-12' }) })).json()).token;
  const list = async (t) => (await (await fetch(`${base}/api/roms?platform=ps2&limit=50`, { headers: { Authorization: `Bearer ${t}` } })).json()).items.map((r) => r.title);
  assert.deepEqual(await list(token), ['Real Thing']);
  assert.deepEqual(await list(mt), ['Real Thing'], 'hidden for the member too');
  const sysId = (await call('/api/roms?platform=ps2&system=only&limit=50')).body.items[0].id;
  const denied = await fetch(`${base}/api/roms/bulk/system`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mt}` }, body: JSON.stringify({ ids: [sysId], system: false }) });
  assert.equal(denied.status, 403);
});
