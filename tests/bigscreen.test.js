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

test('Big Screen: a game shows its logo and its marquee when it has them (the pictures a ScreenScraper match keeps as "wheel" and "marquee"), and the platform choice goes family first, then platform', async () => {
  const { gameLogo, gameMarquee } = await import('../public/bigscreen.js');
  assert.equal(gameLogo({ id: 7, media: { wheel: { path: 'p', url: 'u' } } }), '/api/roms/7/media/wheel');
  assert.equal(gameMarquee({ id: 7, media: { marquee: { path: 'p', url: 'u' } } }), '/api/roms/7/media/marquee');
  assert.equal(gameLogo({ id: 7, media: { screenshot: {} } }), ''); assert.equal(gameMarquee({ id: 7 }), '', 'none when the game has none');
  const bs = read('public/bigscreen.js'), css = read('public/bigscreen.css');
  assert.ok(bs.includes('const families = ()') && bs.includes('st.level === 0') && bs.includes('/api/platforms/families/logo'), 'family tiles, with the family logo');
  assert.ok(bs.includes('onerror="this.closest(\'.bs-mid\').classList.remove(\'has-logo\')"'), 'a logo that cannot be loaded falls back to the cover');
  assert.ok(bs.includes('v.muted = false') && bs.includes("v.muted = true"), 'the video plays with sound, and without it if the browser will not start it with sound');
  assert.ok(css.includes('.bs-marquee') && css.includes('.bs-mid.has-logo .bs-cov'));
});

test('Big Screen: platform names and game counts are in capitals, the game page has a blurred cover on its left, and the details scroll slowly after about five seconds', () => {
  const bs = read('public/bigscreen.js'), css = read('public/bigscreen.css');
  assert.ok(/\.bs-heroname \{ text-transform: uppercase/.test(css) && /\.bs-pill \{ text-transform: uppercase/.test(css), 'names and counts in capitals');
  assert.ok(bs.includes('class="bs-leftbg"') && css.includes('.bs-leftbg i') && css.includes('filter: blur('), 'a blurred cover behind the menu');
  assert.ok(bs.includes('now - t0 > 5000') && bs.includes('* 14'), 'the details start to scroll after about five seconds, slowly');
  assert.ok(css.includes('.bs-media:empty { display: none; }'), 'no empty box where a video would be');
});

test('Big Screen: the year, players and developer stay put above the scrolling description; covers keep their own shape; the game page moves to the other game with LB/RB or left/right', () => {
  const bs = read('public/bigscreen.js'), css = read('public/bigscreen.css');
  assert.ok(bs.indexOf('class="bs-factline"') < bs.indexOf('id="bs-scroll"') && !/<div class="bs-scrollin" id="bs-scrollin">\s*<div class="bs-factline"/.test(bs), 'the facts are outside the scrolling box');
  assert.ok(css.includes('.bs-boxcover.has-img') && css.includes('.bs-cov.has-img') && css.includes('aspect-ratio: auto'), 'a cover with a picture has no fixed frame, so no grey bars');
  assert.ok(bs.includes("a === 'prev-family' || a === 'next-family' || a === 'left' || a === 'right'"), 'LB, RB, left and right change game on the game page');
});

test('Big Screen: the app\'s controller legend is hidden over it, the menu bar slides and shrinks as it moves, and a game marked as broken is flagged on the page and the wheel', () => {
  const bs = read('public/bigscreen.js'), css = read('public/bigscreen.css');
  assert.ok(css.includes('body.bs-open #gp-legend { display: none !important; }'), 'no second legend over the hints');
  assert.ok(css.includes('@keyframes bs-sel-squash') && css.includes('scaleX(.62)') && css.includes('transition: top .26s') && bs.includes("sel.classList.add('moving')"), 'the bar slides, and is shorter on the way');
  assert.ok(css.includes('.bs-ribbon') && css.includes('.bs-brokennote') && css.includes('.bs-row.is-broken') && bs.includes('paintBroken(g)'), 'the broken marks');
  assert.ok(bs.includes('This game is marked as broken. Trying anyway'), 'playing one says so');
});

test('Big Screen: the bottom bar reminds you to hold Select + Start to close a running game', () => {
  const bs = read('public/bigscreen.js');
  assert.ok(bs.includes('Hold in a game to close it') && bs.includes('bs-closehint'));
});
