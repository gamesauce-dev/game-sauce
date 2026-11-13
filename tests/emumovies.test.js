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
const calls = { login: 0, search: 0, file: 0, searched: [], ss: 0, ssParams: [], ssFile: [] };
let fake, fakeBase, server, base, adminToken, bobToken;
let SS_FILES = {};   // name -> { type, body }, built before the stand-in starts

before(async () => {
  const { PNG: PL } = (await import('pngjs')).default;
  const png = (w, h) => { const p = new PL({ width: w, height: h }); p.data.fill(190); return PL.sync.write(p); };
  SS_FILES = { 'cover.png': { type: 'image/png', body: png(80, 110) }, 'back.png': { type: 'image/png', body: png(80, 110) }, 'spine.png': { type: 'image/png', body: png(24, 110) },
    'disc.png': { type: 'image/png', body: png(100, 100) }, 'manual.pdf': { type: 'application/pdf', body: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') } };
  fake = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/ss/jeuRecherche.php' || url.pathname === '/ss/jeuInfos.php') {
      calls.ss++; calls.ssParams.push({ _path: url.pathname, ...Object.fromEntries(url.searchParams) });
      res.setHeader('Content-Type', 'application/json');
      const searching = url.pathname.endsWith('Recherche.php');
      const name = searching ? url.searchParams.get('recherche') : String(url.searchParams.get('gameid') || '').replace(/^g:/, '');
      if (String(name).startsWith('Ss Error')) { res.statusCode = 403; return res.end('Erreur de login : Vérifier les identifiants utilisateurs !'); }
      if (String(name).startsWith('Ss Notfound')) { res.statusCode = 404; return res.end('Erreur : Rom/Iso/Dossier non trouvée !'); }
      if (name === 'Ss Missing Game') return res.end(JSON.stringify({ header: {}, response: { jeux: [] } }));
      if (searching && name === 'Ss Wrong Game') return res.end(JSON.stringify({ header: {}, response: { jeux: [{ id: 'g:Another Title Entirely', noms: [{ langue: 'en', text: 'Another Title Entirely' }] }] } }));
      if (searching) return res.end(JSON.stringify({ header: {}, response: { jeux: [{ id: 'g:' + name, noms: [{ langue: 'en', text: name }] }] } }));
      // the links carry the asker's credentials, as ScreenScraper's can
      const creds = 'devid=devid-x&devpassword=devpw-secret-1&softname=game-sauce&ssid=ssuser&sspassword=sspw-secret-2';
      const link = (file, extra = '') => `${fakeBase}/ssfiles/${file}?${creds}${extra}`;
      const medias = [{ type: 'video', region: 'wor', url: link('video.mp4', '&media=video') }, { type: 'video-normalized', region: 'wor', url: link('video-normalized.mp4', '&media=video-normalized') }, { type: 'box-2D', region: 'us', url: link('cover.png') }];
      if (name !== 'Ss Partial Game') medias.push({ type: 'box-2D-back', region: 'us', url: link('back.png') }, { type: 'box-2D-side', region: 'us', url: link('spine.png') }, { type: 'support-2D', region: 'us', url: link('disc.png') }, { type: 'manuel', region: 'us', url: link('manual.pdf') });
      return res.end(JSON.stringify({ header: {}, response: { jeu: { id: '77', noms: [{ langue: 'en', text: name }], medias } } }));
    }
    if (url.pathname.startsWith('/ssfiles/')) {
      calls.ssFile.push({ _file: url.pathname.split('/').pop(), ...Object.fromEntries(url.searchParams) });
      if (url.searchParams.get('sspassword') !== 'sspw-secret-2' || url.searchParams.get('devpassword') !== 'devpw-secret-1') { res.statusCode = 403; return res.end('no credentials'); }
      const named = SS_FILES[url.pathname.split('/').pop()];
      if (named) { res.setHeader('Content-Type', named.type); return res.end(named.body); }
      res.setHeader('Content-Type', 'video/mp4'); return res.end(MP4);
    }
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
  process.env.SS_API_BASE = `${fakeBase}/ss`;
  process.env.SS_MIN_INTERVAL_MS = '1';
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
  // background lookups started by the games these tests add finish before the database closes
  const { matchJobStatus } = await import('../src/lib/physical.js');
  const { detailsJobStatus } = await import('../src/lib/consoles.js');
  for (let i = 0; i < 200 && (matchJobStatus().running || detailsJobStatus().running); i++) await new Promise((r) => setTimeout(r, 50));
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
  put('snes/videos/Pack Dash Suffix-video.mp4', MP4);   // RetroBat names a video <rom name>-video
  put('snes/videos/Pack Rom Only (USA).mp4', MP4);   // a game that is only in the ROM Library
  put('snes/videos/Pack Old Format.avi', Buffer.from('RIFF....AVI '));
  put('snes/videos/Pack Not Owned (USA).mp4', MP4);
  put('nes/Videos/Pack Bad Header.mp4', Buffer.from('<html>not a video at all</html>'));
  put('Videos/Super Nintendo/Pack Reverse Layout.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const folders = await call('/api/art/folders', { method: 'PUT', body: { folders: [pack] } });
  assert.equal(folders.status, 200);
  const mk = (platform, title) => call('/api/physical/games', { method: 'POST', body: { platform, title, region: 'USA' } });
  db.prepare("INSERT INTO roms (title, sort_title, filename, storage_path, platform_id, size_bytes, sha1) VALUES ('Pack Rom Only', 'pack rom only', 'pro.sfc', 'x', (SELECT id FROM platforms WHERE slug = 'snes'), 1, 'sha-pack-rom-only')").run();
  await mk('snes', 'Pack Link Game'); await mk('snes', 'Pack Dash Suffix'); await mk('nes', 'Pack Bad Header'); await mk('snes', 'Pack Reverse Layout');

  const prev = await call('/api/art/import', { method: 'POST', body: { target: 'video', folder: pack } });
  assert.equal(prev.status, 200);
  assert.equal(prev.body.matched.video, 5); assert.equal(prev.body.will.video, 5);
  assert.equal(prev.body.unsupported_videos, 1); assert.deepEqual(prev.body.unsupported_list, ['Pack Old Format.avi']);
  assert.equal(prev.body.unmatched_total, 1, 'a video for a game nobody has is not imported');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM game_videos WHERE source = 'folder'").get().c, 0, 'a preview saves nothing');

  await call('/api/art/import', { method: 'POST', body: { target: 'video', folder: pack, apply: true } });
  let st; for (let i = 0; i < 80; i++) { st = (await call('/api/art/import/status')).body; if (!st.running && st.finished_at) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.applied.video, 4); assert.equal(st.failed, 1); assert.match(st.failures[0].reason, /not an mp4 or webm/);
  const row = db.prepare("SELECT path, source FROM game_videos WHERE title_key = 'pack link game'").get();
  assert.equal(row.source, 'folder'); assert.equal(row.path, path.resolve(good), 'linked where it is, not copied');
  assert.ok(!fs.existsSync(path.join(process.env.GAMESAUCE_STORAGE_DIR, 'videos', 'snes', 'pack-link-game.mp4')), 'nothing was copied into storage');
  assert.ok(db.prepare("SELECT 1 FROM game_videos WHERE title_key = 'pack reverse layout' AND platform = 'snes'").get(), 'the videos / platform layout works too');

  // a game that is only in the ROM Library gets its video too, and it plays in the Library's details
  const romRow = db.prepare("SELECT id FROM roms WHERE sha1 = 'sha-pack-rom-only'").get();
  assert.equal((await call(`/api/videos/status?kind=rom&id=${romRow.id}`)).body.available, true);
  assert.equal((await call(`/api/videos/file?kind=rom&id=${romRow.id}`)).status, 200);

  // it plays for the game, and a second import finds nothing new
  const g = (await call('/api/physical/games')).body.items.find((x) => x.title === 'Pack Link Game');
  assert.equal(g.has_video, true);
  const f = await call(`/api/videos/file?kind=physical&id=${g.id}`);
  assert.equal(f.status, 200); assert.equal(f.body.length, MP4.length);
  const again = await call('/api/art/import', { method: 'POST', body: { target: 'video', folder: pack } });
  assert.equal(again.body.will.video, 1);   // only the bad-header file is still left to try assert.equal(again.body.skipped.video, 4);

  // the cache limit trims only what EmuMovies sent, never a person's own pack
  await saveCreds({ EMUMOVIES_USER: 'frank', EMUMOVIES_PASSWORD: 'hunter2-secret' });
  process.env.EMUMOVIES_CACHE_GB = String(MP4.length * 0.5 / (1024 ** 3));
  const r = await ensureVideo({ title: 'Pack Cache Probe', platform: 'gbc' });
  assert.equal(r.status, 'ready');
  delete process.env.EMUMOVIES_CACHE_GB;
  assert.ok(fs.existsSync(good), 'the pack file is still there');
  assert.ok(db.prepare("SELECT 1 FROM game_videos WHERE title_key = 'pack link game' AND path IS NOT NULL").get(), 'and still linked');
});


test('ROM Library: pictures and manuals from a folder are matched to Library games (admin only), the cover is kept, the rest are served, and they leave with the game', async () => {
  const { db } = await import('../src/db.js');
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const pack = path.join(TMP, 'romart');
  const put = (rel, buf) => { const f = path.join(pack, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return f; };
  put('snes/covers/Rom Art Game (USA).png', PNG);
  put('snes/spines/Rom Art Game (USA).png', PNG);
  put('snes/discs/Rom Art Game (USA).png', PNG);
  put('snes/manuals/Rom Art Game (USA).pdf', PDF);
  put('snes/covers/Nobody Has This.png', PNG);
  put('snes/manuals/Bad Manual (USA).pdf', Buffer.from('not a pdf at all, just words'));
  await call('/api/art/folders', { method: 'PUT', body: { folders: [pack] } });
  const rom = (title, sha) => Number(db.prepare("INSERT INTO roms (title, sort_title, filename, storage_path, platform_id, size_bytes, sha1, region) VALUES (?, ?, ?, 'x', (SELECT id FROM platforms WHERE slug = 'snes'), 1, ?, 'USA')").run(title, title.toLowerCase(), `${title}.sfc`, sha).lastInsertRowid);
  const id = rom('Rom Art Game', 'sha-rom-art'), badId = rom('Bad Manual', 'sha-bad-manual');

  assert.equal((await call('/api/art/import', { token: bobToken, method: 'POST', body: { target: 'rom', folder: pack } })).status, 403, 'the shared Library is changed by an admin only');
  const prev = await call('/api/art/import', { method: 'POST', body: { target: 'rom', folder: pack } });
  assert.equal(prev.status, 200);
  assert.equal(prev.body.matched.cover, 1); assert.equal(prev.body.matched.spine, 1); assert.equal(prev.body.matched.disc, 1); assert.equal(prev.body.matched.manual, 2);
  assert.equal(prev.body.unmatched_total, 1, 'a cover for a game nobody has is left');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM rom_files').get().c, 0, 'a preview saves nothing');

  await call('/api/art/import', { method: 'POST', body: { target: 'rom', folder: pack, apply: true } });
  let st; for (let i = 0; i < 80; i++) { st = (await call('/api/art/import/status')).body; if (!st.running && st.finished_at) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.applied.cover, 1); assert.equal(st.applied.spine, 1); assert.equal(st.applied.disc, 1); assert.equal(st.applied.manual, 1);
  assert.equal(st.failed, 1); assert.match(st.failures[0].reason, /A manual must be a PDF/);
  const row = db.prepare('SELECT cover_path, cover_locked FROM roms WHERE id = ?').get(id);
  assert.ok(row.cover_path && fs.existsSync(row.cover_path) && row.cover_locked === 1, 'the cover is kept like an uploaded one');

  const d = (await call(`/api/roms/${id}`)).body;
  assert.deepEqual(d.files.map((f) => f.kind).sort(), ['disc', 'manual', 'spine']);
  const man = await call(`/api/roms/${id}/file/manual`);
  assert.equal(man.status, 200); assert.match(man.type, /application\/pdf/); assert.equal(man.body.length, PDF.length);
  assert.equal((await call(`/api/roms/${id}/file/spine`)).status, 200);
  assert.equal((await call(`/api/roms/${id}/file/back`)).status, 404);
  assert.equal((await call(`/api/roms/${badId}`)).body.files.length, 0);

  // a second import has nothing left to fill (apart from the manual that cannot be read)
  const again = await call('/api/art/import', { method: 'POST', body: { target: 'rom', folder: pack } });
  assert.equal(again.body.will.cover + again.body.will.spine + again.body.will.disc, 0);

  const dir = path.dirname(db.prepare('SELECT path FROM rom_files WHERE rom_id = ? LIMIT 1').get(id).path);
  assert.ok(fs.existsSync(dir));
  const del = await call(`/api/roms/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM rom_files WHERE rom_id = ?').get(id).c, 0);
  assert.ok(!fs.existsSync(dir), 'their files went with the game');
});


test('a video is shared between consoles of one generation (PS2, Xbox, GameCube...), not across generations, handhelds or arcade', async () => {
  const { ensureVideo, videoFile, siblingPlatforms } = await import('../src/lib/emumovies.js');
  await saveCreds({ EMUMOVIES_USER: 'frank', EMUMOVIES_PASSWORD: 'hunter2-secret' });
  assert.ok(siblingPlatforms('ps2').includes('xbox') && siblingPlatforms('ps2').includes('gamecube'));
  assert.ok(!siblingPlatforms('ps2').includes('ps3') && !siblingPlatforms('ps2').includes('gba'), 'not another generation, not a handheld');
  assert.deepEqual(siblingPlatforms('mame'), []); assert.deepEqual(siblingPlatforms('arcade'), []);
  assert.ok(siblingPlatforms('gba').includes('gba') === false && !siblingPlatforms('gba').includes('xbox'));

  const first = await ensureVideo({ title: 'Cross Platform Racer', platform: 'ps2' });
  assert.equal(first.status, 'ready');
  const searches = calls.search, files = calls.file;
  const onXbox = await ensureVideo({ title: 'Cross Platform Racer (Europe)', platform: 'xbox' });
  assert.equal(onXbox.status, 'ready'); assert.equal(onXbox.path, first.path, 'the same file: nothing copied');
  assert.equal(calls.search, searches); assert.equal(calls.file, files, 'and nothing asked of EmuMovies');
  assert.ok(videoFile({ title: 'Cross Platform Racer', platform: 'gamecube' }));
  assert.equal(videoFile({ title: 'Cross Platform Racer', platform: 'ps3' }), null, 'another generation has its own');
  assert.equal(videoFile({ title: 'Cross Platform Racer', platform: 'gba' }), null, 'a handheld game of the same name is another game');

  // tiles of the Xbox copy know too
  const shelf = async (title, platform) => (await call('/api/physical/games', { token: bobToken, method: 'POST', body: { platform, title } })).body;
  const xb = await shelf('Cross Platform Racer', 'xbox'), x360 = await shelf('Cross Platform Racer', 'xbox360');
  const list = (await call('/api/physical/games', { token: bobToken })).body.items;
  assert.equal(list.find((g) => g.id === xb.id).has_video, true);
  assert.ok(!list.find((g) => g.id === x360.id).has_video);
  assert.equal((await call(`/api/videos/status?kind=physical&id=${xb.id}`, { token: bobToken })).body.available, true);
  assert.equal((await call(`/api/videos/file?kind=physical&id=${xb.id}`, { token: bobToken })).status, 200);
});


test('Import game assets does pictures, manuals and videos in one run from the same folder', async () => {
  const { db } = await import('../src/db.js');
  const { PNG: PngLib } = (await import('pngjs')).default; const img = new PngLib({ width: 80, height: 110 }); img.data.fill(180); const PNG = PngLib.sync.write(img);   // a real picture, big enough to be a cover
  const pack = path.join(TMP, 'combo');
  const put = (rel, buf) => { const f = path.join(pack, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return f; };
  put('snes/covers/Combo Game (USA).png', PNG);
  put('snes/videos/Combo Game (USA).mp4', MP4);
  put('snes/videos/Combo Old.avi', Buffer.from('RIFF....AVI '));
  await call('/api/art/folders', { method: 'PUT', body: { folders: [pack] } });
  const g = (await call('/api/physical/games', { method: 'POST', body: { platform: 'snes', title: 'Combo Game', region: 'USA' } })).body;

  const prev = await call('/api/art/import', { method: 'POST', body: { target: 'physical', folder: pack } });
  assert.equal(prev.body.matched.cover, 1); assert.equal(prev.body.matched.video, 1); assert.equal(prev.body.will.video, 1);
  assert.equal(prev.body.unsupported_videos, 1);
  await call('/api/art/import', { method: 'POST', body: { target: 'physical', folder: pack, apply: true } });
  let st; for (let i = 0; i < 80; i++) { st = (await call('/api/art/import/status')).body; if (!st.running && st.finished_at) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.applied.cover, 1); assert.equal(st.applied.video, 1); assert.equal(st.failed, 0);
  const shelf = (await call('/api/physical/games')).body.items.find((x) => x.id === g.id);
  assert.equal(shelf.has_cover, true); assert.equal(shelf.has_video, true);

  // a folder with pictures only reads exactly as it did: no Videos row
  const plain = path.join(TMP, 'plainpics'); fs.mkdirSync(path.join(plain, 'snes', 'covers'), { recursive: true }); fs.writeFileSync(path.join(plain, 'snes', 'covers', 'Other (USA).png'), PNG);
  await call('/api/art/folders', { method: 'PUT', body: { folders: [pack, plain] } });
  const p2 = await call('/api/art/import', { method: 'POST', body: { target: 'physical', folder: plain } });
  assert.equal(p2.body.matched.video, undefined);
});


test('ScreenScraper is a video source: asked first, EmuMovies fills what it lacks, and no credential is ever stored, shown or sent to the wrong place', async () => {
  const { ensureVideo } = await import('../src/lib/emumovies.js');
  const { db } = await import('../src/db.js');
  await saveCreds({ EMUMOVIES_USER: 'frank', EMUMOVIES_PASSWORD: 'hunter2-secret', SS_DEV_ID: 'devid-x', SS_DEV_PASSWORD: 'devpw-secret-1', SS_USER: 'ssuser', SS_PASSWORD: 'sspw-secret-2' });

  // ScreenScraper first: nothing is asked of EmuMovies
  const emuSearches = calls.search;
  const r = await ensureVideo({ title: 'Ss Video Game', platform: 'snes' });
  assert.equal(r.status, 'ready'); assert.equal(r.source, 'screenscraper'); assert.equal(calls.search, emuSearches);
  const searched = calls.ssParams.filter((p) => p._path.endsWith('Recherche.php')).at(-1), paged = calls.ssParams.filter((p) => p._path.endsWith('jeuInfos.php')).at(-1);
  assert.equal(searched.recherche, 'Ss Video Game', 'looked up by its title, not by a file name'); assert.ok(!('romnom' in searched) && !('romnom' in paged));
  assert.equal(paged.gameid, 'g:Ss Video Game'); assert.equal(paged.ssid, 'ssuser');
  assert.equal(calls.ssFile.at(-1)._file, 'video-normalized.mp4', 'the normalised video is preferred');
  assert.equal(calls.ssFile.at(-1).sspassword, 'sspw-secret-2', 'the download is signed when it is made');
  assert.equal(db.prepare("SELECT source FROM game_videos WHERE title_key = 'ss video game'").get().source, 'screenscraper');

  // no credential left in anything stored (the lookup's cached answer holds the links)
  const dump = JSON.stringify(db.prepare('SELECT payload FROM metadata_cache').all());
  assert.ok(dump.includes('video-normalized'), 'the lookup was cached');
  assert.ok(!dump.includes('sspw-secret-2') && !dump.includes('devpw-secret-1') && !dump.includes('sspassword'), 'cleaned before it is stored');
  // the window is told where it came from
  const s = await call('/api/physical/games', { token: bobToken, method: 'POST', body: { platform: 'snes', title: 'Ss Video Game' } });
  const st = await call('/api/videos/status?kind=physical&id=' + s.body.id, { token: bobToken });
  assert.equal(st.body.available, true); assert.equal(st.body.source, 'ScreenScraper');

  // nothing at ScreenScraper: EmuMovies is tried, and its key is not sent to ScreenScraper
  const before = calls.search;
  const m = await ensureVideo({ title: 'Ss Missing Game', platform: 'snes' });
  assert.equal(m.status, 'ready'); assert.equal(m.source, 'emumovies'); assert.equal(calls.search, before + 1);
  // ScreenScraper unreachable or refusing: EmuMovies still gets its turn
  const e = await ensureVideo({ title: 'Ss Error Game', platform: 'snes' });
  assert.equal(e.status, 'ready'); assert.equal(e.source, 'emumovies');
  // ScreenScraper's French "not found" (HTTP 404) is just "no video there": EmuMovies is tried, and nothing is shown as an error
  const nf = await ensureVideo({ title: 'Ss Notfound Game', platform: 'snes' });
  assert.equal(nf.status, 'ready'); assert.equal(nf.source, 'emumovies');
  // a search hit with a different title is never taken
  const wrong = await ensureVideo({ title: 'Ss Wrong Game', platform: 'snes' });
  assert.equal(wrong.source, 'emumovies', 'not the other game\'s video');
  assert.ok(!calls.ssParams.some((p) => p.gameid === 'g:Another Title Entirely'), 'its page was never asked for');
  // a refusal on its own is an error, not "no video", and never echoes a credential
  const { registerVideoSource } = await import('../src/lib/emumovies.js');
  assert.ok(registerVideoSource);
  const only = await ensureVideo({ title: 'Ss Error Two', platform: 'snes' }, { apiImpl: { findVideo: async () => { throw new Error('boom sspw-secret-2'); } } });
  assert.equal(only.status, 'error'); assert.ok(!only.error.includes('sspw-secret-2'));
  // a remembered "no video" is used until Try again asks ScreenScraper afresh
  db.prepare("INSERT OR REPLACE INTO metadata_cache (key, provider, payload, fetched_at) VALUES ('ss-video2:snes:ss cache game', 'screenscraper', '{\"url\":null,\"why\":\"remembered answer\"}', datetime('now'))").run();
  const down = { apiImpl: { findVideo: async () => { throw new Error('EmuMovies is down'); } } };
  const stale = await ensureVideo({ title: 'Ss Cache Game', platform: 'snes' }, down);
  assert.equal(stale.status, 'error'); assert.match(stale.error, /ScreenScraper: remembered answer/);
  const searchesBefore = calls.ssParams.length;
  const fresh = await ensureVideo({ title: 'Ss Cache Game', platform: 'snes', force: true }, down);
  assert.equal(fresh.status, 'ready'); assert.equal(fresh.source, 'screenscraper'); assert.ok(calls.ssParams.length > searchesBefore, 'it asked ScreenScraper again');
  // one source says "no video" and the other is down: both are said, in that order
  const mixed = await ensureVideo({ title: 'Ss Missing Game', platform: 'gba' }, { apiImpl: { findVideo: async () => { throw new Error('The EmuMovies address api.example.invalid does not exist'); } } });
  assert.equal(mixed.status, 'error'); assert.match(mixed.error, /^No video was found at ScreenScraper: its search on system [0-9]+ found no game titled "Ss Missing Game". The EmuMovies address/);
  const { screenscraper } = await import('../src/lib/providers.js');
  // the ordinary metadata lookup of a title with no hashes (Physical, Digital) goes through the same name search
  const rec = await screenscraper.lookup({ title: 'Ss Lookup Game', platform: { slug: 'snes', screenscraper_id: 4 }, hashes: {} });
  assert.equal(rec.source, 'screenscraper'); assert.equal(rec.title, 'Ss Lookup Game');
  assert.ok(!calls.ssParams.some((p) => 'romnom' in p), 'a bare title is never sent as a file name');
  assert.ok(!JSON.stringify(rec).includes('sspassword'), 'the record carries no credential');
  await assert.rejects(screenscraper.videoFor({ title: 'Ss Error Three', platform: 'snes' }), (err) => /did not accept the login/.test(err.message) && !/Erreur|identifiants/.test(err.message), 'plain English, not the French reply');
});

test('ScreenScraper links lose their credentials: new ones as they arrive, and the ones earlier builds stored, once', async () => {
  const { ssClean } = await import('../src/lib/providers.js');
  const { scrubSsText, scrubStoredSsLinks } = await import('../src/lib/ssscrub.js');
  const { db } = await import('../src/db.js');
  const dirty = `${process.env.SS_API_BASE}/mediaJeu.php?devid=a&devpassword=b&softname=c&ssid=d&sspassword=e&systemeid=3&jeuid=9&media=box-2D`;
  assert.equal(ssClean(dirty), `${process.env.SS_API_BASE}/mediaJeu.php?systemeid=3&jeuid=9&media=box-2D`);
  assert.equal(ssClean('https://example.com/a.png?ssid=keep'), 'https://example.com/a.png?ssid=keep', 'only ScreenScraper links are touched');
  assert.equal(scrubSsText('{"url":"https://api.screenscraper.fr/x?devid=a&devpassword=b&ssid=d&sspassword=e"}'), '{"url":"https://api.screenscraper.fr/x"}');
  assert.equal(scrubSsText('https://s.fr/m.php?systemeid=3&sspassword=e&media=x'), 'https://s.fr/m.php?systemeid=3&media=x');
  db.prepare("INSERT OR REPLACE INTO metadata_cache (key, provider, payload, fetched_at) VALUES ('old-ss', 'screenscraper', ?, datetime('now'))").run('{"cover_url":"https://s.fr/a.php?devid=a&devpassword=b&ssid=d&sspassword=e&media=box"}');
  db.prepare("UPDATE roms SET cover_url = 'https://s.fr/a.php?ssid=d&sspassword=e&media=box' WHERE id = (SELECT MIN(id) FROM roms)").run();
  assert.ok(scrubStoredSsLinks(db) >= 2);
  assert.ok(!db.prepare("SELECT payload FROM metadata_cache WHERE key = 'old-ss'").get().payload.includes('password'));
  assert.ok(!(db.prepare('SELECT cover_url FROM roms WHERE cover_url LIKE ?').get('%sspassword%')));
});

test('Find assets: the video, cover, spine, disc art, back and manual ScreenScraper has are kept where a game is missing them (Library, Physical, Digital), gaps only', async () => {
  const { db } = await import('../src/db.js');
  await saveCreds({ SS_DEV_ID: 'devid-x', SS_DEV_PASSWORD: 'devpw-secret-1', SS_USER: 'ssuser', SS_PASSWORD: 'sspw-secret-2' });
  const assets = (qs, tok, body = {}) => call('/api/videos/assets?' + qs, { token: tok, method: 'POST', body });
  const ph = async (title, tok = bobToken) => (await call('/api/physical/games', { token: tok, method: 'POST', body: { platform: 'ps2', title, region: 'PAL' } })).body;

  // Physical (a disc game: it has disc art too)
  const g = await ph('Ss Assets Game');
  const r = await assets('kind=physical&id=' + g.id, bobToken);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.got.sort(), ['back', 'cover', 'disc', 'manual', 'spine', 'video']);
  const shelf = (await call('/api/physical/games/' + g.id, { token: bobToken })).body;
  assert.ok(shelf.has_cover && shelf.has_spine && shelf.has_disc && shelf.has_back && shelf.has_manual);
  assert.equal(shelf.manual.type, 'application/pdf');
  const signed = calls.ssFile.filter((f) => ['cover.png', 'spine.png', 'disc.png', 'back.png', 'manual.pdf'].includes(f._file));
  assert.ok(signed.length >= 5 && signed.every((f) => f.sspassword === 'sspw-secret-2'), 'every file is signed when it is fetched');
  assert.ok(!JSON.stringify(db.prepare('SELECT payload FROM metadata_cache').all()).includes('sspw-secret-2'), 'and no credential is stored');
  assert.ok(!JSON.stringify(r.body).includes('secret'), 'nor shown');

  // a second press has nothing to add and asks for no file
  const filesBefore = calls.ssFile.length;
  const again = await assets('kind=physical&id=' + g.id, bobToken);
  assert.deepEqual(again.body.got, []); assert.ok(Object.values(again.body.results).every((x) => x === 'had'));
  assert.equal(calls.ssFile.length, filesBefore);

  // what ScreenScraper lacks is said, not invented
  const p = await ph('Ss Partial Game');
  const pr = (await assets('kind=physical&id=' + p.id, bobToken)).body;
  assert.deepEqual(pr.got.sort(), ['cover', 'video']); assert.equal(pr.results.spine, 'none'); assert.equal(pr.results.manual, 'none');
  assert.equal((await call('/api/physical/games/' + p.id, { token: bobToken })).body.has_spine, false);

  // somebody else's game is not theirs to fill
  assert.equal((await assets('kind=physical&id=' + g.id, adminToken)).status, 404);

  // Library
  const plat = db.prepare("SELECT id FROM platforms WHERE slug = 'ps2'").get();
  const rid = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, storage_path, platform_id, size_bytes, sha1, region) VALUES ('Ss Rom Assets', 'ss rom assets', 'ssra.iso', 'x', ?, 1, 'sha-ss-rom-assets', 'USA')").run(plat.id).lastInsertRowid);
  const lr = (await assets('kind=rom&id=' + rid, adminToken)).body;
  assert.deepEqual(lr.got.sort(), ['back', 'cover', 'disc', 'manual', 'spine', 'video']);
  const row = db.prepare('SELECT cover_path, cover_locked FROM roms WHERE id = ?').get(rid);
  assert.ok(fs.existsSync(row.cover_path)); assert.equal(row.cover_locked, 0, 'an automatic cover: a later lookup may replace it');
  assert.deepEqual((await call('/api/roms/' + rid)).body.files.map((f) => f.kind).sort(), ['back', 'disc', 'manual', 'spine']);

  // Digital: a console game gets its cover (and video)
  const dg = (await call('/api/digital/games', { token: bobToken, method: 'POST', body: { platform: 'ps4', title: 'Ss Dig Assets' } })).body;
  const dr = (await assets('kind=digital&store=' + dg.store + '&id=' + encodeURIComponent(dg.app_id), bobToken)).body;
  assert.ok(dr.got.includes('cover')); assert.deepEqual(Object.keys(dr.results).sort(), ['cover', 'video']);
  const tile = (await call('/api/digital/games?store=playstation&hidden=show', { token: bobToken })).body.items.find((x) => x.app_id === dg.app_id);
  assert.ok(tile.cover_url);
});

test('arcade sets: pictures, videos and manuals named like the ROM (ggx15.png for ggx15.zip) are matched to it, whatever the game\'s title', async () => {
  const { db } = await import('../src/db.js');
  const { PNG: PL } = (await import('pngjs')).default; const img = new PL({ width: 80, height: 110 }); img.data.fill(150); const PNG = PL.sync.write(img);
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const pack = path.join(TMP, 'arcadepack');
  const put = (rel, buf) => { const f = path.join(pack, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return f; };
  put('atomiswave/images/ggx15.png', PNG);
  put('atomiswave/videos/ggx15.mp4', MP4);
  put('atomiswave/manuals/ggx15.pdf', PDF);
  put('atomiswave/images/notinthelibrary.png', PNG);
  put('atomiswave/images/anothr_snap.png', PNG);   // a word added after the ROM name
  put('snes/images/odd-file-name.png', PNG);
  await call('/api/art/folders', { method: 'PUT', body: { folders: [pack] } });
  const rom = (platform, title, filename, sha) => Number(db.prepare("INSERT INTO roms (title, sort_title, filename, storage_path, platform_id, size_bytes, sha1) VALUES (?, ?, ?, 'x', (SELECT id FROM platforms WHERE slug = ?), 1, ?)").run(title, title.toLowerCase(), filename, platform, sha).lastInsertRowid);
  const ggx = rom('atomiswave', 'Guilty Gear X ver 1.5', 'ggx15.zip', 'sha-ggx15'), odd = rom('snes', 'Totally Different Title', 'odd-file-name.sfc', 'sha-odd-file'), another = rom('atomiswave', 'Another Game', 'anothr.zip', 'sha-anothr');

  const prev = await call('/api/art/import', { method: 'POST', body: { target: 'rom', folder: pack } });
  assert.equal(prev.status, 200);
  assert.equal(prev.body.matched.cover, 3, 'the arcade picture, the one named like a non-arcade ROM, and one with a word added');
  assert.equal(prev.body.matched.manual, 1); assert.equal(prev.body.matched.video, 1);
  assert.equal(prev.body.unmatched_total, 1, 'a file that is named like nothing is left');

  await call('/api/art/import', { method: 'POST', body: { target: 'rom', folder: pack, apply: true } });
  let st; for (let k = 0; k < 80; k++) { st = (await call('/api/art/import/status')).body; if (!st.running && st.finished_at) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.failed, 0); assert.equal(st.applied.cover, 3); assert.equal(st.applied.manual, 1); assert.equal(st.applied.video, 1);
  assert.ok(db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(ggx).cover_path, 'the cover of ggx15');
  assert.ok(db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(odd).cover_path, 'by file name on any platform');
  assert.ok(db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(another).cover_path, 'anothr_snap.png belongs to anothr.zip');
  assert.deepEqual((await call('/api/roms/' + ggx)).body.files.map((f) => f.kind), ['manual']);
  // the video is kept under the game's title, so it is found wherever the game is listed
  assert.ok(db.prepare("SELECT path FROM game_videos WHERE platform = 'atomiswave' AND title_key = 'guilty gear x ver 1 5' AND source = 'folder'").get());
  assert.equal((await call('/api/videos/status?kind=rom&id=' + ggx)).body.available, true);

  // the same run again has nothing new, and a title match still wins over a file name
  const again = await call('/api/art/import', { method: 'POST', body: { target: 'rom', folder: pack } });
  assert.equal(again.body.will.cover + again.body.will.manual + again.body.will.video, 0);
});

test('several endings at once ("Image|Manual|Video") let assets split over folders, each adding its own word, find one game', async () => {
  const { db } = await import('../src/db.js');
  const { cutTitle } = await import('../src/lib/artimport.js');
  assert.equal(cutTitle('ggx15Image', 'Image|Manual|Video'), 'ggx15');
  assert.equal(cutTitle('ggx15manual', 'Image|Manual|Video'), 'ggx15', 'not case sensitive');
  assert.equal(cutTitle('Zork (USA) Video', ' (|Video'), 'Zork', 'the earliest ending wins');
  assert.equal(cutTitle('Zork', 'Image||Manual'), 'Zork'); assert.equal(cutTitle('ImageZork', 'Image|Zork'), 'Image', 'an ending at the very start is ignored');
  const { PNG: PL } = (await import('pngjs')).default; const img = new PL({ width: 80, height: 110 }); img.data.fill(120); const PNG = PL.sync.write(img);
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const pack = path.join(TMP, 'cutpack');
  const put = (rel, buf) => { const f = path.join(pack, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); };
  put('neogeo/images/kof98Image.png', PNG); put('neogeo/manuals/kof98Manual.pdf', PDF); put('neogeo/videos/kof98Video.mp4', MP4);
  await call('/api/art/folders', { method: 'PUT', body: { folders: [pack] } });
  const id = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, storage_path, platform_id, size_bytes, sha1) VALUES ('The King of Fighters 98', 'the king of fighters 98', 'kof98.zip', 'x', (SELECT id FROM platforms WHERE slug = 'neogeo'), 1, 'sha-kof98')").run().lastInsertRowid);
  const none = await call('/api/art/import', { method: 'POST', body: { target: 'rom', folder: pack } });
  assert.equal(none.body.matched.cover + none.body.matched.manual + (none.body.matched.video || 0), 0, 'without the endings nothing matches');
  const all = await call('/api/art/import', { method: 'POST', body: { target: 'rom', folder: pack, cut: 'Image|Manual|Video' } });
  assert.equal(all.body.matched.cover, 1); assert.equal(all.body.matched.manual, 1); assert.equal(all.body.matched.video, 1);
  await call('/api/art/import', { method: 'POST', body: { target: 'rom', folder: pack, cut: 'Image|Manual|Video', apply: true } });
  let st; for (let k = 0; k < 80; k++) { st = (await call('/api/art/import/status')).body; if (!st.running && st.finished_at) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.failed, 0); assert.ok(db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(id).cover_path);
  assert.deepEqual((await call('/api/roms/' + id)).body.files.map((f) => f.kind), ['manual']);
  assert.equal((await call('/api/videos/status?kind=rom&id=' + id)).body.available, true);
});

test('Refresh metadata keeps a cover that was uploaded or imported (cover_locked), and replaces an automatic one', async () => {
  const { db } = await import('../src/db.js');
  await saveCreds({ SS_DEV_ID: 'devid-x', SS_DEV_PASSWORD: 'devpw-secret-1', SS_USER: 'ssuser', SS_PASSWORD: 'sspw-secret-2' });
  const own = path.join(process.env.GAMESAUCE_STORAGE_DIR, 'covers', 'custom-refresh-test.png');
  fs.mkdirSync(path.dirname(own), { recursive: true }); fs.writeFileSync(own, SS_FILES['cover.png'].body);
  const plat = db.prepare("SELECT id FROM platforms WHERE slug = 'ps2'").get();
  const rom = (title, sha, locked) => Number(db.prepare("INSERT INTO roms (title, sort_title, filename, storage_path, platform_id, size_bytes, sha1, cover_path, cover_locked) VALUES (?, ?, ?, 'x', ?, 1, ?, ?, ?)").run(title, title.toLowerCase(), title + '.iso', plat.id, sha, own, locked).lastInsertRowid);
  const mine = rom('Ss Refresh Own', 'sha-refresh-own', 1), auto = rom('Ss Refresh Auto', 'sha-refresh-auto', 0);

  const a = await call('/api/metadata/' + mine + '/refresh', { method: 'POST' });
  assert.equal(a.body.updated, true);
  assert.deepEqual(a.body.assets.got.sort(), ['back', 'disc', 'manual', 'spine', 'video'], 'the refresh also filled what the game was missing (its cover was already there)');
  const keep = db.prepare('SELECT cover_path, cover_locked FROM roms WHERE id = ?').get(mine);
  assert.equal(keep.cover_path, own, 'the cover you uploaded or imported is not replaced'); assert.equal(keep.cover_locked, 1);

  const b = await call('/api/metadata/' + auto + '/refresh', { method: 'POST' });
  assert.equal(b.body.updated, true);
  const fresh = db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(auto);
  assert.ok(fresh.cover_path && fresh.cover_path !== own && fs.existsSync(fresh.cover_path), 'an automatic cover is replaced by the provider\'s');

  // the shelf's "look up again" does the same, and a second press adds nothing
  const g = (await call('/api/physical/games', { token: bobToken, method: 'POST', body: { platform: 'ps2', title: 'Ss Lookup Shelf', region: 'PAL' } })).body;
  const m = await call('/api/physical/games/' + g.id + '/auto-match', { token: bobToken, method: 'POST' });
  assert.ok(m.body.assets.got.includes('video') && m.body.assets.got.includes('spine'), 'looked up and filled');
  assert.equal((await call('/api/physical/games/' + g.id, { token: bobToken })).body.has_spine, true);
  const m2 = await call('/api/physical/games/' + g.id + '/auto-match', { token: bobToken, method: 'POST' });
  assert.deepEqual(m2.body.assets.got, []);
});

test('with no login saved, fetching says so and the window offers nothing', async () => {
  await saveCreds({ EMUMOVIES_USER: '', EMUMOVIES_PASSWORD: '', EMUMOVIES_API_KEY: '', SS_DEV_ID: '', SS_DEV_PASSWORD: '', SS_USER: '', SS_PASSWORD: '' });
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

test('a video in the details window stops when the window is closed or its page left (it is only hidden, so it would play on with sound)', () => {
  const js = fs.readFileSync(new URL('../public/video.js', import.meta.url), 'utf8');
  assert.ok(js.includes("drawerEl.classList.contains('hidden')") && js.includes("drawerEl.querySelectorAll('video').forEach((v) => v.pause())"), 'paused when the window is hidden');
  assert.ok(js.includes("v.addEventListener('timeupdate', () => { if (!v.isConnected || !v.offsetParent) v.pause(); })"), 'and when it is no longer on screen');
});
