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
