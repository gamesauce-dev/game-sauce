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
  const loose = rules.filter((sel) => !/ui-modern/.test(sel) && !/^\.(modern-bar|modern-home|chip-rows|az-bar)/.test(sel) && !/^@(media|keyframes)/.test(sel) && !/^(from|to|\d+%)$/.test(sel) && !/^\.m[bh]-/.test(sel));
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
  assert.match(css, /repeat\(auto-fill, minmax\(5\.6rem, 1fr\)\)/, 'one tile size for both boxes');
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

test('A-Z jump, grid size and back to top sit above the grid and work from the list as sorted', () => {
  const js = read('public/modern.js'), css = read('public/modern.css'), html = read('public/index.html');
  assert.match(html, /id="az-bar"/);
  assert.match(js, /\['#', \.\.\.'ABCDEFGHIJKLMNOPQRSTUVWXYZ'\]/);
  assert.match(js, /s === 'title' \? 1 : s === '-title' \? -1 : 0/, 'only offered while sorted by title, either way');
  assert.match(js, /libLoadMore/, 'it loads further pages until the letter exists, then scrolls');
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
  assert.match(css, /\.chip\.on\.part \{[^}]*dashed/);
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
  assert.match(js, /\['#create-source', 'source-add-and-scan'\]/);
  assert.ok(fs.existsSync(new URL('../public/modern/icons/source-add-and-scan.svg', import.meta.url)));
  assert.match(read('public/modern/icons/source-add-and-scan.svg'), /currentColor/);
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
  for (const [sel, n] of [['#drawer-prev', 'arrow-left'], ['#drawer-next', 'arrow-right'], ['#identify-search', 'search'], ['#edit-form button[type="submit"]', 'save'], ['[data-promo="addcoll"]', 'collection-grid'], ['[data-promo="refresh"]', 'scan-again'], ['#new-collection', 'collection-new']]) {
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
  for (const n of ['select-2', 'done', 'collection-new', 'system', 'clear-reset', 'hidden', 'visible']) assert.ok(fs.existsSync(new URL(`../public/modern/icons/${n}.svg`, import.meta.url)), n);
  for (const s of ["['#bulk-selectall', 'select-2']", "['#bulk-system-btn', 'system']", "['#bulk-clearmatch-btn', 'clear-reset']", "['#bulk-cancel', 'done']", "['#bulk-addcoll', 'collection-new']"]) assert.ok(js.includes(s), s);
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
  assert.ok(js.includes("{ view: 'collections', icon: 'collection-new'"));
  assert.ok(js.includes("'[data-promo=\"addcoll\"]', 'collection-new'") || js.includes('data-promo="addcoll"]\', \'collection-new\''));
});

test('Settings icon swaps (upload-cover, replace-text, covers, database-check, providers-2, Library, game-controller, backup-save)', () => {
  const js = read('public/modern.js'), app = read('public/app.js');
  for (const s of ["['#profile-upload', 'upload-cover']", "['#dat-rematch-force', 'replace-text']", "['#db-health-refresh', 'database-check']", "['#platform-add-toggle', 'game-controller']", "['#backup-run', 'database-backup-save']"]) assert.ok(js.includes(s), s);
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
  assert.ok(js.includes("['#addcoll-new', 'collection-new']")); assert.ok(js.includes('#collection-create'));
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
