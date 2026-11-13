import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as U from '../launcher/unpack.mjs';

const f = (p, size = 1) => ({ path: p, size });

test('unpack: only an archive, and only where the platform asks (Xbox 360 and PS3 by default)', () => {
  assert.equal(U.wantsUnpack({}, 'xbox360', '.7z'), true);
  assert.equal(U.wantsUnpack({}, 'ps3', '.zip'), true);
  assert.equal(U.wantsUnpack({}, 'xbox360', '.iso'), false, 'a plain file is handed over as it is');
  assert.equal(U.wantsUnpack({}, 'snes', '.zip'), false, 'most emulators open a zip themselves');
  assert.equal(U.wantsUnpack({ unpack: true }, 'wiiu', '.rar'), true, 'the person can ask for any platform');
  assert.equal(U.wantsUnpack({ unpack: false }, 'ps3', '.zip'), false, 'or say no for Xbox 360 and PS3');
});

test('unpack: which file starts the game', () => {
  // Xbox 360: an .iso, else default.xex (the shallowest), else any .xex
  assert.equal(U.pickLaunchFile([f('Game/default.xex'), f('Game/Data0000', 900), f('Game/readme.txt')], 'xbox360'), 'Game/default.xex');
  assert.equal(U.pickLaunchFile([f('Halo.iso', 8e9), f('default.xex')], 'xbox360'), 'Halo.iso', 'an .iso wins');
  assert.equal(U.pickLaunchFile([f('a/b/default.xex'), f('default.xex')], 'xbox360'), 'default.xex', 'the shallowest');
  assert.equal(U.pickLaunchFile([f('Game.xex'), f('Game.png')], 'xbox360'), 'Game.xex');
  // PS3: an .iso, else the game folder's EBOOT.BIN
  assert.equal(U.pickLaunchFile([f('BLUS1/PS3_GAME/USRDIR/EBOOT.BIN'), f('BLUS1/PS3_GAME/PARAM.SFO'), f('BLUS1/PS3_DISC.SFB')], 'ps3'), 'BLUS1/PS3_GAME/USRDIR/EBOOT.BIN');
  assert.equal(U.pickLaunchFile([f('x/EBOOT.BIN'), f('PS3_GAME/USRDIR/EBOOT.BIN')], 'ps3'), 'PS3_GAME/USRDIR/EBOOT.BIN');
  assert.equal(U.pickLaunchFile([f('Game.iso', 5), f('PS3_GAME/USRDIR/EBOOT.BIN')], 'ps3'), 'Game.iso');
  // junk is never chosen; with no rule the biggest file is
  assert.equal(U.pickLaunchFile([f('cover.jpg', 9e9), f('readme.txt', 9e9)], 'xbox360'), null);
  assert.equal(U.pickLaunchFile([f('a.bin', 5), f('b.bin', 50)], 'saturn'), 'b.bin');
  assert.equal(U.pickLaunchFile([f('game.cue'), f('game.bin', 700)], 'saturn'), 'game.cue');
  assert.equal(U.pickLaunchFile([], 'ps3'), null);
  // the person's own pattern wins
  assert.equal(U.pickLaunchFile([f('Game/default.xex'), f('Game/other.xex')], 'xbox360', { launchFile: '**/other.xex' }), 'Game/other.xex');
  assert.equal(U.pickLaunchFile([f('Game/default.xex')], 'xbox360', { launchFile: ['nothing.here', 'Game/*.xex'] }), 'Game/default.xex', 'the next pattern is tried');
  assert.equal(U.pickLaunchFile([f('Game/default.xex')], 'xbox360', { launchFile: 'nothing.here' }), 'Game/default.xex', 'and the rules when none match');
});

test('unpack: patterns', () => {
  assert.ok(U.globTest('**/default.xex')('a/b/default.xex'));
  assert.ok(U.globTest('**/default.xex')('default.xex'));
  assert.ok(U.globTest('*.iso')('Game.ISO'), 'not case sensitive');
  assert.ok(!U.globTest('*.iso')('a/Game.bin'));
  assert.ok(U.globTest('PS3_GAME/USRDIR/EBOOT.BIN')('x/ps3_game/usrdir/eboot.bin'));
  assert.ok(!U.globTest('a.b')('aXb'), 'a dot is a dot');
});

test('unpack: the program is found in turn: 7-Zip, then the system, and a clear message when there is none', async () => {
  const cmds = U.unpackCommands('C:/t/g.7z', 'C:/t/game', { platform: 'win32', env: { ProgramFiles: 'C:/Program Files' }, sevenZip: 'D:/tools/7z.exe' });
  assert.equal(cmds[0].command, 'D:/tools/7z.exe', 'the configured path first');
  assert.ok(cmds.some((c) => /7-Zip[\\/]7z\.exe$/.test(c.command)), 'the usual place');
  assert.equal(cmds.at(-1).command, 'tar.exe');
  assert.deepEqual(cmds[0].args, ['x', '-y', '-oC:/t/game', 'C:/t/g.7z']);
  const lin = U.unpackCommands('/t/g.zip', '/t/game', { platform: 'linux', env: {} });
  assert.ok(lin.some((c) => c.command === 'unzip'), 'a zip on Linux can use unzip');
  assert.ok(!U.unpackCommands('/t/g.7z', '/t/game', { platform: 'linux', env: {} }).some((c) => c.command === 'unzip'), 'but a 7z cannot');

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-unpack-'));
  try {
    const seen = [];
    const gone = Object.assign(new Error('x'), { code: 'ENOENT' });
    const how = await U.unpackArchive('/t/g.zip', dest, { platform: 'win32', env: {}, runImpl: async (c) => { seen.push(c); return c === 'tar.exe' ? { code: 0 } : { error: gone }; } });
    assert.equal(how, 'tar', 'a program that is not there is skipped');
    assert.ok(seen.length > 2);
    await assert.rejects(U.unpackArchive('/t/g.zip', dest, { platform: 'win32', env: {}, runImpl: async () => ({ error: gone }) }), /Install 7-Zip/);
    await assert.rejects(U.unpackArchive('/t/g.zip', dest, { platform: 'win32', env: {}, runImpl: async () => ({ code: 2 }) }), /could not be unpacked.*code 2/);
  } finally { fs.rmSync(dest, { recursive: true, force: true }); }
});

test('unpack: listFiles walks the unpacked folder', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-list-'));
  try {
    fs.mkdirSync(path.join(d, 'A', 'B'), { recursive: true });
    fs.writeFileSync(path.join(d, 'A', 'B', 'x.bin'), 'abc'); fs.writeFileSync(path.join(d, 'y.txt'), 'z');
    assert.deepEqual(U.listFiles(d).sort((a, b) => a.path.localeCompare(b.path)), [{ path: 'A/B/x.bin', size: 3 }, { path: 'y.txt', size: 1 }]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
