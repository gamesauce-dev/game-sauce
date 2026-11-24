// Importing a DAT or the MAME list never renames a game the person edited, and never changes who has a game hidden.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-datkeep-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'dkadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'dk-admin-password-1';

let server, base, db, tok, dats, mame;
const call = async (p, { method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
let n = 0;
const add = (title, filename, slug, source = 'filename') => Number(db.prepare('INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, meta_source) VALUES (?,?,?,(SELECT id FROM platforms WHERE slug = ?),?,1,?,?)')
  .run(title, title.toLowerCase(), filename, slug, path.join(TMP, filename), 'dk' + (++n), source).lastInsertRowid);
const row = (id) => db.prepare('SELECT title, long_title, meta_source, hidden_all, is_system, source_hidden FROM roms WHERE id = ?').get(id);
const mineHidden = (id) => !!db.prepare('SELECT 1 FROM hidden_roms WHERE rom_id = ?').get(id);

const DAT = `<?xml version="1.0"?>
<datafile><header><name>Microsoft - Xbox 360</name><version>1</version></header>
<game name="Halo 3 (USA)"><rom name="Halo 3 (USA).iso" size="1" crc="aaaa0001" sha1="aaaa000000000000000000000000000000000001"/></game>
<game name="Gears of DAT (USA)"><rom name="Gears of DAT (USA).iso" size="1" crc="aaaa0002" sha1="aaaa000000000000000000000000000000000002"/></game>
<game name="Forza DAT (USA)"><rom name="Forza DAT (USA).iso" size="1" crc="aaaa0003" sha1="aaaa000000000000000000000000000000000003"/></game>
</datafile>`;
const LISTXML = `<?xml version="1.0"?>
<!DOCTYPE mame [ ]>
<mame build="0.1">
<machine name="pacman"><description>Pac-Man (Midway)</description><year>1980</year><manufacturer>Namco</manufacturer><rom name="a" size="1"/></machine>
<machine name="galaga"><description>Galaga (Namco rev B)</description><year>1981</year><manufacturer>Namco</manufacturer><rom name="b" size="1"/></machine>
</mame>`;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  dats = await import('../src/dats.js');
  mame = await import('../src/lib/mamenames.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dkadmin', password: 'dk-admin-password-1' }) })).json()).token;
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

const setHash = (id, sha, crc) => db.prepare('UPDATE roms SET sha1 = ?, crc32 = ?, size_bytes = 1 WHERE id = ?').run(sha, crc, id);

test('a title the person edited survives a DAT import, a re-match and a forced re-match', async () => {
  const edited = add('Gears Of War', 'gears.iso', 'xbox360');
  const plain = add('forza', 'forza.iso', 'xbox360');
  const hand = add('Halo Three', 'halo.iso', 'xbox360');
  setHash(edited, 'aaaa000000000000000000000000000000000002', 'aaaa0002');
  setHash(plain, 'aaaa000000000000000000000000000000000003', 'aaaa0003');
  setHash(hand, 'aaaa000000000000000000000000000000000001', 'aaaa0001');
  const r = await call(`/api/roms/${edited}`, { method: 'PATCH', body: { title: 'My Gears Title' } });
  assert.equal(r.status, 200);
  await call(`/api/roms/${hand}`, { method: 'PATCH', body: { title: 'Halo, my way' } });
  assert.equal(row(edited).meta_source, 'manual', "an edit marks the title as the person's own");

  const file = path.join(TMP, 'x360.dat'); fs.writeFileSync(file, DAT);
  await dats.importDat({ filePath: file });
  dats.rematchAll();
  dats.rematchAll({ force: true });
  assert.equal(row(edited).title, 'My Gears Title');
  assert.equal(row(hand).title, 'Halo, my way');
  assert.equal(row(plain).title, 'Forza DAT (USA)', 'a title the app derived itself still takes the DAT name');
  // saving the same title again (the form does it) is not an edit
  const same = await call(`/api/roms/${plain}`, { method: 'PATCH', body: { title: 'Forza DAT (USA)', genre: 'Racing' } });
  assert.equal(same.status, 200); assert.equal(row(plain).meta_source, 'dat');
});

test('a hidden game stays exactly as hidden through a DAT import, a re-match and the MAME list', async () => {
  const mineOnly = add('Hide Me', 'hideme.iso', 'xbox360');
  const everyone = add('Hide From All', 'hideall.iso', 'xbox360');
  const arcade = add('pacman', 'pacman.zip', 'mame');
  const sys = add('galaga', 'galaga.zip', 'mame');
  setHash(mineOnly, 'bbbb000000000000000000000000000000000001', 'bbbb0001');
  setHash(everyone, 'bbbb000000000000000000000000000000000002', 'bbbb0002');
  db.prepare('INSERT INTO hidden_roms (user_id, rom_id) VALUES ((SELECT id FROM users LIMIT 1), ?)').run(mineOnly);
  db.prepare('INSERT INTO hidden_roms (user_id, rom_id) VALUES ((SELECT id FROM users LIMIT 1), ?)').run(arcade);
  db.prepare('UPDATE roms SET hidden_all = 1 WHERE id IN (?, ?)').run(everyone, sys);
  const state = () => [mineOnly, everyone, arcade, sys].map((id) => [row(id).hidden_all, row(id).source_hidden, mineHidden(id)]);
  const before = state();

  const file = path.join(TMP, 'x360b.dat'); fs.writeFileSync(file, DAT.replace(/aaaa/g, 'bbbb').replace('Halo 3', 'Halo 4'));
  await dats.importDat({ filePath: file });
  dats.rematchAll(); dats.rematchAll({ force: true });
  const list = path.join(TMP, 'list.xml'); fs.writeFileSync(list, LISTXML);
  await mame.importMameNames(list);
  for (const slug of mame.ARCADE_ROMSET) dats.rematchAll({ platform: slug });
  mame.applyMameNames();

  assert.deepEqual(state(), before);
  assert.equal(row(arcade).title, 'Pac-Man', 'the MAME list still names a game that was never edited');
});

test('the MAME list does not rename a title the person edited', async () => {
  const id = add('pacman', 'pacman2.zip', 'mame');
  db.prepare("INSERT OR IGNORE INTO mame_names (name, title) VALUES ('pacman2', 'Pac-Man (Midway)')").run();
  mame.applyMameNames(id);
  assert.equal(row(id).title, 'Pac-Man');
  await call(`/api/roms/${id}`, { method: 'PATCH', body: { title: 'Pacman (mine)' } });
  mame.applyMameNames(); mame.applyMameNames(id);
  const r = row(id);
  assert.equal(r.title, 'Pacman (mine)');
  assert.equal(r.long_title, 'Pac-Man (Midway)', 'the long name is still filled from the list');
});
