import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-lb-'));
process.env.GAMESAUCE_DATA_DIR = dir;
const lb = await import('../src/lib/launchbox.js');
const { launchboxVariants } = await import('../src/lib/providers.js');

after(() => {
  lb._resetLaunchBox();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { /* Windows may hold the file a moment */ } }
});

const game = (id, name, platform, extra = '') => `<Game><Name>${name}</Name><DatabaseID>${id}</DatabaseID><Platform>${platform}</Platform>${extra}</Game>`;
const img = (id, type, region, file) => `<GameImage><DatabaseID>${id}</DatabaseID><Type>${type}</Type><Region>${region}</Region><FileName>${file}</FileName></GameImage>`;
const XML = `<?xml version="1.0" standalone="yes"?><LaunchBox>
${game(1, 'Destroy All Humans!', 'Sony Playstation 2', '<ReleaseYear>2005</ReleaseYear><Overview>Crypto &amp; co invade.</Overview><Genres>Action; Shooter</Genres><Developer>Pandemic</Developer><MaxPlayers>1</MaxPlayers><CommunityRating>3.46</CommunityRating>')}
${game(2, 'Destroy All Humans! 2', 'Sony Playstation 2', '<ReleaseYear>2006</ReleaseYear>')}
${game(3, 'Micro Machines', 'Sony Playstation 2', '<ReleaseYear>2002</ReleaseYear>')}
${game(4, 'Final Fantasy VII', 'Sony Playstation')}
${game(5, 'Siren', 'Sony Playstation 2', '<ReleaseYear>2003</ReleaseYear>')}
${game(6, 'Something Obscure', 'Some Unknown Platform')}
${game(7, 'Micro Machines', 'Sony Playstation 2', '<ReleaseYear>1996</ReleaseYear>')}
<GameAlternateName><AlternateName>Forbidden Siren</AlternateName><DatabaseID>5</DatabaseID><Region>Europe</Region></GameAlternateName>
${img(1, 'Screenshot - Gameplay', 'World', 'shot1.jpg')}
${img(1, 'Box - Front', 'Europe', 'eu.jpg')}
${img(1, 'Box - Front', 'North America', 'na.jpg')}
${img(2, 'Box - Front', 'North America', 'dah2.jpg')}
${img(7, 'Box - Front', 'North America', 'mm96.jpg')}
${img(6, 'Box - Front', 'World', 'unknown.jpg')}
</LaunchBox>`;

/** A real zip (deflated) holding Metadata.xml plus a decoy, so the reader has to pick the right entry. */
function makeZip(files) {
  const parts = [], central = []; let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text); const comp = zlib.deflateRawSync(data); const nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    parts.push(lh, nm, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nm); offset += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

test('reads one entry out of a zip without unpacking the rest', async () => {
  const zip = path.join(dir, 't.zip');
  fs.writeFileSync(zip, makeZip([['Mame.xml', '<decoy/>'], ['Metadata.xml', XML]]));
  const { stream, size } = await lb.openZipEntry(zip, 'Metadata.xml');
  const chunks = []; for await (const c of stream) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), XML);
  assert.equal(size, Buffer.byteLength(XML));
  await assert.rejects(() => lb.openZipEntry(zip, 'Nope.xml'), /not inside the zip/);
});

test('imports only platforms the app knows, and says what it found', async () => {
  assert.equal(lb.launchboxReady(), false, 'nothing is ready before an import');
  const r = await lb.importLaunchBox(Readable.from([XML.slice(0, 700), XML.slice(700)]), { totalBytes: XML.length });
  assert.equal(r.games, 6, 'the unknown platform is skipped');
  assert.equal(lb.launchboxReady(), true);
  const st = lb.launchboxStatus();
  assert.equal(st.available, true); assert.equal(st.games, 6); assert.ok(st.imported_at);
});

test('an exact name finds its own game, never the sequel', () => {
  const a = lb.launchboxFind(['Destroy All Humans!'], 'ps2');
  assert.equal(a.title, 'Destroy All Humans!'); assert.equal(a.release_year, 2005);
  assert.equal(lb.launchboxFind(['Destroy All Humans! 2'], 'ps2').title, 'Destroy All Humans! 2');
  assert.equal(lb.launchboxFind(['Destroy All'], 'ps2'), null, 'a partial name is not a match');
  assert.equal(lb.launchboxFind(['Destroy All Humans'], 'ps2').title, 'Destroy All Humans!', 'punctuation does not matter');
});

test('record carries the details, the North American cover and a screenshot', () => {
  const g = lb.launchboxFind(['Destroy All Humans!'], 'ps2');
  assert.equal(g.description, 'Crypto & co invade.', 'entities decoded');
  assert.equal(g.genre, 'Action, Shooter'); assert.equal(g.developer, 'Pandemic'); assert.equal(g.players, '1'); assert.equal(g.rating, 3.5);
  assert.equal(g.cover_url, 'https://images.launchbox-app.com/na.jpg', 'North America beats Europe');
  assert.equal(g.media.screenshot, 'https://images.launchbox-app.com/shot1.jpg');
  assert.equal(g.source, 'launchbox');
});

test('alternate names, roman numerals, the right platform and the year tie-break', () => {
  assert.equal(lb.launchboxFind(['Forbidden Siren'], 'ps2').title, 'Siren', 'found through an alternate name');
  assert.equal(lb.launchboxFind(['Final Fantasy 7'], 'ps1').title, 'Final Fantasy VII', 'digits equal roman numerals');
  assert.equal(lb.launchboxFind(['Final Fantasy VII'], 'ps2'), null, 'only that platform is searched');
  assert.equal(lb.launchboxFind(['Something Obscure'], 'ps2'), null);
  assert.equal(lb.launchboxFind(['Micro Machines'], 'ps2', 1996).release_year, 1996, 'same name twice: nearest year wins');
  assert.equal(lb.launchboxFind(['Micro Machines'], 'ps2', 2002).release_year, 2002);
  assert.equal(lb.launchboxFind(['Micro Machines'], 'nonsense'), null, 'unknown platform');
});

test('manual search lists matches and tries the exact name first', () => {
  const r = lb.launchboxSearch('destroy all humans', 'ps2');
  assert.deepEqual(r.items.map((i) => i.title), ['Destroy All Humans!', 'Destroy All Humans! 2']);
  assert.deepEqual(lb.launchboxSearch('zzzz', 'ps2').items, []);
});

test('title variants only strip what is not part of the name', () => {
  assert.deepEqual(launchboxVariants('Micro Machines (Europe) (En,Fr)'), ['Micro Machines (Europe) (En,Fr)', 'Micro Machines']);
  assert.ok(!launchboxVariants('Ratchet & Clank: Size Matters').includes('Ratchet & Clank'), 'a subtitle is never cut off');
  assert.ok(launchboxVariants('Puzzle Bobble / Bust-A-Move').includes('Bust-A-Move'), 'either side of a slash');
});

test('a failed import leaves the working index untouched', async () => {
  await assert.rejects(() => lb.importLaunchBox(Readable.from(['<LaunchBox><Game><Name>x</Name></Game></LaunchBox>'])), /No games were found/);
  assert.equal(lb.launchboxReady(), true);
  assert.equal(lb.launchboxFind(['Micro Machines'], 'ps2', 2002).release_year, 2002);
});

test('consoles ask LaunchBox first, arcade platforms do not', async () => {
  const { enrich, PROVIDERS, launchbox } = await import('../src/lib/providers.js');
  assert.ok(PROVIDERS.includes(launchbox));
  const r = await enrich({ title: 'Micro Machines (Europe)', platform: { slug: 'ps2' }, hashes: null, year: 2002 });
  assert.equal(r.source, 'launchbox', 'a console game is answered by the exact-name database');
  assert.equal(r.title, 'Micro Machines');
  assert.equal(r.release_year, 2002);
  const arcade = await enrich({ title: 'Micro Machines', platform: { slug: 'mame' }, hashes: null, titleTrusted: true });
  assert.notEqual(arcade?.source, 'launchbox', 'arcade order is unchanged and needs a trusted title');
});
