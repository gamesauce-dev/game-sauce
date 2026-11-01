import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-modern-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'madmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'm-admin-password-1';

let server, base, db, adminTok, memberTok, playTok;
const call = async (p, { token = adminTok, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (u, p) => (await call('/api/auth/login', { token: null, method: 'POST', body: { username: u, password: p } })).body.token;
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('madmin', 'm-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'mmember', password: 'm-member-pass-12', role: 'user' } });
  const created = await call('/api/auth/users', { method: 'POST', body: { username: 'mplayer', password: 'm-player-pass-12', role: 'user' } });
  const pid = created.body.user?.id ?? created.body.id ?? db.prepare("SELECT id FROM users WHERE username = 'mplayer'").get().id;
  await call(`/api/auth/users/${pid}`, { method: 'PATCH', body: { mode: 'play' } });
  memberTok = await login('mmember', 'm-member-pass-12');
  playTok = await login('mplayer', 'm-player-pass-12');
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('each person can choose Classic or Modern, and only those two', async () => {
  assert.equal((await call('/api/prefs/ui_mode', { token: memberTok, method: 'PUT', body: { value: 'modern' } })).status, 200);
  assert.equal((await call('/api/prefs', { token: memberTok })).body.ui_mode, 'modern');
  assert.equal((await call('/api/prefs', { token: adminTok })).body.ui_mode, undefined, 'it is per person: the admin is still on Classic');
  assert.equal((await call('/api/prefs/ui_mode', { token: memberTok, method: 'PUT', body: { value: 'neon' } })).status, 400);
  assert.equal((await call('/api/prefs/ui_mode', { token: memberTok, method: 'PUT', body: { value: null } })).status, 200);
  assert.equal((await call('/api/prefs', { token: memberTok })).body.ui_mode, undefined, 'cleared: back to Classic');
});

test('a play-only account can read and set its own look, but nothing else changes', async () => {
  assert.equal((await call('/api/auth/me', { token: playTok })).body.user.play_only, true, 'this account really is play-only');
  assert.equal((await call('/api/prefs/ui_mode', { token: playTok, method: 'PUT', body: { value: 'modern' } })).status, 200);
  assert.equal((await call('/api/prefs/identify_provider', { token: playTok, method: 'PUT', body: { value: 'igdb' } })).status, 403);
});

test('Modern is a separate layer: Classic files carry no Modern rules, and every Modern rule is scoped', () => {
  const css = read('public/modern.css');
  assert.match(css, /body\.ui-modern/);
  // outside the light palette and the two "hidden unless modern" lines, no selector may apply without .ui-modern
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.split('{')[0].trim()).filter(Boolean);
  const loose = rules.filter((sel) => !/ui-modern/.test(sel) && !/^\.(modern-bar|modern-home|chip-rows)/.test(sel) && !/^@media/.test(sel) && !/^\.m[bh]-/.test(sel));
  assert.deepEqual(loose, [], 'unscoped Modern selectors would leak into Classic');
  assert.doesNotMatch(read('public/styles.css'), /ui-modern/);
});

test('the top bar uses the supplied icon set and lists the pages in order', () => {
  const js = read('public/modern.js');
  const order = [...js.matchAll(/\{ view: '([a-z]+)', icon: '([A-Za-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(order, ['home', 'library', 'collections', 'sources', 'upload', 'emulators', 'settings']);
  const names = [...js.matchAll(/icon: '([A-Za-z-]+)'/g)].map((m) => m[1]);
  for (const n of [...names, 'light-mode', 'dark-mode', 'gui-toggle', 'sign-out', 'pin', 'play']) assert.ok(fs.existsSync(new URL(`../public/modern/icons/${n}.svg`, import.meta.url)), `icon ${n}.svg is shipped`);
});

test('every shipped icon is a plain SVG that takes the text colour', () => {
  const dir = new URL('../public/modern/icons/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.svg'));
  assert.ok(files.length >= 95);
  for (const f of files) {
    const t = fs.readFileSync(new URL(f, dir), 'utf8');
    assert.match(t, /^<svg /, f);
    assert.doesNotMatch(t, /<script|onload=|javascript:/i, `${f} must not carry script`);
    assert.match(t, /currentColor/, `${f} follows the text colour (light and dark mode)`);
  }
});

test('the bar is built once (a second build would double every click)', () => {
  const js = read('public/modern.js');
  assert.match(js, /building \|\| \(building = doBuildBar\(\)\)/);
  assert.match(js, /e\.currentTarget\.contains\(nav\)/, 'page buttons are matched inside the bar, not on <body data-mview>');
});

test('Modern Home reuses Classic\'s boxes, equal tile sizes and equal title heights', () => {
  const js = read('public/modern.js'), css = read('public/modern.css');
  assert.match(js, /class="strips mh-strips"/);
  assert.match(js, /data-strip="played"/);
  assert.match(js, /data-strip="recent"/);
  assert.match(css, /\.card-title \{ min-height: 2\.5em; \}/, 'every title is two lines tall, so covers never shrink');
  assert.match(css, /repeat\(auto-fill, 5\.6rem\)/, 'one tile size for both boxes');
  assert.match(read('public/app.js'), /applyStrips\(host, false\)|applyStrips\(b\.closest\('\.modern-home'\), false\)/, 'a short window does not collapse the Home boxes');
});

test('the ticker lives in the top bar on every page, and Library will swap it for the library tools', () => {
  const js = read('public/modern.js'), css = read('public/modern.css');
  assert.match(js, /<div class="mb-slot" id="mb-slot">[\s\S]*id="mh-ticker"[\s\S]*id="mb-library-tools"/, 'one slot in the bar holds both');
  assert.doesNotMatch(js.slice(js.indexOf('async function renderHome')), /id="mh-ticker"/, 'Home no longer carries its own ticker');
  assert.match(js, /refreshTicker\(\);/, 'it is refreshed on every page change');
  assert.match(css, /mb-tools\[data-mview="library"\] \.mh-ticker \{ display: none; \}/, 'hidden in Library once the tools are in the bar');
});

test('the logo is the vector file, sized to the icon row; the account is an avatar menu on the right', () => {
  const js = read('public/modern.js'), css = read('public/modern.css');
  assert.match(js, /<img src="\/logo\.svg"/);
  assert.match(css, /\.mb-brand img \{[^}]*width: 2\.5rem; height: 2\.5rem/);
  assert.match(read('public/logo.svg'), /viewBox=/);
  assert.doesNotMatch(read('public/logo.svg'), /<image|base64/, 'a true vector, no embedded bitmap');
  const right = js.slice(js.indexOf('<div class="mb-right">'));
  assert.match(right, /id="mb-theme"[\s\S]*id="mb-gui"[\s\S]*id="mb-acct-btn"[\s\S]*My account[\s\S]*Sign out/, 'switches then avatar, in that order, on the right');
  assert.doesNotMatch(js.slice(0, js.indexOf('<div class="mb-right">')), /mb-signout/, 'sign-out is no longer at the left');
});

test('Library tools in the bar drive the Classic controls instead of duplicating them', () => {
  const js = read('public/modern.js'), css = read('public/modern.css');
  // each tool button proxies a real Classic control, so filters and loading stay in one place
  for (const sel of ['[data-toggle="favorite"]', '[data-toggle="hidden"]', '#select-toggle', '#bulk-enrich']) assert.ok(js.includes(sel), `${sel} is driven from the bar`);
  assert.match(js, /id="tl-q"/);
  assert.match(js, /dispatchEvent\(new Event\('input'/, 'typing in the bar fires the real search box');
  assert.match(js, /sel\.dispatchEvent\(new Event\('change'/, 'sort fires the real sort control');
  assert.match(js, /3-dot-spinner/, 'a metadata run shows the three-dot spinner');
  assert.match(css, /#view-library > \.toolbar \{ display: none; \}/);
  assert.match(css, /mb-tools\[data-mview="library"\] \.mh-ticker \{ display: none; \}/);
  // play-only accounts get the cut-down set: no sort, hidden, select, more
  assert.match(js, /po \? '' :/);
});

test('the platform chip row: families, then the platforms of the opened family, several at once', () => {
  const js = read('public/modern.js'), css = read('public/modern.css'), html = read('public/index.html'), app = read('public/app.js');
  assert.match(html, /id="chip-rows"/);
  assert.match(js, /data-chip-all/); assert.match(js, /data-chip-fam=/); assert.match(js, /data-chip-plat=/);
  assert.match(js, /cur\.includes\(slug\) \? cur\.filter/, 'a lit chip is dropped again when clicked');
  assert.match(app, /\[state\.platform, \.\.\.\(state\.extraPlatforms \|\| \[\]\)\]\.join\(','\)/, 'the picked platforms go to the server as one list');
  assert.match(app, /state\.extraPlatforms = \[\];\s*\/\/ the sidebar picks one platform/, 'choosing from the Classic sidebar clears the extras');
  assert.match(app, /confirmChoice\(\{ title: 'Fetch metadata for which games\?'/, 'with several platforms picked, a metadata run asks its scope instead of guessing');
  assert.match(css, /body\.ui-modern\[data-mview="library"\] \.chip-rows \{ display: flex/);
  assert.match(css, /^\.chip-rows \{ display: none; \}/m, 'hidden everywhere else, so Classic never shows it');
});
