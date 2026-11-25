// The list of save states the player offers can be worked with a controller. A pretend controller in a real browser; the emulator is not loaded.
// Needs the test browser (npx playwright install chromium) and is skipped without it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-picker-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'pkadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'pk-admin-password-1';

const A = 0, B = 1, UP = 12, DOWN = 13;
let server, base, romId, saveIds, browser;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  const db = (await import('../src/db.js')).default;
  const { putSave } = await import('../src/lib/saves.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const file = path.join(TMP, 'Pick.nes'); fs.writeFileSync(file, 'not really a game');
  romId = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, meta_source) VALUES ('Pick', 'pick', 'Pick.nes', (SELECT id FROM platforms WHERE slug = 'nes'), ?, 17, 'pk', 'filename')").run(file).lastInsertRowid);
  const uid = db.prepare('SELECT id FROM users').get().id;
  // newest first in the list: the last one made is the first row. 'nes' with no version asks for "Load anyway" (a second press)
  saveIds = ['nes', 'nes', 'nes'].map((core) => putSave(uid, romId, 'state', core, Buffer.from('state'))).reverse();
  try { const { chromium } = await import('playwright'); browser = await chromium.launch(); } catch { browser = null; }
});
after(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise((r) => server?.close(r)); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ } });

/** The player with its list up, a pretend controller plugged in, and a note of which save's data was asked for. */
async function open({ id = 'Pretend pad', layout = null, held = [] } = {}) {
  const context = await browser.newContext();
  await context.request.post(base + '/api/auth/login', { data: { username: 'pkadmin', password: 'pk-admin-password-1' } });
  await context.route(/^https:\/\//, (route) => route.abort());
  await context.addInitScript(([padId, pref, down]) => {
    window.padDown = new Set(down);
    const pad = () => ({ id: padId, index: 1, connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: window.padDown.has(i), value: window.padDown.has(i) ? 1 : 0 })) });
    navigator.getGamepads = () => [null, pad()];   // not in the first slot, as some browsers have it
    if (pref) localStorage.setItem('gamesauce_pad_layout', pref);
  }, [id, layout, held]);
  const page = await context.newPage();
  const asked = [];
  page.on('request', (r) => { const m = r.url().match(/\/saves\/(\d+)\/file/); if (m) asked.push(Number(m[1])); });
  await page.goto(`${base}/ejs-player.html?${new URLSearchParams({ id: String(romId), rom: `/api/roms/${romId}/play/Pick.nes`, core: 'nes' })}`);
  await page.waitForSelector('#picker .slot button');
  await page.waitForTimeout(200);
  const wait = () => page.waitForTimeout(120);
  const press = async (b) => { await page.evaluate((n) => window.padDown.add(n), b); await wait(); await page.evaluate((n) => window.padDown.delete(n), b); await wait(); };
  const on = () => page.evaluate(() => { const all = [...document.querySelectorAll('#picker button')]; const i = all.findIndex((x) => x.classList.contains('pad-on')); return i < 0 ? null : `${i} ${all[i].textContent}`; });
  const listUp = () => page.evaluate(() => Boolean(document.querySelector('#picker')));
  return { page, context, asked, press, on, listUp, wait };
}

test('the controller moves through the list and chooses, a second press for "Load anyway"', async (t) => {
  if (!browser) return t.skip('test browser not installed');
  const p = await open();
  try {
    assert.equal(await p.on(), '0 Load', 'the newest save is highlighted');
    await p.press(DOWN); assert.equal(await p.on(), '1 Load');
    await p.press(DOWN); await p.press(DOWN); assert.equal(await p.on(), '3 Start new game');
    await p.press(DOWN); assert.equal(await p.on(), '3 Start new game', 'it stops at the end');
    await p.press(UP); await p.press(UP); assert.equal(await p.on(), '1 Load');
    await p.press(A); assert.equal(await p.on(), '1 Load anyway'); assert.equal(await p.listUp(), true);
    await p.press(A); await p.wait();
    assert.equal(await p.listUp(), false);
    assert.equal(p.asked[0], saveIds[1], 'the highlighted save is the one loaded');
  } finally { await p.context.close(); }
});

test('a button still held from starting the game chooses nothing until it is let go', async (t) => {
  if (!browser) return t.skip('test browser not installed');
  const p = await open({ held: [A] });
  try {
    await p.page.waitForTimeout(500);
    assert.equal(await p.listUp(), true); assert.deepEqual(p.asked, []);
    assert.equal(await p.on(), '0 Load', 'nothing was even armed');
    await p.page.evaluate(() => window.padDown.clear()); await p.wait();
    await p.press(A);
    assert.equal(await p.on(), '0 Load anyway');
  } finally { await p.context.close(); }
});

test('B starts a new game, and Nintendo pads choose with their own A', async (t) => {
  if (!browser) return t.skip('test browser not installed');
  let p = await open();
  try { await p.press(B); assert.equal(await p.listUp(), false); assert.ok(!p.asked.includes(saveIds[0]) && !p.asked.includes(saveIds[2]), 'no save state was loaded'); } finally { await p.context.close(); }
  p = await open({ id: 'Nintendo Switch Pro Controller (Vendor: 057e)' });
  try { await p.press(1); assert.equal(await p.on(), '0 Load anyway', 'the right-hand button is A there'); await p.press(0); assert.equal(await p.listUp(), false, 'and the bottom one is B'); } finally { await p.context.close(); }
  p = await open({ id: 'Nintendo Switch Pro Controller (Vendor: 057e)', layout: 'xbox' });
  try { await p.press(0); assert.equal(await p.on(), '0 Load anyway', 'the layout chosen in settings wins'); } finally { await p.context.close(); }
});
