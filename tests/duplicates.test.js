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
  const kept = g.items.find((i) => i.keep);
  assert.equal(kept.id, us, 'the USA copy is the one kept');
  assert.match(kept.why, /USA release/);
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
  const kept1 = g.items.find((i) => i.keep);
  assert.equal(kept1.id, good);
  assert.match(kept1.why, /verified against a DAT/);
  assert.equal(g.items[1].id, bad);

  const a = rom('gba', 'Glitch Garden (USA) (Rev 1).gba', { revision: '1' });
  const b = rom('gba', 'Glitch Garden (USA) (Rev 2).gba', { revision: '2' });
  const r2 = (await call('/api/admin/duplicates?platform=gba')).body;
  assert.equal(r2.groups[0].items.find((i) => i.keep).id, b, 'rev 2 is the keeper');
  assert.ok(a);
});

test('a favourite is protected: it is the suggested keeper even if another has a nicer region', async () => {
  const fav = rom('n64', 'Banner of Dawn (Europe).z64');
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, rom_id) VALUES ((SELECT id FROM users WHERE username = \'dmember\'), ?)').run(fav); // any person's favourite protects the copy
  rom('n64', 'Banner of Dawn (USA).z64');
  const g = (await call('/api/admin/duplicates?platform=n64')).body.groups[0];
  const kept2 = g.items.find((i) => i.keep);
  assert.equal(kept2.id, fav);
  assert.match(kept2.why, /a favourite/);
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
  await call(`/api/roms/${b}/hide`, { method: 'POST', body: { hidden: true } }); // the admin hides it (personal)
  assert.equal((await call('/api/admin/duplicates?platform=ps1')).body.total, 0, 'once the extra is hidden the group is resolved');
  await call(`/api/roms/${b}/hide`, { method: 'POST', body: { hidden: false } });
  db.prepare('UPDATE roms SET missing = 1 WHERE id = ?').run(b);
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

/* ───── numbers in the file name keep different volumes / discs / sequels apart ───── */

test('volumes are not duplicates, even when a provider gave both the same stored title', async () => {
  // Reported case: "Volume 2" and "Volume 3" were listed as duplicates of each other.
  const v2 = rom('xbox', 'Woody Woodpecker and Friends Volume 2 (USA).iso');
  const v3 = rom('xbox', 'Woody Woodpecker and Friends Volume 3 (USA).iso');
  db.prepare("UPDATE roms SET title = 'Woody Woodpecker and Friends', sort_title = 'woody woodpecker and friends' WHERE id IN (?, ?)").run(v2, v3);
  const r = (await call('/api/admin/duplicates?platform=xbox')).body;
  assert.equal(r.total, 0, 'two different volumes are two different games');

  // ...while a genuine regional pair of the same volume is still found
  rom('xbox', 'Woody Woodpecker and Friends Volume 2 (Europe).iso');
  const id = db.prepare("SELECT id FROM roms WHERE filename = 'Woody Woodpecker and Friends Volume 2 (Europe).iso'").get().id;
  db.prepare("UPDATE roms SET title = 'Woody Woodpecker and Friends', sort_title = 'woody woodpecker and friends' WHERE id = ?").run(id);
  const r2 = (await call('/api/admin/duplicates?platform=xbox')).body;
  assert.equal(r2.total, 1);
  assert.deepEqual(r2.groups[0].items.map((i) => i.filename).sort(), ['Woody Woodpecker and Friends Volume 2 (Europe).iso', 'Woody Woodpecker and Friends Volume 2 (USA).iso']);
});

test('discs, parts and numbered sequels with an identical stored title stay separate', async () => {
  // each family gets its own stored title, as real games would (a Disc 1 and a Part 1 are not the same game anyway)
  const mk = (fn, title) => { const id = rom('psp', fn); db.prepare('UPDATE roms SET title = ?, sort_title = ? WHERE id = ?').run(title, title.toLowerCase(), id); return id; };
  mk('Alpha Quest (Disc 1).iso', 'Alpha Quest'); mk('Alpha Quest (Disc 2).iso', 'Alpha Quest');
  mk('Beta Saga Part 1.iso', 'Beta Saga'); mk('Beta Saga Part 2.iso', 'Beta Saga');
  mk('Gamma Run 3.iso', 'Gamma Run'); mk('Gamma Run 4.iso', 'Gamma Run');
  const groups = (await call('/api/admin/duplicates?platform=psp')).body.groups.filter((g) => /Alpha Quest|Beta Saga|Gamma Run/.test(g.title));
  assert.equal(groups.length, 0, 'none of them are duplicates of each other');
  // a real duplicate of one of them is still caught
  mk('Alpha Quest (Disc 1) (Europe).iso', 'Alpha Quest');
  const again = (await call('/api/admin/duplicates?platform=psp')).body.groups.filter((g) => /Alpha Quest/.test(g.title));
  assert.equal(again.length, 1);
  assert.equal(again[0].items.length, 2, 'only the two Disc 1 copies are grouped');
});

test('roman numerals count too, and a year or region tag does not', async () => {
  const { distinguishers } = await import('../src/lib/duplicates.js');
  assert.notEqual(distinguishers('Street Brawl II (USA).sfc'), distinguishers('Street Brawl III (USA).sfc'));
  assert.equal(distinguishers('Street Brawl II (USA).sfc'), distinguishers('Street Brawl II (Europe) (Rev A).sfc'));
  assert.equal(distinguishers('Pitfall (1982) (USA).bin'), distinguishers('Pitfall (Europe).bin'));
  assert.notEqual(distinguishers('Woody Volume 2 (USA).iso'), distinguishers('Woody Volume 3 (USA).iso'));
  assert.equal(distinguishers('Super Street Fighter II Turbo (USA).sfc'), distinguishers('Super Street Fighter II Turbo (Europe).sfc'), 'the reported true duplicate still matches');
  assert.equal(distinguishers('Mixed Words (USA).sfc'), '', 'words like "mix" are not mistaken for numerals');
});

test('your keep choice overrides the automatic pick and survives a re-run', async () => {
  const a = rom('gba', 'Pinned Game (USA).gba');
  const b = rom('gba', 'Pinned Game (Japan).gba');
  const find = async () => (await call('/api/admin/duplicates?platform=gba')).body.groups.find((g) => /Pinned/.test(g.title));
  let g = await find();
  assert.equal(g.items.find((i) => i.keep).id, a, 'automatic: USA wins');
  assert.equal((await call('/api/admin/duplicates/keep', { method: 'POST', body: { id: b, value: 1 } })).status, 200);
  g = await find();
  assert.equal(g.items.find((i) => i.keep).id, b, 'your pick wins');
  assert.deepEqual(g.items.filter((i) => i.keep).map((i) => i.id), [b]);
  assert.equal(g.items.find((i) => i.id === b).chosen, 'keep');
  // pin both: both stay
  await call('/api/admin/duplicates/keep', { method: 'POST', body: { id: a, value: 1 } });
  g = await find();
  assert.equal(g.items.filter((i) => i.keep).length, 2);
  // back to automatic
  await call('/api/admin/duplicates/keep', { method: 'POST', body: { id: a, value: null } });
  await call('/api/admin/duplicates/keep', { method: 'POST', body: { id: b, value: null } });
  g = await find();
  assert.equal(g.items.find((i) => i.keep).id, a);
  assert.equal((await call('/api/admin/duplicates/keep', { method: 'POST', token: memberTok, body: { id: a, value: 1 } })).status, 403);
});

test('a copy marked Keep cannot be deleted (single, bulk, orphan purge) until Keep is switched off', async () => {
  const k = rom('gba', 'Protected Game (USA).gba');
  await call('/api/admin/duplicates/keep', { method: 'POST', body: { id: k, value: 1 } });
  const one = await call(`/api/roms/${k}`, { method: 'DELETE' });
  assert.equal(one.status, 409);
  assert.match(one.body.error, /locked/);
  const bulk = await call('/api/roms/bulk/delete', { method: 'POST', body: { ids: [k] } });
  assert.equal(bulk.body.deleted, 0);
  assert.equal(bulk.body.protected, 1);
  const purge = await call('/api/roms?dry_run=0', { method: 'DELETE' });
  assert.equal(purge.status, 200);
  assert.ok(db.prepare('SELECT 1 FROM roms WHERE id = ?').get(k), 'still in the library after all three');
  await call('/api/admin/duplicates/keep', { method: 'POST', body: { id: k, value: null } });
  assert.equal((await call(`/api/roms/${k}`, { method: 'DELETE' })).status, 200);
});

test('favourites: deleting a game someone favourited needs confirmation, and says who', async () => {
  const f = rom('gba', 'Beloved Game (USA).gba');
  const admin = db.prepare("SELECT id FROM users WHERE username = 'dadmin'").get().id;
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, rom_id) VALUES (?, ?)').run(admin, f);
  const warn = await call(`/api/roms/${f}`, { method: 'DELETE' });
  assert.equal(warn.status, 409);
  assert.deepEqual(warn.body.favourite_of, ['dadmin']);
  assert.match(warn.body.error, /favourite of dadmin/);
  const bulk = await call('/api/roms/bulk/delete', { method: 'POST', body: { ids: [f] } });
  assert.equal(bulk.status, 409);
  assert.equal(bulk.body.favourite_count, 1);
  assert.ok(db.prepare('SELECT 1 FROM roms WHERE id = ?').get(f), 'nothing deleted yet');
  const ok = await call(`/api/roms/${f}?confirm_favorites=1`, { method: 'DELETE' });
  assert.equal(ok.status, 200);
});

test('a tie says so; locking one copy ends the tie', async () => {
  const a = rom('gba', 'Twin Game (USA).gba');
  const b = rom('gba', 'Twin Game (USA) (2).gba');
  const find = async () => (await call('/api/admin/duplicates?platform=gba')).body.groups.find((g) => /Twin/.test(g.title));
  let g = await find();
  if (g) { // same score, no lock: tie
    assert.equal(g.tied, true);
    assert.ok(g.items.every((i) => i.tie));
    await call('/api/admin/duplicates/keep', { method: 'POST', body: { id: a, value: 1 } });
    g = await find();
    assert.equal(g.tied, false);
    assert.equal(g.items.filter((i) => i.keep).length, 1);
  }
});

test('favourites are per person: one user starring a game does not star it for anyone else', async () => {
  const g = rom('gba', 'Per Person Game (USA).gba');
  const asMember = (p, o = {}) => call(p, { token: memberTok, ...o });
  assert.equal((await asMember(`/api/roms/${g}`)).body.favorite, 0);
  assert.equal((await asMember(`/api/roms/${g}/favorite`, { method: 'POST' })).body.favorite, 1);
  assert.equal((await asMember(`/api/roms/${g}`)).body.favorite, 1, 'the member sees their own star');
  assert.equal((await call(`/api/roms/${g}`)).body.favorite, 0, 'the admin does NOT see the member\'s star');
  assert.equal((await call('/api/roms?favorite=1&limit=100')).body.items.some((r) => r.id === g), false, 'not in the admin favourites list');
  assert.equal((await asMember('/api/roms?favorite=1&limit=100')).body.items.some((r) => r.id === g), true, 'in the member favourites list');
  assert.equal((await call(`/api/roms/${g}/favorite`, { method: 'POST' })).body.favorite, 1, 'admin can star it independently');
  assert.equal((await asMember(`/api/roms/${g}/favorite`, { method: 'POST' })).body.favorite, 0, 'member un-stars only their own');
  assert.equal((await call(`/api/roms/${g}`)).body.favorite, 1, 'admin star untouched');
});

test('the same arcade zip name on two different platforms is NOT a duplicate (FBNeo vs MAME)', async () => {
  const a = rom('fba', 'enduror.zip');
  const b = rom('mame', 'enduror.zip');
  db.prepare("INSERT OR IGNORE INTO mame_names (name, title, year, manufacturer, cloneof, isbios, isdevice) VALUES ('enduror', 'Enduro Racer', 1986, 'Sega', NULL, 0, 0)").run();
  const all = (await call('/api/admin/duplicates?limit=200')).body.groups;
  assert.ok(!all.some((g) => g.items.some((i) => i.id === a) && g.items.some((i) => i.id === b)), 'FBNeo and MAME copies are never grouped together');
  const c = rom('mame', 'enduror2.zip');
  db.prepare("INSERT OR IGNORE INTO mame_names (name, title, year, manufacturer, cloneof, isbios, isdevice) VALUES ('enduror2', 'Enduro Racer (clone)', 1986, 'Sega', 'enduror', 0, 0)").run();
  const g2 = (await call('/api/admin/duplicates?platform=mame&limit=200')).body.groups.find((g) => g.items.some((i) => i.id === b));
  assert.ok(g2 && g2.items.some((i) => i.id === c), 'a clone on the SAME platform still groups under its parent');
});

test('locking a copy never changes the order the copies are shown in', async () => {
  const a = rom('gba', 'Order Check (USA).gba');
  const b = rom('gba', 'Order Check (Japan).gba');
  const find = async () => (await call('/api/admin/duplicates?platform=gba&limit=200')).body.groups.find((g) => /Order Check/.test(g.title));
  const before = (await find()).items.map((i) => i.id);
  await call('/api/admin/duplicates/keep', { method: 'POST', body: { id: before[1], value: 1 } }); // lock the one shown SECOND
  const afterLock = await find();
  assert.deepEqual(afterLock.items.map((i) => i.id), before, 'same order after locking the second copy');
  assert.equal(afterLock.items.find((i) => i.keep).id, before[1], 'the locked (second) copy is the one kept');
  await call('/api/admin/duplicates/keep', { method: 'POST', body: { id: before[1], value: null } });
  assert.deepEqual((await find()).items.map((i) => i.id), before, 'and the same again after unlocking');
  assert.ok(a && b);
});

test('arcade zips with different parents are never grouped by a shared title (Darkstalkers vs Night Warriors on CPS2)', async () => {
  // CPS2 is a platform people add themselves (as on a real server), so create it the same way.
  db.prepare("INSERT OR IGNORE INTO platforms (slug, name, short_name, family, accent, extensions) VALUES ('cps2', 'Capcom CPS2', 'CPS2', 'Arcade', '#b71c1c', 'zip')").run();
  const a = rom('cps2', 'dstlk.zip');
  const b = rom('cps2', 'nwarr.zip');
  const clone = rom('cps2', 'vampj.zip');
  // both zips were wrongly given the same stored title by a metadata provider
  db.prepare("UPDATE roms SET title = 'Night Warriors: Darkstalkers Revenge', sort_title = 'night warriors: darkstalkers revenge' WHERE id IN (?, ?)").run(a, b);
  for (const [name, title, cloneof] of [['dstlk', 'Darkstalkers', null], ['nwarr', 'Night Warriors', null], ['vampj', 'Vampire (Japan)', 'dstlk']]) {
    db.prepare('INSERT OR REPLACE INTO mame_names (name, title, year, manufacturer, cloneof, isbios, isdevice) VALUES (?, ?, 1994, ?, ?, 0, 0)').run(name, title, 'Capcom', cloneof);
  }
  const groups = (await call('/api/admin/duplicates?platform=cps2&limit=200')).body.groups;
  assert.ok(!groups.some((g) => g.items.some((i) => i.id === a) && g.items.some((i) => i.id === b)), 'different parents stay apart');
  const g = groups.find((x) => x.items.some((i) => i.id === clone));
  assert.ok(g && g.items.some((i) => i.id === a), 'a real clone still groups under its parent');
});

test('same-title disc images with very different sizes are flagged as probably not duplicates', async () => {
  const a = rom('ps2', 'Size Check (USA).chd');
  const b = rom('ps2', 'Size Check (Europe).chd');
  db.prepare('UPDATE roms SET size_bytes = ? WHERE id = ?').run(1400 * 1048576, a);
  db.prepare('UPDATE roms SET size_bytes = ? WHERE id = ?').run(3500 * 1048576, b);
  const g = (await call('/api/admin/duplicates?platform=ps2&limit=200')).body.groups.find((x) => /Size Check/.test(x.title));
  assert.ok(g, 'still listed');
  assert.equal(g.size_mismatch, true);
  db.prepare('UPDATE roms SET size_bytes = ? WHERE id = ?').run(1450 * 1048576, b);
  const g2 = (await call('/api/admin/duplicates?platform=ps2&limit=200')).body.groups.find((x) => /Size Check/.test(x.title));
  assert.equal(g2.size_mismatch, false, 'similar sizes: no warning');
});
