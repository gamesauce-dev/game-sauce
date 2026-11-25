// What a member (full or play-only) is told: never the provider accounts, never where things are on the server, nothing about a game hidden from everyone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-privacy-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'pvadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'pv-admin-password-1';

const MARK = path.basename(TMP);   // every folder on the "server" holds this, so any path that gets out shows it
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
let server, base, db, admin, member, play, shown, secret, collId, artDir, srcDir;

const call = async (p, { token = admin, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, body: json };
};
const noPaths = (r, what) => assert.ok(!r.text.includes(MARK), `${what} gives away a folder on the server: ${r.text.slice(Math.max(0, r.text.indexOf(MARK) - 200), r.text.indexOf(MARK) + 80)}`);

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  const { COVER_DIR } = await import('../src/lib/storage.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  admin = await login('pvadmin', 'pv-admin-password-1');
  for (const [u, p] of [['pvmember', 'pv-member-pass-12'], ['pvplay', 'pv-play-pass-1234']]) await call('/api/auth/users', { method: 'POST', body: { username: u, password: p, role: 'user' } });
  const playId = db.prepare("SELECT id FROM users WHERE username = 'pvplay'").get().id;
  await call(`/api/auth/users/${playId}`, { method: 'PATCH', body: { mode: 'play' } });
  member = await login('pvmember', 'pv-member-pass-12'); play = await login('pvplay', 'pv-play-pass-1234');

  srcDir = path.join(TMP, 'games'); fs.mkdirSync(srcDir);
  const src = (await call('/api/sources', { method: 'POST', body: { path: srcDir, platform_hint: 'snes', name: 'Games' } })).body.id;
  const cover = path.join(COVER_DIR, 'c.png'); fs.writeFileSync(cover, PNG);
  const add = (title, file, genre, region) => {
    const f = path.join(srcDir, file); fs.writeFileSync(f, file);
    return Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, source_path, source_id, in_place, size_bytes, meta_source, genre, region, cover_path, provider_media) VALUES (?, ?, ?, (SELECT id FROM platforms WHERE slug = 'snes'), ?, ?, ?, 1, 1, 'filename', ?, ?, ?, ?)")
      .run(title, title.toLowerCase(), file, f, f, src, genre, region, cover, JSON.stringify({ box2d: { path: cover, url: 'https://images.igdb.com/a.jpg' }, wheel: { path: cover, url: 'https://images.igdb.com/w.jpg' } })).lastInsertRowid);
  };
  shown = add('Shown Game', 'shown.sfc', 'Platform', 'USA');
  secret = add('Zzhush Quest', 'zzhush.sfc', 'ZzhushGenre', 'ZzhushRegion');
  for (const [id, tag] of [[shown, 'plain-tag'], [secret, 'zzhush-tag']]) {
    db.prepare('INSERT INTO tags (name) VALUES (?)').run(tag);
    db.prepare('INSERT INTO rom_tags (rom_id, tag_id) SELECT ?, id FROM tags WHERE name = ?').run(id, tag);
  }
  for (const t of [member, play]) for (const id of [shown, secret]) await call(`/api/roms/${id}/favorite`, { token: t, method: 'POST', body: {} });
  await call(`/api/roms/${shown}/favorite`, { method: 'POST', body: {} });
  for (const t of [member, play]) { await call(`/api/roms/${shown}/play`, { token: t }); }
  collId = (await call('/api/collections', { token: member, method: 'POST', body: { name: 'Mine' } })).body.id;
  await call(`/api/collections/${collId}/roms`, { token: member, method: 'POST', body: { rom_ids: [shown, secret] } });
  const vault = path.join(TMP, 'storage', 'emulators'); fs.mkdirSync(vault, { recursive: true }); fs.writeFileSync(path.join(vault, 'emu.zip'), 'x');
  db.prepare("INSERT INTO emulators (platform_slug, name, source, filename, storage_path, size_bytes) VALUES ('snes', 'Emu', 'upload', 'emu.zip', ?, 1)").run(path.join(vault, 'emu.zip'));
  await call(`/api/roms/${secret}/hide-all`, { method: 'POST', body: { hidden: true } });

  artDir = path.join(TMP, 'Artwork'); fs.mkdirSync(path.join(artDir, 'snes', 'covers'), { recursive: true }); fs.writeFileSync(path.join(artDir, 'snes', 'covers', 'Shown Game.png'), PNG);
  await call('/api/art/folders', { method: 'PUT', body: { folders: [artDir] } });
  await call('/api/metadata/providers', { method: 'PUT', body: { fields: { SS_USER: 'owner-ss-name', SS_PASSWORD: 'dummy-ss-pass', IGDB_CLIENT_ID: 'dummy-client-id', EMUMOVIES_USER: 'owner@example.test' } } });
});
after(async () => {
  await call('/api/metadata/providers', { method: 'DELETE' }).catch(() => {});
  server?.closeAllConnections(); await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('provider settings and the ScreenScraper account are for the admin only', async () => {
  for (const u of ['/api/metadata', '/api/metadata/providers', '/api/metadata/screenscraper/account', '/api/metadata/screenscraper/systems']) {
    const r = await call(u, { token: member });
    assert.equal(r.status, 403, u);
    assert.ok(!/owner-ss-name|dummy-client-id|owner@example\.test/.test(r.text), u);
  }
  const r = await call('/api/metadata');
  assert.equal(r.status, 200); assert.match(r.text, /owner-ss-name/, 'the admin still sees them');
  assert.equal((await call('/api/metadata/providers')).status, 200);
});

// Everything a member can read without naming something of someone else's. A new route of this kind belongs in this list.
const reads = () => ['/api/stats', '/api/platforms', '/api/version', '/api/prefs', '/api/roms', '/api/roms?limit=500&sort=added', '/api/roms?favorite=1', '/api/roms?playable=1', '/api/roms?system=all&hidden=all',
  '/api/roms/facets', '/api/roms/recently-played', `/api/roms/${shown}`, `/api/roms/${shown}/saves`, '/api/collections', `/api/collections/${collId}`, '/api/digital', '/api/digital/games',
  '/api/physical', '/api/physical/games', '/api/physical/sellers', '/api/physical/digital/review', '/api/art/folders', '/api/art/platforms', '/api/art/sharing', '/api/art/fill-job', '/api/art/import/status',
  '/api/messages/summary', '/api/messages/people', '/api/messages/conversations', '/api/messages/notices', '/api/metadata/launchbox', '/api/emulators/guide', '/api/emulators/vault',
  '/api/auth/me', '/api/auth/policy', '/api/auth/sessions', '/api/health'];

test('nothing a member or a play-only account can read names a folder on the server or a game hidden from them', async () => {
  for (const [who, token] of [['member', member], ['play-only', play]]) {
    let answered = 0;
    for (const u of reads()) {
      const r = await call(u, { token });
      assert.ok(r.status < 500, `${who} ${u} ${r.status}`);
      if (r.status === 200) answered++;
      noPaths(r, `${who} ${u}`);
      assert.ok(!/zzhush/i.test(r.text), `${who} ${u} tells of the hidden game: ${r.text.slice(Math.max(0, r.text.search(/zzhush/i) - 150), r.text.search(/zzhush/i) + 80)}`);
    }
    assert.ok(answered >= (who === 'member' ? 30 : 12), `${who}: only ${answered} answered, so the sweep proves little`);
  }
});

test('counts leave the hidden game out, and who favourited a game is not told', async () => {
  for (const token of [member, play]) {
    const stats = (await call('/api/stats', { token })).body;
    assert.equal(stats.library.favorites, 1, 'library favourites');
    assert.equal(stats.mine.favorites, 1, 'my favourites');
    const f = (await call('/api/roms/facets', { token })).body;
    assert.deepEqual(f.genres, [{ name: 'Platform', count: 1 }]); assert.deepEqual(f.regions, [{ name: 'USA', count: 1 }]); assert.deepEqual(f.tags, [{ name: 'plain-tag', count: 1 }]);
    assert.deepEqual(f.sources, []);
    assert.ok(!('favourite_of' in (await call(`/api/roms/${shown}`, { token })).body));
  }
});

test('the pages still get what they draw with, and the admin still sees everything', async () => {
  const mine = (await call(`/api/roms/${shown}`, { token: member })).body;
  assert.deepEqual(Object.keys(mine.media).sort(), ['box2d', 'wheel'], 'which pictures there are');
  assert.ok(mine.media.wheel && mine.cover_url.startsWith(`/api/roms/${shown}/cover`));
  const listed = (await call('/api/roms', { token: member })).body.items[0];
  assert.ok(listed.media.wheel && listed.cover_url);
  assert.ok((await call(`/api/collections/${collId}`, { token: member })).body.items[0].cover_url);

  for (const r of [(await call(`/api/roms/${shown}`)).body, (await call('/api/roms')).body.items.find((x) => x.id === shown)]) {
    assert.equal(r.source_path, path.join(srcDir, 'shown.sfc')); assert.equal(r.source_root, srcDir); assert.ok(r.media.box2d.path);
  }
  assert.ok((await call(`/api/roms/${shown}`)).body.favourite_of.includes('pvmember'));
  const f = (await call('/api/roms/facets')).body;
  assert.equal(f.sources[0].path, srcDir); assert.ok(f.genres.some((g) => g.name === 'ZzhushGenre'));
  const edited = (await call(`/api/roms/${shown}`, { method: 'PATCH', body: { players: 2 } })).body;
  assert.equal(edited.source_root, srcDir, 'after an edit too');
  assert.equal((await call('/api/art/folders')).body.folders[0].path, artDir);
});

test('a member imports artwork from a folder without being told where it is', async () => {
  const { folders } = (await call('/api/art/folders', { token: member })).body;
  assert.equal(folders.length, 1); assert.equal(folders[0].exists, true);
  const folder = folders[0].path;
  assert.match(folder, /Artwork/, 'still recognisable by its name'); assert.ok(!folder.includes(MARK));
  await call('/api/physical/games', { token: member, method: 'POST', body: { title: 'Shown Game', platform: 'snes' } });
  const preview = await call('/api/art/import', { token: member, method: 'POST', body: { target: 'physical', folder } });
  assert.equal(preview.status, 200, preview.text); assert.equal(preview.body.will.cover, 1); noPaths(preview, 'the preview');
  fs.renameSync(path.join(artDir, 'snes', 'covers', 'Shown Game.png'), path.join(artDir, 'moved-away.png'));   // so the import fails, and says why
  assert.equal((await call('/api/art/import', { token: member, method: 'POST', body: { target: 'physical', folder, apply: true } })).status, 200);
  let status; for (let i = 0; i < 200; i++) { status = await call('/api/art/import/status', { token: member }); if (!status.body.running) break; await new Promise((r) => setTimeout(r, 25)); }
  assert.equal(status.body.failed, 1, status.text); noPaths(status, 'a failed import');
  const bad = await call('/api/art/import', { token: member, method: 'POST', body: { target: 'physical', folder: '#9 nothing' } });
  assert.equal(bad.status, 400);
});
