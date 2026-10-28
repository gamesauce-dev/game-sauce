import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-dupes-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'dadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'd-admin-password-1';

let server, base, db, adminTok, memberTok;
const call = async (p, { token = adminTok, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (u, p) => (await call('/api/auth/login', { token: null, method: 'POST', body: { username: u, password: p } })).body.token;
let n = 0;
const rom = (slug, filename, extra = {}) => {
  const { parseFilename, sortTitle } = global.__meta;
  const parsed = parseFilename(filename);
  const sha = `dup${String(++n).padStart(6, '0')}`;
  return db.prepare(`INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, region, revision, sha1, dat_status, favorite, cover_path)
    VALUES ((SELECT id FROM platforms WHERE slug = ?), ?, ?, ?, ?, 1000, ?, ?, ?, ?, ?, ?)`)
    .run(slug, parsed.title, sortTitle(parsed.title), filename, `/nowhere/${filename}`, extra.region ?? parsed.region, extra.revision ?? parsed.revision, sha, extra.dat ?? null, extra.fav ? 1 : 0, extra.cover ?? null).lastInsertRowid;
};

before(async () => {
  global.__meta = await import('../src/lib/metadata.js');
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('dadmin', 'd-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'dmember', password: 'd-member-pass-12', role: 'user' } });
  memberTok = await login('dmember', 'd-member-pass-12');
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('it is admin-only and starts empty', async () => {
  assert.equal((await call('/api/admin/duplicates', { token: null })).status, 401);
  assert.equal((await call('/api/admin/duplicates', { token: memberTok })).status, 403);
  const r = await call('/api/admin/duplicates');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.total, r.body.extra, r.body.groups.length], [0, 0, 0]);
});

test('regional versions of one game are grouped, and the USA copy is suggested', async () => {
  const eu = rom('snes', 'Starfall Rangers (Europe).sfc');
  const jp = rom('snes', 'Starfall Rangers (Japan).sfc');
  const us = rom('snes', 'Starfall Rangers (USA).sfc');
  rom('snes', 'Lonely Game (USA).sfc'); // no twin: must not appear
  const r = (await call('/api/admin/duplicates')).body;
  assert.equal(r.total, 1);
  assert.equal(r.extra, 2);
  const g = r.groups[0];
  assert.equal(g.items.length, 3);
  assert.equal(g.items[0].id, us, 'USA first');
  assert.equal(g.items[0].keep, true);
  assert.match(g.items[0].why, /USA release/);
  assert.deepEqual(g.items.filter((i) => i.keep).map((i) => i.id), [us], 'exactly one keeper');
  assert.ok(g.items.map((i) => i.id).includes(eu) && g.items.map((i) => i.id).includes(jp));
  assert.ok(!r.groups.some((x) => /Lonely/.test(x.title)), 'a single copy is not a duplicate');
});

test('"The" and punctuation do not hide a match', async () => {
  rom('nes', 'The Dungeon of Echoes (USA).nes');
  rom('nes', 'Dungeon of Echoes (Europe).nes');
  const r = (await call('/api/admin/duplicates?platform=nes')).body;
  assert.equal(r.total, 1);
  assert.equal(r.groups[0].items.length, 2);
});

test('the same title on a different platform is NOT a duplicate', async () => {
  rom('gb', 'Cobalt Blade (USA).gb');
  rom('gbc', 'Cobalt Blade (USA).gbc');
  const r = (await call('/api/admin/duplicates')).body;
  assert.ok(!r.groups.some((g) => /Cobalt Blade/.test(g.title)), 'GB and GBC versions are different games here');
});

test('a DAT-verified copy beats a bad dump, and a later revision beats an earlier one', async () => {
  const bad = rom('genesis', 'Iron Tide (USA).md', { dat: 'bad' });
  const good = rom('genesis', 'Iron Tide (USA) (Rev A).md', { dat: 'verified', revision: 'A' });
  const r = (await call('/api/admin/duplicates?platform=genesis')).body;
  const g = r.groups.find((x) => /Iron Tide/.test(x.title));
  assert.equal(g.items[0].id, good);
  assert.match(g.items[0].why, /verified against a DAT/);
  assert.equal(g.items[1].id, bad);

  const a = rom('gba', 'Glitch Garden (USA) (Rev 1).gba', { revision: '1' });
  const b = rom('gba', 'Glitch Garden (USA) (Rev 2).gba', { revision: '2' });
  const r2 = (await call('/api/admin/duplicates?platform=gba')).body;
  assert.equal(r2.groups[0].items[0].id, b, 'rev 2 is the keeper');
  assert.ok(a);
});

test('a favourite is protected: it is the suggested keeper even if another has a nicer region', async () => {
  const fav = rom('n64', 'Banner of Dawn (Europe).z64', { fav: true });
  rom('n64', 'Banner of Dawn (USA).z64');
  const g = (await call('/api/admin/duplicates?platform=n64')).body.groups[0];
  assert.equal(g.items[0].id, fav);
  assert.match(g.items[0].why, /a favourite/);
});

test('arcade clones are grouped under their parent using the MAME name list', async () => {
  db.prepare("INSERT INTO mame_names (name, title, year, manufacturer, cloneof, isbios, isdevice) VALUES ('sf2', 'Street Brawl II', 1991, 'X', NULL, 0, 0)").run();
  db.prepare("INSERT INTO mame_names (name, title, year, manufacturer, cloneof, isbios, isdevice) VALUES ('sf2ua', 'Street Brawl II (US rev A)', 1991, 'X', 'sf2', 0, 0)").run();
  db.prepare("INSERT INTO mame_names (name, title, year, manufacturer, cloneof, isbios, isdevice) VALUES ('sf2j', 'Street Brawl II (Japan)', 1991, 'X', 'sf2', 0, 0)").run();
  rom('arcade', 'sf2.zip'); rom('arcade', 'sf2ua.zip'); rom('arcade', 'sf2j.zip');
  const r = (await call('/api/admin/duplicates?platform=arcade')).body;
  assert.equal(r.total, 1, 'three differently-titled sets, one game');
  assert.equal(r.groups[0].items.length, 3);
});

test('hidden and missing games are left out', async () => {
  const a = rom('ps1', 'Midnight Courier (USA).bin');
  const b = rom('ps1', 'Midnight Courier (Europe).bin');
  assert.equal((await call('/api/admin/duplicates?platform=ps1')).body.total, 1);
  db.prepare('UPDATE roms SET hidden = 1 WHERE id = ?').run(b);
  assert.equal((await call('/api/admin/duplicates?platform=ps1')).body.total, 0, 'once the extra is hidden the group is resolved');
  db.prepare('UPDATE roms SET hidden = 0, missing = 1 WHERE id = ?').run(b);
  assert.equal((await call('/api/admin/duplicates?platform=ps1')).body.total, 0);
  assert.ok(a);
});

test('hiding the extras uses the existing reversible hide and never touches files or rows', async () => {
  rom('psp', 'Echo Pulse (USA).iso'); rom('psp', 'Echo Pulse (Europe).iso');
  const before = db.prepare('SELECT COUNT(*) AS n FROM roms').get().n;
  const g = (await call('/api/admin/duplicates?platform=psp')).body.groups[0];
  const extras = g.items.filter((i) => !i.keep).map((i) => i.id);
  const res = await call('/api/roms/bulk/hide', { method: 'POST', body: { ids: extras, hidden: true } });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM roms').get().n, before, 'no rows removed');
  assert.equal((await call('/api/admin/duplicates?platform=psp')).body.total, 0);
  await call('/api/roms/bulk/hide', { method: 'POST', body: { ids: extras, hidden: false } });
  assert.equal((await call('/api/admin/duplicates?platform=psp')).body.total, 1, 'unhiding brings the group back');
});

test('results are paged', async () => {
  for (let i = 0; i < 6; i++) { rom('dreamcast', `Page Game ${i} (USA).cdi`); rom('dreamcast', `Page Game ${i} (Europe).cdi`); }
  const p1 = (await call('/api/admin/duplicates?platform=dreamcast&limit=4&offset=0')).body;
  const p2 = (await call('/api/admin/duplicates?platform=dreamcast&limit=4&offset=4')).body;
  assert.equal(p1.total, 6); assert.equal(p1.groups.length, 4); assert.equal(p2.groups.length, 2);
  assert.equal(new Set([...p1.groups, ...p2.groups].map((g) => g.key)).size, 6, 'no repeats across pages');
});
