import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-bigscreen-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'badmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'b-admin-password-1';

let server, base, db, tok = {};
const call = async (p, { method = 'GET', body, as = 'admin' } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + tok[as], 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok.admin = await login('badmin', 'b-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'ann', password: 'ann-password-12', role: 'user' } });
  tok.ann = await login('ann', 'ann-password-12');
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('Mark as broken: any signed-in account can mark a game the emulator cannot run, and take the mark off; it shows in the list and the details', async () => {
  const id = Number(db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1) VALUES ((SELECT id FROM platforms WHERE slug = 'xbox360'), 'Broken Game', 'broken game', 'broken.iso', 'x', 3, 'b00000000000000000000000000000000000000b')").run().lastInsertRowid);
  const find = async (as) => (await call('/api/roms?q=Broken+Game', { as })).body.items.find((r) => r.id === id);
  assert.equal((await find('admin')).broken, 0, 'not marked to begin with');
  const marked = await call(`/api/roms/${id}/broken`, { method: 'POST', as: 'ann', body: { broken: true } });
  assert.equal(marked.status, 200); assert.equal(marked.body.broken, 1);
  assert.equal((await find('admin')).broken, 1, 'everybody sees it: it is a fact about the game');
  assert.equal((await call(`/api/roms/${id}`)).body.broken, 1, 'and in the details');
  assert.equal((await call(`/api/roms/${id}/broken`, { method: 'POST', as: 'ann', body: {} })).body.broken, 0, 'no value: it toggles');
  assert.equal((await call(`/api/roms/999999/broken`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await fetch(`${base}/api/roms/${id}/broken`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401, 'signed in only');
});

test('Big Screen: the wheel puts the game in the middle at full size and fades the others; the menu is Play, Favourite, Add to Collection, Mark as Broken, Hide', async () => {
  const { wheelStyle, gameMenu } = await import('../public/bigscreen.js');
  const mid = wheelStyle(0), next = wheelStyle(1), far = wheelStyle(3), above = wheelStyle(-1);
  assert.deepEqual([mid.y, mid.scale, mid.opacity], [0, 1, 1]);
  assert.ok(next.y > 0 && above.y === -next.y, 'below and above are mirror images');
  assert.ok(next.scale < 1 && far.scale < next.scale && far.opacity < next.opacity);
  assert.equal(wheelStyle(9).opacity, 0, 'a game far away is not shown');
  assert.deepEqual(gameMenu({}).map((m) => m.k), ['play', 'fav', 'coll', 'broken', 'hide']);
  assert.deepEqual(gameMenu({}).map((m) => m.label), ['Play', 'Favourite', 'Add to Collection', 'Mark as Broken', 'Hide']);
  assert.equal(gameMenu({ favorite: 1 })[1].label, 'Remove Favourite');
  assert.equal(gameMenu({ broken: 1 })[3].label, 'Unmark as Broken');
});

test('Big Screen is wired in: a button in the Library bar and the Modern bar, #/bigscreen opens it, the pad drives it, and only the platforms this PC can start are listed', () => {
  const html = read('public/index.html'), app = read('public/app.js'), mj = read('public/modern.js'), pad = read('public/gamepad.js'), bs = read('public/bigscreen.js');
  assert.ok(html.includes('id="open-bigscreen"') && html.includes('/bigscreen.css'));
  assert.ok(app.includes("import * as bigscreen from './bigscreen.js'") && app.includes("location.hash === '#/bigscreen'") && app.includes('openBigScreen: openBigScreenView'));
  assert.ok(mj.includes('id="mb-bigscreen"') && mj.includes("v === 'bigscreen'") && fs.existsSync(new URL('../public/modern/icons/big-screen.svg', import.meta.url)));
  assert.ok(pad.includes("$('.cv') || $('.bs')") && pad.includes("root.classList.contains('bs')"), 'the pad reaches Big Screen');
  assert.ok(bs.includes('st.lp.includes(p.slug)'), 'only the platforms the emulator setup reports (once it has)');
});
