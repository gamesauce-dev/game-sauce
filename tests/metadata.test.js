import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilename, sortTitle } from '../src/lib/metadata.js';
import { crc32 } from '../src/lib/hash.js';
import { detectPlatform, candidatePlatforms, PLATFORMS } from '../src/lib/platforms.js';

test('parses a No-Intro style filename', () => {
  const r = parseFilename('Super Metroid (Japan, USA) (En,Ja) (Rev 1).sfc');
  assert.equal(r.title, 'Super Metroid');
  // Multi-region tags collapse to the first (primary) region.
  assert.equal(r.region, 'USA');
  assert.equal(r.revision, '1');
});

test('extracts year and region from a scene filename', () => {
  const r = parseFilename('1994 - Super Metroid (USA).smc');
  assert.equal(r.title, 'Super Metroid');
  assert.equal(r.year, 1994);
  assert.equal(r.region, 'USA');
});

test('keeps parenthesised words that are part of the title', () => {
  const r = parseFilename('Zelda II - The Adventure of Link (USA).nes');
  assert.equal(r.title, 'Zelda II - The Adventure of Link');
});

test('handles dots-as-spaces dumps', () => {
  const r = parseFilename('Sonic.The.Hedgehog.2.USA.md');
  assert.equal(r.title, 'Sonic The Hedgehog 2');
  assert.equal(r.region, 'USA');
});

test('strips GoodTools noise tags', () => {
  const r = parseFilename('Mega Man 2 (U) [!].nes');
  assert.equal(r.title, 'Mega Man 2');
  assert.equal(r.region, 'USA');
});

test('dots inside a real title are punctuation, not separators', () => {
  assert.equal(parseFilename('Super Mario Bros. Wonder (Europe).nsp').title, 'Super Mario Bros. Wonder');
  assert.equal(parseFilename('Dr. Mario (USA).nes').title, 'Dr. Mario');
});

test('underscore-separated dumps are split', () => {
  const r = parseFilename('Sonic_The_Hedgehog_2_USA.md');
  assert.equal(r.title, 'Sonic The Hedgehog 2');
  assert.equal(r.region, 'USA');
});

test('multi-region dumps prefer USA over Japan', () => {
  assert.equal(parseFilename('Super Metroid (Japan, USA).sfc').region, 'USA');
  assert.equal(parseFilename('Game (Europe, Japan).md').region, 'Europe');
});

test('sort title drops leading articles', () => {
  assert.equal(sortTitle('The Legend of Zelda'), 'legend of zelda');
  assert.equal(sortTitle('A Link to the Past'), 'link to the past');
});

test('crc32 matches the known vector for "123456789"', () => {
  assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
});

test('detects platforms from unambiguous extensions', () => {
  assert.equal(detectPlatform('game.sfc'), 'snes');
  assert.equal(detectPlatform('game.gba'), 'gba');
  assert.equal(detectPlatform('game.unknown-ext'), null);
});

test('shared extensions are ambiguous, not guessed', () => {
  // .iso belongs to a dozen platforms; .pkg to PS3/4/5; .nsp to Switch and Switch 2.
  assert.equal(detectPlatform('game.iso'), null);
  assert.equal(detectPlatform('game.pkg'), null);
  assert.equal(detectPlatform('game.nsp'), null);
  assert.deepEqual(candidatePlatforms('pkg').sort(), ['ps3', 'ps4', 'ps5']);
  assert.ok(candidatePlatforms('iso').length > 5);
});

test('disc and bracket tags are stripped before provider searches', async () => {
  const { stripDiscTags } = await import('../src/lib/providers.js');
  assert.equal(stripDiscTags('Alone in the Dark: The New Nightmare [Disc 1]'), 'Alone in the Dark: The New Nightmare');
  assert.equal(stripDiscTags('Final Fantasy VII (Disc 2 of 3)'), 'Final Fantasy VII');
  assert.equal(stripDiscTags('Metal Gear Solid - Disc 1'), 'Metal Gear Solid');
  assert.equal(stripDiscTags('Resident Evil 2 [CD2] [!]'), 'Resident Evil 2');
  assert.equal(stripDiscTags('Disc World'), 'Disc World', 'a title that merely contains the word survives');
  assert.equal(stripDiscTags('Part Time Hero'), 'Part Time Hero');
});

test('arcade matching accepts the same words in another order, and tries the alternative name after a slash', async () => {
  const { pickArcadeHit, titleVariants } = await import('../src/lib/providers.js');
  const T = (title) => ({ title, cover_url: 'x' });
  assert.equal(pickArcadeHit([T('Super Baseball 2020'), T('ACA Neo Geo: 2020 Super Baseball')], '2020 Super Baseball')?.title, 'Super Baseball 2020', 'reordered words match');
  assert.equal(pickArcadeHit([T('Super Puzzle Bobble'), T('Azumanga Daioh Puzzle Bobble')], 'Puzzle Bobble'), null, 'a longer different title is still rejected');
  assert.equal(pickArcadeHit([T('Baseball Stars')], 'Stars Baseball Pro'), null, 'different words never match');
  assert.ok(titleVariants('Puzzle Bobble / Bust-A-Move').includes('Bust-A-Move'), 'the name after the slash is tried too');
  assert.ok(titleVariants('Puzzle Bobble 2 / Bust-A-Move Again').includes('Bust-A-Move Again'));
});

test('arcade matching: roman numerals, equal titles pick the matching year, exact titles beat loose ones', async () => {
  const { pickArcadeHit } = await import('../src/lib/providers.js');
  const T = (title, y, art = true) => ({ title, release_year: y, cover_url: art ? 'x' : null });
  assert.equal(pickArcadeHit([T('Crossed Swords II', 1995)], 'Crossed Swords 2')?.title, 'Crossed Swords II', 'II = 2');
  assert.equal(pickArcadeHit([T('Mega Man 10', 2010)], 'Mega Man X'), null, 'X is not 10');
  assert.equal(pickArcadeHit([T('Bust-A-Move', 1996), T('Bust-A-Move', 1994), T('Bust-A-Move', 2006)], 'Bust-A-Move', 1994)?.release_year, 1994, 'the game released in the known year wins');
  assert.equal(pickArcadeHit([T('Sengoku', 1991, false), T('Sengoku Ace', 1993)], 'Sengoku', 1991), null, 'the right title without art is "no match", not a different game');
  assert.equal(pickArcadeHit([T('Sengoku', 1991), T('Sengoku Ace', 1993)], 'Sengoku', 1991)?.title, 'Sengoku', 'exact beats a longer title');
});

test('web-page codes are turned back into characters, and unknown ones are left alone', async () => {
  const { decodeEntities } = await import('../src/lib/metadata.js');
  assert.equal(decodeEntities('Top Hunter - Roddy &amp; Cathy'), 'Top Hunter - Roddy & Cathy');
  assert.equal(decodeEntities('Fire &amp;amp; Ice'), 'Fire & Ice', 'double-escaped too');
  assert.equal(decodeEntities('It&#39;s &quot;Fun&quot;'), 'It\'s "Fun"');
  assert.equal(decodeEntities('Plain Title: 2 & 3'), 'Plain Title: 2 & 3', 'a normal ampersand is untouched');
  assert.equal(decodeEntities('R&D &madeup; thing'), 'R&D &madeup; thing', 'unknown codes stay');
  assert.equal(decodeEntities(null), null);
});
