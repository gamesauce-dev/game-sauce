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
