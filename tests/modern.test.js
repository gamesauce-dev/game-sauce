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
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

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
  const loose = rules.filter((sel) => !/ui-modern/.test(sel) && !/^\.(modern-bar|modern-home|chip-rows|az-bar)/.test(sel) && !/^@(media|keyframes)/.test(sel) && !/^(from|to|\d+%)$/.test(sel) && !/^\.m[bh]-/.test(sel));
  assert.deepEqual(loose, [], 'unscoped Modern selectors would leak into Classic');
  assert.doesNotMatch(read('public/styles.css'), /ui-modern/);
});

test('the top bar uses the supplied icon set and lists the pages in order', () => {
  const js = read('public/modern.js');
  const order = [...js.matchAll(/\{ view: '([a-z]+)', icon: '([A-Za-z0-9-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(order, ['home', 'library', 'digital', 'physical', 'collections', 'carousel', 'sources', 'upload', 'emulators', 'messages', 'settings']);
  assert.match(js, /view: 'emulators', icon: 'emulators-2'/);
  const names = [...js.matchAll(/icon: '([A-Za-z0-9-]+)'/g)].map((m) => m[1]);
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

test('the bar is built once per person (a second build for the same person would double every click)', () => {
  const js = read('public/modern.js');
  assert.match(js, /if \(building && builtFor === key\) return building;/, 'the same person reuses the bar that is already built');
  assert.match(js, /return \(building = doBuildBar\(\)\);/);
  assert.match(js, /e\.currentTarget\.contains\(nav\)/, 'page buttons are matched inside the bar, not on <body data-mview>');
});

test('Modern Home reuses Classic\'s boxes, equal tile sizes and equal title heights', () => {
  const js = read('public/modern.js'), css = read('public/modern.css');
  assert.match(js, /class="strips mh-strips"/);
  assert.match(js, /data-strip="played"/);
  assert.match(js, /data-strip="recent"/);
  assert.match(css, /\.card-title \{ min-height: 2\.5em; \}/, 'every title is two lines tall, so covers never shrink');
  assert.match(css, /repeat\(auto-fill, minmax\(5\.6rem, 1fr\)\)/, 'one tile size for both boxes');
  assert.match(read('public/app.js'), /applyStrips\(host, false\)|applyStrips\(b\.closest\('\.modern-home'\), false\)/, 'a short window does not collapse the Home boxes');
});

test('the ticker lives in the top bar on every page, and Library will swap it for the library tools', () => {
  const js = read('public/modern.js'), css = read('public/modern.css');
  assert.match(js, /<div class="mb-slot" id="mb-slot">[\s\S]*id="mh-ticker"[\s\S]*id="mb-library-tools"/, 'one slot in the bar holds both');
  assert.doesNotMatch(js.slice(js.indexOf('async function renderHome')), /id="mh-ticker"/, 'Home no longer carries its own ticker');
  assert.match(js, /refreshTicker\(view === 'library'\);/, 'it is refreshed on every page change');
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
  assert.match(css, /body\.ui-modern:not\(\[data-mview="library"\]\) \.chip-rows \{ display: none; \}/, 'Modern shows the chips on the library page only; Classic has them too (styles.css)');
  assert.match(read('public/styles.css'), /^\.chip-rows \{ display: flex; flex-direction: column;/m, 'Classic shows the chips above the games');
  assert.doesNotMatch(read('public/index.html'), /id="platform-list"/, 'and no longer has a platform list down the left');
});

test('A-Z jump, grid size and back to top sit above the grid and work from the list as sorted', () => {
  const js = read('public/modern.js'), css = read('public/modern.css'), html = read('public/index.html');
  assert.match(html, /id="az-bar"/);
  assert.match(js, /\['#', \.\.\.'ABCDEFGHIJKLMNOPQRSTUVWXYZ'\]/);
  assert.match(js, /s === 'title' \? 1 : s === '-title' \? -1 : 0/, 'only offered while sorted by title, either way');
  assert.match(js, /await ctx\.loadLibrary\(\)/, 'it reloads the list starting at the letter (no loading every tile before it)');
  assert.match(js, /data-density="comfortable"[\s\S]*data-density="compact"[\s\S]*id="az-top"/);
  assert.match(js, /az-hit/, 'the first game under the letter is marked');
  assert.match(css, /^\.az-bar \{ display: none; \}/m, 'hidden everywhere but Modern Library');
});

test('the details window sits under the bar, uses the supplied pin icon, and the pin is lit or dim by state', () => {
  const js = read('public/modern.js'), css = read('public/modern.css');
  assert.match(js, /usePinIcon\(ic\.pin\)/);
  assert.match(js, /restorePinIcon\(\)/, 'Classic gets its own pin icon back when Modern is turned off');
  assert.match(js, /--mb-h/, 'the bar height is measured, so the window never covers the bar');
  assert.match(css, /body\.ui-modern \.drawer \{ top: var\(--mb-h, 50px\)/);
  assert.match(css, /body\.ui-modern \.drawer-pin\.is-on \{[^}]*box-shadow/, 'lit when pinned');
  assert.match(css, /body\.ui-modern \.drawer-pin svg \{[^}]*rotate\(35deg\)/, 'tilted and dim when not pinned');
  assert.match(css, /body\.ui-modern \.drawer-scrim \{ top: var\(--mb-h/, 'the dimming overlay also starts under the bar');
});

test('chip row: a family selects the whole family (All goes off), a platform then narrows, and a new list starts at the top', () => {
  const js = read('public/modern.js'), app = read('public/app.js'), css = read('public/modern.css');
  assert.match(js, /chipFamily = f; setPlatforms\(slugs\);/, 'clicking a family selects all of its platforms, so All is not left lit');
  assert.match(js, /if \(wholeFamily\) setPlatforms\(\[slug\]\);/, 'with the whole family on, a platform click narrows to that one');
  assert.match(js, /famState = /);
  assert.match(js, /' on whole'/); assert.match(js, /' on part'/);
  // the reported bug: the grid kept its old scroll position, past the end of a short list, so the tiles were "missing"
  assert.match(js, /g\.scrollTop = 0;\s*\n\s*await ctx\.loadLibrary\(\);/, 'scroll resets before loading a different list');
  assert.match(js, /requestAnimationFrame\(\(\) => \{ g\.scrollTop = 0; \}\)/, 'and again once the new tiles are drawn');
  assert.match(app, /wholeFam \? `\$\{fam\} \(all platforms\)`/, 'the heading names a whole family');
  assert.doesNotMatch(css, /\.chip(?:\[style\*="--chip-c"\])?\.on\.part \{[^}]*dashed/, 'a part-selected family is not dashed');
  assert.doesNotMatch(css, /\.chip\.on\.part \{ box-shadow: none/, 'and it keeps the selected glow');
});

test('medium windows (snapped to half a screen): the library tools drop to their own line instead of overlapping the switches', () => {
  const css = read('public/modern.css');
  const m = css.match(/@media \(max-width: 1060px\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'there is a rule for windows up to 1060px wide');
  assert.match(m[1], /\.modern-bar \{ flex-wrap: wrap/);
  assert.match(m[1], /\.mb-slot \{ order: 6; flex: 1 1 100%; \}/, 'the tools / ticker take a full line of their own');
  assert.match(m[1], /\.mb-right \{ margin-left: auto; \}/, 'the switches stay at the right of the icon row');
});

test('stage 3: icons in place of words on the other pages, from your icon set, with the words kept as the tooltip', () => {
  const js = read('public/modern.js'), css = read('public/modern.css'), app = read('public/app.js');
  const map = js.slice(js.indexOf('const ICON_MAP = ['), js.indexOf('const miKnown'));
  const names = [...map.matchAll(/'([A-Za-z-]+)'\]/g)].map((x) => x[1]);
  assert.ok(names.length >= 40, 'a good number of buttons are mapped');
  for (const n of new Set(names)) assert.ok(fs.existsSync(new URL(`../public/modern/icons/${n}.svg`, import.meta.url)), `mapped icon ${n}.svg exists`);
  // the selectors it points at exist in the page or the app's templates
  const html = read('public/index.html');
  for (const id of ['scan-all', 'add-source', 'new-collection', 'enrich-missing-covers', 'backup-run', 'dat-upload', 'platform-add-toggle', 'health-refresh']) assert.ok(html.includes(`id="${id}"`), `#${id} is a real button`);
  assert.match(js, /el\.setAttribute\('title', label\)/, 'the words stay as the hover text');
  assert.match(js, /el\.setAttribute\('aria-label', label\)/, 'and as the screen-reader label');
  assert.match(css, /body\.ui-modern \[data-mi\] \{ font-size: 0;/, 'the words are hidden only in Modern');
  assert.match(css, /mask: center \/ contain no-repeat/, 'the icon takes the text colour (light and dark mode)');
  // Settings: every group and setting names an icon, and every one exists
  const used = [...app.matchAll(/mi: '([A-Za-z0-9-]+)'/g)].map((x) => x[1]);
  assert.ok(used.length >= 23, 'all Settings groups and settings carry an icon');
  for (const n of new Set(used)) assert.ok(fs.existsSync(new URL(`../public/modern/icons/${n}.svg`, import.meta.url)), `Settings icon ${n}.svg exists`);
  assert.match(app, /aria-label="\$\{esc\(g\.label\)\}"/, 'icon-only group tiles still have a label for screen readers');
  assert.doesNotMatch(read('public/styles.css'), /data-mi/, 'Classic is untouched');
});

test('opening a family chip never shifts the other chips sideways (the arrow space is always reserved)', () => {
  const css = read('public/modern.css');
  assert.match(css, /\.chip\[data-chip-fam\]::after \{[^}]*border-top: 5px solid transparent/, 'the arrow slot exists on every family chip, transparent until open');
  assert.match(css, /\.chip\[data-chip-fam\]\.open::after \{ border-top-color: currentColor; \}/);
  assert.doesNotMatch(css, /\.chip\.open::after \{ content/, 'the old rule that only added the arrow to the open chip is gone');
});

test('Home: two equal boxes side by side with the same tile size; a whole family lights only the family chip', () => {
  const css = read('public/modern.css'), js = read('public/modern.js'), app = read('src/app.js');
  assert.doesNotMatch(css, /@media \(min-width: 760px\) \{ body\.ui-modern \.mh-strips/, 'the two boxes are stacked, not side by side');
  assert.match(css, /\.mh-strips \.strip \.recent-row \{ grid-template-columns: repeat\(auto-fill, minmax\(5\.6rem, 1fr\)\)/, 'tiles stretch to fill each box, by the same rule in both');
  assert.match(js, /recently-played\?limit=24/);
  assert.match(app, /ORDER BY r\.created_at DESC LIMIT 24/, 'enough recent tiles to fill a wide box');
  assert.match(js, /const wholeNow = /);
  assert.match(js, /picked\.has\(p\.slug\) && !wholeNow \? ' on' : ''/, 'platform chips stay unlit while the whole family is selected');
});

test('"Add and scan" is your source-add-and-scan icon in Modern, with the words as its tooltip', () => {
  const js = read('public/modern.js');
  assert.match(js, /\['#create-source', 'source-add-and-scan-2'\]/);
  assert.ok(fs.existsSync(new URL('../public/modern/icons/source-add-and-scan-2.svg', import.meta.url)));
  assert.match(read('public/modern/icons/source-add-and-scan-2.svg'), /currentColor/);
});

test('close, tick, copy, clear-reset and show-more icons are wired to their buttons', () => {
  const js = read('public/modern.js');
  for (const [id, n] of [['#health-copy', 'copy'], ['#bulk-clear', 'clear-reset-2'], ['#dup-more', 'show-more-down-arrow'], ['#browser-use', 'tick'], ['#cancel-source', 'close']]) {
    assert.ok(js.includes(id) && fs.existsSync(new URL(`../public/modern/icons/${n}.svg`, import.meta.url)), `${id} -> ${n}`);
  }
});

test('Sources: Disable uses the folder-disable icon; Enable uses folder-enable', () => {
  assert.match(read('public/modern.js'), /\[data-act="toggle"\]\[data-enabled="0"\]', 'folder-enable'/);
  assert.ok(fs.existsSync(new URL('../public/modern/icons/folder-enable.svg', import.meta.url)));
  assert.match(read('public/modern.js'), /\[data-act="toggle"\]\[data-enabled="1"\]', 'folder-disable'/);
  assert.match(read('public/app.js'), /data-act="toggle" data-enabled=/);
  assert.ok(fs.existsSync(new URL('../public/modern/icons/folder-disable.svg', import.meta.url)));
});

test('Modern text has more contrast (brighter colours, medium weight) and icons are applied before paint', () => {
  const css = read('public/modern.css'), js = read('public/modern.js');
  assert.match(css, /body\.ui-modern \{ --text: #f6f7fb; --muted: #c0c7d6;/);
  assert.match(css, /font-weight: 500;/);
  assert.doesNotMatch(css, /font-weight: (600|700|bold)[^}]*\}\s*\/\* more contrast/i);
  assert.match(js, /roots\.add\(el\)/, 'only the redrawn parts are re-checked, straight away');
  assert.match(js, /iconize\(n\)/);
});

test('Modern: apply buttons are green and cancel buttons are red, in both light and dark', () => {
  const css = read('public/modern.css');
  assert.match(css, /--apply: #1f9d63;/); assert.match(css, /--cancel: #f06b6b;/);
  assert.match(css, /data-theme="light"\] body\.ui-modern \{ --apply: #178a4c;/);
  assert.match(css, /\.btn-primary, body\.ui-modern \.btn\[data-mi="tick"\] \{ background: var\(--apply\)/);
  assert.match(css, /\.btn\[data-mi="close"\][^{]*\{ color: var\(--cancel\)/);
});

test('Settings leftovers (user Disable/Enable, Edit, Delete, downloads, Update password) have icons', () => {
  const js = read('public/modern.js'), app = read('public/app.js');
  for (const s of ['#names-apply', '#backup-download', 'lb-update', 'data-pact="edit"', 'data-bk-del', 'user-disable', 'user-enable', '#dup-hide-all']) assert.ok(js.includes(s), s);
  assert.match(app, /data-act="toggle-user" data-disabled=/);
});

test('Settings pills are equal icon-only circles and Settings text is brighter', () => {
  const css = read('public/modern.css');
  assert.match(css, /\.subtile\[data-mi\], body\.ui-modern \.subtile\[data-mi\]\.is-active \{ width: 2\.4rem; height: 2\.4rem;/);
  assert.match(css, /body\.ui-modern #view-settings \{ --muted: #d6dce9;/);
});

test('Modern: no page titles, collection covers; details row promotes three extras and keeps More actions', () => {
  const css = read('public/modern.css'), js = read('public/modern.js'), app = read('public/app.js'), api = read('src/routes/collections.js');
  assert.match(css, /body\.ui-modern \.page-title \{ display: none; \}/);
  assert.match(api, /c\.covers = pick\.all\(c\.id\)/, 'the API sends up to four covers per collection');
  assert.match(app, /collection-covers/);
  assert.match(js, /function promoteDetailActions/);
  for (const k of ['addcoll', 'hide', 'refresh']) assert.ok(js.includes(`data-promo="${k}"`), k);
  assert.ok(js.includes("'.detail-actions #more-btn', 'more-actions'"), 'More actions keeps its (icon) button');
  assert.doesNotMatch(css, /\.more-menu[^{]*\{ display: contents/, 'the More menu is a real menu again');
  assert.match(css, /\.ibtn\[data-tip\]:hover::after[^}]*display: none/, 'the old dark hover bubble is off in Modern');
  assert.match(js, /t\.title = tip/, 'the words come from the browser tooltip, like the top bar');
});

test('Modern: Retro font is a per-device switch that only swaps the font variable', () => {
  const css = read('public/modern.css'), js = read('public/modern.js');
  assert.match(js, /id="mb-retro"/); assert.ok(js.includes("getItem('gamesauce_retro') !== '0'"), 'on by default'); assert.match(js, /export function applyRetro/);
  assert.match(css, /body\.ui-modern\.ui-retro \{ --font: ui-monospace/);
  assert.doesNotMatch(read('public/styles.css'), /ui-retro/, 'Classic is untouched');
});

test('Details window: nav arrows, search/save icons, upload-cover icon, no duplicates in More actions, genre pills like chips', () => {
  const css = read('public/modern.css'), js = read('public/modern.js');
  for (const [sel, n] of [['#drawer-prev', 'arrow-left'], ['#drawer-next', 'arrow-right'], ['#identify-search', 'search'], ['#edit-form button[type="submit"]', 'save'], ['[data-promo="addcoll"]', 'collection-grid'], ['[data-promo="refresh"]', 'scan-again'], ['#new-collection', 'add-collection']]) {
    assert.ok(js.includes(`'${sel}'`) || js.includes(`${sel}"]', '${n}'`) || js.includes(sel), sel);
    assert.ok(fs.existsSync(new URL(`../public/modern/icons/${n}.svg`, import.meta.url)), n);
  }
  assert.ok(fs.existsSync(new URL('../public/modern/icons/upload-cover.svg', import.meta.url)));
  assert.match(css, /\.more-menu \[data-act="addcoll"\], body\.ui-modern \.more-menu \[data-act="hide"\], body\.ui-modern \.more-menu \[data-act="refresh"\] \{ display: none; \}/);
  assert.match(css, /upload-cover\.svg/);
  assert.match(css, /\.genre-pill \{ text-transform: none;/);
  assert.match(css, /#view-collections \.toolbar[^{]*\{ justify-content: flex-start; \}/);
});

test('Selection bar icons, platform chip counts match the list, storage in the ticker', () => {
  const js = read('public/modern.js'), app = read('src/app.js');
  for (const n of ['select-2', 'done', 'add-collection', 'system', 'clear-reset', 'hidden', 'visible']) assert.ok(fs.existsSync(new URL(`../public/modern/icons/${n}.svg`, import.meta.url)), n);
  for (const s of ["['#bulk-selectall', 'select-2']", "['#bulk-system-btn', 'system']", "['#bulk-clearmatch-btn', 'clear-reset']", "['#bulk-cancel', 'done']", "['#bulk-addcoll', 'add-collection']"]) assert.ok(js.includes(s), s);
  assert.ok(js.includes("ic['select-2']"), 'top library menu select icon');
  assert.match(app, /AS visible_count/, 'the platforms API reports what the default list shows');
  assert.match(js, /const pc = \(p\) => \(p\.visible_count \?\? p\.count\) \|\| 0;/);
  assert.doesNotMatch(js.slice(js.indexOf('export function renderChips'), js.indexOf('async function chipChanged')), /\bp\.count\b/, 'chips never use the raw count');
  assert.match(js, /of ROMs stored/);
});

test('Avatar picture sizing, favourite tile icon, clear-match icon, upload-cover in Edit, collection icon on the bar and row', () => {
  const css = read('public/modern.css'), js = read('public/modern.js');
  assert.match(css, /\.mb-avatar \{ background-size: cover;/);
  assert.match(css, /\.mb-avatar\.has-pic \{ color: transparent; font-size: 0; \}/);
  assert.match(css, /\.card-fav::before[^}]*favourite\.svg/);
  assert.match(css, /data-act="clearmatch"\]::before[^}]*clear-reset\.svg/);
  assert.ok(js.includes("['label.btn:has(#cover-input)', 'upload-cover']"));
  assert.ok(js.includes("{ view: 'collections', icon: 'collection'"));
  assert.match(js, /data-promo="addcoll"\]', 'add-collection'/);
});

test('Settings icon swaps (upload-cover, replace-text, covers, database-check, providers-2, Library, game-controller, backup-save)', () => {
  const js = read('public/modern.js'), app = read('public/app.js');
  for (const s of ["['#profile-upload', 'upload-cover']", "['#dat-rematch-force', 'replace-text']", "['#db-health-refresh', 'database-check']", "['#platform-add-toggle', 'add-platform-2']", "['#backup-run', 'database-backup-save']"]) assert.ok(js.includes(s), s);
  for (const s of ["mi: 'providers-2'", "mi: 'Library', ico: '🕹'", "mi: 'covers', ico: '🖼'"]) assert.ok(app.includes(s), s);
  for (const n of ['covers', 'database-check', 'replace-text', 'providers-2', 'upload-cover', 'Library', 'game-controller', 'database-backup-save']) assert.ok(fs.existsSync(new URL(`../public/modern/icons/${n}.svg`, import.meta.url)), n);
});

test('Add ROMs: the dropzone stretches to the height of the Options panel', () => {
  const css = read('public/modern.css');
  assert.match(css, /\.upload-layout \{ align-items: stretch; \}/);
  assert.match(css, /\.upload-layout \.dropzone \{ display: flex; flex-direction: column;/);
});

test('Emulators: second save button (arrow-up) does the same as Save to vault, Download is an icon, Classic keeps one button', () => {
  const js = read('public/modern.js'), app = read('public/app.js'), cls = read('public/styles.css');
  assert.ok(js.includes("['[data-save-release].emu-save-alt', 'arrow-up']"));
  assert.ok(js.includes("['.emu-dl', 'download']"));
  assert.ok(fs.existsSync(new URL('../public/modern/icons/arrow-up.svg', import.meta.url)));
  assert.match(app, /data-save-release="\$\{esc\(key\)\}" title="Save to vault"/, 'the second button carries the same data-save-release, so it runs the same code');
  assert.match(cls, /\.emu-save-alt \{ display: none; \}/, 'Classic shows only the one button');
  assert.match(app, /why\[key\]/, 'the page says why GitHub gave no answer');
  assert.match(app, /An empty answer never wipes a good one/);
});

test('Collection picker: New collection and Create are icons; counts read correctly and are not cut off', () => {
  const js = read('public/modern.js'), app = read('public/app.js');
  assert.ok(js.includes("['#addcoll-new', 'add-collection']")); assert.ok(js.includes('#collection-create'));
  assert.match(app, /\$\{c\.count === 1 \? 'game' : 'games'\}/);
  assert.match(app, /✓ in · remove/);
});

test('Phone width: Emulator cards and the details bar are kept inside the screen', () => {
  const css = read('public/modern.css');
  assert.match(css, /@media \(max-width: 640px\) \{\s+body\.ui-modern \.emu-card/);
  assert.match(css, /body\.ui-modern \.drawer-bar \{ max-width: 100vw;/);
});

test('Play-only accounts do not get the promoted management buttons on the details row', () => {
  assert.match(read('public/modern.css'), /body\.ui-modern\.play-only \.detail-actions \[data-promo\] \{ display: none; \}/);
});

test('Emulators: a rolling-build project is explained, not offered a pointless retry', () => {
  assert.match(read('public/app.js'), /This project publishes \$\{emuState\.why\[key\]/);
});

test('Admin-only play-only preview, avatar on sign-in, Settings sub-icons under their parent', () => {
  const js = read('public/modern.js'), app = read('public/app.js'), au = read('src/routes/auth.js');
  assert.match(au, /avatar_v: user\.avatar_updated \|\| null/, 'sign-in carries the picture version');
  assert.match(app, /user\.role === 'admin' && sessionStorage\.getItem\('gamesauce_preview_play'\) === '1'/, 'only an admin can preview');
  assert.match(js, /pv\.classList\.toggle\('hidden', u\.role !== 'admin'\)/, 'the menu item is for admins only');
  assert.match(js, /function alignSubtiles/);
  assert.match(js, /row\.style\.paddingLeft/);
});

test('new accounts start in Modern; people who already exist are not changed', async () => {
  assert.equal((await call('/api/prefs', { token: memberTok })).body.ui_mode, undefined, 'cleared earlier in this file, so it reads as Classic');
  await call('/api/auth/users', { method: 'POST', body: { username: 'mfresh', password: 'm-fresh-pass-123', role: 'user' } });
  const freshTok = await login('mfresh', 'm-fresh-pass-123');
  assert.equal((await call('/api/prefs', { token: freshTok })).body.ui_mode, 'modern', 'a brand-new person starts in Modern');
  assert.equal((await call('/api/prefs/ui_mode', { token: freshTok, method: 'PUT', body: { value: 'classic' } })).status, 200, 'and can switch to Classic');
  assert.equal((await call('/api/prefs', { token: freshTok })).body.ui_mode, 'classic');
});

test('Details window dims gently, top-bar pages release it, tooltips use the app font, gold favourite, deeper black, sign-in follows the last look', () => {
  const css = read('public/modern.css'), js = read('public/modern.js'), app = read('public/app.js'), cls = read('public/styles.css');
  assert.match(css, /body\.ui-modern \.drawer-scrim \{ background: rgba\(8, 9, 14, \.32\)/, 'a softer dim than the old 55%');
  assert.match(js, /Choosing a page releases the details window, unless it is pinned/);
  assert.match(js, /ctx\.closeDrawer\?\.\(\)/); assert.match(app, /modern\.initModern\(\{ closeDrawer,/);
  assert.match(css, /#mb-tip \{[^}]*font: 500 0\.8rem\/1\.3 var\(--font\)/, 'the bubble uses the app font variable (so Retro applies)');
  assert.match(js, /function tipify/); assert.match(js, /function untipify/, 'Classic gets its own tooltips back');
  assert.match(css, /\.card-fav \{ color: #f5c542;/);
  assert.match(css, /ui-deep \{ --bg: #000000;/); assert.match(js, /id="mb-deep"/); assert.match(js, /gamesauce_deep/);
  assert.match(app, /function paintLoginLook/); assert.match(app, /gamesauce_last_look/);
  assert.match(cls, /body\.login-modern \.auth-card/);
  assert.match(js, /localStorage\.setItem\('gamesauce_last_look', next\)/, 'switching look updates what the sign-in screen will show');
});

test('Ticker has the game-sauce name line and an admin-only update line; one bar in the play-only preview; icons never draw as a block', () => {
  const js = read('public/modern.js'), css = read('public/modern.css'), app = read('src/app.js');
  assert.match(js, /mh-brand/); assert.match(js, /Update available: game-sauce/);
  assert.match(js, /ctx\.user\(\)\?\.role === 'admin'[\s\S]*admin\/update-check/, 'the update line is only asked for by admins');
  assert.match(app, /api\.get\('\/admin\/update-check', requireAuth, requireAdmin/);
  assert.match(css, /body\.ui-modern \.play-topbar \{ display: none !important; \}/);
  assert.match(css, /\[data-mi\]::before \{ content: ''; visibility: hidden;/, 'an icon is invisible until its picture has loaded');
  assert.match(js, /visibility: visible/); assert.match(js, /img\.onload = add/);
});

test('Settings file choosers share one style, DAT import sits on the chooser line, light-mode text is darker, sign-in has no green or session message', () => {
  const html = read('public/index.html'), css = read('public/modern.css'), app = read('public/app.js'), cls = read('public/styles.css');
  assert.match(html, /<div class="dat-row">\s*<input type="file" id="dat-file"[^>]*class="file-input" \/>\s*<button class="btn btn-primary" id="dat-upload">/, 'Import is on the same line as Choose file');
  assert.match(html, /id="dat-upload">Import<\/button>\s*<button class="btn" id="dat-rematch">[\s\S]*?id="dat-rematch-force"/, 'Import and the two re-match buttons sit together on the chooser line');
  assert.match(html, /id="names-file" accept="\.csv,text\/csv" class="file-input"/);
  assert.match(html, /name="file" required class="file-input"/, 'the Emulators vault chooser too');
  assert.match(css, /body\.ui-modern \.file-input \{ display: block; width: 100%;/);
  assert.match(css, /html\[data-theme="light"\] body\.ui-modern \{\s+--warn: #8a5a00; --good: #0f7a46;/);
  assert.match(css, /html\[data-theme="light"\] body\.ui-modern \.pill\.warn \{ color: #7a4e00;/);
  assert.doesNotMatch(app, /Your session has ended/, 'no message on a sign-in screen that is already showing');
  assert.doesNotMatch(cls, /login-modern \.auth-form \.btn-primary \{ background: #1f9d63/, 'the sign-in button is not green');
});

test('an admin can change another person\'s role; the last admin and your own role are protected; the admin badge has room', async () => {
  const r = (p, o) => call(p, o);
  const created = await call('/api/auth/users', { method: 'POST', body: { username: 'mrole', password: 'm-role-pass-1234', role: 'user' } });
  const rid = created.body.user?.id ?? created.body.id ?? db.prepare("SELECT id FROM users WHERE username = 'mrole'").get().id;
  assert.equal((await r(`/api/auth/users/${rid}`, { method: 'PATCH', body: { role: 'admin' } })).body.role, 'admin', 'promoted');
  const roleTok = await login('mrole', 'm-role-pass-1234');
  assert.equal((await call('/api/auth/users', { token: roleTok })).status, 200, 'the new admin can use admin routes straight away');
  assert.equal((await r(`/api/auth/users/${rid}`, { method: 'PATCH', body: { role: 'user' } })).body.role, 'user', 'demoted');
  assert.equal((await call('/api/auth/users', { token: roleTok })).status, 403, 'and loses admin routes straight away');
  assert.equal((await r(`/api/auth/users/${rid}`, { method: 'PATCH', body: { role: 'wizard' } })).status, 400);
  const me = (await call('/api/auth/me')).body.user.id;
  assert.equal((await r(`/api/auth/users/${me}`, { method: 'PATCH', body: { role: 'user' } })).status, 409, 'you cannot change your own role');
  assert.equal((await call(`/api/auth/users/${rid}`, { token: memberTok, method: 'PATCH', body: { role: 'admin' } })).status, 403, 'a member cannot promote anyone');
  const css = read('public/styles.css'), app = read('public/app.js');
  assert.match(css, /\.user-line \.user-badge \{ margin-left: 0\.75rem; \}/); assert.match(app, /data-act="role-setting"/);
});

test('a No cover filter for everyone: server filter, Classic pill, Modern tool button', async () => {
  const none = await call('/api/roms?cover=0&limit=5', { token: memberTok });
  assert.equal(none.status, 200);
  assert.ok(none.body.items.every((r) => !r.cover_url), 'every game it returns has no cover');
  const withCover = await call('/api/roms?cover=1&limit=5', { token: memberTok });
  assert.ok(withCover.body.items.every((r) => r.cover_url), 'and cover=1 returns only games with one');
  const html = read('public/index.html'), app = read('public/app.js'), js = read('public/modern.js');
  assert.match(html, /data-toggle="nocover"/); assert.match(app, /state\.cover = state\.cover === 'none' \? null : 'none'/);
  assert.match(js, /id="tl-nocover"/); assert.match(js, /proxy\('\[data-toggle="nocover"\]'\)/);
  assert.ok(fs.existsSync(new URL('../public/modern/icons/empty-covers.svg', import.meta.url)));
});

test('Stats totals are links that open the Library with the same filter, so the number matches', () => {
  const app = read('public/app.js'), api = read('src/routes/roms.js');
  assert.match(app, /data-stat-go=/); assert.match(app, /function openLibraryFor/);
  for (const k of ['all', 'system', 'matched', 'unmatched-name', 'cover', 'nocover', 'orphan', 'missing', 'hidden']) assert.ok(app.includes(`'${k}'`), k);
  assert.match(app, /state\.incl = 'all'/, 'hidden and System games are included where the Stats total counts them');
  assert.match(api, /req\.query\.cover === '0'/); assert.match(api, /req\.query\.matched === '1'/);
});

test('the No cover tool uses the no-covers icon', () => {
  const js = read('public/modern.js');
  assert.match(js, /\$\{ic\['no-covers-2'\]\}<\/button>/); assert.ok(js.includes("'no-covers-2', 'fetch-metadata-3'"));
  assert.doesNotMatch(js, /ic\['empty-covers'\]/);
  assert.ok(fs.existsSync(new URL('../public/modern/icons/no-covers-2.svg', import.meta.url)));
});

test('the Modern bar is rebuilt for whoever signs in, so a play-only person never gets the last person\'s admin bar', () => {
  const js = read('public/modern.js');
  assert.match(js, /const whoKey = \(\) =>/); assert.match(js, /builtFor === key/, 'the bar remembers who it was built for');
  assert.match(js, /bar\.dataset\.wired/, 'its click handler is attached once, however often it is rebuilt');
  assert.match(js, /buildLibraryTools\.timer/, 'and the Library tools timer is started once');
});

test('collections say which games can be played, and offer Play on them', async () => {
  const mk = await call('/api/collections', { method: 'POST', body: { name: 'Playable test' } });
  const snes = db.prepare("SELECT id FROM roms WHERE platform_id = (SELECT id FROM platforms WHERE slug = 'snes') LIMIT 1").get();
  const ps1 = db.prepare("SELECT id FROM roms WHERE platform_id = (SELECT id FROM platforms WHERE slug = 'ps1') LIMIT 1").get();
  const ids = [snes?.id, ps1?.id].filter(Boolean);
  if (ids.length < 2) return;   // the seeded test library has no such games: nothing to compare
  await call(`/api/collections/${mk.body.id}/roms`, { method: 'POST', body: { rom_ids: ids } });
  const d = (await call(`/api/collections/${mk.body.id}`)).body;
  assert.equal(d.items.find((r) => r.id === snes.id).playable, true, 'a SNES game has a browser core');
  assert.equal(d.items.find((r) => r.id === ps1.id).playable, false, 'a PS1 game needs a BIOS: no Play button');
  assert.match(read('public/app.js'), /data-rom-play=/); assert.match(read('public/app.js'), /\.then\(openPlayer\)/);
});

test('play-only: platform pills count only playable games; no Add ROMs offered; CSV tools rename; checkbox rows aligned', async () => {
  const app = read('public/app.js'), css = read('public/styles.css'), html = read('public/index.html'), srv = read('src/app.js'), roms = read('src/routes/roms.js');
  assert.match(srv, /AS playable_count/, 'the platform list reports how many games can be played in the browser');
  assert.match(roms, /export function playableSql\(\)/); assert.match(roms, /where\.push\(playableSql\(\)\)/, 'the list filter and the counts share one rule');
  assert.match(app, /authState\.user\?\.play_only\s*\? all\.map\(\(p\) => \(\{ \.\.\.p, count: p\.playable_count/, 'a play-only person sees playable counts, so empty platforms and families drop out');
  assert.match(css, /body\.play-only #empty \[data-view="upload"\] \{ display: none; \}/);
  assert.match(html, /<h3>CSV tools </); assert.match(app, /label: 'CSV tools'/); assert.doesNotMatch(html + app, /Game names \(CSV\)/);
  assert.match(css, /\.export-row \.policy-row \{ margin: 0; align-items: center; min-height: 2\.4rem;/);
  assert.match(html, /id="covers-platform"/);
});

test('the CSV import takes an optional cover zip and shows a combined preview', () => {
  const html = read('public/index.html'), app = read('public/app.js'), r = read('src/routes/roms.js');
  assert.match(html, /id="names-covers-zip"/); assert.match(html, /id="names-covers-replace"/);
  assert.match(app, /fd\.append\('zip', zf\)/); assert.match(app, /<b>Covers:<\/b>/);
  assert.match(r, /\.fields\(\[\{ name: 'csv', maxCount: 1 \}, \{ name: 'zip', maxCount: 1 \}\]\)/);
  assert.match(r, /planCoversForCsv\(entries, hits/);
});

test('Emulators: the refresh button sits between the Vault and the first emulator, with its own icon', () => {
  const html = read('public/index.html'), js = read('public/modern.js');
  assert.ok(html.indexOf('id="emu-refresh-latest"') > html.indexOf('id="emu-upload-form"') && html.indexOf('id="emu-refresh-latest"') < html.indexOf('id="emu-guide"'));
  assert.match(js, /\['#emu-refresh-latest', 'emulators-refresh'\]/);
  for (const n of ['emulators-2', 'emulators-refresh', 'no-covers-2', 'fetch-metadata-3', 'heart']) assert.ok(fs.existsSync(new URL(`../public/modern/icons/${n}.svg`, import.meta.url)), n);
  assert.match(read('public/app.js'), /id: 'health',\s+label: 'Health',\s+mi: 'heart'/);
});

test('ticker: the game-sauce name is always the first line; health wording is calm; Lock hover says Lock / Unlock', () => {
  const js = read('public/modern.js');
  assert.match(js, /lines\.unshift\(brand\);\s*\n\s*const track/);
  assert.doesNotMatch(js, /has warnings/); assert.match(js, /a few notes to read/);
  assert.match(read('public/index.html'), /title="Lock \/ Unlock the selected games/);
});

test('Library reset: one button clears search, platforms and filters in both looks', () => {
  const app = read('public/app.js'), js = read('public/modern.js'), html = read('public/index.html');
  assert.match(html, /id="reset-filters"/); assert.match(app, /async function resetFilters\(\)/); assert.match(app, /function filtersActive\(\)/);
  assert.match(js, /id="tl-reset"/); assert.match(js, /ctx\.resetFilters/); assert.match(js, /'clear-reset-2'/);
});

test('the release: the version, the changelog heading and the docs agree', () => {
  const pkg = JSON.parse(read('package.json')), cl = read('CHANGELOG.md');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  const v = pkg.version.replace(/\./g, '\\.');
  assert.match(cl, new RegExp(`## \\[Unreleased\\][\\s\\S]*?## \\[${v}\\] - 20\\d\\d-\\d\\d-\\d\\d`), 'the changelog has a heading for the current version');
  assert.match(cl, /## \[0\.2\.0\] - 2026-11-02/, 'and the earlier ones are kept');
  for (const f of ['README.md', 'docs/USER-GUIDE.md']) assert.doesNotMatch(read(f), /⛁ Orphans/, f + ' still says Orphans pill');
  assert.match(read('README.md'), /GAMESAUCE_MAX_UPLOAD/); assert.match(read('README.md'), /bulk\/lock/);
});

test('Reset also closes the open platform family row', () => {
  assert.match(read('public/modern.js'), /b\.id === 'tl-reset'\) \{ chipFamily = null;/);
});

test('Reset is live while a family row of platform pills is open, even with no platform picked', () => {
  assert.match(read('public/modern.js'), /ctx\.filtersActive\?\.\(\) \|\| chipFamily/);
});

test('details window keeps its previous / next row when the opened game leaves the list (e.g. matched while filtered to No cover)', () => {
  const app = read('public/app.js');
  assert.match(app, /if \(i >= 0\) state\.navSnap = ids\.slice\(\);/);
  assert.match(app, /state\.nav = \{ ids: state\.navSnap \}/);
  assert.ok((app.match(/state\.navSnap = null;/g) || []).length >= 5, 'every fresh open resets the snapshot');
});

test('Modern remembers Library vs Home across a refresh; refresh button left and larger; bigger A-Z, add-folder icon; calm light close button', () => {
  const js = read('public/modern.js'), css = read('public/modern.css');
  assert.match(js, /sessionStorage\.setItem\('gamesauce_mview', view\)/); assert.match(js, /was === 'library' \? 'library' : 'home'/);
  assert.match(read('public/app.js'), /removeItem\('gamesauce_mview'\)/);
  assert.match(css, /\.az-l \{[^}]*font-size: 1\.05rem/); assert.match(css, /\.emu-refresh-bar \{ display: flex; justify-content: flex-start;/);
  assert.match(css, /\.source-addfolder \.btn\[data-mi\]::before \{ width: 1\.7rem/);
  assert.match(css, /data-theme="light"\] body\.ui-modern #player-close \{ background: transparent/);
});

test('Health: Copy report works without HTTPS (older copy command, then a select-and-copy box)', () => {
  const app = read('public/app.js');
  assert.match(app, /navigator\.clipboard\?\.writeText/); assert.match(app, /document\.execCommand\('copy'\)/); assert.match(app, /id = 'health-report-box'/);
});

test('Library: total beside the platform heading, tighter spacing; add-folder uses source-add-2; pinned details release on other pages', () => {
  const js = read('public/modern.js'), css = read('public/modern.css'), app = read('public/app.js');
  assert.match(app, /class="lib-total"/); assert.match(css, /body\.ui-modern #result-count \{ display: none; \}/); assert.match(css, /\.filter-row \{ min-height: 0;/);
  assert.match(js, /\['\[data-act="add-folder"\]', 'source-add-2'\]/); assert.ok(fs.existsSync(new URL('../public/modern/icons/source-add-2.svg', import.meta.url)));
  assert.match(js, /const keepPinned = view === 'library' && document\.body\.classList\.contains\('details-pinned'\);/);
  // A pinned Steam game's details close on leaving Digital (and a ROM's on entering it); a Physical game's stay in Physical in the same way.
  assert.match(app, /function setView\(view\) \{\r?\n[^]*?const own = state\.openDigital \? 'digital' : state\.openPhysical != null \? 'physical' : 'library';\r?\n    if \(own === 'library' \? \(view === 'digital' \|\| view === 'physical' \|\| view === 'messages'\) : view !== own\) closeDrawer\(\);\r?\n  \}\r?\n  state\.view = view;/);
});

test('Modern details header: blurred cover backdrop with the pills and action icons laid on it, built from the existing elements', () => {
  const js = read('public/modern.js'), css = read('public/modern.css');
  assert.match(js, /function buildDetailHero\(/); assert.match(js, /buildDetailHero\(root\);/); assert.match(js, /hero\.append\(pills\)/); assert.match(js, /hero\.append\(cover, actions\)/);
  assert.match(css, /body\.ui-modern \.detail-hero \{ --bar-h: 4\.6rem; position: relative;/); assert.match(css, /\.hero-back \{[^}]*filter: blur\(26px\)/);
  assert.doesNotMatch(read('public/styles.css'), /detail-hero|hero-back/, 'Classic carries none of it');
});

test('My saves goes below the title, not inside the Modern details header', () => {
  assert.match(read('public/app.js'), /const hero = anchor\?\.closest\('\.detail-hero'\);/);
});

test('Details header controls are glass: translucent fill and border, genre pills centred, top strip see-through until scrolled', () => {
  const css = read('public/modern.css'), js = read('public/modern.js');
  assert.match(css, /\.detail-hero > \.genre-pills \{[^}]*justify-content: center/);
  assert.match(css, /\.drawer-bar \{ background: transparent;/); assert.match(css, /\.drawer-bar\.is-scrolled \{ background:/);
  assert.match(css, /backdrop-filter: blur\(8px\)/); assert.match(js, /classList\.toggle\('is-scrolled', d\.scrollTop > 8\)/);
  assert.doesNotMatch(css, /\.detail-hero > \.detail-actions \{[^}]*rgba\(10,12,18,\.5\)/, 'no solid bar behind the action icons');
});

test('genre pills sit below the previous / next row, not behind it', () => {
  assert.match(read('public/modern.css'), /\.detail-hero > \.genre-pills \{ position: absolute; top: calc\(var\(--bar-h\) \+ 1\.4rem\)/);
});

test('details header uses the stored screenshot as the backdrop when there is one, and keeps the blurred cover otherwise', () => {
  const app = read('public/app.js'), js = read('public/modern.js'), css = read('public/modern.css');
  assert.match(app, /data-shot="\/api\/roms\/\$\{rom\.id\}\/media\/screenshot"/);
  assert.match(js, /const shot = cover\.dataset\.shot;/); assert.match(js, /probe\.naturalWidth >= 200/); assert.match(js, /hero\.classList\.add\('has-shot'\)/);
  assert.match(css, /\.detail-hero\.has-shot \.hero-back \{ filter: blur\(7px\)/);
});

test('a refresh keeps every picked platform, not just the first (so a whole family stays selected)', () => {
  assert.match(read('public/app.js'), /const NAV_FIELDS = \['platform', 'extraPlatforms', 'q',/);
});

test('the download button in the details header is glass like the rest, not green', () => {
  const css = read('public/modern.css');
  assert.doesNotMatch(css, /\.ibtn:not\(\.ibtn-primary\)/); assert.doesNotMatch(css, /detail-hero > \.detail-actions \.ibtn-primary/);
});

test('no-green buttons: neutral outline, new icons wired, welcome tour and change password are icon-sized', () => {
  const css = read('public/modern.css'), js = read('public/modern.js');
  for (const id of ['#edit-form button[type="submit"]', '#new-collection', '#add-source', '#create-source', '#emu-upload-form button[type="submit"]', '#profile-upload', '#welcome-again', '#password-form button[type="submit"]', '#dat-upload', '#names-apply', '#covers-apply', '#dup-hide-all', '#backup-download', '#backup-save', '#platform-add-toggle'])
    assert.ok(css.includes('body.ui-modern ' + id + ',') || css.includes('body.ui-modern ' + id + ' {'), 'neutral rule for ' + id);
  for (const [sel, name] of [["'#new-collection', 'add-collection'", 'add-collection'], ["'#add-source, #empty-add-source', 'source-add-2'", 'source-add-2'], ["'#create-source', 'source-add-and-scan-2'", 'source-add-and-scan-2'], ["'save-to-vault-2'", 'save-to-vault-2'], ["'#welcome-again', 'welcome-tour-2'", 'welcome-tour-2'], ["'#password-form button[type=\"submit\"]', 'save-password'", 'save-password'], ["'#covers-preview', 'preview-2'", 'preview-2'], ["'#names-preview', 'preview-2'", 'preview-2'], ["'#backup-save', 'save-settings-2'", 'save-settings-2'], ["'#platform-add-toggle', 'add-platform-2'", 'add-platform-2']]) {
    assert.ok(js.includes(sel), 'wired: ' + sel); assert.ok(fs.existsSync(new URL('../public/modern/icons/' + name + '.svg', import.meta.url)), name + '.svg exists');
  }
  assert.match(css, /#welcome-again, body\.ui-modern #password-form button\[type="submit"\] \{ width: 3\.4rem;/);
});

test('the change-password icon rule comes after the general settings-form rule, so it is not overwritten', () => {
  const js = read('public/modern.js');
  assert.ok(js.indexOf("'#password-form button[type=\"submit\"]', 'save-password'") > js.indexOf("'#view-settings form button.btn-primary[type=\"submit\"]', 'save-settings'"));
});

test('icons on the neutral (formerly green) buttons use the text colour, so they show on the light theme too', () => {
  const css = read('public/modern.css');
  for (const id of ['#add-source', '#welcome-again', '#names-apply', '#backup-save', '#platform-add-toggle', '#edit-form button[type="submit"]'])
    assert.ok(css.includes('body.ui-modern ' + id + '[data-mi]::before'), id);
  assert.match(css, /\[data-mi\]::before \{ background: currentColor; \}\n\/\* Welcome tour/);
});

test('Add user, provider Save, Download database and the empty-state Add folder are neutral too, with icons that show on both themes', () => {
  const css = read('public/modern.css'), js = read('public/modern.js');
  for (const id of ['#new-user-form button[type="submit"]', '[data-act="save-provider"]', '[data-act="lb-update"]', '#empty-add-source']) { assert.ok(css.includes('body.ui-modern ' + id + ',') || css.includes('body.ui-modern ' + id + ' {'), id); assert.ok(css.includes('body.ui-modern ' + id + '[data-mi]::before'), id + ' icon'); }
  assert.match(js, /\['#add-source, #empty-add-source', 'source-add-2'\]/);
});

test('every primary button with an icon is neutral in Modern (sign-in and the welcome wizard excepted)', () => {
  const css = read('public/modern.css');
  assert.match(css, /\.btn-primary\[data-mi\]:not\(#login-submit\):not\(\[id\^="wz-"\]\) \{ background: var\(--panel\);/);
  assert.match(css, /\.btn-primary\[data-mi\]:not\(#login-submit\):not\(\[id\^="wz-"\]\)::before \{ background: currentColor; \}/);
});

test('chips: no coloured left edge, family chips round and tall like platform chips, glow on hover', () => {
  const css = read('public/modern.css');
  assert.match(css, /\.chip\[style\*="--chip-c"\]:hover \{[^}]*box-shadow: 0 0 0 1px var\(--chip-c\), 0 0 14px/);
  assert.doesNotMatch(css, /border-left-color: var\(--chip-c\)/);
});

test('Modern: every chip is a rounded square, selected chips glow, platform Save uses the save-platform icon', () => {
  const css = fs.readFileSync(new URL('../public/modern.css', import.meta.url), 'utf8'), js = fs.readFileSync(new URL('../public/modern.js', import.meta.url), 'utf8');
  assert.match(css, /body\.ui-modern \.chip \{ display: inline-flex; align-items: center; gap: 0\.4rem; height: 2\.1rem;[^}]*border-radius: 0\.65rem;/);
  assert.match(css, /body\.ui-modern \.chip\.on \{ box-shadow: 0 0 0 1px color-mix/);
  assert.ok(js.includes("'save-platform'")); assert.ok(fs.existsSync(new URL('../public/modern/icons/save-platform.svg', import.meta.url)));
});

test('Modern: the health Repair button for missing covers has an icon', () => {
  assert.ok(fs.readFileSync(new URL('../public/modern.js', import.meta.url), 'utf8').includes("['#health-repair-covers', 'recheck']"));
});

test('Settings > Platforms and Sources can be folded by family, and the choice is remembered', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(app, /function makeFoldable\(container, headSelector, scope, nameOf\)/);
  assert.match(app, /makeFoldable\(wrap, '\.source-family', 'sources'/);
  assert.match(app, /makeFoldable\(list, '\.fam-head', 'platforms'/);
  assert.match(app, /localStorage\.setItem\(key, JSON\.stringify\(\[\.\.\.folded\]\)\)/);
  assert.match(css, /\.fold-hidden \{ display: none !important; \}/);
});

test('Modern Home: a search box with a platform list sits above Continue playing and opens the Library with the results', () => {
  const js = fs.readFileSync(new URL('../public/modern.js', import.meta.url), 'utf8'), css = fs.readFileSync(new URL('../public/modern.css', import.meta.url), 'utf8');
  assert.ok(js.indexOf('id="mh-search"') > 0 && js.indexOf('id="mh-search"') < js.indexOf('class="strips mh-strips"'), 'above the strips');
  assert.match(js, /id="mh-plat"/); assert.match(js, /function submitHomeSearch\(\)/); assert.match(js, /Object\.assign\(st, \{ platform: plat, extraPlatforms: \[\], q: text \}\)/);
  assert.match(js, /go\('library'\);\s*ctx\.loadLibrary/);
  assert.match(css, /body\.ui-modern \.mh-search \{ display: flex;/);
});

test('Digital page: view, Steam panel, nav entries and launch link exist', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), js = fs.readFileSync(new URL('../public/modern.js', import.meta.url), 'utf8');
  assert.match(html, /id="view-digital"/); assert.match(html, /id="mod-steam"/); assert.match(html, /data-view="digital"/);
  const dgjs = fs.readFileSync(new URL('../public/digital.js', import.meta.url), 'utf8');
  assert.match(js, /view: 'digital'/); assert.match(dgjs, /async function loadDigital\(keep = false\)/); assert.match(app, /if \(view === 'digital'\) digital\.load\(\);/);
  assert.match(app, /modules: \['profile', 'welcome', 'steam', 'password', 'controller', 'playpc'\]/);
  assert.ok(!/dg-card[^`]*download/.test(dgjs), 'no download on a digital tile');
});

test('Digital tiles show the store badge icon in Modern and the word in Classic', () => {
  const css = fs.readFileSync(new URL('../public/modern.css', import.meta.url), 'utf8'), cls = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.ok(fs.existsSync(new URL('../public/modern/icons/steam-badge.svg', import.meta.url)));
  assert.match(css, /body\.ui-modern \.dg-badge \.dg-badge-ico \{[^}]*steam-badge\.svg/);
  assert.match(css, /body\.ui-modern \.dg-badge \.dg-badge-txt \{ display: none; \}/);
  assert.match(cls, /\.dg-badge-ico \{ display: none; \}/);
});

test('the new logo files: square badge for icon uses, wide logo on the sign-in card, both plain vectors with no live text', () => {
  for (const f of ['public/logo.svg', 'public/logo-wide.svg']) { const s = read(f); assert.match(s, /viewBox=/); assert.doesNotMatch(s, /<image|base64|<text/, f + ' is a true vector with the text as shapes'); }
  assert.match(read('public/logo.svg'), /viewBox="0 0 128 128"/);
  assert.match(read('public/index.html'), /class="brand-logo auth-logo" src="\/logo-wide\.svg"/);
});

test('the Digital grid is the scroll area (like the Library), so its scrollbar sits inside the content', () => {
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#view-digital \{ overflow: hidden; \}/);
  assert.match(css, /\.dg-grid \{ flex: 1 1 auto; min-height: 0; overflow-y: auto;/);
});

test('Modern details header: the More menu opens upward so the header cannot clip it', () => {
  const css = fs.readFileSync(new URL('../public/modern.css', import.meta.url), 'utf8');
  assert.match(css, /body\.ui-modern \.detail-hero \.more-menu \{ top: auto; bottom: calc\(100% \+ 0\.5rem\);/);
});

test('Digital tiles: heart, hide and play switch, Favourites and Show hidden chips, marks keep the scroll position', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), dgjs = fs.readFileSync(new URL('../public/digital.js', import.meta.url), 'utf8');
  assert.match(dgjs, /data-dg-mark="favourite"/); assert.match(dgjs, /data-dg-mark="hidden"/); assert.match(dgjs, /data-dg-mark="play"/);
  assert.match(dgjs, /data-dg-toggle="fav"/); assert.match(dgjs, /data-dg-toggle="hidden"/); assert.match(dgjs, /Show hidden/);
  assert.match(dgjs, /scroller\.scrollTop = keepTop/);
  assert.match(app, /your favourites, hidden games and play-button choices/);
});

test('Steam details window: opened from a tile, trimmed actions, cover fallback', () => {
  const app = fs.readFileSync(new URL('../public/digital.js', import.meta.url), 'utf8');
  assert.match(app, /async function openDigitalDetail\(store, appId\)/);
  assert.match(app, /openDigitalDetail\(tile\.dataset\.dgStoreOf, tile\.dataset\.dgApp\)/);
  const body = app.slice(app.indexOf('function renderSteamDetail'), app.indexOf('function renderConsoleDetail'));
  for (const gone of ['download', 'data-act="delete"', 'data-act="refresh"', 'data-act="keep"', 'more-btn', 'identify-q']) assert.ok(!body.includes(gone), gone + ' is not offered for a Steam game');
  assert.match(app, /data-fb="\$\{esc\(g\.cover_fallback_url/);
});

test('Digital: prev/next, A-Z, grid size, back to top; Home/Library reset; chip hover says turn on / off', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), js = fs.readFileSync(new URL('../public/modern.js', import.meta.url), 'utf8'), html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const dgjs = fs.readFileSync(new URL('../public/digital.js', import.meta.url), 'utf8');
  assert.match(dgjs, /function stepDigital\(dir\)/); assert.match(dgjs, /function syncDigitalNav\(\)/);
  assert.match(app, /state\.openRomId == null && state\.openDigital/);
  assert.match(html, /id="dg-letters"/); assert.match(html, /data-dg-density="compact"/); assert.match(html, /id="dg-top"/);
  assert.match(js, /click to \$\{picked\.has\(p\.slug\) && !wholeNow \? 'turn off' : 'turn on'\}/);
  assert.doesNotMatch(js, /\(click to remove\)/);
  assert.match(js, /if \(v === 'home' \|\| v === 'library'\) \{ chipFamily = null; ctx\.resetDigital\?\.\(\);/);
  assert.match(app, /modern\.initModern\(\{ closeDrawer, resetDigital: digital\.reset,/);
});

test('playable-in-browser marker glows green like the Steam play switch; Digital grid shares the Library scrollbar', () => {
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8'), app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /<span class="card-play" title="Playable in the browser"/);
  assert.match(css, /\.card-cover \.card-play \{\s*display: grid;[^}]*color: #4ade80;[^}]*box-shadow: 0 0 0\.6rem rgba\(74, 222, 128/);
  assert.match(css, /\.dg-grid::-webkit-scrollbar-thumb \{ background: var\(--line-2\)/);
});

test('Digital tiles: heart and hide icons appear on hover like the Library, hidden games keep their Unhide icon', () => {
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.dg-card \.card-fav, \.dg-card \.card-hide \{ opacity: 1; \}/);
  assert.match(css, /\.dg-card\.is-hidden \.card-hide \{ opacity: 1; \}/);
});

test('Digital: an Installed chip beside Favourites', () => {
  const app = fs.readFileSync(new URL('../public/digital.js', import.meta.url), 'utf8');
  assert.match(app, /data-dg-toggle="installed"/); assert.match(app, /params\.set\('installed', '1'\)/);
});

test('Welcome tour: an optional Steam step after the picture card, for everyone', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const cards = app.slice(app.indexOf('function welcomeCards(isAdmin)'), app.indexOf('function startWelcome'));
  const ids = [...cards.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids.slice(0, 5), ['hello', 'password', 'picture', 'steam', 'providers']);
  assert.match(app, /steam: wireSteamCard/); assert.match(app, /function wireSteamCard\(\)/);
  assert.match(app, /api\('\/digital\/steam\/sync', \{ method: 'POST' \}\);\s*form\.key\.value = ''/);
});

test('A-Z jump: the Library list starts AT the letter (one request, offset), Digital resets to the top, Reset clears the jump', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), js = fs.readFileSync(new URL('../public/modern.js', import.meta.url), 'utf8');
  assert.match(app, /state\.azFor !== state\.libQuery\.toString\(\) \+ '\|' \+ state\.sort\) state\.azOffset = 0/);
  assert.match(app, /params\.set\('offset', String\(azBase \+ loaded\)\)/);
  assert.match(app, /state\.azOffset = 0; state\.azLetter = null; state\.azFor = null;/);
  assert.match(app, /if \(!keepPlace\) grid\.scrollTop = 0;/);
  const jump = js.slice(js.indexOf('async function jumpTo(letter)'), js.indexOf('function offsetOf') > js.indexOf('async function jumpTo') ? js.length : undefined);
  assert.match(js, /s\.azOffset = same \? 0 : offsetOf\(letter\);\s*s\.azLetter = same \? null : letter;/);
  assert.match(js, /await ctx\.loadLibrary\(\);\s*\/\/ one request that starts at the letter's first game/);
  assert.doesNotMatch(js, /while \(\(s\.libLoadedCount\?\.\(\) \|\| 0\) <= want/, 'no more loading every tile before the letter');
  assert.match(fs.readFileSync(new URL('../public/digital.js', import.meta.url), 'utf8'), /grid\.scrollTop = 0;\s*dg\.ids = items\.map/, 'Digital: a new list starts at its top');
});

test('Proxmox installer: generates a random secret key, writes it to the env file and prints it once', () => {
  const sh = fs.readFileSync(new URL('../install/proxmox-lxc.sh', import.meta.url), 'utf8');
  assert.match(sh, /SECRET_KEY="\$\(openssl rand -hex 32\)"/);
  assert.match(sh, /GAMESAUCE_SECRET_KEY=\$SECRET_KEY\nENV\nchmod 600 \/etc\/game-sauce\.env/);
  assert.match(sh, /SECRET_KEY="\$SECRET_KEY" bash \/root\/gs-install\.sh/);
  assert.match(sh, /Secret key  \$SECRET_KEY/);
});

test('Digital grid draws in chunks and has no blur on its tiles (iPhone/iPad froze with thousands drawn at once)', () => {
  const app = fs.readFileSync(new URL('../public/digital.js', import.meta.url), 'utf8'), css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(app, /function dgRender\(reset\)/); assert.match(app, /dg\.shown = dg\.rendered \+ 60/);
  assert.match(app, /const dgIds = \(\) => dg\.ids \|\| \[\];/);
  assert.match(app, /loadDigital\(true\); if \(scroller\)/);
  assert.match(css, /\.dg-card \.card-fav, \.dg-card \.card-hide, \.dg-card \.card-badge, \.dg-card \.dg-hours \{[^}]*backdrop-filter: none/);
});

test('WebKit (Mac and Linux): native controls follow the look, the Digital tiles do not use content-visibility, and the shelf back panel is flat', () => {
  const css = read('public/styles.css'), ph = read('public/physical.css');
  assert.match(css, /:root \{\s*color-scheme: dark;/, 'dark by default: drop-downs and text boxes are not drawn white with pale text');
  assert.ok(read('public/modern.css').includes('html[data-theme="light"]:has(body.ui-modern) { color-scheme: light; }'), 'the Modern light look stays light');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /content-visibility/, 'tiles collapsed to their top edge in some WebKit versions');
  assert.match(ph, /\.ph-row \{[^}]*background: #07080b;/, 'a flat dark back panel');
  assert.doesNotMatch(ph.slice(ph.indexOf('.ph-row {'), ph.indexOf('.ph-books {')), /gradient/, 'no gradients on the shelf back (they band on some screens)');
});
