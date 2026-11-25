// What a full member may and may not do: only an admin edits a game's details, and a game hidden from everyone does not exist for a member, on any route.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-perms-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'pmadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'pm-admin-password-1';

let server, base, db, adminTok, memberTok, memberId, adminId, secret, twin, plain, collId;
const SECRET = 'Zzsecret Quest';
const call = async (p, { token = adminTok, method = 'GET', body, form, headers = {} } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: form || (body ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, body: json, cache: res.headers.get('cache-control') || '' };
};
const login = async (u, p) => (await call('/api/auth/login', { token: null, method: 'POST', body: { username: u, password: p } })).body.token;
const addRom = (title, file, sha, cover = null) => Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, meta_source, cover_path) VALUES (?, ?, ?, (SELECT id FROM platforms WHERE slug = 'snes'), ?, 1, ?, 'filename', ?)")
  .run(title, 'zzsecret quest', file, path.join(TMP, file), sha, cover).lastInsertRowid);

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  const { COVER_DIR } = await import('../src/lib/storage.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('pmadmin', 'pm-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'pmmember', password: 'pm-member-pass-12', role: 'user' } });
  memberTok = await login('pmmember', 'pm-member-pass-12');
  memberId = db.prepare("SELECT id FROM users WHERE username = 'pmmember'").get().id;
  adminId = db.prepare("SELECT id FROM users WHERE username = 'pmadmin'").get().id;
  const cover = path.join(COVER_DIR, 'secret.png'); fs.writeFileSync(cover, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex'));
  secret = addRom(SECRET, 'zzsecret.sfc', 'pm1', cover);
  fs.writeFileSync(path.join(TMP, 'zzsecret.sfc'), 'x');
  twin = addRom('Zzvisible Twin', 'twin.sfc', 'pm2');       // same sort title as the secret: it would be listed as another version of it
  plain = addRom('Plain Game', 'plain.sfc', 'pm3');
  db.prepare('UPDATE roms SET sort_title = ? WHERE id = ?').run('plain game', plain);
  // the member had touched the game before it was hidden: a collection, a favourite, play and download history
  collId = (await call('/api/collections', { token: memberTok, method: 'POST', body: { name: 'Mine' } })).body.id;
  await call(`/api/collections/${collId}/roms`, { token: memberTok, method: 'POST', body: { ids: [secret, plain] } });
  await call(`/api/roms/${secret}/favorite`, { token: memberTok, method: 'POST', body: {} });
  for (const kind of ['play', 'download', 'download', 'download']) db.prepare('INSERT INTO downloads (rom_id, user_id, kind) VALUES (?, ?, ?)').run(secret, memberId, kind);
  await call(`/api/roms/${secret}/hide-all`, { method: 'POST', body: { hidden: true } });
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

const leaks = (r) => /zzsecret/i.test(r.text.replace(/zzsecret quest",?"?sort/gi, '')) && /Zzsecret Quest|zzsecret\.sfc/.test(r.text);

test('no list, count or summary a member can ask for names a game hidden from everyone', async () => {
  const urls = ['/api/stats', '/api/platforms', '/api/roms', '/api/roms?q=zzsecret', '/api/roms?hidden=1', '/api/roms?hidden=show', '/api/roms?system=all&hidden=all', '/api/roms?favorite=1', '/api/roms?sort=added', '/api/roms/facets',
    '/api/roms/recently-played', '/api/collections', `/api/collections/${collId}`, '/api/messages/summary', `/api/roms/${twin}`, `/api/roms?platform=snes`];
  for (const u of urls) {
    const r = await call(u, { token: memberTok });
    assert.ok(r.status < 500, `${u} ${r.status}`);
    assert.ok(!leaks(r), `${u} names the hidden game: ${r.text.slice(0, 300)}`);
  }
  const stats = (await call('/api/stats', { token: memberTok })).body;
  assert.ok(!stats.topDownloaded || stats.topDownloaded.id !== secret, 'the most downloaded game is not the hidden one');
  assert.equal(stats.byPlatform.reduce((n, p) => n + p.count, 0), 2, 'platform counts leave it out');
  const admin = (await call('/api/stats')).body;
  assert.equal(admin.topDownloaded.id, secret, 'the admin still sees it');
  assert.equal(admin.byPlatform.reduce((n, p) => n + p.count, 0), 3);
});

test('every route that names the hidden game answers "not found" to a member', async () => {
  const routes = [['GET', ''], ['GET', '/cover'], ['GET', '/cover?w=320'], ['GET', '/file/spine'], ['GET', '/media/video'], ['GET', '/download'], ['GET', '/play'], ['GET', '/play/zzsecret.sfc'], ['GET', '/saves'],
    ['POST', '/launch'], ['POST', '/saves'], ['POST', '/favorite'], ['POST', '/hide'], ['POST', '/broken'], ['DELETE', '/saves/1']];
  for (const [method, tail] of routes) assert.equal((await call(`/api/roms/${secret}${tail}`, { token: memberTok, method, body: method === 'POST' ? {} : undefined })).status, 404, `${method} /roms/:id${tail}`);
  // the video routes name a game by kind and id
  for (const u of [`/api/videos/status?kind=rom&id=${secret}`, `/api/videos/file?kind=rom&id=${secret}`, `/api/videos/file?kind=rom&id=${secret}&variant=theme`]) assert.equal((await call(u, { token: memberTok })).status, 404, u);
  assert.equal((await call('/api/videos/fetch', { token: memberTok, method: 'POST', body: { kind: 'rom', id: secret } })).status, 404, 'videos/fetch');
  assert.equal((await call(`/api/videos/status?kind=rom&id=${secret}`)).status, 200, 'the admin still can');
  assert.equal((await call(`/api/videos/status?kind=rom&id=${plain}`, { token: memberTok })).status, 200, 'a visible game is as before');
});

test('no other way of writing a game number gets a member past the hidden check', async () => {
  // The database reads "5.0", "5e0", "+5" and " 5" as game 5, so an id that is not plain digits must name no game at all.
  const spell = (id) => [`${id}.0`, `${id}.`, `${id}e0`, `0${id}`, `%2B${id}`, `%20${id}`, `${id}%20`, `%09${id}`, `${id}%0A`];
  const footprint = () => ({
    broken: db.prepare('SELECT broken FROM roms WHERE id = ?').get(secret).broken,
    saves: db.prepare('SELECT COUNT(*) AS n FROM save_states WHERE rom_id = ?').get(secret).n,
    downloads: db.prepare('SELECT COUNT(*) AS n FROM downloads WHERE rom_id = ?').get(secret).n
  });
  const before = footprint();
  assert.equal((await call('/api/auth/policy', { method: 'PUT', body: { members_can_download: true } })).status, 200);   // so the download and launch routes are not refused for another reason
  try {
    const routes = [['GET', ''], ['GET', '/cover'], ['GET', '/media/box2d'], ['GET', '/file/spine'], ['GET', '/download'], ['GET', '/play'], ['GET', '/play/zzsecret.sfc'], ['GET', '/saves'],
      ['POST', '/launch'], ['POST', '/saves'], ['POST', '/favorite'], ['POST', '/hide'], ['POST', '/broken'], ['DELETE', '/saves/1']];
    for (const id of spell(secret)) for (const [method, tail] of routes) {
      const r = await call(`/api/roms/${id}${tail}`, { token: memberTok, method, body: method === 'POST' ? {} : undefined });
      assert.equal(r.status, 404, `${method} /roms/${id}${tail}`);
      assert.ok(!/zzsecret/i.test(r.text), `${method} /roms/${id}${tail} names the hidden game`);
    }
    // a save sent as the player sends it
    const res = await fetch(`${base}/api/roms/${secret}.0/saves`, { method: 'POST', headers: { Authorization: `Bearer ${memberTok}`, 'Content-Type': 'application/octet-stream' }, body: 'state' });
    assert.equal(res.status, 404, 'POST saves with data');
    for (const id of spell(secret)) assert.equal((await call(`/api/videos/status?kind=rom&id=${id}`, { token: memberTok })).status, 404, `videos ${id}`);
  } finally {
    await call('/api/auth/policy', { method: 'PUT', body: { members_can_download: false } });
  }
  assert.deepEqual(footprint(), before, 'nothing was changed or logged for the hidden game');
  const { canSeeRom } = await import('../src/lib/visibility.js');
  for (const id of [`${plain}.0`, ` ${plain}`, '0x1', '', null, 1.5]) assert.equal(canSeeRom({ id: memberId, role: 'user' }, id), false, `canSeeRom ${JSON.stringify(id)}`);
  assert.equal(canSeeRom({ id: memberId, role: 'user' }, plain), true);
  assert.equal(canSeeRom({ id: memberId, role: 'user' }, String(plain)), true);
  assert.equal((await call(`/api/roms/${secret}`)).status, 200, 'the admin still opens it by its number');
  assert.equal((await call(`/api/roms/${plain}`, { token: memberTok })).status, 200, 'a visible game is as before');
});

test('a hidden game cannot be named in a message, by the sender or to someone who cannot see it', async () => {
  const share = (token, to, id) => call(`/api/messages/with/${to}`, { token, method: 'POST', body: { text: 'look', game: { type: 'rom', id } } });
  const bySender = await share(memberTok, adminId, secret);
  assert.equal(bySender.status, 400); assert.ok(!/Zzsecret/.test(bySender.text));
  const toMember = await share(adminTok, memberId, secret);
  assert.equal(toMember.status, 400, 'an admin cannot send a member the name of a game the member may not see');
  assert.equal((await share(memberTok, adminId, plain)).status < 300, true, 'a visible game can be shared');
});

test('a member cannot change a game: details, identify, covers, lookups', async () => {
  const before = db.prepare('SELECT title, genre, cover_path, meta_source FROM roms WHERE id = ?').get(plain);
  const png = new FormData(); png.append('cover', new Blob([fs.readFileSync(db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(secret).cover_path)], { type: 'image/png' }), 'c.png');
  const attempts = [
    ['edit details', `/api/roms/${plain}`, { method: 'PATCH', body: { title: 'Changed by a member', genre: 'x' } }],
    ['edit tags', `/api/roms/${plain}`, { method: 'PATCH', body: { tags: ['x'] } }],
    ['upload a cover', `/api/roms/${plain}/cover`, { method: 'POST', form: png }],
    ['reset the cover', `/api/roms/${plain}/cover`, { method: 'DELETE' }],
    ['refresh details', `/api/metadata/${plain}/refresh`, { method: 'POST', body: {} }],
    ['identify', `/api/metadata/${plain}/apply`, { method: 'POST', body: { candidate: { title: 'Changed' } } }],
    ['fetch details in bulk', '/api/roms/bulk/enrich', { method: 'POST', body: { ids: [plain] } }],
    ['find assets for a library game', '/api/videos/assets', { method: 'POST', body: { kind: 'rom', id: plain } }]
  ];
  for (const [what, url, opts] of attempts) assert.equal((await call(url, { token: memberTok, ...opts })).status, 403, what);
  assert.deepEqual(db.prepare('SELECT title, genre, cover_path, meta_source FROM roms WHERE id = ?').get(plain), before, 'nothing changed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rom_tags WHERE rom_id = ?').get(plain).n, 0);
  // what stays a member's own: favourites, collections, hiding from their own view, and an admin can still edit
  assert.equal((await call(`/api/roms/${plain}/favorite`, { token: memberTok, method: 'POST', body: {} })).status, 200);
  assert.equal((await call(`/api/roms/${plain}/hide`, { token: memberTok, method: 'POST', body: {} })).status, 200);
  const ok = await call(`/api/roms/${plain}`, { method: 'PATCH', body: { genre: 'Adventure' } });
  assert.equal(ok.status, 200); assert.equal(db.prepare('SELECT genre FROM roms WHERE id = ?').get(plain).genre, 'Adventure');
});

test('covers are cached by one person\'s browser only, never by a shared cache', async () => {
  for (const u of [`/api/roms/${secret}/cover`, `/api/roms/${secret}/media/box2d`]) {
    const r = await call(u);
    assert.equal(r.status, 200, u);
    assert.match(r.cache, /private/, u); assert.ok(!/public/.test(r.cache), u);
  }
});

test('the details window offers editing only to an admin', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const fn = app.slice(app.indexOf('async function openDetail(id) {'), app.indexOf('async function openDetail(id) {') + 14000);
  assert.match(fn, /const canEdit = authState\.user\?\.role === 'admin';/);
  assert.match(fn, /\$\{canEdit \? `<button class="mi" role="menuitem" data-act="refresh">/);
  assert.match(fn, /\$\{canEdit \? `<button class="mi" role="menuitem" data-act="cover-upload">/);
  assert.match(fn, /\$\{canEdit \? `\n    <div class="section-label">Identify this game<\/div>/);
  assert.match(fn, /\$\{canEdit \? `\n    <div class="section-label">Edit<\/div>/);
  // the buttons that may be absent are wired only when they are there
  for (const sel of [`'[data-act="refresh"]'`, "'#cover-input'", "'#edit-form'"]) assert.ok(app.includes(`$(${sel}, drawer)?.addEventListener`), sel);
});

test('a member cannot delete games, one at a time or in bulk, and cannot upload ROMs', async () => {
  const doomed = addRom('Do Not Delete', 'keep.sfc', 'pm10'); fs.writeFileSync(path.join(TMP, 'keep.sfc'), 'keep me');
  db.prepare('UPDATE roms SET in_place = 0 WHERE id = ?').run(doomed);
  assert.equal((await call(`/api/roms/${doomed}`, { token: memberTok, method: 'DELETE' })).status, 403, 'delete one');
  assert.equal((await call(`/api/roms/${doomed}?confirm_favorites=1&delete_file=1`, { token: memberTok, method: 'DELETE' })).status, 403, 'delete one, with its file');
  assert.equal((await call('/api/roms/bulk/delete', { token: memberTok, method: 'POST', body: { ids: [doomed, plain], confirm_favorites: true } })).status, 403, 'delete in bulk');
  assert.equal((await call('/api/roms', { token: memberTok, method: 'DELETE' })).status, 403, 'clear the library');
  assert.equal((await call('/api/roms/missing', { token: memberTok, method: 'DELETE' })).status, 403, 'delete missing');
  assert.ok(db.prepare('SELECT 1 FROM roms WHERE id = ?').get(doomed) && db.prepare('SELECT 1 FROM roms WHERE id = ?').get(plain), 'still in the library');
  assert.ok(fs.existsSync(path.join(TMP, 'keep.sfc')), 'and the file is still on disk');

  const incoming = path.join(TMP, 'storage', 'roms', '.incoming');
  const count = () => { try { return fs.readdirSync(incoming).length; } catch { return 0; } };
  const before = { roms: db.prepare('SELECT COUNT(*) AS n FROM roms').get().n, files: count() };
  const form = new FormData(); form.append('roms', new Blob(['member upload ' + Math.random()]), 'sneaky.sfc'); form.append('platform', 'snes');
  assert.equal((await call('/api/roms/upload', { token: memberTok, method: 'POST', form })).status, 403, 'upload');
  assert.deepEqual({ roms: db.prepare('SELECT COUNT(*) AS n FROM roms').get().n, files: count() }, before, 'nothing was added or even received');
  // an admin still can
  assert.equal((await call(`/api/roms/${doomed}`, { method: 'DELETE' })).status, 200);
});

test("a member's Hide changes their own view only, one game or many", async () => {
  const one = addRom('Hide Just Mine', 'h1.sfc', 'pm20'), two = addRom('Hide Mine Too', 'h2.sfc', 'pm21');
  assert.equal((await call(`/api/roms/${one}/hide`, { token: memberTok, method: 'POST', body: { hidden: true } })).status, 200);
  assert.equal((await call('/api/roms/bulk/hide', { token: memberTok, method: 'POST', body: { ids: [two], hidden: true } })).status, 200);
  for (const id of [one, two]) assert.equal(db.prepare('SELECT hidden_all FROM roms WHERE id = ?').get(id).hidden_all, 0, 'not hidden for anyone else');
  const ids = async (token) => (await call('/api/roms?limit=200', { token })).body.items.map((r) => r.id);
  const mine = await ids(memberTok), admins = await ids(adminTok);
  assert.ok(!mine.includes(one) && !mine.includes(two), 'gone from the member\'s own view');
  assert.ok(admins.includes(one) && admins.includes(two), 'the admin still has them');
  assert.equal((await call('/api/roms/bulk/hide-all', { token: memberTok, method: 'POST', body: { ids: [one], hidden: true } })).status, 403, 'hide for everyone is the admin\'s');
  assert.equal((await call(`/api/roms/${one}/hide-all`, { token: memberTok, method: 'POST', body: { hidden: true } })).status, 403);
});

test('the Delete controls are offered only to an admin', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(app, /\$\{canEdit \? `<button class="ibtn ibtn-danger\$\{rom\.keep_override/, 'the details window button');
  assert.ok(app.includes(`$('[data-act="delete"]', drawer)?.addEventListener`), 'wired only when it is there');
  assert.ok(app.includes(`$('#bulk-delete-btn')?.classList.toggle('hidden', n === 0 || authState.user?.role !== 'admin')`), 'the bulk bar button');
});
