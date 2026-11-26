// BIOS and firmware files in the Emulators vault: the admin adds them, and they are treated like ROM files for who may see and download them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-bios-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'biadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'bi-admin-password-1';
process.env.GAMESAUCE_RATE_LIMIT = '0';
process.env.GAMESAUCE_UPDATE_CHECK = '0';

let server, base, db, realFetch;
const token = {}, ids = {};

async function call(who, method, url, body, form) {
  const res = await realFetch(base + '/api' + url, {
    method,
    headers: { ...(token[who] ? { Authorization: `Bearer ${token[who]}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: form || (body ? JSON.stringify(body) : undefined)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* the file itself */ }
  return { status: res.status, text, json, disposition: res.headers.get('content-disposition') || '' };
}
const upload = (who, bytes, filename, fields) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([bytes]), filename);
  return call(who, 'POST', '/emulators/vault/upload', null, fd);
};

before(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => (base && String(u).startsWith(base) ? realFetch(u, o) : Promise.reject(new Error('no outside requests in this test')));
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  token.admin = (await call('nobody', 'POST', '/auth/login', { username: 'biadmin', password: 'bi-admin-password-1' })).json.token;
  for (const who of ['member', 'player']) {
    ids[who] = (await call('admin', 'POST', '/auth/users', { username: `bi${who}`, password: `bi-${who}-password-12`, role: 'user' })).json.id;
    token[who] = (await call('nobody', 'POST', '/auth/login', { username: `bi${who}`, password: `bi-${who}-password-12` })).json.token;
  }
  await call('admin', 'PATCH', `/auth/users/${ids.player}`, { mode: 'play' });
});
after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ }
});

let bios, installer;

test('the admin adds a BIOS file, tied to a platform and kept under its own file name', async () => {
  const r = await upload('admin', 'bios bytes', 'scph_5501.bin', { kind: 'bios', platform_slug: 'ps1' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.json.kind, r.json.platform_slug, r.json.name, r.json.filename], ['bios', 'ps1', 'scph_5501.bin', 'scph_5501.bin']);
  assert.equal(r.json.storage_path, undefined, 'where it is kept is not sent');
  bios = r.json;
  installer = (await upload('admin', 'installer bytes', 'Some_Emulator-setup.exe', { platform_slug: 'ps1' })).json;
  assert.deepEqual([installer.kind, installer.name], ['emulator', 'Some Emulator setup'], 'with nothing said, it is an installer, named as before');
});

test('a platform is required, an unknown kind is refused, and only the admin adds or removes', async () => {
  assert.equal((await upload('admin', 'x1', 'a.bin', { kind: 'bios' })).status, 400);
  assert.equal((await upload('admin', 'x2', 'a.bin', { kind: 'rom', platform_slug: 'ps1' })).status, 400);
  assert.equal((await upload('member', 'x3', 'a.bin', { kind: 'bios', platform_slug: 'ps1' })).status, 403);
  assert.equal((await call('member', 'DELETE', `/emulators/vault/${bios.id}`)).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emulators').get().n, 2);
});

test('the same file again is reported as already there, and stays as it was', async () => {
  const r = await upload('admin', 'bios bytes', 'renamed.bin', { kind: 'bios', platform_slug: 'ps2' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.duplicate, r.json.id, r.json.platform_slug, r.json.filename], [true, bios.id, 'ps1', 'scph_5501.bin']);
});

test('BIOS and firmware files follow the ROM download setting; installers do not', async () => {
  const listed = async (who) => (await call(who, 'GET', '/emulators/vault')).json.items.map((v) => v.id).sort();
  const check = async (may, why) => {
    assert.deepEqual(await listed('member'), (may ? [bios.id, installer.id] : [installer.id]).sort(), why);
    const dl = await call('member', 'GET', `/emulators/vault/${bios.id}/download`);
    assert.equal(dl.status, may ? 200 : 403, why);
    assert.equal(dl.text.includes('bios bytes'), may, why);
    assert.equal((await call('member', 'GET', `/emulators/vault/${installer.id}/download`)).status, 200, why);
  };
  await check(false, 'off by default');
  await call('admin', 'PUT', '/auth/policy', { members_can_download: true });
  await check(true, 'allowed for members');
  await call('admin', 'PATCH', `/auth/users/${ids.member}`, { download: 'deny' });
  await check(false, 'this person never');
  await call('admin', 'PUT', '/auth/policy', { members_can_download: false });
  await call('admin', 'PATCH', `/auth/users/${ids.member}`, { download: 'allow' });
  await check(true, 'this person always');
  const own = await call('admin', 'GET', `/emulators/vault/${bios.id}/download`);
  assert.equal(own.status, 200);
  assert.match(own.disposition, /filename="scph_5501\.bin"/, 'an emulator looks for that exact name');
});

test('play-only accounts and people who are not signed in get nothing from the vault', async () => {
  await call('admin', 'PUT', '/auth/policy', { members_can_download: true });
  for (const [who, status] of [['player', 403], ['nobody', 401]]) {
    for (const url of ['/emulators/vault', `/emulators/vault/${bios.id}/download`]) assert.equal((await call(who, 'GET', url)).status, status, `${who} ${url}`);
  }
});

test('a BIOS file does not count as a saved emulator', () => {
  const route = fs.readFileSync(new URL('../src/routes/emulators.js', import.meta.url), 'utf8');
  assert.match(route, /SELECT name, version, platform_slug FROM emulators WHERE kind = 'emulator'/);
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(app, /emuState\.vault\.filter\(\(v\) => v\.kind !== 'bios' && \(/, 'the "in vault" mark on the emulator cards');
});

test('the admin removes a BIOS file and its stored copy', async () => {
  const stored = db.prepare('SELECT storage_path FROM emulators WHERE id = ?').get(bios.id).storage_path;
  assert.ok(fs.existsSync(stored));
  assert.equal((await call('admin', 'DELETE', `/emulators/vault/${bios.id}`)).status, 200);
  assert.equal(fs.existsSync(stored), false);
});
