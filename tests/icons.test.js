import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-icons-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'iadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'i-admin-password-1';

let server, base, db, adminTok, memberTok;
const call = async (p, { token = adminTok, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (u, p) => (await call('/api/auth/login', { token: null, method: 'POST', body: { username: u, password: p } })).body.token;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('iadmin', 'i-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'imember', password: 'i-member-pass-12', role: 'user' } });
  memberTok = await login('imember', 'i-member-pass-12');
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('the server and the browser agree on which icons exist, and every built-in platform has a default', async () => {
  const { ICON_TYPES, PLATFORMS } = await import('../src/lib/platforms.js');
  const text = fs.readFileSync(new URL('../public/platform-icons.js', import.meta.url), 'utf8');
  const types = text.match(/PLATFORM_ICON_TYPES = \[([\s\S]*?)\n\];/)[1];
  const inBrowser = [...types.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(inBrowser.sort(), [...ICON_TYPES].sort());
  const defaults = text.match(/DEFAULT_ICON_BY_SLUG = \{([\s\S]*?)\};/)[1];
  for (const p of PLATFORMS) assert.match(defaults, new RegExp(`['"]?${p.slug}['"]?:`), `${p.slug} has a default icon`);
  for (const m of defaults.matchAll(/: '([a-z]+)'/g)) assert.ok(ICON_TYPES.includes(m[1]), `default "${m[1]}" is a real icon`);
});

test('an admin can choose a platform icon; it is validated, and members cannot', async () => {
  assert.equal((await call('/api/platforms/nes', { method: 'PATCH', body: { icon: 'cartridge' } })).body.icon, 'cartridge');
  assert.equal((await call('/api/platforms')).body.items.find((p) => p.slug === 'nes').icon, 'cartridge', 'it comes back with the platform list');
  assert.equal((await call('/api/platforms/nes', { method: 'PATCH', body: { icon: 'dragon' } })).status, 400);
  assert.equal((await call('/api/platforms/nes', { token: memberTok, method: 'PATCH', body: { icon: 'disc' } })).status, 403);
  assert.equal((await call('/api/platforms/nes', { method: 'PATCH', body: { icon: '' } })).body.icon, null, 'cleared: back to the built-in one');
});

test('a platform added by hand can have an icon from the start', async () => {
  const r = await call('/api/platforms', { method: 'POST', body: { slug: 'myhandheld', name: 'My Handheld', family: 'Others', icon: 'handheld' } });
  assert.equal(r.status, 201); assert.equal(r.body.icon, 'handheld');
  const bad = await call('/api/platforms', { method: 'POST', body: { slug: 'myother', name: 'My Other', icon: 'nonsense' } });
  assert.equal(bad.status, 201); assert.equal(bad.body.icon, null, 'an unknown icon is ignored, not an error');
});

test('games carry their platform icon, and search finds a game by its platform', async () => {
  const file = path.join(TMP, 'x.rom'); fs.writeFileSync(file, 'rom');
  const ins = (slug, title, sha) => db.prepare(`INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1)
    VALUES ((SELECT id FROM platforms WHERE slug = ?), ?, ?, ?, ?, 3, ?)`).run(slug, title, title.toLowerCase(), `${title}.rom`, file, sha);
  ins('gb', 'Tiny Quest', 'ic01'); ins('snes', 'Big Quest', 'ic02'); ins('genesis', 'Other Thing', 'ic03');
  await call('/api/platforms/gb', { method: 'PATCH', body: { icon: 'handheld' } });
  const t = (q) => call(`/api/roms?limit=50&q=${encodeURIComponent(q)}`).then((r) => r.body.items.map((i) => i.title).sort());
  assert.deepEqual(await t('quest'), ['Big Quest', 'Tiny Quest']);
  assert.deepEqual(await t('game boy'), ['Tiny Quest'], 'a platform name finds its games');
  assert.deepEqual(await t('snes'), ['Big Quest'], 'so does its short name');
  assert.deepEqual(await t('nintendo'), ['Big Quest', 'Tiny Quest'], 'and its family');
  assert.equal((await call('/api/roms?q=tiny')).body.items[0].platform_icon, 'handheld');
});

test('edits to a built-in platform survive a restart or an update (the built-in list no longer overwrites them)', async () => {
  const { seedPlatforms } = await import('../src/lib/platforms.js');
  await call('/api/platforms/ps1', { method: 'PATCH', body: { short_name: 'PSX', accent: '#123456', name: 'PlayStation (mine)', family: 'Sony' } });
  await call('/api/platforms/genesis', { method: 'PATCH', body: { short_name: 'GENESIS', icon: 'cartridge' } });
  seedPlatforms(db); // what every start and every update runs
  seedPlatforms(db);
  const row = (slug) => db.prepare('SELECT * FROM platforms WHERE slug = ?').get(slug);
  assert.equal(row('ps1').short_name, 'PSX');
  assert.equal(row('ps1').accent, '#123456');
  assert.equal(row('ps1').name, 'PlayStation (mine)');
  assert.equal(row('genesis').short_name, 'GENESIS');
  assert.equal(row('genesis').icon, 'cartridge', 'the icon choice is kept too');
  assert.equal(row('snes').short_name, 'SNES', 'an untouched platform is, of course, still the built-in one');
});

test('a built-in platform that is missing is created again, and blank ids are filled from the built-in values', async () => {
  const { seedPlatforms } = await import('../src/lib/platforms.js');
  db.prepare("DELETE FROM platforms WHERE slug = 'virtualboy'").run();
  db.prepare("UPDATE platforms SET screenscraper_id = NULL, tgdb_id = NULL WHERE slug = 'n64'").run();
  seedPlatforms(db);
  assert.ok(db.prepare("SELECT 1 FROM platforms WHERE slug = 'virtualboy'").get(), 'a missing built-in platform is created');
  const n64 = db.prepare("SELECT screenscraper_id, tgdb_id FROM platforms WHERE slug = 'n64'").get();
  assert.ok(n64.screenscraper_id && n64.tgdb_id, 'ids that were never set are filled in');
  db.prepare("UPDATE platforms SET screenscraper_id = 9999 WHERE slug = 'n64'").run();
  seedPlatforms(db);
  assert.equal(db.prepare("SELECT screenscraper_id FROM platforms WHERE slug = 'n64'").get().screenscraper_id, 9999, 'an id the admin set is never replaced');
});
