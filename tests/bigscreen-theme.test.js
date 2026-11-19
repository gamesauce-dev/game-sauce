import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-bstheme-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'tadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 't-admin-password-1';

let server, base, tok, db;
const call = async (p, { method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'tadmin', password: 't-admin-password-1' }) })).json()).token;
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('the Big Screen look is a per-person setting: a known theme is kept, anything else is refused, none clears it', async () => {
  assert.equal((await call('/api/prefs/bs_theme', { method: 'PUT', body: { value: 'xbox360' } })).status, 200);
  assert.equal((await call('/api/prefs')).body.bs_theme, 'xbox360');
  assert.equal((await call('/api/prefs/bs_theme', { method: 'PUT', body: { value: 'nonsense' } })).status, 400);
  assert.equal((await call('/api/prefs/bs_theme', { method: 'PUT', body: { value: null } })).status, 200);
  assert.equal((await call('/api/prefs')).body.bs_theme, undefined, 'the standard look keeps no setting');
});

test('Big Screen takes its look from the setting, and every theme rule stays inside its own class', () => {
  const js = read('public/bigscreen.js'), app = read('public/app.js'), html = read('public/index.html'), css = read('public/bs-themes.css');
  assert.ok(js.includes("root.classList.add('bs-theme-' + th)") && js.includes('host.theme'), 'the root gets bs-theme-<name>');
  assert.ok(app.includes("theme: () => state.prefs?.bs_theme") && app.includes('id="bstheme-picker"') === false && html.includes('id="bstheme-picker"'), 'the picker and the hand-over');
  assert.ok(html.includes('/bs-themes.css'));
  // the look is for its own consoles only: it is put on and taken off as the screens change
  assert.ok(js.includes("THEME_CONSOLES = { xbox360: new Set(['xbox', 'xbox360', 'xbla', 'xboxone', 'xboxseries'])"));
  for (const call of ["useTheme(null); st.screen = 'platforms'", "useTheme(srcSlug()); st.screen = 'games'", "useTheme(g.platform); st.screen = 'game'", "const backToWheel = () => { useTheme(srcSlug());"]) assert.ok(js.includes(call), call);
  assert.ok(!js.includes("root.classList.add('bs-theme-' + th); }"), 'no theme class is put on when Big Screen opens');
  // without a theme nothing changes: each selector in the theme file starts from the theme's class
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((b) => b.split('{')[0].trim()).filter(Boolean).flatMap((s) => s.split(',').map((x) => x.trim())).filter((x) => !/^@|^(from|to)$/.test(x));
  assert.ok(selectors.length > 20);
  for (const s of selectors) assert.match(s, /^\.bs(\.bs)?-theme-xbox360([ .]|$)/, 'scoped: ' + s);
  // a logo set to have a light backing (or every logo, if the person asked) gets a class the look draws a plate with; Favourites and Collections keep their colours
  assert.ok(js.includes("plated = (x) => (x.plate || x.logo_plate || host.plateAll?.()") && js.includes('family_logo_plate') && app.includes("plateAll: () => state.prefs?.chip_plate === 'on'"));
  assert.ok(css.includes('img.bs-plate') && css.includes('.bs-ptile.bs-t-fav') && css.includes('.bs-ptile.bs-t-colls'));
  // the Blades layout of the games screen: drawn only with the Xbox 360 look, and the standard wheel is still what every other look gets
  assert.ok(js.includes("const blades = () => root.classList.contains('bs-theme-xbox360')") && js.includes("if (blades()) { $('#bs-main').innerHTML = bladesShell(); placeBlades(); return; }"));
  assert.ok(js.includes('const placeGames = () => (blades() ? placeBlades() : placeWheel())') && js.includes("st.gi = Math.max(0, Math.min(st.games.length - 1, i)); placeGames();"), 'moving through the games redraws whichever layout is on');
  assert.ok(js.includes(".bs-row, .bs-bl-row"), 'a click on a row works in both layouts');
  for (const c of ['.bs-bl-row.on', '.bs-bl-l', '.bs-bl-r', '.bs-bl-shot.cover']) assert.ok(css.includes('.bs-theme-xbox360 ' + c), c);
  // the Blades details: two tabs on each blade, the platform's logo (or its name) in the header and on every row, and a game's video playing without sound in the picture's place
  assert.ok(js.includes("bladeSvg(true, m.left)") && js.includes("bladeSvg(false, m.right)") && js.includes('preserveAspectRatio="none"') && !js.includes("bs-tab"), "the blades are a drawing of stacked bands");
  // the blades lead somewhere: the Xbox platforms in order, with left and right changing blade; a band with no platform has no words
  assert.ok(js.includes("THEME_CONSOLES.xbox360.has(p.slug)") && js.includes("const switchBlade = (to)") && js.includes("enterSource({ kind: 'platform', slug: t.slug, name: t.name, plat: t })"));
  assert.ok(js.includes("if (blades() && (a === 'left' || a === 'right'))") && js.includes("switchBlade(m.i0 + (a === 'left' ? -1 : 1))") && js.includes("e.target.closest('.bs-bl-lab')"));
  assert.ok(js.includes("if (!b?.p) return '';") && js.includes("bs-bl-lab cur") && js.includes('data-bi="${b.i}"') && css.includes(".bs-theme-xbox360 .bs-bl-lab"), "a band with no platform has no words; the current one names itself; the others lead somewhere");
  assert.ok(js.includes("sfx('whoosh')") && js.includes("kind === 'whoosh'") && css.includes("@keyframes bs-slide-r") && css.includes("prefers-reduced-motion"), "changing blade slides the middle in and whooshes, and stays still for reduced motion");
  // the coloured controller buttons on the screen (A green, B red, X blue, Y yellow) replace the bottom bar of hints, the artwork box holds the game's other pictures, and the description has a fixed height that glides
  assert.ok(js.includes("<i data-k=\"${b}\">${b}</i>") && js.includes("btn('Y', 'Play on this PC')") && js.includes("btn('A', 'Open', true)") && js.includes("root.classList.add('bs-bl-on')"));
  assert.ok(js.includes("autoScroll('#bs-bl-scroll', '#bs-bl-scrollin')") && js.includes('class="bs-bl-art"'));
  for (const k of ['A', 'B', 'X', 'Y']) assert.ok(css.includes(`.bs-xb i[data-k="${k}"]`), k);
  assert.ok(css.includes('.bs-theme-xbox360.bs-bl-on .bs-hints { display: none; }') && css.includes('.bs-theme-xbox360 .bs-bl-desc { flex: 0 0 auto; height: 5.8em;'));
  assert.ok(js.includes("const logoImg = (p, cls)") && js.includes("logoImg(src.plat, 'bs-bl-hlogo')") && js.includes("logoImg(st.plats.find((p) => p.slug === g.platform), 'bs-bl-plogo')"));
  assert.ok(js.includes('if (g.has_video) st.vidT = setTimeout(') && js.includes('v.muted = true') && js.includes('clearTimeout(st.vidT)'), 'the video starts once the highlight rests, is silent, and is cleared on leaving');
  for (const c of ['.bs-bl-shot.video video', '.bs-bl-plogo', '.bs-bl-hlogo']) assert.ok(css.includes('.bs-theme-xbox360 ' + c), c);
  assert.ok(css.includes(".bs-theme-xbox360 .bs-xbl .bs-xb:first-child { margin-left") && css.includes(".bs-theme-xbox360 .bs-xbr .bs-xb:first-child { margin-right"), "the buttons are staggered");
  // inspired by, not copied: no outside address, no font file, no picture
  assert.ok(!/url\(|@font-face|https?:/i.test(css), 'plain gradients and system fonts only');
});
