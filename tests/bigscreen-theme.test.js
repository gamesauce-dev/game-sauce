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
  // without a theme nothing changes: each selector in the theme file starts from the theme's class
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((b) => b.split('{')[0].trim()).filter(Boolean).flatMap((s) => s.split(',').map((x) => x.trim()));
  assert.ok(selectors.length > 20);
  for (const s of selectors) assert.match(s, /^\.bs(\.bs)?-theme-xbox360( |$)|^\.bs\.bs-theme-xbox360$/, 'scoped: ' + s);
  // a logo set to have a light backing (or every logo, if the person asked) gets a class the look draws a plate with; Favourites and Collections keep their colours
  assert.ok(js.includes("plated = (x) => (x.plate || x.logo_plate || host.plateAll?.()") && js.includes('family_logo_plate') && app.includes("plateAll: () => state.prefs?.chip_plate === 'on'"));
  assert.ok(css.includes('img.bs-plate') && css.includes('.bs-ptile.bs-t-fav') && css.includes('.bs-ptile.bs-t-colls'));
  // inspired by, not copied: no outside address, no font file, no picture
  assert.ok(!/url\(|@font-face|https?:/i.test(css), 'plain gradients and system fonts only');
});
