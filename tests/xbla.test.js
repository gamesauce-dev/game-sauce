import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkSource, xblaGameName, isStfsPackage, resolvePlatform } from '../src/lib/scanner.js';
import * as U from '../launcher/unpack.mjs';

const HEX = '9F2DAA064D494AA82B43B65362C59E9B89A88F8F58';   // an Xbox Live Arcade package's file name: no extension

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-xbla-'));
  for (const [rel, data] of Object.entries(files)) {
    const f = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
  }
  return root;
}
const pkg = (magic = 'LIVE') => Buffer.concat([Buffer.from(magic, 'latin1'), Buffer.alloc(60, 1)]);

test('XBLA: the game is named after its folder, with or without a title id folder, however deep', () => {
  assert.equal(xblaGameName(`CASTLEVANIA SYMPHONY OF THE NIGHT/58410847/000D0000/${HEX}`), 'CASTLEVANIA SYMPHONY OF THE NIGHT');
  assert.equal(xblaGameName(`Banjo Tooie/000D0000/${HEX}`), 'Banjo Tooie', 'no title id folder');
  assert.equal(xblaGameName(`XBLA/Braid/5841081B/000D0000/${HEX}`), 'Braid', 'a folder above the game is ignored');
  assert.equal(xblaGameName(`58410847/000D0000/${HEX}`, 'My Game'), 'My Game', 'the source folder is the game folder');
  assert.equal(xblaGameName('Game/00007000/abc'), null, 'Games on Demand are not XBLA');
  assert.equal(xblaGameName('Game/000B0000/abc'), null, 'nor title updates');
  assert.equal(xblaGameName(`Game\\58410847\\000d0000\\${HEX}`), 'Game', 'Windows paths too');
});

test('XBLA: a package is told by its first four bytes', () => {
  const root = tree({ a: pkg('CON '), b: pkg('LIVE'), c: pkg('PIRS'), d: Buffer.from('not a package at all'), e: Buffer.alloc(0) });
  try {
    for (const n of ['a', 'b', 'c']) assert.equal(isStfsPackage(path.join(root, n)), true, n);
    for (const n of ['d', 'e', 'missing']) assert.equal(isStfsPackage(path.join(root, n)), false, n);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('XBLA: a scan picks up the packages under 000D0000, named after the game, and nothing else in those folders', () => {
  const root = tree({
    [`CASTLEVANIA SYMPHONY OF THE NIGHT/58410847/000D0000/${HEX}`]: pkg(),
    [`CASTLEVANIA SYMPHONY OF THE NIGHT/58410847/000B0000/ABCDEF0123456789ABCDEF0123456789ABCDEF01`]: pkg(),   // a title update
    [`Banjo Tooie/000D0000/${HEX.slice(0, 40).replace('9F', 'AB')}`]: pkg('CON '),
    [`Some GoD/534307E6/00007000/AABBCCDDEEFF00112233445566778899AABBCCDD`]: pkg(),                              // Games on Demand
    [`Not Stfs/58410999/000D0000/0123456789ABCDEF0123456789ABCDEF01234567`]: Buffer.from('plain data, no package header'),
    'Halo.iso': 'iso bytes'
  });
  try {
    const { found } = walkSource({ path: root, recursive: 1 });
    assert.deepEqual(found.map((f) => f.filename).sort(), ['Banjo Tooie.xbla', 'CASTLEVANIA SYMPHONY OF THE NIGHT.xbla', 'Halo.iso']);
    const c = found.find((f) => f.filename.startsWith('CASTLEVANIA'));
    assert.equal(path.basename(c.path), HEX, 'the real file is the one on disk');
    assert.equal(c.ext, 'xbla');
    assert.equal(resolvePlatform({ filename: c.filename, relativePath: c.relativePath, sourceHint: null }).slug, 'xbla');
    assert.equal(resolvePlatform({ filename: c.filename, relativePath: c.relativePath, sourceHint: 'xbox360' }).slug, 'xbla', 'inside an Xbox 360 source it is still its own platform');
    // a source for another platform does not take them, and one for Xbox 360 does
    assert.equal(walkSource({ path: root, recursive: 1, platform_hint: 'ps3' }).found.some((f) => f.ext === 'xbla'), false);
    assert.equal(walkSource({ path: root, recursive: 1, platform_hint: 'xbox360' }).found.filter((f) => f.ext === 'xbla').length, 2);
    // with the source folder being the game's own folder
    const inside = walkSource({ path: path.join(root, 'Banjo Tooie'), recursive: 1 }).found;
    assert.deepEqual(inside.map((f) => f.filename), ['Banjo Tooie.xbla']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('XBLA: the launcher hands the package over with no extension, and a zipped one is found inside the archive', () => {
  const src = fs.readFileSync(new URL('../launcher/gamesauce-launcher.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("link.ext === '.xbla' ? '' : link.ext"), 'the temporary copy has no extension: Xenia takes that for an STFS package');
  const files = [{ path: `Castlevania/58410847/000D0000/${HEX}`, size: 5e6 }, { path: 'Castlevania/58410847/000B0000/ABCDEF', size: 9e6 }, { path: 'Castlevania/readme.txt', size: 3 }];
  assert.equal(U.pickLaunchFile(files, 'xbox360'), `Castlevania/58410847/000D0000/${HEX}`, 'the Arcade package, not the bigger title update');
});
