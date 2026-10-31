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
