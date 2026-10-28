import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePlatform, walkSource } from '../src/lib/scanner.js';
import { PLATFORMS } from '../src/lib/platforms.js';

/* ───────────────── platform resolution ───────────────── */

test('a source hint always wins', () => {
  const r = resolvePlatform({ filename: 'Game.pkg', relativePath: 'Game.pkg', sourceHint: 'ps5' });
  assert.deepEqual(r, { slug: 'ps5', confidence: 'hint' });
});

test('folder names disambiguate shared extensions', () => {
  const cases = [
    ['Games/PlayStation 4/Uncharted.pkg', 'ps4'],
    ['Games/PS5/Demons Souls.pkg', 'ps5'],
    ['Games/playstation-5/Ratchet.pkg', 'ps5'],
    ['Games/PS3/Uncharted.pkg', 'ps3'],
    ['Games/Switch/Mario.nsp', 'switch'],
    ['Games/Xbox 360/Halo.iso', 'xbox360'],
    ['Games/PlayStation 2/God of War.iso', 'ps2'],
    ['Games/Sony/SomeGame.iso', 'ps2'], // family folder: first candidate of that family wins
    ['Games/Nintendo/Super Mario.nsp', 'switch']
  ];
  for (const [relativePath, expected] of cases) {
    const filename = relativePath.split('/').pop();
    const r = resolvePlatform({ filename, relativePath, sourceHint: null });
    assert.equal(r.slug, expected, `${relativePath} -> ${r.slug}, expected ${expected}`);
  }
});

test('unambiguous extension resolves without any hint', () => {
  assert.equal(resolvePlatform({ filename: 'a.sfc', relativePath: 'a.sfc', sourceHint: null }).slug, 'snes');
  assert.equal(resolvePlatform({ filename: 'a.vpk', relativePath: 'a.vpk', sourceHint: null }).slug, 'psvita');
  assert.equal(resolvePlatform({ filename: 'a.xex', relativePath: 'a.xex', sourceHint: null }).slug, 'xbox360');
});

test('an unresolvable shared extension lands in "other" with candidates', () => {
  const r = resolvePlatform({ filename: 'mystery.pkg', relativePath: 'mystery.pkg', sourceHint: null });
  assert.equal(r.slug, 'other');
  assert.deepEqual(r.candidates.sort(), ['ps3', 'ps4', 'ps5']);
});

/* ───────────────── walking a folder ───────────────── */

function makeTree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-scan-'));
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('walks recursively and finds ROM-ish files only', () => {
  const root = makeTree({
    'PS4/Game One.pkg': 'x'.repeat(64),
    'PS4/nested/Game Two.pkg': 'y'.repeat(64),
    'SNES/Game Three.sfc': 'z'.repeat(64),
    'SNES/readme.txt': 'not a rom',
    'SNES/cover.jpg': 'not a rom'
  });

  const { found } = walkSource({ path: root, recursive: 1 });
  const names = found.map((f) => f.filename).sort();
  assert.deepEqual(names, ['Game One.pkg', 'Game Three.sfc', 'Game Two.pkg']);

  const one = found.find((f) => f.filename === 'Game One.pkg');
  assert.equal(one.path, path.join(root, 'PS4', 'Game One.pkg'));
  assert.equal(one.relativePath, path.join('PS4', 'Game One.pkg'));
  assert.equal(one.size, 64);

  fs.rmSync(root, { recursive: true, force: true });
});

test('respects recursive=false', () => {
  const root = makeTree({ 'top.sfc': 'a', 'sub/deep.sfc': 'b' });
  const { found } = walkSource({ path: root, recursive: 0 });
  assert.deepEqual(found.map((f) => f.filename), ['top.sfc']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('skips .cue descriptors that sit next to their .bin', () => {
  const root = makeTree({
    'PS1/Final Fantasy VII (Disc 1).bin': 'b'.repeat(32),
    'PS1/Final Fantasy VII (Disc 1).cue': 'FILE "x.bin" BINARY'
  });
  const { found } = walkSource({ path: root, recursive: 1 });
  assert.deepEqual(found.map((f) => f.filename), ['Final Fantasy VII (Disc 1).bin']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('ignores system junk and empty files', () => {
  const root = makeTree({
    'game.sfc': 'a',
    'Thumbs.db': 'junk',
    '.DS_Store': 'junk',
    '._game.sfc': 'resource fork',
    'empty.sfc': ''
  });
  const { found } = walkSource({ path: root, recursive: 1 });
  assert.deepEqual(found.map((f) => f.filename), ['game.sfc']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('honours ignore globs', () => {
  const root = makeTree({ 'keep.sfc': 'a', 'skip-me.sfc': 'b', 'temp.sfc': 'c' });
  const { found } = walkSource({ path: root, recursive: 1, ignore_globs: 'skip-me.sfc,temp.*' });
  assert.deepEqual(found.map((f) => f.filename), ['keep.sfc']);
  fs.rmSync(root, { recursive: true, force: true });
});

/* ───────────────── catalogue sanity ───────────────── */

test('every platform has a unique slug and at least one extension (or is "other")', () => {
  const slugs = new Set();
  for (const p of PLATFORMS) {
    assert.ok(!slugs.has(p.slug), `duplicate slug ${p.slug}`);
    slugs.add(p.slug);
    if (p.slug !== 'other') assert.ok((p.extensions?.length || 0) > 0, `${p.slug} has no extensions`);
  }
});

test('all requested consoles are present', () => {
  const slugs = new Set(PLATFORMS.map((p) => p.slug));
  for (const required of [
    'ps1', 'ps2', 'ps3', 'ps4', 'ps5', 'psp', 'psvita',
    'xbox', 'xbox360', 'xboxone', 'xboxseries',
    'nes', 'snes', 'n64', 'gamecube', 'wii', 'wiiu', 'switch', 'switch2',
    'gb', 'gbc', 'gba', 'nds', '3ds', 'virtualboy',
    'genesis', 'mastersystem', 'gamegear', 'saturn', 'dreamcast', 'arcade'
  ]) {
    assert.ok(slugs.has(required), `missing platform ${required}`);
  }
});
