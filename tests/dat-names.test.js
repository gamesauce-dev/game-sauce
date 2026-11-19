import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-datnames-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'dnadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'dn-admin-password-1';

const { prepareApp } = await import('../src/app.js');
await prepareApp();   // every table, as the app has them
const { default: db } = await import('../src/db.js');
const { seedPlatforms } = await import('../src/lib/platforms.js');
const { importDat, rematchAll, listDatfiles, normTitle } = await import('../src/dats.js');
seedPlatforms(db);

after(() => { try { db.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });


const DAT = `<?xml version="1.0"?>
<datafile><header><name>Microsoft - Xbox 360</name><description>Redump test</description><version>1</version></header>
<game name="Halo 3 (USA) (En,Fr)"><rom name="Halo 3 (USA) (En,Fr).iso" size="7000000000" crc="aaaa0001" md5="a1" sha1="aaaa000000000000000000000000000000000001"/></game>
<game name="Halo 3 (Europe) (En,Fr,De)"><rom name="Halo 3 (Europe) (En,Fr,De).iso" size="7000000000" crc="aaaa0002" md5="a2" sha1="aaaa000000000000000000000000000000000002"/></game>
<game name="Legend of the Test, The (USA)"><rom name="Legend of the Test, The (USA).iso" size="5000000000" crc="bbbb0001" md5="b1" sha1="bbbb000000000000000000000000000000000001"/></game>
<game name="Gears of Nothing (USA)"><rom name="Gears of Nothing (USA).iso" size="6000000000" crc="cccc0001" md5="c1" sha1="cccc000000000000000000000000000000000001"/></game>
</datafile>`;

const platformId = (slug) => db.prepare('SELECT id FROM platforms WHERE slug = ?').get(slug).id;
let n = 0;
const rom = (slug, filename, title, region = null) => Number(db.prepare(
  "INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1, region, meta_source) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'filename')"
).run(platformId(slug), title, title.toLowerCase(), filename, 'C:/n/' + (++n), 'dn' + n, region).lastInsertRowid);
const row = (id) => db.prepare('SELECT title, dat_status, dat_title FROM roms WHERE id = ?').get(id);

test('normTitle drops tags, punctuation and a leading article moved to the end', () => {
  assert.equal(normTitle('Halo 3 (USA) (En,Fr)'), 'halo 3');
  assert.equal(normTitle('Halo 3.iso'), 'halo 3');
  assert.equal(normTitle('Legend of the Test, The (USA)'), 'the legend of the test');
  assert.equal(normTitle('Halo, Anniversary'), 'halo anniversary', 'a word that only starts with a is not an article');
});

test('a console game no checksum finds is matched by its name, and the report lists each game once', async () => {
  const file = path.join(TMP, 'x360.dat'); fs.writeFileSync(file, DAT);
  const r = await importDat({ filePath: file, name: 'Xbox 360 test' });
  assert.equal(r.platform, 'xbox360'); assert.equal(r.entries, 4);
  const halo = rom('xbox360', '4D5307E6', 'Halo 3', 'Europe');   // a Games on Demand package: its file name is a hex id
  const zelda = rom('xbox360', 'The Legend of the Test.iso', 'The Legend of the Test');
  const other = rom('ps3', 'Gears of Nothing.iso', 'Gears of Nothing');   // another platform is never matched against this DAT
  rematchAll();
  assert.equal(row(halo).dat_status, 'named'); assert.equal(row(halo).dat_title, 'Halo 3 (Europe) (En,Fr,De)', 'its own region wins');
  assert.equal(row(zelda).dat_status, 'named');
  assert.equal(row(other).dat_status, 'not-in-dat');

  const { default: router } = await import('../src/routes/dats.js');
  const express = (await import('express')).default;
  const app = express(); app.use('/api/dats', router);
  const srv = app.listen(0); const port = srv.address().port;
  const id = listDatfiles()[0].id;
  try {
    const all = await (await fetch(`http://localhost:${port}/api/dats/${id}/have-want?group=game&want=all`)).json();
    assert.equal(all.games, 3, 'Halo 3 is one game though two regions are listed'); assert.equal(all.games_have, 2);
    assert.deepEqual(all.items.map((i) => `${i.title}:${i.have ? 'have' : 'missing'}`), ['Gears of Nothing:missing', 'Halo 3:have', 'Legend of the Test, The:have']);
    const missing = await (await fetch(`http://localhost:${port}/api/dats/${id}/have-want?group=game&want=missing`)).json();
    assert.deepEqual(missing.items.map((i) => i.title), ['Gears of Nothing']);
  } finally { srv.close(); }
});
