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
  assert.deepEqual(gameMenu({}).map((m) => m.label), ['Play', 'Favourite', 'Add to Collection', 'Broken', 'Hide']);
  assert.equal(gameMenu({ favorite: 1 })[1].label, 'Favourite', 'the word stays'); assert.equal(gameMenu({ favorite: 1 })[1].on, true, 'it is on'); assert.equal(gameMenu({})[1].on, false);
  assert.equal(gameMenu({ broken: 1 })[3].label, 'Broken', 'the word stays'); assert.equal(gameMenu({ broken: 1 })[3].on, true);
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
  assert.ok(css.includes('.bs-brokenicon') && css.includes('.bs-row.is-broken') && bs.includes('paintBroken(g)'), 'the broken marks');
  assert.ok(bs.includes('Emulation has issues with this game, so it may not run well. Starting it anyway'), 'playing one says so, and still starts it');
  assert.ok(!read('public/bigscreen.css').includes('line-through'), 'a game with issues is not struck out: it can often still be played');
});

test('Big Screen: the bottom bar reminds you to hold Select + Start to close a running game', () => {
  const bs = read('public/bigscreen.js');
  assert.ok(bs.includes('Hold in a game to close it') && bs.includes('bs-closehint'));
});

test('the Library list can be limited to one of your own collections (Big Screen shows a collection as a wheel of full game rows)', async () => {
  const id = Number(db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1) VALUES ((SELECT id FROM platforms WHERE slug = 'snes'), 'Shelf Game', 'shelf game', 'shelf.sfc', 'x', 3, '5e1f000000000000000000000000000000000001')").run().lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1) VALUES ((SELECT id FROM platforms WHERE slug = 'snes'), 'Other Game', 'other game', 'other.sfc', 'x', 3, '5e1f000000000000000000000000000000000002')").run().lastInsertRowid);
  const coll = (await call('/api/collections', { method: 'POST', body: { name: 'Big Screen shelf' } })).body;
  await call(`/api/collections/${coll.id}/roms`, { method: 'POST', body: { rom_ids: [id] } });
  const list = (await call(`/api/roms?collection=${coll.id}`)).body;
  assert.deepEqual(list.items.map((r) => r.id), [id], 'only the games in that collection');
  assert.ok(!list.items.some((r) => r.id === other));
  assert.equal((await call(`/api/roms?collection=${coll.id}`, { as: 'ann' })).body.total, 0, 'a collection is its owner\'s: nobody else sees its games through it');
});

test('Big Screen: the on-screen keyboard moves over its keys, a game has its own background art, the sounds can be muted, the collection chooser and the admin question exist', async () => {
  const { KEYBOARD, kbMove, gameBackdrop, sfx } = await import('../public/bigscreen.js');
  assert.deepEqual(kbMove(0, 0, 'left'), [0, 0]); assert.deepEqual(kbMove(0, 0, 'right'), [0, 1]); assert.deepEqual(kbMove(0, 9, 'right'), [0, 9], 'stays on the row');
  assert.deepEqual(kbMove(0, 0, 'up'), [0, 0]); assert.equal(kbMove(3, 5, 'down')[0], 4, 'down goes to the bottom row');
  const bottom = kbMove(3, 9, 'down'); assert.equal(bottom[0], 4); assert.ok(bottom[1] <= KEYBOARD[4].length - 1, 'the column follows into the shorter row');
  assert.ok(KEYBOARD.flat().includes('done') && KEYBOARD.flat().includes('cancel') && KEYBOARD.flat().includes('back') && KEYBOARD.flat().includes('space'));
  assert.equal(gameBackdrop({ id: 4, media: { fanart: {}, screenshot: {} } }), '/api/roms/4/media/fanart', 'fan art first');
  assert.equal(gameBackdrop({ id: 4, media: { screenshot: {} } }), '/api/roms/4/media/screenshot', 'then a screenshot');
  assert.equal(gameBackdrop({ id: 4, backdrop_url: '/x.png', media: { fanart: {} } }), '/x.png', 'an imported one wins');
  assert.equal(gameBackdrop({ id: 4 }), '', 'none: the cover is blurred instead');
  assert.equal(typeof sfx, 'function'); sfx('move');   // no audio device here: it stays silent and does not throw
  const bs = read('public/bigscreen.js'), pad = read('public/gamepad.js'), css = read('public/bigscreen.css');
  assert.ok(bs.includes("gamesauce_bs_muted") && bs.includes("a === 'menu'") && bs.includes("e.key === 'm'") && bs.includes('id="bs-snd"'), 'Start, M or the speaker switch the sounds');
  assert.ok(pad.includes("edge(BTN.START)") && pad.includes("act: 'menu'"), 'the pad sends Start to Big Screen');
  assert.ok(bs.includes('Hide from everyone') && bs.includes('isAdmin()'), 'an admin is asked before a game is hidden from everyone');
  assert.ok(bs.includes("kind: 'fav'") && bs.includes("kind: 'colls'") && bs.includes('collection: String(s.id)') && bs.includes('New collection'), 'Favourites and Collections tiles, and a new collection from the chooser');
  assert.ok(css.includes('.bs-bgl.on.art') && css.includes('.bs-kbgrid') || css.includes('.bs-key'), 'the styles are there');
});

/* ───────── platform art and the Library's own logos, marquees and backgrounds ───────── */

import zlib from 'node:zlib';
import http from 'node:http';
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const pngChunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
const makePng = (w = 8, h = 8, rgb = [200, 80, 30]) => { const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; } const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]); };

test('Platform art from a folder: a Platforms folder inside a listed artwork folder gives each platform (and family) its logo; gaps only unless replace; only listed folders; admins only', async () => {
  const art = path.join(TMP, 'artfolder'); const plat = path.join(art, 'Platforms'); fs.mkdirSync(plat, { recursive: true });
  fs.writeFileSync(path.join(plat, 'PlayStation 2.png'), makePng()); fs.writeFileSync(path.join(plat, 'ps1-logo.png'), makePng(9, 9)); fs.writeFileSync(path.join(plat, 'Sony.png'), makePng(10, 10));
  fs.writeFileSync(path.join(plat, 'Nonsense Machine.png'), makePng()); fs.writeFileSync(path.join(plat, 'readme.txt'), 'not a picture');
  assert.equal((await call('/api/art/folders', { method: 'PUT', body: { folders: [art] } })).status, 200);
  assert.equal((await call('/api/art/platform-logos/import', { method: 'POST', body: { folder: path.join(TMP, 'elsewhere') } })).status, 400, 'only a listed folder');
  assert.equal((await call('/api/art/platform-logos/import', { method: 'POST', as: 'ann', body: { folder: art } })).status, 403, 'admins only');
  const r = (await call('/api/art/platform-logos/import', { method: 'POST', body: { folder: art } })).body;
  assert.deepEqual([...r.saved].sort(), ['ps1', 'ps2']); assert.deepEqual(r.families, ['Sony']); assert.deepEqual(r.unmatched, ['Nonsense Machine.png']); assert.equal(r.files, 4);
  const logo = await fetch(`${base}/api/platforms/ps2/logo`, { headers: { Authorization: 'Bearer ' + tok.admin } }); assert.equal(logo.status, 200); assert.match(logo.headers.get('content-type'), /png/);
  assert.equal((await fetch(`${base}/api/platforms/families/logo?family=Sony`, { headers: { Authorization: 'Bearer ' + tok.admin } })).status, 200);
  const again = (await call('/api/art/platform-logos/import', { method: 'POST', body: { folder: art } })).body;
  assert.deepEqual(again.saved, [], 'gaps only'); assert.deepEqual([...again.had].sort(), ['ps1', 'ps2']);
  assert.deepEqual([...(await call('/api/art/platform-logos/import', { method: 'POST', body: { folder: art, replace: true } })).body.saved].sort(), ['ps1', 'ps2'], 'replace on request');
  assert.ok((await call('/api/platforms')).body.items.find((p) => p.slug === 'ps2').logo_v, 'the platform list says it has a logo');
});

test('Platform art from ScreenScraper: a platform with no logo gets the clean logo its system has; the others are left alone', async () => {
  const logoPng = makePng(12, 12, [10, 120, 200]);
  const fake = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/ss/systemesListe.php') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ response: { systemes: [{ id: 3, noms: { nom_eu: 'NES' }, medias: [{ type: 'wheel', url: `http://127.0.0.1:${fake.address().port}/img/nes.png?devid=a&devpassword=b&ssid=c&sspassword=d`, region: 'wor' }, { type: 'photo', url: 'http://127.0.0.1:1/never.png' }] }, { id: 4, noms: { nom_eu: 'SNES' }, medias: [{ type: 'fanart', url: 'http://127.0.0.1:1/never2.png' }] }] } })); }
    if (u.pathname.startsWith('/img/')) { res.setHeader('Content-Type', 'image/png'); return res.end(logoPng); }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const keep = { b: process.env.SS_API_BASE, i: process.env.SS_MIN_INTERVAL_MS, ...Object.fromEntries(['SS_DEV_ID', 'SS_DEV_PASSWORD', 'SS_USER', 'SS_PASSWORD'].map((k) => [k, process.env[k]])) };
  process.env.SS_API_BASE = `http://127.0.0.1:${fake.address().port}/ss`; process.env.SS_MIN_INTERVAL_MS = '1';
  Object.assign(process.env, { SS_DEV_ID: 'devid', SS_DEV_PASSWORD: 'devpw', SS_USER: 'user', SS_PASSWORD: 'pw' });
  try {
    db.prepare("UPDATE platforms SET screenscraper_id = 3 WHERE slug = 'nes'").run(); db.prepare("UPDATE platforms SET screenscraper_id = 4 WHERE slug = 'snes'").run();
    db.prepare("DELETE FROM platform_logos WHERE slug IN ('nes', 'snes')").run();
    assert.equal((await call('/api/art/platform-logos/fetch', { method: 'POST', as: 'ann', body: {} })).status, 403, 'admins only');
    const r = (await call('/api/art/platform-logos/fetch', { method: 'POST', body: {} })).body;
    assert.ok(r.got.includes('nes'), 'NES got its logo (the "wheel" picture)'); assert.ok(r.none.includes('snes'), 'SNES has no logo picture: it is listed, not guessed');
    assert.ok(db.prepare("SELECT 1 FROM platform_logos WHERE slug = 'nes'").get() && !db.prepare("SELECT 1 FROM platform_logos WHERE slug = 'snes'").get());
    const ps2Before = db.prepare("SELECT updated FROM platform_logos WHERE slug = 'ps2'").get().updated;
    await call('/api/art/platform-logos/fetch', { method: 'POST', body: {} });
    assert.equal(db.prepare("SELECT updated FROM platform_logos WHERE slug = 'ps2'").get().updated, ps2Before, 'a logo that is there is left alone');
  } finally {
    for (const [k, v] of Object.entries({ SS_API_BASE: keep.b, SS_MIN_INTERVAL_MS: keep.i, SS_DEV_ID: keep.SS_DEV_ID, SS_DEV_PASSWORD: keep.SS_DEV_PASSWORD, SS_USER: keep.SS_USER, SS_PASSWORD: keep.SS_PASSWORD })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise((r) => fake.close(r));
  }
});

test('Game logos, marquees and backgrounds: the importer reads them for Library games, they come back on the list as logo_url, marquee_url and backdrop_url, and Find assets asks for them', async () => {
  const { classify } = await import('../src/lib/artimport.js');
  assert.equal(classify(['arcade', 'logos'], 'sf2.png').kind, 'logo'); assert.equal(classify(['arcade', 'wheel'], 'sf2.png').kind, 'logo');
  assert.equal(classify(['arcade', 'marquees'], 'sf2.png').kind, 'marquee'); assert.equal(classify(['arcade', 'fanart'], 'sf2.png').kind, 'fanart');
  const { setRomFile, ROM_FILE_KINDS } = await import('../src/lib/romfiles.js');
  assert.ok(['logo', 'marquee', 'fanart'].every((k) => ROM_FILE_KINDS.includes(k)));
  const id = Number(db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1) VALUES ((SELECT id FROM platforms WHERE slug = 'arcade'), 'Street Fighter II', 'street fighter ii', 'sf2.zip', 'x', 3, 'af00000000000000000000000000000000000001')").run().lastInsertRowid);
  const before = (await call('/api/roms?q=Street+Fighter')).body.items.find((r) => r.id === id);
  assert.ok(!before.logo_url && !before.marquee_url && !before.backdrop_url, 'none to begin with');
  setRomFile(id, 'logo', makePng(20, 8)); setRomFile(id, 'marquee', makePng(40, 8)); setRomFile(id, 'fanart', makePng(32, 18));
  const row = (await call('/api/roms?q=Street+Fighter')).body.items.find((r) => r.id === id);
  assert.equal(row.logo_url, `/api/roms/${id}/file/logo`); assert.equal(row.marquee_url, `/api/roms/${id}/file/marquee`); assert.equal(row.backdrop_url, `/api/roms/${id}/file/fanart`);
  assert.equal((await fetch(`${base}${row.logo_url}`, { headers: { Authorization: 'Bearer ' + tok.admin } })).status, 200, 'and the file is served');
  const assets = read('src/lib/assets.js'), prov = read('src/lib/providers.js');
  assert.ok(assets.includes("kinds: ['cover', 'spine', 'disc', 'back', 'manual', 'logo', 'marquee', 'fanart']") && prov.includes("logo: 'wheel', marquee: 'screenmarquee', fanart: 'fanart'"), 'Find assets asks ScreenScraper for the logo (wheel), the marquee and the fan art');
  const { gameLogo, gameMarquee, gameBackdrop } = await import('../public/bigscreen.js');
  assert.equal(gameLogo(row), row.logo_url); assert.equal(gameMarquee(row), row.marquee_url); assert.equal(gameBackdrop(row), row.backdrop_url, 'Big Screen shows an imported one first');
});

test('Big Screen: the video on the game page stops when a game is started (emulator or browser player) or the window loses focus, and carries on when it is back', () => {
  const bs = read('public/bigscreen.js');
  assert.ok(bs.includes('const pauseVideo = ()') && bs.includes('const resumeVideo = ()'));
  assert.ok(/const playLocal = async \(g\) => \{[\s\S]*?pauseVideo\(\);/.test(bs) && /const openBrowser = \(g\) => \{[^\n]*pauseVideo\(\)/.test(bs), 'both ways of starting a game pause it');
  assert.ok(bs.includes("window.addEventListener('blur', pauseVideo)") && bs.includes("window.addEventListener('focus', resumeVideo)") && bs.includes("window.removeEventListener('blur', pauseVideo)"), 'a window that is not in front is silent, and the listeners are removed on close');
});

test('The launcher\'s setup page lists every platform the server has (a platform added in Settings > Platforms, or one newer than the launcher), without using up its sync token; with no server it uses the shipped list', async () => {
  const added = await call('/api/platforms', { method: 'POST', body: { slug: 'zzconsole', name: 'ZZ Console', family: 'Others' } });
  assert.equal(added.status, 201);
  const minted = (await call('/api/launcher/sync-token', { method: 'POST', body: {} })).body;
  assert.ok(minted.token);
  assert.equal((await fetch(`${base}/api/launcher/platforms?token=nonsense-nonsense-nonsense-123`)).status, 404, 'a token that is not good lists nothing');
  const { startConfigServer, platformsWithServer, platformList } = await import('../launcher/configure.mjs');
  const file = path.join(TMP, 'launcher-setup.json');
  const s = await startConfigServer({ configFile: file, open: false, syncToken: { server: base, token: minted.token } });
  try {
    const cfg = await (await fetch(`http://127.0.0.1:${s.port}/api/config`, { headers: { 'x-key': s.key } })).json();
    const slugs = cfg.platforms.map((p) => p.slug);
    assert.ok(slugs.includes('zzconsole'), 'the platform added on the server is listed'); assert.ok(slugs.includes('xbla'), 'and the ones the launcher shipped with');
    assert.equal(new Set(slugs).size, slugs.length, 'each only once');
    const sync = await fetch(`${base}/api/launcher/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: minted.token, platforms: ['zzconsole'] }) });
    assert.equal(sync.status, 200, 'the token was not used up by listing the platforms: it still reports the choices');
  } finally { s.close(); }
  assert.deepEqual((await platformsWithServer({ server: 'http://127.0.0.1:1', token: 'x'.repeat(30) }, async () => { throw new Error('down'); })).map((p) => p.slug), platformList().map((p) => p.slug), 'no server: the shipped list');
  assert.deepEqual((await platformsWithServer(null)).map((p) => p.slug), platformList().map((p) => p.slug), 'opened without a server: the shipped list');
});

test('Fill the gaps: a run asks about the games of one platform that lack a logo, marquee or background (up to the limit), keeps only those kinds, remembers who it asked, stops on the day\'s allowance, and is for admins', async () => {
  const { fillCandidates, startFill, stopFill, fillJob, FILL_KINDS } = await import('../src/lib/assets.js');
  const { setRomFile } = await import('../src/lib/romfiles.js');
  const mk = (title, sha) => Number(db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1) VALUES ((SELECT id FROM platforms WHERE slug = 'gamegear'), ?, ?, ?, 'x', 3, ?)").run(title, title.toLowerCase(), `${title}.gg`, sha).lastInsertRowid);
  const a = mk('Alpha', 'f1100000000000000000000000000000000000a1'), b = mk('Bravo', 'f1100000000000000000000000000000000000b2'), c = mk('Charlie', 'f1100000000000000000000000000000000000c3'), d = mk('Delta', 'f1100000000000000000000000000000000000d4'), e = mk('Echo', 'f1100000000000000000000000000000000000e5');
  for (const k of FILL_KINDS) setRomFile(b, k, makePng());                          // Bravo has all three of its own
  const pic = path.join(TMP, 'matched.png'); fs.writeFileSync(pic, makePng());
  db.prepare('UPDATE roms SET provider_media = ? WHERE id = ?').run(JSON.stringify({ wheel: { path: pic }, marquee: { path: pic }, fanart: { path: pic } }), c);   // Charlie's match kept them
  assert.deepEqual(fillCandidates('gamegear', 10), [a, d, e], 'only the games missing something');
  assert.deepEqual(fillCandidates('gamegear', 2), [a, d], 'at most the limit');
  const keep = Object.fromEntries(['SS_DEV_ID', 'SS_DEV_PASSWORD', 'SS_USER', 'SS_PASSWORD'].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { SS_DEV_ID: 'devid', SS_DEV_PASSWORD: 'devpw', SS_USER: 'user', SS_PASSWORD: 'pw' });
  const wait = async () => { for (let i = 0; i < 200 && fillJob.running; i++) await new Promise((r) => setTimeout(r, 20)); };
  try {
    const asked = [];
    startFill({ platform: 'gamegear', limit: 2, userId: 1, ask: async (x) => { asked.push(x); return x.id === a ? { got: ['logo', 'fanart'], errors: {}, results: {} } : { got: [], errors: {}, results: {} }; } });
    await wait();
    assert.deepEqual(asked.map((x) => x.id), [a, d]); assert.ok(asked.every((x) => x.skipVideo === true && x.only.join() === 'logo,marquee,fanart'), 'only the three small kinds, no video');
    assert.equal(fillJob.games_filled, 1); assert.deepEqual(fillJob.got, { logo: 1, marquee: 0, fanart: 1 }); assert.equal(fillJob.none, 1); assert.match(fillJob.message, /^Done/);
    assert.deepEqual(fillCandidates('gamegear', 10), [e], 'the two it asked about are left for two weeks');
    startFill({ platform: 'gamegear', limit: 5, userId: 1, ask: async () => ({ got: [], errors: {}, results: {}, why: "ScreenScraper's allowance for today is used up" }) });
    await wait();
    assert.match(fillJob.message, /allowance for today is used up/); assert.equal(fillJob.done, 1, 'it stopped on the allowance');
    assert.deepEqual(fillCandidates('gamegear', 10), [], 'and that game was marked too');
    startFill({ platform: 'gamegear', limit: 5, userId: 1, ask: async () => ({ got: [], errors: {} }) });
    await wait(); assert.match(fillJob.message, /Nothing to do/);
    assert.equal(typeof stopFill, 'function');
  } finally { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  assert.equal((await call('/api/art/fill-job', { method: 'POST', as: 'ann', body: { platform: 'gamegear' } })).status, 403, 'admins only');
  assert.equal((await call('/api/art/fill-job', { method: 'POST', body: { platform: 'nonesuch' } })).status, 404, 'a platform that exists');
  assert.equal((await call('/api/art/fill-job', { method: 'POST', body: { platform: 'gamegear' } })).status, 400, 'ScreenScraper has to be set up');
  assert.equal((await call('/api/art/fill-job')).status, 200);
  const ui = read('public/app.js'), html = read('public/index.html');
  assert.ok(html.includes('class="plat-art-box" id="plat-art"') && !html.includes('class="panel" id="plat-art"'), 'the box must not carry the panel class: Settings hides every panel except the open page, which hid it');
  assert.ok(html.includes('id="plat-fill-go"') && html.includes('id="plat-fill-limit"') && ui.includes("'/art/fill-job'"), 'the button and its progress are in Settings > Platforms');
});

test('Settings > Platforms: the Platform art box comes before the + Add platform button', () => {
  const html = read('public/index.html');
  assert.ok(html.indexOf('id="plat-art"') < html.indexOf('id="platform-add-toggle"') && html.indexOf('id="platform-add-toggle"') < html.indexOf('id="platform-add-form"'), 'art box, then the add button, then its form');
});

test('Big Screen: Favourites and Collections are a row of their own below the platforms, with art (heart, stack of cases, cover mosaic), and up / down move between the rows', () => {
  const bs = read('public/bigscreen.js'), css = read('public/bigscreen.css');
  assert.ok(bs.includes('const extraItems = ()') && bs.includes('id="bs-rw1"') && bs.includes('const switchRow = (r)'), 'a second row');
  assert.ok(bs.includes("(a === 'up' || a === 'down') && st.level === 0"), 'up and down move between the rows');
  assert.ok(bs.includes('const HEART =') && bs.includes('const STACK =') && bs.includes('const mosaic = (covers)'), 'artwork for the tiles');
  assert.ok(css.includes('.bs-t-fav {') && css.includes('.bs-t-colls') && css.includes('.bs-mosaic') && css.includes('.bs-main.two .bs-railwrap.r2'), 'and its styles');
});

test('Big Screen: a row of tiles that fits on the screen is centred as a whole, and the Favourites and Collections row has room between its tiles', () => {
  const bs = read('public/bigscreen.js'), css = read('public/bigscreen.css');
  assert.ok(bs.includes('total > 0 && total <= w ? (w - total) / 2'), 'a row that fits is centred whole; a longer one keeps the chosen tile in the middle');
  assert.ok(css.includes('.bs-railwrap.r2 .bs-rail { gap: 2.2em; }') && css.includes('.bs-railwrap.r2 .bs-ptile.on { transform: scale(1.06); }'), 'room between the two, and the chosen one does not grow into its neighbour');
});

test('Big Screen: the wheel shows a game\'s marquee on every platform (else its logo, else the cover); a game with a manual gets Read Manual, read on the right of the game page', async () => {
  const { wheelArt, gameMenu } = await import('../public/bigscreen.js');
  assert.equal(wheelArt({ id: 3, platform: 'snes', marquee_url: '/m.png', logo_url: '/l.png' }), '/m.png', 'a marquee first, on any platform');
  assert.equal(wheelArt({ id: 3, platform: 'arcade', logo_url: '/l.png' }), '/l.png', 'else the logo');
  assert.equal(wheelArt({ id: 3, platform: 'ps2' }), '', 'else nothing: the cover is shown');
  assert.equal(wheelArt({ id: 3, logo_url: '/l.png', media: { marquee: {}, wheel: {} } }), '/l.png', "your own logo beats ScreenScraper's marquee");
  assert.equal(wheelArt({ id: 3, media: { marquee: {} } }), '/api/roms/3/media/marquee', 'a ScreenScraper match\'s marquee counts too');
  assert.deepEqual(gameMenu({}).map((m) => m.k), ['play', 'fav', 'coll', 'broken', 'hide'], 'no manual: no menu item');
  assert.deepEqual(gameMenu({ manual_url: '/m.pdf' }).map((m) => m.k), ['play', 'fav', 'coll', 'manual', 'broken', 'hide']);
  assert.equal(gameMenu({ manual_url: '/m.pdf' })[3].label, 'Read Manual');
  const { setRomFile } = await import('../src/lib/romfiles.js');
  const id = Number(db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1) VALUES ((SELECT id FROM platforms WHERE slug = 'snes'), 'Manual Game', 'manual game', 'manual.sfc', 'x', 3, 'ac00000000000000000000000000000000000001')").run().lastInsertRowid);
  assert.ok(!(await call('/api/roms?q=Manual+Game')).body.items.find((r) => r.id === id).manual_url, 'none to begin with');
  setRomFile(id, 'manual', Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n'), 'Manual.pdf');
  const row = (await call('/api/roms?q=Manual+Game')).body.items.find((r) => r.id === id);
  assert.equal(row.manual_url, `/api/roms/${id}/file/manual`); assert.equal(row.manual_type, 'application/pdf', 'the list says a manual is there and what it is');
  const bs = read('public/bigscreen.js'), css = read('public/bigscreen.css');
  assert.ok(bs.includes('<section class="bs-manpane" id="bs-man" hidden>') && bs.includes("classList.add('reading')") && bs.includes("import('./pdfview.js')"), 'the manual goes in a pane on the right, drawn by the app\'s own reader');
  assert.ok(css.includes('.bs-game.reading .bs-info { display: none; }') && css.includes('.bs-manpane { grid-column: 3;'), 'in place of the details');
  assert.ok(bs.includes("manualKey('PageUp')") && bs.includes("manualKey('+')") && bs.includes('closeManual()'), 'LB/RB page, left/right zoom, B closes');
});

test('Big Screen: Favourite is a toggle: its word turns gold when on, and a gold star shows above the cover', () => {
  const bs = read('public/bigscreen.js'), css = read('public/bigscreen.css');
  assert.ok(bs.includes('class="bs-favstar') && bs.includes("classList.toggle('fav-on'") && bs.includes("$('.bs-favstar')?.classList.toggle('on'"), 'the star and the colour follow the toggle');
  assert.ok(css.includes('.bs-mi.fav-on { color: #f5c542; }') && css.includes('.bs-favstar.on'), 'gold');
});

test('Big Screen: Broken is a toggle: its word turns red when on, with a red crossed-out controller above the cover (beside the star)', () => {
  const bs = read('public/bigscreen.js'), css = read('public/bigscreen.css');
  assert.ok(bs.includes('class="bs-badges"') && bs.includes('class="bs-brokenicon"') && bs.includes("b.classList.toggle('broken-on'"), 'the icon and the colour');
  assert.ok(css.includes('.bs-mi.broken-on { color: #ff6b6b; }') && css.includes('.bs-game.is-broken .bs-brokenicon'), 'red, shown when the game is marked');
});

test('Big Screen: the advisory on the right of a game marked as broken reads "Emulation has issues"', () => {
  const bs = read('public/bigscreen.js');
  assert.equal((bs.match(/<em class="bs-flag">Emulation has issues<\/em>/g) || []).length, 2, 'on the page and when it is toggled');
  assert.ok(!bs.includes('the emulator cannot run it</em>'));
});

test('Big Screen: a favourite shows a gold star just left of its title on the wheel (not on the Favourites wheel)', () => {
  const bs = read('public/bigscreen.js'), css = read('public/bigscreen.css');
  assert.ok(bs.includes("g.favorite && st.src?.kind !== 'fav'") && bs.includes('class="bs-favmark"'), 'the star, in the title text before the first word');
  assert.ok(css.includes('.bs-favmark { display: inline-block; margin-right: .3em; color: #f5c542;'), 'gold, with a gap before the title');
});

/* ───────── multi-disc sets ───────── */

test('Multi-disc sets: a file name that says Disc / Disk / CD (or an .m3u playlist) marks a game as part of a set; "Disc 1 of 1", CD32 and a title that merely says Disc do not', async () => {
  const { detectMultiDisc, isMultiDisc } = await import('../src/lib/multidisc.js');
  for (const n of ['Final Fantasy VII (USA) (Disc 1).cue', 'Final Fantasy VII (USA) (Disc 2 of 3).chd', 'Policenauts [CD2].iso', 'Phantasmagoria - Disc 2.iso', 'Game (Disk A).adf', 'Game (Disc 3).bin', 'Final Fantasy VII.m3u']) assert.equal(detectMultiDisc(n), true, n);
  for (const n of ['Game (Disc 1 of 1).iso', 'Alien Breed (CD32).iso', 'Disc World (USA).iso', 'Plain Game.sfc', 'Disco Elysium.iso', 'Game (USA).chd', '']) assert.equal(detectMultiDisc(n), false, n || '(empty)');
  assert.equal(isMultiDisc({ filename: 'Game (Disc 1).cue', multidisc_override: 0 }), false, 'an admin saying no wins');
  assert.equal(isMultiDisc({ filename: 'Plain.iso', multidisc_override: 1 }), true, 'and saying yes');
  assert.equal(isMultiDisc({ filename: 'Game (Disc 1).cue', multidisc_override: null }), true, 'no setting: the name decides');
});

test('Multi-disc sets: the list says which games are one, Play on this PC is refused for them (with the reason), an admin can say yes or no by hand, and the platform list counts them', async () => {
  const real = path.join(TMP, 'disc-test.iso'); fs.writeFileSync(real, 'x');
  const mk = (title, filename, sha) => Number(db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1) VALUES ((SELECT id FROM platforms WHERE slug = 'saturn'), ?, ?, ?, ?, 1, ?)").run(title, title.toLowerCase(), filename, real, sha).lastInsertRowid);
  const set1 = mk('Set Game Disc 1', 'Set Game (Disc 1).iso', 'd150000000000000000000000000000000000001'), set2 = mk('Set Game Disc 2', 'Set Game (Disc 2).iso', 'd150000000000000000000000000000000000002'), single = mk('Single Disc Game', 'Single Disc Game.iso', 'd150000000000000000000000000000000000003');
  const row = async (id) => (await call('/api/roms?q=Game&limit=50')).body.items.find((r) => r.id === id);
  assert.equal((await row(set1)).multidisc, 1); assert.equal((await row(set2)).multidisc, 1); assert.equal((await row(single)).multidisc, 0);
  assert.equal((await call(`/api/roms/${set1}`)).body.multidisc, 1, 'in the details too');
  const refused = await call(`/api/roms/${set1}/launch`, { method: 'POST' });
  assert.equal(refused.status, 409); assert.match(refused.body.error, /multi-disc set/); assert.equal(refused.body.multidisc, true);
  assert.equal((await call(`/api/roms/${single}/launch`, { method: 'POST' })).status, 200, 'a single disc still starts');
  assert.equal((await call(`/api/roms/${set1}/multidisc`, { method: 'POST', as: 'ann', body: { value: false } })).status, 403, 'admins only');
  assert.equal((await call(`/api/roms/${set1}/multidisc`, { method: 'POST', body: { value: 'maybe' } })).status, 400);
  const no = (await call(`/api/roms/${set1}/multidisc`, { method: 'POST', body: { value: false } })).body;
  assert.deepEqual([no.multidisc_override, no.multidisc], [0, 0]); assert.equal((await call(`/api/roms/${set1}/launch`, { method: 'POST' })).status, 200, 'said not a set: it starts');
  const yes = (await call(`/api/roms/${single}/multidisc`, { method: 'POST', body: { value: true } })).body; assert.deepEqual([yes.multidisc_override, yes.multidisc], [1, 1]);
  assert.equal((await call(`/api/roms/${single}/launch`, { method: 'POST' })).status, 409, 'said a set: refused');
  const back = (await call(`/api/roms/${single}/multidisc`, { method: 'POST', body: { value: null } })).body; assert.deepEqual([back.multidisc_override, back.multidisc], [null, 0], 'null: the name decides again');
  const bulk = (await call('/api/roms/bulk/multidisc', { method: 'POST', body: { ids: [set1, set2], value: null } })).body; assert.equal(bulk.changed, 2);
  assert.equal((await call('/api/roms/bulk/multidisc', { method: 'POST', as: 'ann', body: { ids: [set1], value: true } })).status, 403); assert.equal((await call('/api/roms/bulk/multidisc', { method: 'POST', body: { ids: [], value: true } })).status, 400);
  assert.equal((await row(set1)).multidisc, 1, 'set by name again');
  assert.ok((await call('/api/platforms')).body.items.find((p) => p.slug === 'saturn').multidisc_count >= 2, 'the platform list counts the sets');
});

test('Multi-disc sets: a badge on the tile, the reason in the details, an admin control, a bulk button, and the Carousel and Big Screen leave them out', () => {
  const app = read('public/app.js'), html = read('public/index.html'), car = read('public/carousel.js'), bs = read('public/bigscreen.js');
  assert.ok(app.includes('class="card-md"') && read('public/styles.css').includes('.card-md {'), 'a badge on the line under the title');
  assert.ok(app.includes('if (rom.multidisc) { toast(') && app.includes('data-act="multidisc"') && app.includes("'/roms/bulk/multidisc'") && app.includes('class="hint md-note"'), 'the details say why, an admin can flip it');
  assert.ok(html.includes('id="bulk-md-btn"') && app.includes("addEventListener('click', bulkMultiDiscSelected)"), 'a bulk button');
  assert.ok(car.includes('!g.missing && !g.multidisc'), 'the Carousel leaves them out');
  assert.ok(bs.includes('!g.missing && !g.multidisc') && bs.includes('p.multidisc_count') && bs.includes('&& !g.multidisc && (g.playable'), 'Big Screen leaves them out of its lists and counts');
});

test('Storage clean-up: files nothing points at are found and cleared; used and fresh ones, and ROMs, are kept', async () => {
  const crypto = await import('node:crypto');
  const root = path.resolve(process.env.GAMESAUCE_STORAGE_DIR);
  const old = (rel, size = 10) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(size, 1)); const t = new Date(Date.now() - 3600e3); fs.utimesSync(f, t, t); return f; };
  const url = 'https://media.example/box.png', hash = crypto.createHash('sha1').update(url).digest('hex');
  const usedCover = old('covers/usedcover.jpg'), lostCover = old('covers/lostcover.jpg', 50);
  const usedMedia = old(`media/box2d-${hash}.png`), lostMedia = old('media/box2d-' + 'a'.repeat(40) + '.png', 70);
  const rom = path.join(root, 'roms', 'snes', 'ab', 'keep.sfc'); fs.mkdirSync(path.dirname(rom), { recursive: true }); fs.writeFileSync(rom, 'rom'); fs.utimesSync(rom, new Date(0), new Date(0));
  const id = Number(db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1, cover_path, provider_media) VALUES ((SELECT id FROM platforms WHERE slug = 'snes'), 'Clean Game', 'clean game', 'clean.sfc', ?, 3, 'c1ea000000000000000000000000000000000001', ?, ?)").run(rom, usedCover, JSON.stringify({ box2d: url })).lastInsertRowid);
  const usedFile = old(`rom-files/${id}/logo.png`), lostFile = old('rom-files/99999/logo.png', 30);
  db.prepare('INSERT INTO rom_files (rom_id, kind, path, name, type, bytes) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'logo', usedFile, 'logo.png', 'image/png', 10);
  db.prepare('INSERT INTO rom_files (rom_id, kind, path, name, type, bytes) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'marquee', path.join(root, 'rom-files', String(id), 'gone.png'), 'gone.png', 'image/png', 10);
  const fresh = path.join(root, 'covers', 'fresh.jpg'); fs.writeFileSync(fresh, 'x');
  const scan = await call('/api/admin/storage/unused');
  assert.equal(scan.status, 200);
  assert.equal(scan.body.total_files, 3, 'the lost cover, the lost media picture and the lost game file');
  assert.equal(scan.body.total_bytes, 150);
  assert.equal(scan.body.broken_records, 1, 'a record whose file is gone');
  assert.equal((await call('/api/admin/storage/unused', { as: 'ann' })).status, 403);
  assert.equal((await call('/api/admin/storage/clear', { method: 'POST', as: 'ann', body: {} })).status, 403);
  assert.ok(fs.existsSync(lostCover), 'the scan deletes nothing');
  const done = await call('/api/admin/storage/clear', { method: 'POST', body: {} });
  assert.equal(done.body.removed, 3); assert.equal(done.body.records, 1);
  for (const f of [lostCover, lostMedia, lostFile]) assert.ok(!fs.existsSync(f), f);
  for (const f of [usedCover, usedMedia, usedFile, fresh, rom]) assert.ok(fs.existsSync(f), f);
  assert.ok(!fs.existsSync(path.join(root, 'rom-files', '99999')), 'the emptied folder is tidied');
  assert.equal((await call('/api/admin/storage/unused')).body.total_files, 0);
});
