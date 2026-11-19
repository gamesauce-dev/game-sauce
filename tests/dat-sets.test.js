import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-datsets-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'dsadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'ds-admin-password-1';

const { prepareApp } = await import('../src/app.js');
await prepareApp();   // every table, as the app has them
const { default: db } = await import('../src/db.js');
const { seedPlatforms } = await import('../src/lib/platforms.js');
const { importDat, rematchAll, listDatfiles, deleteDatfile } = await import('../src/dats.js');
const { importMameNames } = await import('../src/lib/mamenames.js');
seedPlatforms(db);

after(() => { try { db.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

const DAT = `<?xml version="1.0"?>
<datafile><header><name>MAME</name><description>MAME test set</description><version>0.1</version></header>
<machine name="pacman"><description>Pac-Man (Midway)</description><rom name="pacman.6e" size="4096" crc="c1e6ab10"/></machine>
<machine name="pacmanf" cloneof="pacman"><description>Pac-Man (hack)</description><rom name="pacman.6e" size="4096" crc="c1e6ab10"/></machine>
<machine name="galaga"><description>Galaga (Namco rev B)</description><rom name="gg1_1b.3p" size="4096" crc="ab036c9f"/></machine>
</datafile>`;

const platformId = (slug) => db.prepare('SELECT id FROM platforms WHERE slug = ?').get(slug).id;
let n = 0;
const rom = (slug, filename, title, metaSource) => Number(db.prepare(
  "INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1, meta_source) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
).run(platformId(slug), title, title.toLowerCase(), filename, 'C:/n/' + (++n), 'ds' + n, metaSource).lastInsertRowid);
const row = (id) => db.prepare('SELECT title, dat_status, dat_title, filename FROM roms WHERE id = ?').get(id);

test('a DAT keeps every machine by name, even one whose chips another machine already supplied', async () => {
  const file = path.join(TMP, 'mame.dat'); fs.writeFileSync(file, DAT);
  const r = await importDat({ filePath: file, platform: 'mame', name: 'MAME test' });
  assert.equal(r.sets, 3, 'three machines');
  assert.equal(r.entries, 2, 'the clone shares its parent\'s chip, so that chip is stored once');
  assert.deepEqual(db.prepare('SELECT set_name, cloneof FROM dat_sets ORDER BY set_name').all().map((s) => `${s.set_name}:${s.cloneof || ''}`), ['galaga:', 'pacman:', 'pacmanf:pacman']);
});

test('an arcade zip is matched by its file name, and a title it was given does not stop that', () => {
  const clone = rom('mame', 'pacmanf.zip', 'pacmanf', 'filename');         // a title from the file name: the DAT names it
  const named = rom('mame', 'galaga.zip', 'Galaga', 'mame-list');          // a title from a name list: it stays
  const odd = rom('mame', 'notinthedat.zip', 'Something', 'filename');
  const other = rom('snes', 'pacman.zip', 'pacman', 'filename');           // a console game with the same file name is not an arcade set
  rematchAll();
  assert.equal(row(clone).dat_status, 'verified'); assert.equal(row(clone).title, 'Pac-Man (hack)'); assert.equal(row(clone).dat_title, 'Pac-Man (hack)');
  assert.equal(row(named).dat_status, 'verified'); assert.equal(row(named).title, 'Galaga', 'a title from a name list is kept');
  assert.equal(row(named).dat_title, 'Galaga (Namco rev B)');
  assert.equal(row(odd).dat_status, 'not-in-dat');
  assert.equal(row(other).dat_status, 'not-in-dat', 'only the arcade platforms are matched by name');
});

test('the match uses the original file name, upper or lower case, with or without the .zip', () => {
  const upper = rom('mame', 'PacMan.ZIP', 'PacMan', 'filename');
  rematchAll({ platform: 'mame' });
  assert.equal(row(upper).dat_status, 'verified');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dat_sets").get().n, 3);
});

test('a -listxml file is also a DAT: its machines are kept as sets, the arcade games match on them at once, and a newer file replaces it', async () => {
  const xml = `<?xml version="1.0"?><mame build="0.233">
<machine name="dkong" sourcefile="dkong.cpp"><description>Donkey Kong (US set 1)</description><year>1981</year><manufacturer>Namco</manufacturer></machine>
<machine name="dkongjr" cloneof="dkong"><description>Donkey Kong Junior (US set F-2)</description><year>1982</year><manufacturer>Nintendo</manufacturer></machine>
<machine name="speaker" isdevice="yes" runnable="no"><description>Speaker</description></machine>
</mame>`;
  const file = path.join(TMP, 'listxml.dat'); fs.writeFileSync(file, xml);
  const out = await importMameNames(file);
  assert.equal(out.sets, 2, 'the device is not a game you keep');
  const a = rom('mame', 'dkong.zip', 'something', 'filename'), b = rom('neogeo', 'dkongjr.zip', 'else', 'filename');
  rematchAll({ platform: 'mame' }); rematchAll({ platform: 'neogeo' });
  assert.equal(row(a).dat_status, 'verified'); assert.equal(row(b).dat_status, 'verified');
  const card = listDatfiles().find((d) => d.filename === 'mame -listxml');
  assert.equal(card.sets, 2); assert.equal(card.roms_matched, 2, 'matches by set name are counted on the DAT card');
  assert.equal(card.missing_count, 0);
  await importMameNames(file);   // a newer list replaces the old one
  assert.equal(listDatfiles().filter((d) => d.filename === 'mame -listxml').length, 1);
  rematchAll({ platform: 'mame' });
  assert.equal(listDatfiles().find((d) => d.filename === 'mame -listxml').roms_matched >= 1, true);
  deleteDatfile(listDatfiles().find((d) => d.filename === 'mame -listxml').id);
  assert.equal(row(a).dat_status, null, 'removing the DAT clears what it verified');
});
