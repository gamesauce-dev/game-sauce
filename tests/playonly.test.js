import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-playonly-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'padmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'p-admin-password-1';

let server, base, db, adminTok, playTok, fullTok, ids = {}, userIds = {};
const call = async (p, { token = adminTok, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (u, p) => (await call('/api/auth/login', { token: null, method: 'POST', body: { username: u, password: p } })).body.token;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('padmin', 'p-admin-password-1');
  for (const [n, pw] of [['pplayer', 'p-player-pass-12'], ['pfull', 'p-full-pass-123']]) {
    userIds[n] = (await call('/api/auth/users', { method: 'POST', body: { username: n, password: pw, role: 'user' } })).body.id;
  }
  const file = path.join(TMP, 'x.rom'); fs.writeFileSync(file, 'rom');
  const ins = (slug, title, sha, extra = {}) => Number(db.prepare(`INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1, release_year, play_override, missing)
    VALUES ((SELECT id FROM platforms WHERE slug = ?), ?, ?, ?, ?, 3, ?, ?, ?, ?)`).run(slug, title, title.toLowerCase(), `${title}.rom`, file, sha, extra.year ?? null, extra.override ?? null, extra.missing ?? 0).lastInsertRowid);
  ids.snes = ins('snes', 'Snes Game', 'po01'); ids.ps2 = ins('ps2', 'Ps2 Game', 'po02');
  ids.forcedOff = ins('nes', 'Forced Off', 'po03', { override: 0 }); ids.mameOld = ins('mame', 'Old Mame', 'po04', { year: 1982 });
  ids.mameNew = ins('mame', 'New Mame', 'po05', { year: 2005 }); ids.mameForced = ins('mame', 'Forced Mame', 'po06', { year: 2005, override: 1 });
  ids.gone = ins('gba', 'Missing Gba', 'po07', { missing: 1 });
  await call(`/api/auth/users/${userIds.pplayer}`, { method: 'PATCH', body: { mode: 'play' } });
  playTok = await login('pplayer', 'p-player-pass-12');
  fullTok = await login('pfull', 'p-full-pass-123');
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('the admin sets the mode per person, and only for members', async () => {
  const users = (await call('/api/auth/users')).body.items;
  assert.equal(users.find((u) => u.username === 'pplayer').mode, 'play');
  assert.equal(users.find((u) => u.username === 'pfull').mode, 'full');
  assert.equal((await call(`/api/auth/users/${userIds.pplayer}`, { token: playTok, method: 'PATCH', body: { mode: 'full' } })).status, 403, 'a play-only person cannot lift their own limit');
  assert.equal((await call(`/api/auth/users/${userIds.pfull}`, { method: 'PATCH', body: { mode: 'banana' } })).status, 400);
  const adminId = users.find((u) => u.username === 'padmin').id;
  assert.equal((await call(`/api/auth/users/${adminId}`, { method: 'PATCH', body: { mode: 'play' } })).status, 400, 'an admin always has the full screen');
});

test('/me tells the app which screen to show', async () => {
  assert.equal((await call('/api/auth/me', { token: playTok })).body.user.play_only, true);
  assert.equal((await call('/api/auth/me', { token: fullTok })).body.user.play_only, false);
  assert.equal((await call('/api/auth/me')).body.user.play_only, false);
});

test('a play-only person can pick, open and play, and nothing else', async () => {
  const t = playTok;
  assert.equal((await call('/api/roms?limit=10', { token: t })).status, 200);
  assert.equal((await call(`/api/roms/${ids.snes}`, { token: t })).status, 200);
  assert.equal((await call(`/api/roms/${ids.snes}/play/x.rom`, { token: t })).status, 200, 'playing');
  assert.equal((await call(`/api/roms/${ids.snes}/favorite`, { token: t, method: 'POST', body: {} })).status, 200, 'favourites');
  // refused
  assert.equal((await call(`/api/roms/${ids.snes}/download`, { token: t })).status, 403, 'downloading');
  assert.equal((await call('/api/collections', { token: t })).status, 403);
  assert.equal((await call('/api/sources', { token: t })).status, 403);
  assert.equal((await call('/api/emulators/guide', { token: t })).status, 403);
  assert.equal((await call('/api/metadata/providers', { token: t })).status, 403);
  assert.equal((await call(`/api/roms/${ids.snes}`, { token: t, method: 'PATCH', body: { title: 'Hacked' } })).status, 403, 'editing');
  assert.equal((await call(`/api/roms/${ids.snes}`, { token: t, method: 'DELETE' })).status, 403, 'deleting');
  assert.equal((await call(`/api/roms/${ids.snes}/hide`, { token: t, method: 'POST', body: {} })).status, 403);
  assert.equal((await call('/api/roms/bulk/enrich', { token: t, method: 'POST', body: { ids: [ids.snes] } })).status, 403);
  assert.equal((await call('/api/auth/users', { token: t })).status, 403, 'the user list (admin only anyway)');
  assert.equal(db.prepare('SELECT title FROM roms WHERE id = ?').get(ids.snes).title, 'Snes Game');
});

test('their own account tools still work: password, sessions, picture, welcome tour', async () => {
  assert.equal((await call('/api/auth/sessions', { token: playTok })).status, 200);
  assert.equal((await call('/api/auth/welcomed', { token: playTok, method: 'POST', body: { done: true } })).status, 200);
  assert.equal((await call('/api/auth/password', { token: playTok, method: 'POST', body: { current_password: 'wrong', new_password: 'whatever-123' } })).status, 401, 'reaches the password check (wrong password), so it is not blocked by the allow-list');
});

test('a full account is unchanged', async () => {
  assert.equal((await call('/api/collections', { token: fullTok })).status, 200);
  assert.equal((await call('/api/emulators/guide', { token: fullTok })).status, 200);
});

test('playable=1 lists only what the Play button would offer', async () => {
  const titles = (await call('/api/roms?limit=50&playable=1', { token: playTok })).body.items.map((i) => i.title).sort();
  assert.deepEqual(titles, ['Forced Mame', 'Old Mame', 'Snes Game'], 'no PS2 (no core), no forced-off, no MAME after the cut-off unless forced on, none missing');
  assert.equal((await call('/api/roms?limit=50&playable=1&q=snes', { token: playTok })).body.total, 1, 'search stays inside the playable games');
  assert.equal((await call('/api/roms?limit=50&playable=1', { token: playTok })).body.items.every((i) => i.playable), true);
});

test('a play-only person sees the logos and game art that Big Screen draws, and no other files', async () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
  const family = db.prepare("SELECT family FROM platforms WHERE slug = 'snes'").get().family;
  for (const [url, fields] of [['/api/platforms/snes/logo', {}], ['/api/platforms/families/logo', { family }]]) {
    const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v); fd.append('logo', new Blob([PNG], { type: 'image/png' }), 'l.png');
    assert.equal((await fetch(base + url, { method: 'POST', headers: { Authorization: `Bearer ${adminTok}` }, body: fd })).status, 200, url);
  }
  const { setRomFile } = await import('../src/lib/romfiles.js');
  for (const id of [ids.snes, ids.ps2]) for (const kind of ['logo', 'marquee', 'fanart', 'spine', 'disc', 'back']) setRomFile(id, kind, PNG);
  setRomFile(ids.snes, 'manual', Buffer.from('%PDF-1.4 a manual'), 'm.pdf');
  const status = async (url) => (await fetch(base + url, { headers: { Authorization: `Bearer ${playTok}` } })).status;

  const logos = ['/api/platforms/snes/logo?v=1', `/api/platforms/families/logo?family=${encodeURIComponent(family)}&v=1`, ...['logo', 'marquee', 'fanart'].map((k) => `/api/roms/${ids.snes}/file/${k}`)];
  for (const url of logos) assert.equal(await status(url), 200, url);
  for (const k of ['spine', 'disc', 'back', 'manual']) assert.equal(await status(`/api/roms/${ids.snes}/file/${k}`), 403, k);
  assert.equal(await status('/api/platforms/all'), 403, 'the admin catalogue is not a logo');
  for (const [method, url] of [['POST', '/api/platforms/snes/logo'], ['DELETE', '/api/platforms/snes/logo'], ['POST', '/api/platforms/families/logo'], ['DELETE', '/api/platforms/families/logo?family=x'], ['PUT', '/api/platforms/snes/logo/plate']]) {
    assert.equal((await call(url, { token: playTok, method, body: {} })).status, 403, `${method} ${url}`);
  }
  // a game hidden from everyone keeps its art to itself
  await call(`/api/roms/${ids.ps2}/hide-all`, { method: 'POST', body: { hidden: true } });
  for (const k of ['logo', 'marquee', 'fanart']) assert.equal(await status(`/api/roms/${ids.ps2}/file/${k}`), 404, `hidden game ${k}`);
  assert.equal(await status(`/api/roms/${ids.ps2}.0/file/logo`), 403);
  await call(`/api/roms/${ids.ps2}/hide-all`, { method: 'POST', body: { hidden: false } });
});

test('a play-only person can watch a Library game\'s videos, and can do nothing else with videos', async () => {
  const file = path.join(TMP, 'snap.mp4'); fs.writeFileSync(file, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12), Buffer.from('SNAP')]));
  const { titleKey } = await import('../src/lib/emumovies.js');
  const { setThemeVideo } = await import('../src/lib/themevideos.js');
  for (const [slug, title] of [['snes', 'Snes Game'], ['ps2', 'Ps2 Game']]) {
    db.prepare("INSERT INTO game_videos (platform, title_key, path, bytes, source, fetched_at, tried_at) VALUES (?, ?, ?, ?, 'folder', datetime('now'), datetime('now'))").run(slug, titleKey(title), file, fs.statSync(file).size);
    setThemeVideo(slug, titleKey(title), file, fs.statSync(file).size);
  }
  const status = async (url) => (await fetch(base + url, { headers: { Authorization: `Bearer ${playTok}` } })).status;
  const watch = (id) => [`/api/videos/file?kind=rom&id=${id}`, `/api/videos/file?kind=rom&id=${id}&variant=theme`, `/api/videos/status?kind=rom&id=${id}`];

  for (const url of watch(ids.snes)) assert.equal(await status(url), 200, url);
  const part = await fetch(`${base}/api/videos/file?kind=rom&id=${ids.snes}`, { headers: { Authorization: `Bearer ${playTok}`, Range: 'bytes=0-7' } });
  assert.equal(part.status, 206, 'the player can seek');
  assert.equal((await call(`/api/videos/status?kind=rom&id=${ids.snes}`, { token: playTok })).body.can_fetch, false, 'no fetch button is offered');

  for (const q of ['kind=physical&id=1', 'kind=digital&store=xbox&id=x', 'id=1', 'kind=rom&kind=physical&id=1', 'kind=ROM&id=1']) for (const what of ['file', 'status']) assert.equal(await status(`/api/videos/${what}?${q}`), 403, `${what}?${q}`);
  for (const url of ['/api/videos/fetch', '/api/videos/assets', '/api/videos/fetch?kind=rom', '/api/videos/file?kind=rom&id=1', '/api/videos/status?kind=rom&id=1']) {
    assert.equal((await call(url, { token: playTok, method: 'POST', body: { kind: 'rom', id: ids.snes, force: true } })).status, 403, `POST ${url}`);
  }
  await call(`/api/roms/${ids.ps2}/hide-all`, { method: 'POST', body: { hidden: true } });
  for (const url of watch(ids.ps2)) assert.equal(await status(url), 404, `hidden game ${url}`);
  for (const url of watch(`${ids.ps2}.0`)) assert.equal(await status(url), 404, `hidden game, oddly numbered ${url}`);
  await call(`/api/roms/${ids.ps2}/hide-all`, { method: 'POST', body: { hidden: false } });
});

test('switching a person back to full restores everything at once', async () => {
  await call(`/api/auth/users/${userIds.pplayer}`, { method: 'PATCH', body: { mode: 'full' } });
  assert.equal((await call('/api/collections', { token: playTok })).status, 200, 'same sign-in, no need to sign in again');
  assert.equal((await call('/api/auth/me', { token: playTok })).body.user.play_only, false);
});

test('the allow-list itself', async () => {
  const { playOnlyAllows } = await import('../src/lib/playonly.js');
  assert.equal(playOnlyAllows('GET', '/roms'), true);
  assert.equal(playOnlyAllows('GET', '/roms/12/download'), false);
  assert.equal(playOnlyAllows('DELETE', '/roms/12'), false);
  assert.equal(playOnlyAllows('GET', '/roms/12/play/Some%20Game.sfc'), true);
  assert.equal(playOnlyAllows('GET', '/roms/bulk/enrich-job'), false);
  assert.equal(playOnlyAllows('PATCH', '/auth/users/3'), false);
  assert.equal(playOnlyAllows('POST', '/auth/avatar'), true);
  assert.equal(playOnlyAllows('PUT', '/prefs/bs_start'), true); assert.equal(playOnlyAllows('PUT', '/prefs/bs_theme'), true);
  assert.equal(playOnlyAllows('PUT', '/prefs/chip_style'), false, 'only the choices of the play screen');
});

test('a play-only account lands in Big Screen unless it chose otherwise, and the menu leaves out what it cannot do', async () => {
  const { gameMenu } = await import('../public/bigscreen.js');
  assert.deepEqual(gameMenu({}, true).map((m) => m.k), ['play', 'fav']);
  assert.deepEqual(gameMenu({}).map((m) => m.k), ['play', 'fav', 'coll', 'broken', 'hide']);
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes("state.prefs?.bs_start ? state.prefs.bs_start === 'on' : Boolean(authState.user?.play_only && !authState.user?.previewing)") && app.includes('else if (startsInBigScreen()) openBigScreenView()') && app.includes('id="bsstart-picker"') === false);
  assert.ok(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').includes('id="bsstart-picker"'));
});

test('the top bar hands the logo, name row and menu back to the sidebar when a play-only user signs out and an admin signs in', () => {
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function syncTopbar()'), src.indexOf('function showApp('));
  // the pieces are looked up once and remembered, not searched for inside the sidebar every time (they are not there while in the bar)
  assert.match(fn, /syncTopbar\.parts/);
  assert.equal(fn.split("$('.brand', side)").length - 1, 1, 'the logo is looked up in one place only');
  assert.doesNotMatch(fn, /footer\.querySelector/, 'the name row is not searched for again on the way back');
  assert.match(fn, /side\.prepend\(brand\)/);
  assert.match(fn, /footer\.prepend\(userRow\)/);
});

test('play-only: a back-to-top arrow replaces the Library button, and the logo goes back to the library', () => {
  const root = (f) => fs.readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');
  assert.match(root('index.html'), /id="to-top"/);
  assert.match(root('styles.css'), /body\.play-only \.play-topbar \.nav \{ display: none; \}/);
  assert.match(root('app.js'), /\$\('#to-top'\)\?\.addEventListener/);
  assert.match(root('app.js'), /closest\('\.brand'\)/);
});

test('the player reads a save state through the older core function when the new one is missing', () => {
  const html = fs.readFileSync(new URL('../public/ejs-player.html', import.meta.url), 'utf8');
  assert.match(html, /bridgeGetState/);
  assert.match(html, /cwrap\('save_state_info'/);
  assert.match(html, /EmulatorJSGetState/, 'a core that has the new function still uses it');
});
