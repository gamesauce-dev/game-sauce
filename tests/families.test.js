import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-fam-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'fadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'f-admin-password-1';
let server, base, db, tok, memberTok;
const call = async (p, { method = 'GET', body, token } = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || tok) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok = await login('fadmin', 'f-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'fmember', password: 'f-member-password-1', role: 'user' } });
  memberTok = await login('fmember', 'f-member-password-1');
});
after(async () => { await new Promise((r) => server?.close(r)); db?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
const fam = (slug) => db.prepare('SELECT family FROM platforms WHERE slug = ?').get(slug).family;

test('rename a family for every platform in it; members cannot; nothing but the label changes', async () => {
  assert.equal((await call('/api/platforms/families/rename', { method: 'POST', token: memberTok, body: { from: 'NEC / SNK', to: 'X' } })).status, 403);
  const before = db.prepare("SELECT slug, screenscraper_id, tgdb_id, name FROM platforms WHERE family = 'NEC / SNK' ORDER BY slug").all();
  assert.ok(before.length >= 2);
  const r = await call('/api/platforms/families/rename', { method: 'POST', body: { from: 'NEC / SNK', to: 'NEC and SNK' } });
  assert.equal(r.status, 200); assert.equal(r.body.changed, before.length); assert.equal(r.body.merged, false);
  const after = db.prepare("SELECT slug, screenscraper_id, tgdb_id, name FROM platforms WHERE family = 'NEC and SNK' ORDER BY slug").all();
  assert.deepEqual(after, before, 'same platforms, same provider ids and names: only the family label moved');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM platforms WHERE family = 'NEC / SNK'").get().n, 0);
  assert.equal((await call('/api/platforms/families/rename', { method: 'POST', body: { from: 'Nope', to: 'Y' } })).status, 404);
  assert.equal((await call('/api/platforms/families/rename', { method: 'POST', body: { from: 'NEC and SNK', to: '  ' } })).status, 400);
});

test('renaming onto an existing family merges them; a different case joins the existing group instead of making a new one', async () => {
  const sega = db.prepare("SELECT COUNT(*) n FROM platforms WHERE family = 'Sega'").get().n;
  const nec = db.prepare("SELECT COUNT(*) n FROM platforms WHERE family = 'NEC and SNK'").get().n;
  const r = await call('/api/platforms/families/rename', { method: 'POST', body: { from: 'NEC and SNK', to: 'sega' } });
  assert.equal(r.body.merged, true); assert.equal(r.body.to, 'Sega', 'typed in lower case, joined the existing "Sega"');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM platforms WHERE family = 'Sega'").get().n, sega + nec);
  // editing one platform with a different-case family does the same
  await call('/api/platforms/nes', { method: 'PATCH', body: { family: 'NINTENDO' } });
  assert.equal(fam('nes'), 'Nintendo');
  // a brand-new family is kept as typed
  await call('/api/platforms/nes', { method: 'PATCH', body: { family: 'My handhelds' } });
  assert.equal(fam('nes'), 'My handhelds');
  // metadata lookups read the platform's slug and provider ids, never the family
  const src = fs.readFileSync(new URL('../src/lib/providers.js', import.meta.url), 'utf8');
  assert.equal(/\.family\b/.test(src), false);
});

test('the page offers existing families as suggestions and a Rename on each family heading', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /<datalist id="family-list">/); assert.match(html, /name="family"[^>]*list="family-list"/);
  assert.match(app, /data-fam-rename/); assert.match(app, /\/platforms\/families\/rename/); assert.match(app, /data-pf="family"[^>]*list="family-list"/);
});

import { usable, FAMILY_DEFAULTS, contrast } from '../src/lib/colours.js';
test('colour guardrails: unreadable colours are refused, every built-in default is accepted, text colour is never the chip colour', () => {
  assert.equal(usable('#000000').ok, false, 'black vanishes on the dark theme');
  assert.equal(usable('#0a0a0a').ok, false);
  assert.equal(usable('#ffffff').ok, false, 'white vanishes on the light theme');
  assert.equal(usable('#fdfdfd').ok, false);
  assert.equal(usable('red').ok, false); assert.equal(usable('#12345').ok, false); assert.equal(usable('').ok, false);
  assert.equal(usable('#E60012').ok, true); assert.equal(usable('#E60012').colour, '#e60012', 'stored in lower case');
  for (const [f, c] of Object.entries(FAMILY_DEFAULTS)) assert.equal(usable(c).ok, true, `default for ${f} must pass its own guardrail`);
  assert.ok(contrast('#ffffff', '#000000') > 20);
});

test('family colour: set, refused when unreadable, reset to the default, listed with the platforms; members cannot; rename keeps it', async () => {
  assert.equal((await call('/api/platforms/families/colour', { method: 'PUT', token: memberTok, body: { family: 'Sega', colour: '#112233' } })).status, 403);
  const list = async () => (await call('/api/platforms')).body.items;
  const sega0 = (await list()).find((p) => p.family === 'Sega').family_colour;
  assert.equal(sega0, FAMILY_DEFAULTS.Sega, 'a built-in family has a sensible default straight away');
  const ok = await call('/api/platforms/families/colour', { method: 'PUT', body: { family: 'Sega', colour: '#33AA55' } });
  assert.equal(ok.status, 200); assert.equal(ok.body.colour, '#33aa55');
  assert.equal((await list()).find((p) => p.family === 'Sega').family_colour, '#33aa55');
  const bad = await call('/api/platforms/families/colour', { method: 'PUT', body: { family: 'Sega', colour: '#000000' } });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /too dark/);
  assert.equal((await list()).find((p) => p.family === 'Sega').family_colour, '#33aa55', 'a refused colour changes nothing');
  assert.equal((await call('/api/platforms/families/colour', { method: 'PUT', body: { family: 'Nope', colour: '#33aa55' } })).status, 404);
  // renaming keeps the colour with the family
  await call('/api/platforms/families/rename', { method: 'POST', body: { from: 'Sega', to: 'Sega consoles' } });
  assert.equal((await list()).find((p) => p.family === 'Sega consoles').family_colour, '#33aa55');
  // reset goes back to the built-in default for that name, or grey for a custom family
  const r = await call('/api/platforms/families/colour', { method: 'PUT', body: { family: 'Sega consoles', colour: '' } });
  assert.equal(r.body.reset, true); assert.equal((await list()).find((p) => p.family === 'Sega consoles').family_colour, '#6b7280');
  await call('/api/platforms/families/rename', { method: 'POST', body: { from: 'Sega consoles', to: 'Sega' } });
  assert.equal((await list()).find((p) => p.family === 'Sega').family_colour, FAMILY_DEFAULTS.Sega);
});

test('Modern chips: tint, no icon, bold; family colour picker in Settings', () => {
  const css = fs.readFileSync(new URL('../public/modern.css', import.meta.url), 'utf8'), js = fs.readFileSync(new URL('../public/modern.js', import.meta.url), 'utf8'), app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(css, /\.chip\[style\*="--chip-c"\] \{ font-weight: 700; height: 2\.1rem; border-radius: 0\.65rem;/);
  assert.match(css, /\.chip\.plat \.plat-ico \{ display: none; \}/);
  assert.match(js, /data-chip-plat="\$\{esc\(p\.slug\)\}" style="--chip-c:/); assert.ok(!/class="chip plat[^`]*\$\{ctx\.platformIconSvg/.test(js), 'the chip no longer draws the platform icon');
  assert.match(app, /data-fam-colour=/); assert.match(app, /\/platforms\/families\/colour/);
});
