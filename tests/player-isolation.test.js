// The in-browser emulator is code from another website, so it runs cut off from the person who is playing: in a frame with no cookie, no storage,
// no way into the app and no signed-in requests (public/ejs-frame.html). The page around it (public/ejs-player.html) looks after the saves and
// treats everything the frame says as untrusted. The last test plays the part of a harmful emulator in a real browser; it needs the test
// browser (npx playwright install chromium) and is skipped without it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-isolation-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'isoadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'iso-admin-password-1';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
let server, base, db, romId;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const file = path.join(TMP, 'Iso Test.nes'); fs.writeFileSync(file, 'not really a game');
  romId = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, meta_source) VALUES ('Iso Test', 'iso test', 'Iso Test.nes', (SELECT id FROM platforms WHERE slug = 'nes'), ?, 17, 'iso', 'filename')").run(file).lastInsertRowid);
});
after(async () => { server?.closeAllConnections(); await new Promise((r) => server?.close(r)); db?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ } });

test('the server itself cuts the emulator page off, however its address is written, and no other page', async () => {
  const policy = async (url) => { const r = await fetch(base + url); await r.arrayBuffer(); return { status: r.status, csp: r.headers.get('content-security-policy'), body: r }; };
  const spellings = ['/ejs-frame.html', '/ejs-frame', '/ejs%2Dframe.html', '/ejs-frame.html?x=1', '/./ejs-frame.html'];
  if (fs.existsSync(new URL('../public/EJS-FRAME.HTML', import.meta.url))) spellings.push('/EJS-FRAME.HTML', '/Ejs-Frame.Html');   // a file system that ignores capitals
  for (const url of spellings) {
    const r = await policy(url);
    assert.equal(r.status, 200, url);
    assert.equal(r.csp, 'sandbox allow-scripts allow-pointer-lock', url);
  }
  for (const url of ['/', '/ejs-player.html', '/app.js', '/styles.css']) { const r = await policy(url); assert.equal(r.status, 200, url); assert.equal(r.csp, null, url); }
});

test('the two halves: no outside code on the signed-in page, and no way into the server from the emulator\'s', () => {
  const host = read('public/ejs-player.html'), frame = read('public/ejs-frame.html');
  assert.doesNotMatch(host, /loader\.js|EJS_|<script[^>]+src=/, 'the signed-in page loads no outside script');
  assert.match(host, /setAttribute\('sandbox', 'allow-scripts allow-pointer-lock'\)/);
  for (const page of [host, frame, read('src/app.js')]) assert.doesNotMatch(page, /sandbox[^\n]*allow-same-origin['"]/);
  assert.match(host, /e\.source !== emu\.contentWindow \|\| e\.origin !== 'null'/, 'only the isolated frame is listened to');
  assert.doesNotMatch(frame, /\/api\/|credentials|fetch\(/, 'the emulator page asks the server for nothing');
  assert.match(frame, /if \(self\.origin !== 'null' \|\| parent === self\)/, 'and loads nothing if it is not cut off');
  assert.match(read('public/app.js'), /frame\.allow = 'gamepad \*; fullscreen \*; autoplay \*; screen-wake-lock \*';/);
});

test('a harmful emulator gets nothing: not the session, not other games, not the app\'s settings, and it cannot flood the saves', async (t) => {
  let chromium, browser;
  try { ({ chromium } = await import('playwright')); browser = await chromium.launch(); } catch { return t.skip('test browser not installed'); }
  try {
    const context = await browser.newContext();
    await context.request.post(base + '/api/auth/login', { data: { username: 'isoadmin', password: 'iso-admin-password-1' } });
    // in place of the real emulator: a script that tries what a bad one would
    const harmful = `(async () => {
      const tell = (m) => parent.postMessage(m, '*');
      const tries = {};
      const attempt = async (name, fn) => { try { await fn(); tries[name] = 'got in'; } catch { tries[name] = 'blocked'; } };
      await attempt('cookie', () => document.cookie.length);
      await attempt('parent', () => parent.document.title);
      await attempt('server', async () => { const r = await fetch('${base}/api/auth/me', { credentials: 'include' }); await r.text(); });
      await attempt('delete', async () => { await fetch('${base}/api/roms/${romId}', { method: 'DELETE', mode: 'no-cors', credentials: 'include' }); throw new Error('sent blind: checked on the server'); });
      window.tries = tries;
      tell({ type: 'storage', key: 'gamesauce_nav', value: 'taken' });
      tell({ type: 'storage', key: 'ejs-settings', value: 'kept' });
      tell({ type: 'storage', key: 'ejs-object', value: { not: 'text' } });
      tell({ type: 'storage', key: 'ejs-huge', value: 'x'.repeat(100000) });
      tell({ type: 'state', state: 'not bytes', rom: 999 });
      tell({ type: 'state', state: { length: 4 } });
      tell({ type: 'flash', text: 'Enter your password' });
      for (let i = 0; i < 12; i++) tell({ type: 'state', state: new Uint8Array([i, 1, 2, 3]), rom: 999, kind: 'battery' });
      tell({ type: 'ready' });
      window.done = true;
    })();`;
    const outside = [];
    await context.route(/^https:\/\//, (route) => {
      const url = route.request().url(); outside.push(url);
      if (url.endsWith('/loader.js')) return route.fulfill({ contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: harmful });
      if (url.endsWith('/version.json')) return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ version: '<img src=x onerror=alert(1)>' }) });
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(`${base}/ejs-player.html?${new URLSearchParams({ id: String(romId), rom: `/api/roms/${romId}/play/Iso%20Test.nes`, title: 'Iso Test', core: 'nes' })}`);
    let frame = null;
    for (let i = 0; i < 100 && !frame; i++) { await page.waitForTimeout(100); const f = page.frames().find((x) => /ejs-frame/.test(x.url())); if (f && await f.evaluate(() => window.done === true).catch(() => false)) frame = f; }
    assert.ok(frame, 'the frame ran the script');
    await page.waitForTimeout(1500);
    assert.deepEqual(await frame.evaluate(() => window.tries), { cookie: 'blocked', parent: 'blocked', server: 'blocked', delete: 'blocked' });
    assert.ok(db.prepare('SELECT 1 FROM roms WHERE id = ?').get(romId), 'the game is still there');
    const saves = db.prepare('SELECT rom_id, kind, core FROM save_states').all();
    assert.deepEqual(saves, [{ rom_id: romId, kind: 'state', core: 'nes' }], 'one save, for this game only, and the odd version text is not taken');
    const kept = await page.evaluate(() => ({ nav: localStorage.getItem('gamesauce_nav'), store: JSON.parse(localStorage.getItem('gamesauce_ejs_frame')) }));
    assert.equal(kept.nav, null, 'the app\'s own settings are out of reach');
    assert.deepEqual(kept.store, { 'ejs-settings': 'kept' });
    assert.doesNotMatch(await page.textContent('body'), /Enter your password/, 'the frame cannot put words on the signed-in page');

    // a game address that is not on this server is not fetched
    const bad = await context.newPage();
    await bad.goto(`${base}/ejs-player.html?${new URLSearchParams({ id: String(romId), rom: 'https://elsewhere.invalid/api/roms/1/play/x.nes', core: 'nes' })}`);
    await bad.waitForTimeout(3500);
    await bad.evaluate(() => [...document.querySelectorAll('#picker > button')].pop()?.click());
    await bad.waitForTimeout(500);
    assert.match(await bad.textContent('body'), /not a game on this server/);
    assert.ok(!outside.some((u) => u.includes('elsewhere.invalid')));
  } finally { await browser.close(); }
});
