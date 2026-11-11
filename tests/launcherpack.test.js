import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-launcherpack-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'ladmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'l-admin-password-1';

let server, base, db, tok;
before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ladmin', password: 'l-admin-password-1' }) })).json()).token;
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ } });

test('the launcher as a download: a zip of the launcher folder with a READ ME FIRST that names this server; only signed-in people who may download', async () => {
  assert.equal((await fetch(base + '/api/launcher/download')).status, 401, 'signed in only');
  const res = await fetch(base + '/api/launcher/download', { headers: { Authorization: 'Bearer ' + tok } });
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/zip'); assert.match(res.headers.get('content-disposition'), /game-sauce-launcher\.zip/);
  const file = path.join(TMP, 'launcher.zip'); fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const { listZip, readEntry } = await import('../src/lib/coverzip.js');
  const entries = listZip(file), names = entries.map((e) => e.name);
  for (const n of ['READ ME FIRST.txt', 'gamesauce-launcher.mjs', 'configure.mjs', 'configure-ui.html', 'platforms.json', 'install-windows.bat', 'install-linux.sh', 'install-macos.sh', 'gamesauce-launcher.vbs']) assert.ok(names.includes(`game-sauce-launcher/${n}`), n);
  const txt = readEntry(file, entries.find((e) => e.name.endsWith('READ ME FIRST.txt'))).toString('utf8');
  assert.ok(txt.includes(base) && txt.includes('Node.js 18') && txt.includes('install-windows.bat') && txt.includes('Set up emulators'), 'says what to do, with this server\'s address');
  const real = fs.readFileSync(new URL('../launcher/platforms.json', import.meta.url));
  assert.ok(readEntry(file, entries.find((e) => e.name.endsWith('platforms.json'))).equals(real), 'the files are the real ones');
  // the screen and the container image carry it too
  assert.ok(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').includes('href="/api/launcher/download"'));
  assert.match(fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8'), /COPY launcher \.\/launcher/);
});
