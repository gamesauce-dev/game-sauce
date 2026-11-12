import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// No live EmuMovies calls: a small local server plays the service (login, search, file), and the library takes injected fakes.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-emumovies-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'emuadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'emu-admin-password-1';
delete process.env.EMUMOVIES_USER; delete process.env.EMUMOVIES_PASSWORD; delete process.env.EMUMOVIES_API_KEY;

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2000, 1)]);
const calls = { login: 0, search: 0, file: 0, searched: [] };
let fake, fakeBase, server, base, adminToken, bobToken;

before(async () => {
  fake = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/auth/login') {
      calls.login++;
      let body = '';
      req.on('data', (c) => { body += c; }).on('end', () => {
        const { username, password } = JSON.parse(body || '{}');
        if (username === 'frank' && password === 'hunter2-secret') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ token: 'tok-1' })); }
        res.statusCode = 401; res.end(`bad login for ${username} / ${password}`);   // a hostile page that echoes the credentials
      });
      return;
    }
    if (url.pathname === '/media/search') {
      calls.search++; calls.searched.push({ system: url.searchParams.get('system'), name: url.searchParams.get('name'), auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      if (url.searchParams.get('name') === 'Nothing Here') return res.end('[]');
      if (url.searchParams.get('name') === 'Huge Game') return res.end(JSON.stringify([{ url: `${fakeBase}/files/huge.mp4` }]));
      if (url.searchParams.get('name') === 'Fake Video') return res.end(JSON.stringify([{ url: `${fakeBase}/files/notvideo.mp4` }]));
      return res.end(JSON.stringify([{ url: `${fakeBase}/files/ok.mp4`, name: 'ok' }]));
    }
    if (url.pathname.startsWith('/files/')) {
      calls.file++;
      if (url.pathname.includes('notvideo')) return res.end('<html>nope</html>');
      if (url.pathname.includes('huge')) { res.setHeader('Content-Length', String(5 * 1024 * 1024)); return res.end(Buffer.concat([MP4, Buffer.alloc(5 * 1024 * 1024)])); }
      res.setHeader('Content-Type', 'video/mp4'); return res.end(MP4);
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeBase = `http://127.0.0.1:${fake.address().port}`;
  process.env.EMUMOVIES_API_BASE = fakeBase;
  process.env.EMUMOVIES_MAX_VIDEO_MB = '1';

  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) }).then((r) => r.json())).token;
  adminToken = await login('emuadmin', 'emu-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'bob', password: 'bob-password-12345', role: 'user' } });
  bobToken = await login('bob', 'bob-password-12345');
});

after(async () => {
  await new Promise((r) => server?.close(r));
  await new Promise((r) => fake?.close(r));
  const { db } = await import('../src/db.js');
  db.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

const call = async (p, { token = adminToken, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer()), type: ct };
};
const saveCreds = (fields) => call('/api/metadata/providers', { method: 'PUT', body: { fields } });

test('EmuMovies is a provider entry: fields, off until set, and secrets are never echoed', async () => {
  const first = await call('/api/metadata/providers');
  const prov = first.body.providers.find((p) => p.id === 'emumovies');
  assert.ok(prov, 'listed under Metadata providers');
  assert.deepEqual(prov.fields.map((f) => f.key), ['EMUMOVIES_USER', 'EMUMOVIES_PASSWORD', 'EMUMOVIES_API_KEY']);
  assert.equal(first.body.enabled.emumovies, false);
  assert.equal((await call('/api/metadata/providers/test', { method: 'POST', body: { provider: 'emumovies' } })).status, 400);

  const saved = await saveCreds({ EMUMOVIES_USER: 'frank', EMUMOVIES_PASSWORD: 'hunter2-secret', EMUMOVIES_API_KEY: 'key-abc-123' });
  assert.equal(saved.body.enabled.emumovies, true);
  const text = JSON.stringify((await call('/api/metadata/providers')).body);
  assert.ok(!text.includes('hunter2-secret') && !text.includes('key-abc-123'), 'password and key are masked');
  assert.ok(prov.fields.find((f) => f.key === 'EMUMOVIES_PASSWORD').secret);
  // Stored encrypted, not as typed.
  const { db } = await import('../src/db.js');
  const row = db.prepare("SELECT value, encrypted FROM app_settings WHERE key = 'EMUMOVIES_PASSWORD'").get();
  assert.equal(row.encrypted, 1); assert.ok(!row.value.includes('hunter2-secret'));
});

test('Test connection signs in; a wrong password says so without echoing it', async () => {
  const ok = await call('/api/metadata/providers/test', { method: 'POST', body: { provider: 'emumovies' } });
  assert.equal(ok.body.ok, true);
  await saveCreds({ EMUMOVIES_PASSWORD: 'wrong-password-77' });
  const bad = await call('/api/metadata/providers/test', { method: 'POST', body: { provider: 'emumovies' } });
  assert.equal(bad.body.ok, false);
  assert.ok(!JSON.stringify(bad.body).includes('wrong-password-77'));
  await saveCreds({ EMUMOVIES_PASSWORD: 'hunter2-secret' });
  // Only an admin can test (and so spend the account).
  assert.equal((await call('/api/metadata/providers/test', { token: bobToken, method: 'POST', body: { provider: 'emumovies' } })).status, 403);
});

test('a video is fetched on demand by title and platform, kept, and not fetched twice', async () => {
  const { ensureVideo, videoFile, videoUsage, systemNameFor } = await import('../src/lib/emumovies.js');
  calls.searched.length = 0; calls.file = 0;
  const r = await ensureVideo({ title: 'Super Metroid (USA)', platform: 'snes' });
  assert.equal(r.status, 'ready');
  assert.ok(fs.existsSync(r.path) && r.path.includes(path.join('storage', 'videos')));
  assert.deepEqual(calls.searched[0], { system: systemNameFor('snes'), name: 'Super Metroid (USA)', auth: 'Bearer tok-1' });
  // The same game under another spelling is the same video: no new request.
  const again = await ensureVideo({ title: 'super metroid', platform: 'snes' });
  assert.equal(again.status, 'ready'); assert.equal(calls.searched.length, 1); assert.equal(calls.file, 1);
  assert.equal(videoFile({ title: 'Super Metroid', platform: 'snes' }).bytes, MP4.length);
  assert.ok(videoUsage().videos >= 1);
});

test('no video found is remembered for a week; a service error is not', async () => {
  const { ensureVideo } = await import('../src/lib/emumovies.js');
  const n0 = calls.search;
  assert.equal((await ensureVideo({ title: 'Nothing Here', platform: 'nes' })).status, 'none');
  assert.equal((await ensureVideo({ title: 'Nothing Here', platform: 'nes' })).status, 'none');
  assert.equal(calls.search, n0 + 1, 'the second ask did not call EmuMovies');
  assert.equal((await ensureVideo({ title: 'Nothing Here', platform: 'nes', force: true })).status, 'none');
  assert.equal(calls.search, n0 + 2, 'force asks again');
  const e = await ensureVideo({ title: 'Anything', platform: 'nes' }, { apiImpl: { findVideo: async () => { throw new Error('EmuMovies rate limit reached (HTTP 429), try again later'); } } });
  assert.equal(e.status, 'error');
  const { db } = await import('../src/db.js');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM game_videos WHERE title_key = 'anything'").get().c, 0);
});

test('a download over the size limit, or that is not a video, is refused and leaves nothing behind', async () => {
  const { ensureVideo, videoFile } = await import('../src/lib/emumovies.js');
  const big = await ensureVideo({ title: 'Huge Game', platform: 'nes' });
  assert.equal(big.status, 'error'); assert.match(big.error, /limit/);
  const notVideo = await ensureVideo({ title: 'Fake Video', platform: 'nes' });
  assert.equal(notVideo.status, 'error'); assert.match(notVideo.error, /not a video/);
  assert.equal(videoFile({ title: 'Huge Game', platform: 'nes' }), null);
  const left = fs.readdirSync(path.join(process.env.GAMESAUCE_STORAGE_DIR, 'videos', 'nes'));
  assert.ok(!left.some((f) => f.endsWith('.part')), `no partial files: ${left}`);
});

test('the cache is trimmed oldest-first when over its limit', async () => {
  const { ensureVideo, videoFile } = await import('../src/lib/emumovies.js');
  process.env.EMUMOVIES_CACHE_GB = String(MP4.length * 1.5 / (1024 ** 3));
  const a = await ensureVideo({ title: 'Cache Old', platform: 'gb' });
  assert.equal(a.status, 'ready');
  const { db } = await import('../src/db.js');
  db.prepare("UPDATE game_videos SET fetched_at = datetime('now', '-1 day') WHERE title_key = 'cache old'").run();
  const b = await ensureVideo({ title: 'Cache New', platform: 'gb' });
  assert.equal(b.status, 'ready');
  assert.equal(videoFile({ title: 'Cache Old', platform: 'gb' }), null, 'older one went');
  assert.ok(videoFile({ title: 'Cache New', platform: 'gb' }), 'newer one stayed');
  assert.ok(!fs.existsSync(a.path));
  delete process.env.EMUMOVIES_CACHE_GB;
});

test('details windows: status, fetch and play for Library, Physical and Digital games; other accounts see nothing of yours', async () => {
  const { db } = await import('../src/db.js');
  const plat = db.prepare("SELECT id FROM platforms WHERE slug = 'nes'").get();
  const romId = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, storage_path, platform_id, size_bytes, sha1) VALUES ('Video Rom', 'video rom', 'v.nes', 'x', ?, 1, 'sha-video-rom')").run(plat.id).lastInsertRowid);
  // Library
  const s = await call(`/api/videos/status?kind=rom&id=${romId}`);
  assert.equal(s.body.can_fetch, true); assert.equal(s.body.available, false);
  assert.equal((await call(`/api/videos/file?kind=rom&id=${romId}`)).status, 404);
  const f = await call(`/api/videos/fetch?kind=rom&id=${romId}`, { method: 'POST', body: {} });
  assert.equal(f.body.available, true);
  const file = await call(`/api/videos/file?kind=rom&id=${romId}`);
  assert.equal(file.status, 200); assert.match(file.type, /video\/mp4/); assert.equal(file.body.length, MP4.length);
  // Physical: Bob's own game is his; the admin gets "not found" for it.
  const g = await call('/api/physical/games', { token: bobToken, method: 'POST', body: { title: 'Bobs Disc', platform: 'ps2' } });
  assert.equal(g.status, 201);
  assert.equal((await call(`/api/videos/status?kind=physical&id=${g.body.id}`, { token: bobToken })).status, 200);
  assert.equal((await call(`/api/videos/status?kind=physical&id=${g.body.id}`)).status, 404, 'admin cannot see it');
  assert.equal((await call(`/api/videos/fetch?kind=physical&id=${g.body.id}`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await call(`/api/videos/file?kind=physical&id=${g.body.id}`)).status, 404);
  const pf = await call(`/api/videos/fetch?kind=physical&id=${g.body.id}`, { token: bobToken, method: 'POST', body: {} });
  assert.equal(pf.body.available, true);
  // Digital: a console game of Bob's; Steam and unknown kinds are not offered.
  const dg = await call('/api/digital/games', { token: bobToken, method: 'POST', body: { platform: 'xbox360', title: 'Bobs Download' } });
  assert.equal(dg.status, 201);
  const q = `kind=digital&store=${dg.body.store}&id=${encodeURIComponent(dg.body.app_id)}`;
  assert.equal((await call(`/api/videos/fetch?${q}`, { token: bobToken, method: 'POST', body: {} })).body.available, true);
  assert.equal((await call(`/api/videos/status?${q}`)).status, 404, 'not the admin game');
  assert.equal((await call('/api/videos/status?kind=digital&store=steam&id=10', { token: bobToken })).status, 404);
  assert.equal((await call('/api/videos/status?kind=weird&id=1')).status, 404);
  assert.equal((await call(`/api/videos/status?kind=rom&id=${romId}`, { token: null })).status, 401);
});

test('video packs: matched by platform and title from a listed folder, linked in place (no copy), unplayable formats skipped, and never deleted by the cache limit', async () => {
  const { db } = await import('../src/db.js');
  const { ensureVideo } = await import('../src/lib/emumovies.js');
  const pack = path.join(TMP, 'pack');
  const put = (rel, buf) => { const f = path.join(pack, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return f; };
  const good = put('snes/videos/Pack Link Game (USA).mp4', MP4);
  put('snes/videos/Pack Old Format.avi', Buffer.from('RIFF....AVI '));
  put('snes/videos/Pack Not Owned (USA).mp4', MP4);
  put('nes/Videos/Pack Bad Header.mp4', Buffer.from('<html>not a video at all</html>'));
  put('Videos/Super Nintendo/Pack Reverse Layout.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const folders = await call('/api/art/folders', { method: 'PUT', body: { folders: [pack] } });
  assert.equal(folders.status, 200);
  const mk = (platform, title) => call('/api/physical/games', { method: 'POST', body: { platform, title, region: 'USA' } });
  await mk('snes', 'Pack Link Game'); await mk('nes', 'Pack Bad Header'); await mk('snes', 'Pack Reverse Layout');

  const prev = await call('/api/art/import', { method: 'POST', body: { target: 'video', folder: pack } });
  assert.equal(prev.status, 200);
  assert.equal(prev.body.matched.video, 3); assert.equal(prev.body.will.video, 3);
  assert.equal(prev.body.unsupported_videos, 1); assert.deepEqual(prev.body.unsupported_list, ['Pack Old Format.avi']);
  assert.equal(prev.body.unmatched_total, 1, 'a video for a game nobody has is not imported');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM game_videos WHERE source = 'folder'").get().c, 0, 'a preview saves nothing');

  await call('/api/art/import', { method: 'POST', body: { target: 'video', folder: pack, apply: true } });
  let st; for (let i = 0; i < 80; i++) { st = (await call('/api/art/import/status')).body; if (!st.running && st.finished_at) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.applied.video, 2); assert.equal(st.failed, 1); assert.match(st.failures[0].reason, /not an mp4 or webm/);
  const row = db.prepare("SELECT path, source FROM game_videos WHERE title_key = 'pack link game'").get();
  assert.equal(row.source, 'folder'); assert.equal(row.path, path.resolve(good), 'linked where it is, not copied');
  assert.ok(!fs.existsSync(path.join(process.env.GAMESAUCE_STORAGE_DIR, 'videos', 'snes', 'pack-link-game.mp4')), 'nothing was copied into storage');
  assert.ok(db.prepare("SELECT 1 FROM game_videos WHERE title_key = 'pack reverse layout' AND platform = 'snes'").get(), 'the videos / platform layout works too');

  // it plays for the game, and a second import finds nothing new
  const g = (await call('/api/physical/games')).body.items.find((x) => x.title === 'Pack Link Game');
  assert.equal(g.has_video, true);
  const f = await call(`/api/videos/file?kind=physical&id=${g.id}`);
  assert.equal(f.status, 200); assert.equal(f.body.length, MP4.length);
  const again = await call('/api/art/import', { method: 'POST', body: { target: 'video', folder: pack } });
  assert.equal(again.body.will.video, 1);   // only the bad-header file is still left to try assert.equal(again.body.skipped.video, 2);

  // the cache limit trims only what EmuMovies sent, never a person's own pack
  await saveCreds({ EMUMOVIES_USER: 'frank', EMUMOVIES_PASSWORD: 'hunter2-secret' });
  process.env.EMUMOVIES_CACHE_GB = String(MP4.length * 0.5 / (1024 ** 3));
  const r = await ensureVideo({ title: 'Pack Cache Probe', platform: 'gbc' });
  assert.equal(r.status, 'ready');
  delete process.env.EMUMOVIES_CACHE_GB;
  assert.ok(fs.existsSync(good), 'the pack file is still there');
  assert.ok(db.prepare("SELECT 1 FROM game_videos WHERE title_key = 'pack link game' AND path IS NOT NULL").get(), 'and still linked');
});


test('with no login saved, fetching says so and the window offers nothing', async () => {
  await saveCreds({ EMUMOVIES_USER: '', EMUMOVIES_PASSWORD: '', EMUMOVIES_API_KEY: '' });
  const { db } = await import('../src/db.js');
  const plat = db.prepare('SELECT id FROM platforms LIMIT 1').get();
  const id = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, storage_path, platform_id, size_bytes, sha1) VALUES ('No Login', 'no login', 'n.bin', 'x', ?, 1, 'sha-no-login')").run(plat.id).lastInsertRowid);
  assert.equal((await call(`/api/videos/status?kind=rom&id=${id}`)).body.can_fetch, false);
  assert.equal((await call(`/api/videos/fetch?kind=rom&id=${id}`, { method: 'POST', body: {} })).status, 400);
});

test('tiles know which games already have a video, and a game shares one video wherever it is listed (Library, Physical, Digital)', async () => {
  const { db } = await import('../src/db.js');
  await saveCreds({ EMUMOVIES_USER: 'frank', EMUMOVIES_PASSWORD: 'hunter2-secret' });
  // Digital: an Xbox 360 console game is filed under the Library platform xbox360
  const dg = (await call('/api/digital/games', { token: bobToken, method: 'POST', body: { platform: 'x360', title: 'Shared Clip Game' } })).body;
  let list = (await call('/api/digital/games?store=xbox&hidden=show', { token: bobToken })).body.items;
  assert.ok(!list.find((g) => g.name === 'Shared Clip Game').has_video, 'no video yet: no flag');
  const f = await call(`/api/videos/fetch?kind=digital&store=${dg.store}&id=${encodeURIComponent(dg.app_id)}`, { token: bobToken, method: 'POST', body: {} });
  assert.equal(f.body.available, true);
  assert.ok(db.prepare("SELECT 1 FROM game_videos WHERE platform = 'xbox360' AND title_key = 'shared clip game' AND path IS NOT NULL").get(), 'kept under the Library platform slug');
  list = (await call('/api/digital/games?store=xbox&hidden=show', { token: bobToken })).body.items;
  assert.equal(list.find((g) => g.name === 'Shared Clip Game').has_video, true);
  // the same game on the Physical shelf already has its video: nothing more to fetch
  const ph = (await call('/api/physical/games', { token: bobToken, method: 'POST', body: { platform: 'xbox360', title: 'Shared Clip Game' } })).body;
  const calls0 = calls.search;
  assert.equal((await call(`/api/videos/status?kind=physical&id=${ph.id}`, { token: bobToken })).body.available, true);
  assert.equal(calls.search, calls0);
  const shelf = (await call('/api/physical/games', { token: bobToken })).body.items;
  assert.equal(shelf.find((g) => g.id === ph.id).has_video, true);
  // Library: a ROM of that title and platform is flagged too, and a different game is not
  const plat = db.prepare("SELECT id FROM platforms WHERE slug = 'xbox360'").get();
  if (plat) {
    db.prepare("INSERT INTO roms (title, sort_title, filename, storage_path, platform_id, size_bytes, sha1) VALUES ('Shared Clip Game', 'shared clip game', 's.iso', 'x', ?, 1, 'sha-shared-clip')").run(plat.id);
    db.prepare("INSERT INTO roms (title, sort_title, filename, storage_path, platform_id, size_bytes, sha1) VALUES ('Other Game', 'other game', 'o.iso', 'x', ?, 1, 'sha-other-game')").run(plat.id);
    const roms = (await call('/api/roms?limit=500')).body.items;
    assert.equal(roms.find((r) => r.title === 'Shared Clip Game').has_video, true);
    assert.ok(!roms.find((r) => r.title === 'Other Game').has_video);
  }
});
