import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// logos.js reaches the database through coverzip.js, so it is loaded only after this test has chosen its own data folder
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-logo-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'ladmin2';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'l-admin-password-2';
const { sniffLogo } = await import('../src/lib/logos.js');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
const svg = (body) => Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' + body + '</svg>');

test('logo files: pictures and plain SVG are accepted; SVG with scripts, handlers or outside links, and non-pictures, are refused', () => {
  assert.equal(sniffLogo(PNG).type, 'image/png');
  assert.equal(sniffLogo(svg('<rect width="10" height="10" fill="red"/>')).type, 'image/svg+xml');
  assert.equal(sniffLogo(svg('<defs><linearGradient id="a"/></defs><rect fill="url(#a)" width="1" height="1"/><use href="#a"/>')).type, 'image/svg+xml', 'references inside the drawing are fine');
  for (const bad of ['<script>alert(1)</script>', '<rect onclick="x()" width="1" height="1"/>', '<foreignObject><div/></foreignObject>', '<image href="https://example.org/x.png"/>', '<a href="javascript:alert(1)"><rect/></a>', '<style>@import url(https://example.org/x.css);</style>', '<rect style="fill:url(https://example.org/x)"/>']) {
    assert.ok(sniffLogo(svg(bad)).error, 'refused: ' + bad);
  }
  assert.equal(sniffLogo(Buffer.from('just some text that is long enough to count')), null);
  assert.equal(sniffLogo(Buffer.from('<html><svg></svg></html> padding padding')), null);
});

let server, base, db, tok, memberTok;
const post = async (p, buf, { token, name = 'logo.png', type = 'image/png' } = {}) => {
  const f = new FormData(); f.append('logo', new Blob([buf], { type }), name);
  const res = await fetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer ' + (token || tok) }, body: f });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const call = async (p, { method = 'GET', body, token } = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || tok) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), res };
};
before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok = await login('ladmin2', 'l-admin-password-2');
  const mk = await call('/api/auth/users', { method: 'POST', body: { username: 'lmember2', password: 'l-member-password-2', role: 'user' } });
  if (mk.status !== 201) throw new Error('create member: ' + mk.status + ' ' + JSON.stringify(mk.body));
  memberTok = await login('lmember2', 'l-member-password-2');
  if (!memberTok) throw new Error('member login failed: ' + JSON.stringify(await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lmember2', password: 'l-member-password-2' }) })).json()));
});
after(async () => { await new Promise((r) => server?.close(r)); db?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('upload, show, replace and remove a platform logo; admin only to change, anyone signed in can see it; it is listed with a version', async () => {
  assert.equal((await post('/api/platforms/snes/logo', PNG, { token: memberTok })).status, 403);
  assert.equal((await post('/api/platforms/snes/logo', Buffer.from('not a picture at all, just words here'))).status, 400);
  assert.equal((await post('/api/platforms/nope/logo', PNG)).status, 404);
  assert.equal((await post('/api/platforms/snes/logo', Buffer.alloc(600 * 1024, 1))).status, 400, 'over 512 KB');
  const bad = await post('/api/platforms/snes/logo', svg('<script>x</script>'), { name: 'a.svg', type: 'image/svg+xml' });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /scripts or links/);
  assert.equal((await call('/api/platforms/snes/logo')).status, 404, 'nothing saved by the refused ones');
  const ok = await post('/api/platforms/snes/logo', PNG);
  assert.equal(ok.status, 200); assert.ok(ok.body.logo_v);
  const got = await call('/api/platforms/snes/logo', { token: memberTok });
  assert.equal(got.status, 200); assert.equal(got.res.headers.get('content-type'), 'image/png'); assert.equal(got.res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await call('/api/platforms', { token: memberTok })).body.items.find((p) => p.slug === 'snes').logo_v, ok.body.logo_v);
  assert.equal((await call('/api/platforms')).body.items.find((p) => p.slug === 'nes').logo_v ?? null, null, 'no logo, no version');
  const sv = await post('/api/platforms/snes/logo', svg('<rect width="10" height="10"/>'), { name: 'a.svg', type: 'image/svg+xml' });
  assert.equal(sv.status, 200); const g2 = await call('/api/platforms/snes/logo');
  assert.equal(g2.res.headers.get('content-type'), 'image/svg+xml'); assert.match(g2.res.headers.get('content-security-policy'), /sandbox/, 'an SVG opened directly cannot run anything');
  assert.equal((await call('/api/platforms/snes/logo', { method: 'DELETE', token: memberTok })).status, 403);
  assert.equal((await call('/api/platforms/snes/logo', { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/platforms/snes/logo')).status, 404);
});

test('a platform keeps its logo when edited, and the logo goes when the platform is deleted', async () => {
  await call('/api/platforms', { method: 'POST', body: { name: 'Logo Test', slug: 'logotest' } });
  await post('/api/platforms/logotest/logo', PNG);
  await call('/api/platforms/logotest', { method: 'PATCH', body: { name: 'Logo Test 2' } });
  assert.equal((await call('/api/platforms/logotest/logo')).status, 200);
  assert.equal((await call('/api/platforms/logotest', { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM platform_logos WHERE slug = 'logotest'").get().n, 0);
});

test('page: a fixed-size logo box in the Library heading, and a logo chooser in the platform editor', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(app, /class=\"lib-logo\"/); assert.match(app, /data-logo-file/); assert.match(app, /\/logo\`, \{ method: 'POST', body: fd \}/);
  assert.match(css, /\.lib-logo \{[^}]*width: 5\.5rem; height: 2\.2rem;/); assert.match(css, /\.lib-logo img \{[^}]*width: 100%; height: 100%; object-fit: contain/);
});

test('family chips are in capitals', () => {
  assert.match(fs.readFileSync(new URL('../public/modern.css', import.meta.url), 'utf8'), /\.chip\[data-chip-fam\] \{ text-transform: uppercase;/);
});

test('family logos: upload, show, replace, remove; admin only; a name with a slash works; rename carries it; listed with the platforms', async () => {
  const fpost = async (p, buf, family, token) => { const f = new FormData(); f.append('family', family); f.append('logo', new Blob([buf], { type: 'image/png' }), 'f.png'); const res = await fetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer ' + (token || tok) }, body: f }); return { status: res.status, body: await res.json().catch(() => null) }; };
  assert.equal((await fpost('/api/platforms/families/logo', PNG, 'Arcade', memberTok)).status, 403);
  assert.equal((await fpost('/api/platforms/families/logo', PNG, 'No such family')).status, 404);
  assert.equal((await fpost('/api/platforms/families/logo', Buffer.from('not a picture, only words in here'), 'Arcade')).status, 400);
  const ok = await fpost('/api/platforms/families/logo', PNG, 'NEC / SNK');
  assert.equal(ok.status, 200);
  const got = await call('/api/platforms/families/logo?family=' + encodeURIComponent('NEC / SNK'), { token: memberTok });
  assert.equal(got.status, 200); assert.equal(got.res.headers.get('content-type'), 'image/png');
  assert.equal((await call('/api/platforms', { token: memberTok })).body.items.find((p) => p.family === 'NEC / SNK').family_logo_v, ok.body.logo_v);
  assert.equal((await call('/api/platforms')).body.items.find((p) => p.family === 'Sega').family_logo_v ?? null, null);
  await call('/api/platforms/families/rename', { method: 'POST', body: { from: 'NEC / SNK', to: 'NEC and SNK' } });
  assert.equal((await call('/api/platforms/families/logo?family=' + encodeURIComponent('NEC and SNK'))).status, 200, 'the logo went with the family');
  assert.equal((await call('/api/platforms/families/logo?family=' + encodeURIComponent('NEC / SNK'))).status, 404);
  assert.equal((await call('/api/platforms/families/logo?family=' + encodeURIComponent('NEC and SNK'), { method: 'DELETE', token: memberTok })).status, 403);
  assert.equal((await call('/api/platforms/families/logo?family=' + encodeURIComponent('NEC and SNK'), { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/platforms/families/logo?family=' + encodeURIComponent('NEC and SNK'))).status, 404);
  assert.equal((await call('/api/platforms/snes/logo')).status, 404, 'the family route did not shadow the platform route');
});

test('page: the heading shows the family logo for several platforms of one family, and the drawer controls sit lower', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), css = fs.readFileSync(new URL('../public/modern.css', import.meta.url), 'utf8');
  assert.match(app, /const sameFam = picked\.length > 1/); assert.match(app, /logoOf \|\| famLogo \|\|/); assert.match(app, /data-famlogo-file/);
  assert.match(css, /\.drawer-bar \{ height: 4\.2rem; padding-top: 0\.8rem;/); assert.match(css, /#drawer-pin, body\.ui-modern \.drawer-bar #drawer-close \{ top: calc\(50% \+ 0\.4rem\); \}/);
});
