import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-src-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');

let server, base;
let libraryC_ps4, libraryC_ps5, libraryC_switch, libraryC_snes;
let libraryD_x360, libraryD_ps2;

function makeLibrary(spec) {
  const root = fs.mkdtempSync(path.join(TMP, 'lib-'));
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const authHeaders = () => ({ Authorization: `Bearer ${process.env.TEST_TOKEN}` });

const json = (p, options) => fetch(base + p, {
  headers: { 'Content-Type': 'application/json', ...authHeaders() },
  ...options
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

before(async () => {
  process.env.GAMESAUCE_ADMIN_USER = 'tester';
  process.env.GAMESAUCE_ADMIN_PASSWORD = 'test-password-123';
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // Sign in once; every request in these suites is authenticated.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'test-password-123' })
  });
  const body = await login.json();
  if (!body.token) throw new Error(`login failed: ${JSON.stringify(body)}`);
  process.env.TEST_TOKEN = body.token;

  // One source per console: platform is REQUIRED at creation, so each console
  // gets its own fixture folder (the old mixed-folder layout is exactly what
  // the mandatory hint kills).
  libraryC_ps4 = makeLibrary({
    'PlayStation 4/Uncharted 4.pkg': 'ps4-bytes-'.repeat(8),
    'PlayStation 4/God of War.pkg': 'gow-bytes-'.repeat(8)
  });
  libraryC_ps5 = makeLibrary({
    'PlayStation 5/Demons Souls.pkg': 'ps5-bytes-'.repeat(8)
  });
  libraryC_switch = makeLibrary({
    'Switch/Mario Odyssey.nsp': 'switch-bytes-'.repeat(8)
  });
  libraryC_snes = makeLibrary({
    'SNES/Super Metroid.sfc': 'snes-bytes-'.repeat(8),
    'notes.txt': 'ignored'
  });

  libraryD_x360 = makeLibrary({
    'Halo 3.iso': 'halo-bytes-'.repeat(8)
  });
  libraryD_ps2 = makeLibrary({
    'Shadow of the Colossus.iso': 'sotc-bytes-'.repeat(8)
  });
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  const { db } = await import('../src/db.js');
  db.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('registering a source rejects a non-existent folder', async () => {
  const res = await json('/api/sources', {
    method: 'POST',
    body: JSON.stringify({ path: path.join(TMP, 'nope'), platform_hint: 'snes' })
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /does not exist/);
});

test('registering two sources keeps their real paths', async () => {
  const mk = async (name, dir, platform_hint) => {
    const r = await json('/api/sources', { method: 'POST', body: JSON.stringify({ name, path: dir, platform_hint }) });
    assert.equal(r.status, 201);
    return r.body;
  };
  const ps4 = await mk('PS4 drive', libraryC_ps4, 'ps4');
  assert.equal(ps4.path, path.resolve(libraryC_ps4));
  assert.equal(ps4.exists, true);
  await mk('PS5 drive', libraryC_ps5, 'ps5');
  await mk('Switch drive', libraryC_switch, 'switch');
  await mk('SNES drive', libraryC_snes, 'snes');
  await mk('Xbox drive', libraryD_x360, 'xbox360');
  await mk('PS2 drive', libraryD_ps2, 'ps2');

  const dup = await json('/api/sources', { method: 'POST', body: JSON.stringify({ path: libraryC_ps4, platform_hint: 'ps4' }) });
  assert.equal(dup.status, 409);

  const list = await json('/api/sources');
  assert.equal(list.body.items.length, 6);
});

test('creating a source without a platform is rejected', async () => {
  for (const body of [{ path: libraryC_ps4 }, { path: libraryC_ps4, platform_hint: 'auto' }, { path: libraryC_ps4, platform_hint: 'nope' }]) {
    const res = await json('/api/sources', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(res.status, 400);
  }
});

test('scanning files every ROM under its source platform (no folder sniffing)', async () => {
  const sources = (await json('/api/sources')).body.items;
  const byPath = Object.fromEntries(sources.map((s) => [s.path, s]));

  for (const s of Object.values(byPath)) {
    const scan = await json(`/api/sources/${s.id}/scan`, { method: 'POST' });
    assert.equal(scan.status, 200);
  }

  const roms = (await json('/api/roms?limit=50')).body.items;
  const byTitle = Object.fromEntries(roms.map((r) => [r.title, r]));

  // Every ROM carries its SOURCE's platform, even where folder names would
  // have said otherwise — the hint is the platform, full stop.
  assert.equal(byTitle['Uncharted 4'].platform, 'ps4');
  assert.equal(byTitle['Demons Souls'].platform, 'ps5');
  assert.equal(byTitle['Mario Odyssey'].platform, 'switch');
  assert.equal(byTitle['Super Metroid'].platform, 'snes');
  assert.equal(byTitle['Halo 3'].platform, 'xbox360');
  assert.equal(byTitle['Shadow of the Colossus'].platform, 'ps2');
  assert.equal(Object.keys(byTitle).length, 7, 'seven ROM files, notes.txt ignored');

  // The path on disk is unchanged and recorded verbatim.
  const uncharted = byTitle['Uncharted 4'];
  assert.equal(uncharted.source_path, path.join(libraryC_ps4, 'PlayStation 4', 'Uncharted 4.pkg'));
  // storage_path is deliberately not exposed by the API; the in-place contract is
  // that the ROM lives at its original path and downloads read from there.
  assert.equal(uncharted.storage_path, undefined, 'internal storage path is not leaked');
  assert.equal(uncharted.source_name, 'PS4 drive');
  assert.equal(uncharted.in_place, 1);
  assert.equal(fs.existsSync(uncharted.source_path), true);
});

test('a Libretro-style multi-folder source resolves its own platforms', async () => {
  // Regression guard for the OLD layout: if someone points one source at a
  // folder with per-console subfolders, filenames still parse — the mandatory
  // hint just means the UI never creates this shape anymore. (Covers the "one
  // ROM folder with SNES + Genesis inside" case.)
  const multi = makeLibrary({
    'SNES/Chrono Trigger (USA).sfc': 'ct2-bytes-'.repeat(8),
    'Genesis/Sonic the Hedgehog 2 (USA).md': 'sonic2-bytes-'.repeat(8)
  });
  const created = await json('/api/sources', { method: 'POST', body: JSON.stringify({ name: 'Multi', path: multi, platform_hint: 'snes' }) });
  const scan = await json(`/api/sources/${created.body.id}/scan`, { method: 'POST' });
  assert.equal(scan.status, 200);
  assert.equal(scan.body.added, 2, 'both files catalogued');

  const roms = (await json(`/api/roms?source=${created.body.id}&limit=50`)).body.items;
  const byFile = Object.fromEntries(roms.map((r) => [r.filename, r]));
  assert.ok(byFile['Chrono Trigger (USA).sfc'], 'SNES file present');
  assert.ok(byFile['Sonic the Hedgehog 2 (USA).md'], 'Genesis file present');
  // The hint wins: both rows file under snes even though folders differ.
  for (const r of Object.values(byFile)) assert.equal(r.platform, 'snes');
});

test('rescanning an unchanged library adds nothing and keeps ids stable', async () => {
  const sources = (await json('/api/sources')).body.items;
  const ps4 = sources.find((s) => s.path === path.resolve(libraryC_ps4));
  const before = (await json(`/api/roms?source=${ps4.id}`)).body.items.map((r) => r.id).sort();

  const scan = await json(`/api/sources/${ps4.id}/scan`, { method: 'POST' });
  assert.equal(scan.body.added, 0);
  assert.equal(scan.body.skipped, 2);

  const after = (await json(`/api/roms?source=${ps4.id}`)).body.items.map((r) => r.id).sort();
  assert.deepEqual(after, before);
});

test('a new file is picked up on rescan, and a deleted one is flagged missing, not removed', async () => {
  const sources = (await json('/api/sources')).body.items;
  const snes = sources.find((s) => s.path === path.resolve(libraryC_snes));
  const ps5 = sources.find((s) => s.path === path.resolve(libraryC_ps5));

  fs.writeFileSync(path.join(libraryC_snes, 'Chrono Trigger (USA).sfc'), 'ct-bytes-'.repeat(8));
  fs.rmSync(path.join(libraryC_ps5, 'PlayStation 5', 'Demons Souls.pkg'));

  const scanSnes = await json(`/api/sources/${snes.id}/scan`, { method: 'POST' });
  assert.equal(scanSnes.body.added, 1);
  // Library C's ps5 source holds Demons Souls; it belongs to a different source
  // than the new Chrono Trigger file, so scan it separately.
  const scanPs5 = await json(`/api/sources/${ps5.id}/scan`, { method: 'POST' });
  assert.equal(scanPs5.body.missing, 1);

  const snesRoms = (await json(`/api/roms?source=${snes.id}`)).body.items;
  const ps5Roms = (await json(`/api/roms?source=${ps5.id}`)).body.items;
  const demons = ps5Roms.find((r) => r.title === 'Demons Souls');
  assert.ok(demons, 'entry survives the file being gone');
  assert.equal(demons.missing, 1);
  assert.ok(snesRoms.some((r) => r.title === 'Chrono Trigger'));
});

test('deleting an in-place ROM removes the catalogue entry but never the file', async () => {
  const roms = (await json('/api/roms?q=chrono')).body.items;
  const rom = roms[0];
  const filePath = rom.source_path;
  assert.equal(fs.existsSync(filePath), true);

  const res = await json(`/api/roms/${rom.id}`, { method: 'DELETE' });
  assert.equal(res.body.file_deleted, false);
  assert.equal(res.body.in_place, true);
  assert.equal(fs.existsSync(filePath), true, 'the user\'s file is still on disk');

  // ...unless explicitly asked.
  const again = await json(`/api/roms?q=uncharted`);
  const rom2 = again.body.items[0];
  const res2 = await json(`/api/roms/${rom2.id}?delete_file=1`, { method: 'DELETE' });
  assert.equal(res2.body.file_deleted, true);
  assert.equal(fs.existsSync(rom2.source_path), false);
});

test('download streams an in-place file from its original location', async () => {
  const roms = (await json('/api/roms?q=super metroid')).body.items;
  const rom = roms[0];
  const res = await fetch(`${base}/api/roms/${rom.id}/download`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'snes-bytes-'.repeat(8));
});

test('removing a source keeps ROMs unless remove_roms is set', async () => {
  const sources = (await json('/api/sources')).body.items;
  const x360 = sources.find((s) => s.path === path.resolve(libraryD_x360));
  const del = await json(`/api/sources/${x360.id}`, { method: 'DELETE' });
  assert.equal(del.body.removed_roms, false);

  const orphans = (await json('/api/roms?q=halo')).body.items;
  assert.equal(orphans.length, 1, 'ROM stays in the library with no source attached');
  assert.equal(orphans[0].source_id, null);
});

test('facets report sources and families', async () => {
  const facets = (await json('/api/roms/facets')).body;
  assert.ok(facets.sources.length >= 1);
  assert.ok(facets.families.some((f) => f.name === 'Sony'));
  assert.ok(facets.families.some((f) => f.name === 'Nintendo'));
});

test('browse endpoint lists folders for the path picker', async () => {
  const res = await json(`/api/sources/browse?path=${encodeURIComponent(libraryC_ps4)}`);
  assert.equal(res.status, 200);
  const names = res.body.dirs.map((d) => d.name).sort();
  assert.deepEqual(names, ['PlayStation 4']);
  assert.equal(res.body.parent, path.dirname(path.resolve(libraryC_ps4)));
});

test('metadata provider status is reported and inert without credentials', async () => {
  const res = await json('/api/metadata');
  const ss = res.body.providers.find((p) => p.id === 'screenscraper');
  assert.equal(ss.enabled, false);
  assert.ok(ss.docs);

  // A refresh with no provider configured must say so, not silently succeed.
  const roms = (await json('/api/roms')).body.items;
  const r = await json(`/api/metadata/${roms[0].id}/refresh`, { method: 'POST' });
  assert.equal(r.body.updated, false);
  assert.match(r.body.reason, /no provider/);
});

test('a source on a user-created platform scans into that platform (custom extension too)', async () => {
  const mk = await json('/api/platforms', { method: 'POST', body: JSON.stringify({ slug: 'mysys', name: 'My System', extensions: ['zzz'] }) });
  assert.equal(mk.status, 201);
  const root = makeLibrary({ 'Cool Game.zzz': 'custom-bytes-'.repeat(8), 'Other Game.sfc': 'sfc-bytes-'.repeat(8) });
  const src = await json('/api/sources', { method: 'POST', body: JSON.stringify({ path: root, platform_hint: 'mysys' }) });
  assert.equal(src.status, 201);
  const scan = await json(`/api/sources/${src.body.id}/scan`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(scan.status, 200);
  assert.equal(scan.body.added, 2);
  const plats = await json('/api/platforms');
  const mine = plats.body.items.find((p) => p.slug === 'mysys');
  assert.equal(mine.count, 2);
});
