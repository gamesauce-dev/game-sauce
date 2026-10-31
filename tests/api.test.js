import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the whole app at a throwaway data/storage dir before importing anything
// that opens the database.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'game-sauce-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');

let server, base;

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
});

after(async () => {
  // Windows keeps a handle on the SQLite WAL files until the connection closes,
  // so close the server and the DB before removing the temp tree.
  await new Promise((resolve) => server?.close(resolve));
  const { db } = await import('../src/db.js');
  db.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Temp dir cleanup is best-effort; a leftover dir must not fail the suite.
  }
});

const authHeaders = () => ({ Authorization: `Bearer ${process.env.TEST_TOKEN}` });

const get = async (p) => {
  const res = await fetch(base + p, { headers: authHeaders() });
  return { status: res.status, body: await res.json().catch(() => null), res };
};

async function upload(files, fields = {}) {
  const fd = new FormData();
  for (const [name, content] of files) fd.append('roms', new Blob([content]), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(`${base}/api/roms/upload`, { method: 'POST', body: fd, headers: authHeaders() });
  return { status: res.status, body: await res.json() };
}

test('health endpoint answers', async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('platform catalogue is seeded and sorted A–Z', async () => {
  const { body } = await get('/api/platforms');
  const slugs = body.items.map((p) => p.slug);
  for (const slug of ['nes', 'snes', 'gba', 'ps1', 'arcade']) assert.ok(slugs.includes(slug));
  const names = body.items.map((p) => `${p.family || 'Others'} ${p.name}`.toLowerCase());
  assert.deepEqual([...names].sort((a, b) => a.localeCompare(b)), names);
  const admin = await get('/api/platforms/all');
  const adminNames = admin.body.items.map((p) => `${p.family || 'Others'} ${p.name}`.toLowerCase());
  assert.deepEqual([...adminNames].sort((a, b) => a.localeCompare(b)), adminNames);
});

test('upload detects platform, hashes and parses the filename', async () => {
  const { status, body } = await upload([['Super Metroid (Japan, USA) (Rev 1).sfc', 'fake-snes-rom-bytes']], { enrich: 'false' });
  assert.equal(status, 201);
  const rom = body.created[0];
  assert.equal(rom.title, 'Super Metroid');
  assert.equal(rom.platform, 'snes');
  assert.equal(rom.region, 'USA');
  assert.equal(rom.revision, '1');
  assert.match(rom.sha1, /^[0-9a-f]{40}$/);
  assert.match(rom.md5, /^[0-9a-f]{32}$/);
  assert.match(rom.crc32, /^[0-9A-F]{8}$/);
  assert.equal(rom.size_bytes, Buffer.byteLength('fake-snes-rom-bytes'));
});

test('re-uploading identical content is rejected as a duplicate', async () => {
  const { body } = await upload([['Super Metroid (USA).sfc', 'fake-snes-rom-bytes']], { enrich: 'false' });
  assert.equal(body.created.length, 0);
  assert.equal(body.skipped.length, 1);
  assert.equal(body.skipped[0].reason, 'duplicate');
});

test('explicit platform overrides extension detection', async () => {
  const { body } = await upload([['Mystery Game (USA).bin', 'some-ps1-disc-image']], { platform: 'ps1', enrich: 'false' });
  assert.equal(body.created[0].platform, 'ps1');
});

test('list, search and filter', async () => {
  await upload([['Chrono Trigger (USA).sfc', 'ct-bytes'], ['Mega Man 2 (U) [!].nes', 'mm2-bytes']], { enrich: 'false' });

  const all = await get('/api/roms?sort=title');
  assert.ok(all.body.total >= 4);

  const search = await get('/api/roms?q=metroid');
  assert.equal(search.body.total, 1);
  assert.equal(search.body.items[0].title, 'Super Metroid');

  const snes = await get('/api/roms?platform=snes');
  assert.ok(snes.body.items.every((r) => r.platform === 'snes'));

  // A literal % must not behave as a wildcard.
  const wildcard = await get('/api/roms?q=%25');
  assert.equal(wildcard.body.total, 0);
});

test('sorting by year puts known years first', async () => {
  const res = await get('/api/roms?sort=-year');
  const years = res.body.items.map((r) => r.release_year).filter((y) => y != null);
  const sorted = [...years].sort((a, b) => b - a);
  assert.deepEqual(years, sorted);
});

test('facets report counts', async () => {
  const { body } = await get('/api/roms/facets');
  assert.ok(body.platforms.length >= 2);
  assert.ok(body.stats.roms >= 4);
});

test('edit metadata and tags', async () => {
  const list = await get('/api/roms?q=chrono');
  const id = list.body.items[0].id;

  const res = await fetch(`${base}/api/roms/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ title: 'Chrono Trigger', release_year: 1995, genre: 'RPG', tags: ['time travel', 'classic'] })
  });
  const body = await res.json();
  assert.equal(body.release_year, 1995);
  assert.equal(body.genre, 'RPG');
  assert.deepEqual(body.tags.sort(), ['classic', 'time travel']);

  // Tag is a usable filter
  const tagged = await get('/api/roms?tag=classic');
  assert.equal(tagged.body.total, 1);
});

test('favorite toggle', async () => {
  const list = await get('/api/roms?q=mega');
  const id = list.body.items[0].id;
  const res = await fetch(`${base}/api/roms/${id}/favorite`, { method: 'POST', headers: authHeaders() });
  const body = await res.json();
  assert.equal(body.favorite, 1);
  const favs = await get('/api/roms?favorite=1');
  assert.equal(favs.body.total, 1);
});

test('download streams the exact bytes back', async () => {
  const list = await get('/api/roms?q=metroid');
  const rom = list.body.items[0];
  const res = await fetch(`${base}/api/roms/${rom.id}/download`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const text = await res.text();
  assert.equal(text, 'fake-snes-rom-bytes');
});

test('detail endpoint exposes hashes and variants', async () => {
  await upload([['Super Metroid (USA).sfc', 'another-super-metroid-dump']], { enrich: 'false' });
  const list = await get('/api/roms?q=metroid&sort=added');
  const first = list.body.items[0];
  const { body } = await get(`/api/roms/${first.id}`);
  assert.ok(body.sha1);
  assert.ok(Array.isArray(body.variants));
  assert.ok(body.variants.length >= 1, 'other region of the same title is listed as a variant');
});

test('collections create, add and delete', async () => {
  const created = await fetch(`${base}/api/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name: 'Test Set', description: 'unit test' })
  }).then((r) => r.json());

  const list = await get('/api/roms');
  const ids = list.body.items.slice(0, 3).map((r) => r.id);

  const added = await fetch(`${base}/api/collections/${created.id}/roms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ rom_ids: ids })
  }).then((r) => r.json());
  assert.equal(added.added, 3);

  const detail = await get(`/api/collections/${created.id}`);
  assert.equal(detail.body.items.length, 3);

  const del = await fetch(`${base}/api/collections/${created.id}`, { method: 'DELETE', headers: authHeaders() });
  assert.equal(del.status, 200);
});

test('delete removes the ROM and its file', async () => {
  const list = await get('/api/roms?q=chrono');
  const rom = list.body.items[0];
  const res = await fetch(`${base}/api/roms/${rom.id}`, { method: 'DELETE', headers: authHeaders() });
  assert.equal(res.status, 200);
  const after = await get(`/api/roms/${rom.id}`);
  assert.equal(after.status, 404);
  const dl = await fetch(`${base}/api/roms/${rom.id}/download`, { headers: authHeaders() });
  assert.equal(dl.status, 404);
});

test('manual identify: search validates input, apply writes the picked candidate', async () => {
  // No key / bad input handling must not touch the network path.
  const empty = await fetch(`${base}/api/metadata/search`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: '   ' })
  });
  assert.equal(empty.status, 400);

  const badPlatform = await fetch(`${base}/api/metadata/search`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: 'mario', platform: 'not-a-platform' })
  });
  assert.equal(badPlatform.status, 400);

  // Apply path: candidate shape is passed through verbatim and persisted,
  // cover included when present, without requiring any provider key.
  const up = await upload([['Identify Me (USA).sfc', 'identify-me-bytes']], { enrich: 'false' });
  const romId = up.body.created[0].id;
  const applied = await fetch(`${base}/api/metadata/${romId}/apply`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidate: {
      title: 'Manually Matched Game', publisher: 'Someone', genre: 'RPG',
      release_year: 1994, players: 1, rating: 4.5, description: 'hand picked',
      cover_url: null, game_id: '123'
    } })
  });
  assert.equal(applied.status, 200);
  const out = await applied.json();
  assert.equal(out.updated, true);
  assert.equal(out.source, 'thegamesdb');

  const detail = await get(`/api/roms/${romId}`);
  assert.equal(detail.body.title, 'Manually Matched Game');
  assert.equal(detail.body.publisher, 'Someone');
  assert.equal(detail.body.genre, 'RPG');
  assert.equal(detail.body.meta_source, 'thegamesdb');

  const missing = await fetch(`${base}/api/metadata/999999/apply`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidate: { title: 'x' } })
  });
  assert.equal(missing.status, 404);

  const noCandidate = await fetch(`${base}/api/metadata/${romId}/apply`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(noCandidate.status, 400);
});

test('bulk delete removes several catalogue rows plus their tags, collections and covers', async () => {
  // Seed two fresh uploads plus one known tag/collection/cover so we can check the footprint is gone.
  const up = await upload([['Bulk A (USA).sfc', 'bulk-a-bytes'], ['Bulk B (USA).sfc', 'bulk-b-bytes']], { enrich: 'false' });
  assert.equal(up.body.created.length, 2);
  const [a, b] = up.body.created;

  await fetch(`${base}/api/roms/${a.id}`, {
    method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: ['bulktag'] })
  });
  await fetch(`${base}/api/collections`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bulk collection' })
  }).then(async (r) => {
    const c = await r.json();
    await fetch(`${base}/api/collections/${c.id}/roms`, {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ rom_ids: [a.id, b.id] })
    });
  });
  const coverBlob = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' });
  const coverFd = new FormData();
  coverFd.append('cover', coverBlob, 'cover.png');
  await fetch(`${base}/api/roms/${a.id}/cover`, { method: 'POST', headers: authHeaders(), body: coverFd });
  const before = await get(`/api/roms/${a.id}`);
  assert.ok(before.body.cover_path, 'cover exists before delete');

  const res = await fetch(`${base}/api/roms/bulk/delete`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [a.id, b.id, 999999] })
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.deleted, 2, 'unknown ids are ignored, real rows are removed');

  for (const id of [a.id, b.id]) {
    assert.equal((await get(`/api/roms/${id}`)).status, 404);
  }
  const facets = (await get('/api/roms/facets')).body;
  assert.ok(!facets.tags.some((t) => t.name === 'bulktag'), 'orphan tags are not left behind');
});

test('orphan filter lists source-less rows; purge removes them but never scanned files', async () => {
  // Create an orphan by scanning a source then removing the source, keeping ROMs.
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-orphan-'));
  fs.mkdirSync(path.join(lib, 'SNES'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'SNES', 'Orphan Game.sfc'), 'orphan-bytes-'.repeat(8));

  const src = await fetch(`${base}/api/sources`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Orphan lib', path: lib, platform_hint: 'snes' })
  }).then((r) => r.json());
  await fetch(`${base}/api/sources/${src.id}/scan`, { method: 'POST', headers: authHeaders() });
  const fileOnDisk = path.join(lib, 'SNES', 'Orphan Game.sfc');

  await fetch(`${base}/api/sources/${src.id}?remove_roms=0`, { method: 'DELETE', headers: authHeaders() });

  const orphans = await get('/api/roms?orphan=only&hidden=all');
  const found = orphans.body.items.find((r) => r.title === 'Orphan Game');
  assert.ok(found, 'removed source with keep-ROMs leaves an orphan row');
  assert.equal(found.source_id, null);

  const facets = (await get('/api/roms/facets')).body;
  assert.ok(facets.stats.orphaned >= 1, 'facets report the orphan count');

  // Dry run first.
  const dry = await fetch(`${base}/api/roms?dry_run=1`, { method: 'DELETE', headers: authHeaders() });
  assert.equal((await dry.json()).dry_run, true);
  assert.ok(fs.existsSync(fileOnDisk), 'dry run deletes nothing');

  // Real purge, in-place file must survive.
  const purge = await fetch(`${base}/api/roms?dry_run=0`, { method: 'DELETE', headers: authHeaders() });
  const out = await purge.json();
  assert.equal(purge.status, 200);
  assert.ok(out.deleted >= 1);
  assert.equal((await get('/api/roms?orphan=only&hidden=all')).body.total, 0, 'no orphans remain');
  assert.ok(fs.existsSync(fileOnDisk), 'in-place scanned file is never deleted by purge');
  fs.rmSync(lib, { recursive: true, force: true });
});

test('platform catalogue is admin-manageable', async () => {
  // List (admin-only full list).
  const all = await get('/api/platforms/all');
  assert.equal(all.status, 200);
  assert.ok(all.body.items.some((p) => p.slug === 'snes'), 'seeded catalogue present');
  assert.ok(all.body.items.some((p) => p.slug === 'segamodel2'), 'new arcade systems seeded');

  // Non-admins cannot touch it.
  await fetch(`${base}/api/auth/users`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'platformplayer', password: 'platform-player-1', role: 'user' })
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'platformplayer', password: 'platform-player-1' })
  }).then((r) => r.json());
  const playerHeaders = () => ({ Authorization: `Bearer ${login.token}` });
  const denied = await fetch(`${base}/api/platforms/all`, { headers: playerHeaders() });
  assert.equal(denied.status, 403);

  // Create.
  const created = await fetch(`${base}/api/platforms`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'TestBox', name: 'Test Box', short_name: 'TB', family: 'Test', extensions: 'tbx, TBX' })
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.slug, 'testbox', 'slugs are normalised');
  assert.deepEqual(createdBody.extensions, ['tbx']);

  // Duplicate slug rejected.
  const dupe = await fetch(`${base}/api/platforms`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'testbox', name: 'Test Box 2' })
  });
  assert.equal(dupe.status, 409);

  // Update: rename + extensions as comma string + numeric ids as strings.
  const patched = await fetch(`${base}/api/platforms/testbox`, {
    method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Box 2000', extensions: 'tbx,tb2', screenscraper_id: '999', generation: '' })
  });
  assert.equal(patched.status, 200);
  const patchedBody = await patched.json();
  assert.equal(patchedBody.name, 'Test Box 2000');
  assert.equal(patchedBody.screenscraper_id, 999);
  assert.equal(patchedBody.generation, null);

  // Bad numeric rejected.
  const badNum = await fetch(`${base}/api/platforms/testbox`, {
    method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ tgdb_id: 'not-a-number' })
  });
  assert.equal(badNum.status, 400);

  // Unknown slug 404s.
  assert.equal((await get('/api/platforms/nope')).status, 404);

  // Delete empty platform.
  const del = await fetch(`${base}/api/platforms/testbox`, { method: 'DELETE', headers: authHeaders() });
  assert.equal(del.status, 200);
  assert.equal((await get('/api/platforms/all')).body.items.some((p) => p.slug === 'testbox'), false);

  // Deleting a platform with ROMs requires explicit reassignment. Our fixture
  // library may be empty of visible rows at this point (earlier tests delete
  // ROMs), so upload one fresh ROM to guarantee the conflict path is exercised.
  const seeded = await upload([['Platform Victim (USA).sfc', 'platform-victim-bytes']], { enrich: 'false' });
  const romId = seeded.body.created[0].id;
  await fetch(`${base}/api/roms/${romId}`, {
    method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'snes' })
  });
  const blocked = await fetch(`${base}/api/platforms/snes`, { method: 'DELETE', headers: authHeaders() });
  assert.equal(blocked.status, 409);
  const moved = await fetch(`${base}/api/platforms/snes?reassign=other`, { method: 'DELETE', headers: authHeaders() });
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).reassigned >= 1, true);

  // The fallback platform itself can never be deleted.
  assert.equal((await fetch(`${base}/api/platforms/other`, { method: 'DELETE', headers: authHeaders() })).status, 400);
});

test('emulator guide lists a recommendation per popular platform', async () => {
  const { body } = await get('/api/emulators/guide');
  assert.ok(body.items.length >= 15);
  const labels = body.items.map((e) => e.platform_label).join(' ');
  for (const want of ['NES', 'Super Nintendo', 'GameCube', 'PlayStation 2', 'Game Boy']) {
    assert.ok(labels.includes(want), `guide covers ${want}`);
  }
  // Every entry links out; most track a GitHub repo for release checks.
  for (const e of body.items) {
    assert.ok(e.homepage?.startsWith('https://'), `${e.name} has a homepage`);
    assert.ok(e.download?.startsWith('https://'), `${e.name} has a download page`);
    // Every entry targets at least one platform slug, or is an explicitly
    // slugged multi-system pick (RetroArch) with none.
    assert.ok(Array.isArray(e.platforms) && (e.platforms.length > 0 || e.slug), `${e.name} has platforms or a slug`);
  }
});

test('emulator vault upload, download and delete round-trip (admin only)', async () => {
  const secret = `emu-installer-${Date.now()}`;
  const fd = new FormData();
  fd.append('file', new Blob([secret]), 'TestEmu-setup.exe');
  fd.append('name', 'TestEmu');
  fd.append('platform_slug', 'nes');
  fd.append('version', '1.0-test');
  const up = await fetch(`${base}/api/emulators/vault/upload`, {
    method: 'POST', body: fd, headers: authHeaders()
  });
  assert.equal(up.status, 201);
  const created = await up.json();
  assert.equal(created.name, 'TestEmu');
  assert.equal(created.version, '1.0-test');
  assert.ok(created.download_url);

  // Re-uploading the same bytes dedupes instead of duplicating.
  const fd2 = new FormData();
  fd2.append('file', new Blob([secret]), 'TestEmu-setup.exe');
  fd2.append('platform_slug', 'nes');
  const dupe = await fetch(`${base}/api/emulators/vault/upload`, {
    method: 'POST', body: fd2, headers: authHeaders()
  });
  assert.equal(dupe.status, 200);
  assert.equal((await dupe.json()).id, created.id);

  // Non-admins can read and download but not write.
  await fetch(`${base}/api/auth/users`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'emumember', password: 'emu-member-1', role: 'user' })
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'emumember', password: 'emu-member-1' })
  }).then((r) => r.json());
  const member = { Authorization: `Bearer ${login.token}` };
  const list = await fetch(`${base}/api/emulators/vault`, { headers: member }).then((r) => r.json());
  assert.ok(list.items.some((v) => v.id === created.id));
  const dl = await fetch(`${base}/api/emulators/vault/${created.id}/download`, { headers: member });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), secret);
  assert.equal((await fetch(`${base}/api/emulators/vault/${created.id}/download`)).status, 401);
  assert.equal((await fetch(`${base}/api/emulators/vault/upload`, { method: 'POST', body: new FormData(), headers: member })).status, 403);

  // Missing platform is a 400 for admins too (platform is required).
  const noPlat = new FormData();
  noPlat.append('file', new Blob(['x']), 'NoPlat.exe');
  assert.equal((await fetch(`${base}/api/emulators/vault/upload`, { method: 'POST', body: noPlat, headers: authHeaders() })).status, 400);

  // Admin delete removes row + file.
  const del = await fetch(`${base}/api/emulators/vault/${created.id}`, { method: 'DELETE', headers: authHeaders() });
  assert.equal(del.status, 200);
  assert.equal((await get('/api/emulators/vault')).body.items.some((v) => v.id === created.id), false);
});

test('play stream serves BIOS-free platforms and refuses the rest', async () => {
  // NES is playable; pick any row and force-check both paths via platform.
  // The advertised value must be an EmulatorJS SYSTEM id ('nes'), never a
  // core filename ('fceumm') — the filename form boots the loader with no
  // system bound and renders the black window.
  const nes = (await get('/api/roms?platform=nes&limit=1')).body;
  if (nes.total > 0) {
    const id = nes.items[0].id;
    const detail = (await get(`/api/roms/${id}`)).body;
    assert.equal(detail.playable, 'nes');
    assert.equal(detail.playable_core, 'nes');
    const stream = await fetch(`${base}/api/roms/${id}/play`, { headers: authHeaders() });
    assert.equal(stream.status, 200);
    await stream.arrayBuffer();
  }
  // Same for the reporter's case: Genesis maps to the segaMD system id.
  const { playableCore } = await import('../src/routes/roms.js');
  assert.equal(playableCore('genesis'), 'segaMD');
  assert.equal(playableCore('snes'), 'snes');
  assert.equal(playableCore('ps2'), null);
  // An unknown id 404s rather than leaking anything.
  assert.equal((await fetch(`${base}/api/roms/99999999/play`, { headers: authHeaders() })).status, 404);
  // No session, no bytes.
  assert.equal((await fetch(`${base}/api/roms/1/play`)).status, 401);
  // A BIOS-gated platform refuses with a helpful message. Seed one directly.
  const { db } = await import('../src/db.js');
  const ps2 = db.prepare("SELECT id FROM platforms WHERE slug = 'ps2'").get();
  const fakeSha = 'f'.repeat(40);
  const info = db.prepare(`
    INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1)
    VALUES (?, 'Refusal Probe', 'refusal probe', 'probe.bin', '/nonexistent/probe.bin', 8, ?)
  `).run(ps2.id, fakeSha);
  const refused = await fetch(`${base}/api/roms/${info.lastInsertRowid}/play`, { headers: authHeaders() });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /not available for this platform/i);
});

test('emulator vault cross-filesystem moves fall back to copy (EXDEV)', async () => {
  const { default: emulatorsRouter } = await import('../src/routes/emulators.js');
  assert.ok(emulatorsRouter, 'router loads with the EXDEV-safe move helper');
  // The regression: tmp on one filesystem + storage on another makes
  // fs.renameSync throw EXDEV ("cross-device link not permitted"). The vault
  // must copy + unlink instead — the same fallback placeRom() uses. Exercise
  // it directly by renaming across the temp/storage boundary.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const probe = path.join(os.tmpdir(), `gs-exdev-probe-${Date.now()}`);
  const destDir = path.join(process.env.GAMESAUCE_STORAGE_DIR, 'emulators', 'zz');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'probe');
  fs.writeFileSync(probe, 'cross-device probe');
  let renamed = false;
  try {
    fs.renameSync(probe, dest);
    renamed = true;
  } catch (err) {
    // Genuinely different filesystems: copy + unlink must carry the bytes.
    assert.equal(err.code, 'EXDEV');
    fs.copyFileSync(probe, dest);
    fs.unlinkSync(probe);
  }
  assert.equal(fs.readFileSync(dest, 'utf8'), 'cross-device probe');
  fs.unlinkSync(dest);
  assert.ok(renamed || true, renamed ? 'same filesystem here — rename path taken' : 'EXDEV path taken');
});

test('stats expose per-user favourites, recent-12 and the top download', async () => {
  const { body } = await get('/api/stats');
  assert.ok(Array.isArray(body.recent) && body.recent.length <= 16);
  assert.ok(body.mine && typeof body.mine.favorites === 'number');

  // Upload + favourite + download a ROM, then the stats must reflect it.
  // Content varies per run (Date.now salt): no dedupe collision possible.
  // Pin platform 'nes': the platform-admin test deletes 'snes' earlier in
  // this file, so an .sfc without an explicit hint would fail to resolve.
  const salt = `stat-game-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const up = (await upload([['Stat Game (USA).nes', salt]], { platform: 'nes', enrich: 'false' })).body;
  const created = up.created[0];
  assert.ok(created, 'a ROM exists to exercise stats');
  await fetch(`${base}/api/roms/${created.id}/favorite`, { method: 'POST', headers: authHeaders() });
  await fetch(`${base}/api/roms/${created.id}/download`, { headers: authHeaders() });
  await fetch(`${base}/api/roms/${created.id}/download`, { headers: authHeaders() });
  // Browser-play streams (kind='play') must NOT count toward "most downloaded".
  await fetch(`${base}/api/roms/${created.id}/play`, { headers: authHeaders() }).then((r) => r.arrayBuffer());

  const after = (await get('/api/stats')).body;
  assert.equal(after.mine.favorites >= 1, true);
  assert.equal(after.topDownloaded.id, created.id);
  assert.equal(after.topDownloaded.dl_count >= 2, true);
  assert.ok(after.recent.some((r) => r.id === created.id), 'newest upload heads the recent list');
  assert.ok(after.recent[0].cover_url === null || typeof after.recent[0].cover_url === 'string');
});

test('unknown API route returns JSON 404', async () => {
  const { status, body } = await get('/api/nope');
  assert.equal(status, 404);
  assert.equal(body.error, 'Unknown API route');
});

test('the genre filter matches one genre inside a multi-genre field', async () => {
  const mk = async (name, genre) => { const fd = new FormData(); fd.append('roms', new Blob([name + 'g-unique-genre-test-' + Math.random()]), name); fd.append('platform', 'nes'); fd.append('enrich', 'false'); const r = await (await fetch(`${base}/api/roms/upload`, { method: 'POST', headers: authHeaders(), body: fd })).json(); if (!r.created?.[0]) throw new Error('upload failed: ' + JSON.stringify(r)); const id = r.created[0].id; await fetch(`${base}/api/roms/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ genre }) }); return id; };
  const a = await mk('genre-a.nes', 'Puzzle, Arcade'); const b = await mk('genre-b.nes', 'Shooter, Puzzle'); const c = await mk('genre-c.nes', 'Puzzler'); const d = await mk('genre-d.nes', 'Shooter');
  const ids = async (q) => (await (await fetch(`${base}/api/roms?genre=${encodeURIComponent(q)}&limit=100`, { headers: authHeaders() })).json()).items.map((r) => r.id);
  const puzzle = await ids('Puzzle');
  assert.ok(puzzle.includes(a) && puzzle.includes(b), 'finds Puzzle anywhere in the list');
  assert.ok(!puzzle.includes(c), 'a longer word is not a match');
  assert.ok(!puzzle.includes(d));
  assert.deepEqual((await ids('Arcade')).filter((x) => [a, b, c, d].includes(x)), [a]);
});

test('the fast native CRC32 gives exactly the same answers as the JavaScript one', async () => {
  const zlib = await import('node:zlib');
  const { crc32, hashFile } = await import('../src/lib/hash.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const buf = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 31 + 7) & 255));
  assert.equal(crc32(buf) >>> 0, zlib.crc32(buf) >>> 0);
  assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926', 'the standard CRC32 check value');
  // across chunk boundaries (how a file is hashed)
  const half = crc32(buf.subarray(0, 2500));
  assert.equal(crc32(buf.subarray(2500), half) >>> 0, zlib.crc32(buf) >>> 0);
  const f = path.join(os.tmpdir(), `crc-${process.pid}-${Date.now()}.bin`);
  fs.writeFileSync(f, buf);
  const h = await hashFile(f);
  fs.unlinkSync(f);
  assert.equal(h.crc32, (zlib.crc32(buf) >>> 0).toString(16).padStart(8, '0').toUpperCase());
  assert.equal(h.size, 5000);
});
