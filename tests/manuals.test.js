import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-manuals-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'madmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'm-admin-password-1';

let server, base, db, tok = {}, ids = {}, man;
const call = async (p, { method = 'GET', body, as = 'admin', raw } = {}) => {
  const headers = { Authorization: 'Bearer ' + tok[as] };
  if (!raw) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: raw || (body ? JSON.stringify(body) : undefined) });
  return { status: res.status, body: await res.json().catch(() => null), res };
};
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const form = (buf, name = 'Bloodborne manual.pdf', type = 'application/pdf') => { const f = new FormData(); f.append('manual', new Blob([buf], { type }), name); return f; };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)]);
const add = async (platform, title, as = 'admin') => (await call('/api/physical/games', { method: 'POST', as, body: { platform, title } })).body;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  man = await import('../src/lib/manuals.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok.admin = await login('madmin', 'm-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'ann', password: 'ann-password-12', role: 'user' } });
  tok.ann = await login('ann', 'ann-password-12');
  for (const u of ['madmin', 'ann']) ids[u] = db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('a manual link: web addresses only (http or https), tidied, cleared by an empty value, and nobody else\'s shelf', async () => {
  const g = await add('ps4', 'Bloodborne');
  assert.equal(g.manual, null); assert.equal(g.has_manual, false);
  const ok = await call(`/api/physical/games/${g.id}/manual`, { method: 'PUT', body: { link: '  https://archive.org/details/bloodborne-manual  ' } });
  assert.equal(ok.status, 200); assert.deepEqual(ok.body.manual, { kind: 'link', url: 'https://archive.org/details/bloodborne-manual' }); assert.equal(ok.body.has_manual, true);
  for (const bad of ['javascript:alert(1)', 'ftp://example.com/m.pdf', 'file:///C:/secret.pdf', 'data:text/html,hi', 'not a link', 'https://']) {
    const r = await call(`/api/physical/games/${g.id}/manual`, { method: 'PUT', body: { link: bad } });
    assert.equal(r.status, 400, bad); assert.match(r.body.error, /web address/);
  }
  assert.equal((await call(`/api/physical/games/${g.id}`)).body.manual.url, 'https://archive.org/details/bloodborne-manual', 'a refused link changed nothing');
  assert.equal((await call(`/api/physical/games/${g.id}/manual`, { method: 'PUT', as: 'ann', body: { link: 'https://example.com/x' } })).status, 404, 'not ann\'s game');
  const cleared = await call(`/api/physical/games/${g.id}/manual`, { method: 'PUT', body: { link: '' } });
  assert.equal(cleared.body.manual, null);
});

test('an uploaded manual: PDF or pictures only (judged by the file itself), kept privately, shown inline, replaced and removed cleanly', async () => {
  const g = await add('ps4', 'Horizon Zero Dawn');
  const up = await call(`/api/physical/games/${g.id}/manual`, { method: 'POST', raw: form(PDF, 'Horizon  manual.pdf') });
  assert.equal(up.status, 200); assert.equal(up.body.manual.kind, 'file'); assert.equal(up.body.manual.type, 'application/pdf'); assert.equal(up.body.manual.name, 'Horizon manual.pdf');
  const file = db.prepare('SELECT manual_path FROM physical_games WHERE id = ?').get(g.id).manual_path;
  assert.ok(file.startsWith(path.join(TMP, 'storage', 'manuals', String(ids.madmin))) && fs.existsSync(file), 'stored under the owner\'s own folder');
  const served = await call(up.body.manual.url, { raw: undefined });
  assert.equal(served.status, 200); assert.equal(served.res.headers.get('content-type'), 'application/pdf');
  assert.match(served.res.headers.get('content-disposition'), /^inline;/); assert.match(served.res.headers.get('content-security-policy'), /sandbox/);
  assert.match((await call(`/api/physical/manual/${g.id}?download=1`)).res.headers.get('content-disposition'), /^attachment;/);
  assert.equal((await call(`/api/physical/manual/${g.id}`, { as: 'ann' })).status, 404, 'private: another person gets nothing');
  // the file decides what it is, not its name or the type the browser sent
  const fake = await call(`/api/physical/games/${g.id}/manual`, { method: 'POST', raw: form(Buffer.from('<html><script>alert(1)</script></html>'), 'x.pdf', 'application/pdf') });
  assert.equal(fake.status, 400); assert.match(fake.body.error, /PDF or a picture/);
  assert.equal((await call(`/api/physical/games/${g.id}/manual`, { method: 'POST', raw: new FormData() })).status, 400, 'no file at all');
  // a link added as well: the file still wins; replacing the file removes the old one
  await call(`/api/physical/games/${g.id}/manual`, { method: 'PUT', body: { link: 'https://example.com/m' } });
  assert.equal((await call(`/api/physical/games/${g.id}`)).body.manual.kind, 'file');
  const png = await call(`/api/physical/games/${g.id}/manual`, { method: 'POST', raw: form(PNG, 'page1.png', 'image/png') });
  assert.equal(png.body.manual.type, 'image/png'); assert.ok(!fs.existsSync(file), 'the old file is gone');
  const gone = await call(`/api/physical/games/${g.id}/manual`, { method: 'DELETE' });
  assert.equal(gone.body.manual, null); assert.equal(gone.body.manual_link, null);
  assert.equal(fs.readdirSync(path.join(TMP, 'storage', 'manuals', String(ids.madmin))).filter((f) => f.startsWith(`${g.id}-`)).length, 0, 'no file left behind');
  assert.equal((await call(`/api/physical/manual/${g.id}`)).status, 404);
});

test('removing a game, or deleting an account, takes its uploaded manuals with it', async () => {
  const mine = await add('ps4', 'God of War'); const hers = await add('ps4', 'Her Game', 'ann');
  await call(`/api/physical/games/${mine.id}/manual`, { method: 'POST', raw: form(PDF) });
  await call(`/api/physical/games/${hers.id}/manual`, { method: 'POST', as: 'ann', raw: form(PDF, 'her.pdf') });
  const mineFile = db.prepare('SELECT manual_path FROM physical_games WHERE id = ?').get(mine.id).manual_path;
  assert.ok(fs.existsSync(mineFile));
  assert.equal((await call(`/api/physical/games/${mine.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!fs.existsSync(mineFile), 'the game is removed, and so is its manual');
  const annDir = man.manualDir(ids.ann); assert.ok(fs.existsSync(annDir));
  const { deleteUser } = await import('../src/auth.js');
  deleteUser(ids.ann);
  assert.ok(!fs.existsSync(annDir), 'her account is deleted, and so is everything she uploaded');
});

test('CSV: a Manual column sets the links (web addresses only; a bad one is left out and mentioned, the game still comes in)', async () => {
  const csv = 'Platform,Game,Manual\nPS4,Bloodborne CSV,https://archive.org/m/bb\nPS2,Gran Turismo 4,javascript:alert(1)\nPS3,Demon Souls,\nPS4,Uncharted,ftp://x/y\n';
  const preview = (await call('/api/physical/import', { method: 'POST', body: { csv, apply: false } })).body;
  assert.equal(preview.games, 4); assert.equal(preview.manuals, 1); assert.equal(preview.bad_links, 2);
  assert.ok(preview.problems.some((p) => /Gran Turismo 4/.test(p.reason) && /left out/.test(p.reason)), 'the problem names the game');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM physical_games WHERE title = 'Bloodborne CSV'").get().n, 0, 'a preview saves nothing');
  const applied = (await call('/api/physical/import', { method: 'POST', body: { csv, apply: true } })).body;
  assert.equal(applied.added, 4);
  const row = (t) => db.prepare('SELECT manual_link FROM physical_games WHERE title = ? AND user_id = ?').get(t, ids.madmin);
  assert.equal(row('Bloodborne CSV').manual_link, 'https://archive.org/m/bb'); assert.equal(row('Gran Turismo 4').manual_link, null); assert.equal(row('Uncharted').manual_link, null);
  // importing again with a new link for a game already there updates it; an empty cell never wipes one
  const again = (await call('/api/physical/import', { method: 'POST', body: { csv: 'Platform,Game,Manual\nPS4,Bloodborne CSV,https://example.org/new\nPS3,Demon Souls,\n', apply: true } })).body;
  assert.equal(again.updated, 1);
  assert.equal(row('Bloodborne CSV').manual_link, 'https://example.org/new');
  await call('/api/physical/import', { method: 'POST', body: { csv: 'Platform,Game,Manual\nPS4,Bloodborne CSV,\n', apply: true } });
  assert.equal(row('Bloodborne CSV').manual_link, 'https://example.org/new', 'an empty cell does not wipe the link');
});

test('the file sniffer and the link cleaner', () => {
  assert.equal(man.sniffManual(PDF).ext, 'pdf'); assert.equal(man.sniffManual(PNG).ext, 'png');
  assert.equal(man.sniffManual(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])).ext, 'jpg');
  assert.equal(man.sniffManual(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)])).ext, 'webp');
  assert.equal(man.sniffManual(Buffer.from('MZ\x90\x00 an executable pretending')), null); assert.equal(man.sniffManual(Buffer.alloc(3)), null);
  assert.equal(man.cleanManualLink(''), null); assert.equal(man.cleanManualLink(null), null);
  assert.equal(man.cleanManualLink('HTTPS://Example.com/A b'), 'https://example.com/A%20b');
  assert.throws(() => man.cleanManualLink('https://' + 'a'.repeat(700) + '.com'), /too long/);
  assert.equal(man.cleanFileName('..\\..\\evil:name?.pdf'), '.._.._evil_name_.pdf');
});

test('the screens: a Manual section in the details window, the manual side of the open case reads it, files open in a viewer, links in a new tab', () => {
  const js = read('public/physical.js'), css = read('public/physical.css'), mj = read('public/modern.js');
  for (const f of ['function manualBlock(g)', 'id="ph-man-upload"', 'id="ph-man-find"', 'id="ph-man-link"', 'id="ph-man-remove"', 'id="ph-man-open"']) assert.ok(js.includes(f), f);
  assert.ok(js.includes("if (CASE.open && e.target.closest('.ph-case-inside')) { openManual(S.byId.get(CASE.id)); return; }"), 'the manual side, once the case is open');
  assert.ok(js.includes("if (m.kind === 'link') { window.open(m.url, '_blank', 'noopener,noreferrer'); return; }"), 'a link opens in a new tab (the desktop app hands it to your browser)');
  assert.ok(js.includes('<iframe src="${esc(m.url)}"') && js.includes("e.key === 'Escape'"), 'a file opens in a viewer over the page: it needs your sign-in, which a separate browser would not have');
  assert.ok(js.includes('No manual for this game yet'), 'no manual: it says so');
  assert.ok(js.includes('<code>Manual</code> (a web link to the game\'s manual)'), 'the CSV panel names the column');
  assert.ok(css.includes('.ph-manview {') && css.includes('.ph-manual.has-manual'));
  for (const id of ['ph-man-open', 'ph-man-upload', 'ph-man-find', 'ph-man-remove', 'ph-man-save']) assert.ok(mj.includes(`'#${id}'`), `Modern gives ${id} an icon`);
});
