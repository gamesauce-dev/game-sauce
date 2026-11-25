// "Save to vault" on a release: it uses what the page already knows about the release, so it does not spend another of GitHub's rationed requests.
// GitHub is faked here; nothing leaves this computer.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-emusave-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'esadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'es-admin-password-1';
delete process.env.GITHUB_TOKEN; delete process.env.GAMESAUCE_GITHUB_TOKEN;

let server, base, db, mod, token, realFetch, api, downloads, mode, fileMode, bytes;
const release = () => ({ tag_name: 'v9', name: 'Nine', published_at: '2026-01-01T00:00:00Z', html_url: 'https://github.test/y', assets: [
  { name: 'emu-linux.tar.gz', size: 10, download_count: 1, browser_download_url: 'https://downloads.test/emu-linux.tar.gz' },
  { name: 'emu-windows.zip', size: 10, download_count: 1, browser_download_url: 'https://downloads.test/emu-windows.zip' }] });

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  mod = await import('../src/routes/emulators.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, opts);
    if (u.startsWith('https://api.github.com/')) {
      api.push({ url: u, auth: opts?.headers?.Authorization || null });
      if (mode === 'limited') return new Response('{}', { status: 403, headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) } });
      return new Response(JSON.stringify(release()), { status: 200 });
    }
    if (u.startsWith('https://downloads.test/')) {
      downloads.push({ url: u, auth: opts?.headers?.Authorization || null });
      return fileMode === 'gone' ? new Response('no', { status: 404 }) : new Response(bytes, { status: 200 });
    }
    throw new Error(`unexpected request: ${u}`);
  };
  token = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'esadmin', password: 'es-admin-password-1' }) })).json()).token;
});
let n = 0;
beforeEach(() => {
  api = []; downloads = []; mode = 'ok'; fileMode = 'ok'; bytes = new TextEncoder().encode(`installer ${++n}`);
  mod._resetReleaseCache();
  db.prepare("DELETE FROM metadata_cache WHERE key LIKE 'ghrel:%'").run();
  db.prepare('DELETE FROM emulators').run();
});
after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections(); await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

const get = async (p) => (await fetch(base + p, { headers: { Authorization: `Bearer ${token}` } })).json();
const save = async (asset) => {
  const res = await fetch(`${base}/api/emulators/vault/from-release`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ platform: 'snes', asset }) });
  return { status: res.status, body: await res.json() };
};

test('saving a release the page has shown asks GitHub for nothing more', async () => {
  assert.ok((await get('/api/emulators/latest/snes')).latest);
  assert.equal(api.length, 1);
  const r = await save('https://downloads.test/emu-linux.tar.gz');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(api.length, 1, 'no second question');
  assert.deepEqual(downloads.map((d) => d.url), ['https://downloads.test/emu-linux.tar.gz']);
  assert.equal(r.body.filename, 'emu-linux.tar.gz'); assert.equal(r.body.version, 'v9'); assert.equal(r.body.source, 'github-release'); assert.equal(r.body.size_bytes, bytes.length);
  assert.ok(fs.readFileSync(db.prepare('SELECT storage_path FROM emulators WHERE id = ?').get(r.body.id).storage_path).equals(Buffer.from(bytes)));
});

test('it still saves while GitHub is refusing questions, once the release is known', async () => {
  await get('/api/emulators/latest/snes');
  db.prepare("UPDATE metadata_cache SET fetched_at = datetime('now', '-1 day') WHERE key LIKE 'ghrel:%'").run();
  mod._resetReleaseCache(); mode = 'limited';
  const r = await save('emu-windows.zip');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.filename, 'emu-windows.zip');
});

test('with nothing known and GitHub refusing, it says why in plain words, and does not keep asking', async () => {
  mode = 'limited';
  const first = await save();
  assert.equal(first.status, 502); assert.match(first.body.error, /GitHub is limiting requests until about \d\d:\d\d/);
  const asked = api.length;
  await save(); await save();
  assert.equal(api.length, asked);
  assert.equal(downloads.length, 0);
});

test('the optional GitHub token goes with the question, never with the download', async () => {
  process.env.GITHUB_TOKEN = 'test-token-not-real';
  try { assert.equal((await save()).status, 201); } finally { delete process.env.GITHUB_TOKEN; }
  assert.deepEqual(api.map((a) => a.auth), ['Bearer test-token-not-real']);
  assert.deepEqual(downloads.map((d) => d.auth), [null]);
});

test('with no choice made the Windows file is taken; a file the release does not have is refused', async () => {
  assert.equal((await save()).body.filename, 'emu-windows.zip');
  const bad = await save('https://evil.test/x.exe');
  assert.equal(bad.status, 400);
  assert.deepEqual(downloads.map((d) => d.url), ['https://downloads.test/emu-windows.zip']);
});

test('a download that fails says so and leaves nothing in the vault', async () => {
  fileMode = 'gone';
  const r = await save();
  assert.equal(r.status, 502); assert.match(r.body.error, /Download failed \(404\)/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emulators').get().n, 0);
});

test('one save button per release, which shows it is working', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.equal(app.split('data-save-release="${esc(key)}"').length - 1, 1);
  for (const f of ['../public/app.js', '../public/modern.js', '../public/styles.css', '../public/modern.css']) assert.ok(!fs.readFileSync(new URL(f, import.meta.url), 'utf8').includes('emu-save-alt'), f);
  assert.match(app, /toast\('Saving to the vault\. A large file can take a while\.', false, \{ busy: true \}\)/);
  assert.match(app, /emuState\.saving\.has\(key\)/, 'a redrawn page keeps the button off while the save runs');
});
