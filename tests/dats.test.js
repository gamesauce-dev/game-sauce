import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-dat-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'datadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'dat-admin-password-1';

let server, base, token, library, datPath;

const auth = () => ({ Authorization: `Bearer ${token}` });
const call = async (p, { method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth(), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
};

const GAMES = {
  metroid: Buffer.from('super-metroid-cartridge-bytes'.repeat(40)),
  chrono: Buffer.from('chrono-trigger-cartridge-bytes'.repeat(30)),
  unknown: Buffer.from('a-rom-nobody-has-ever-catalogued'.repeat(20))
};

function writeDat() {
  const entry = (title, romName, buf) => `
  <game name="${title}">
    <description>${title}</description>
    <rom name="${romName}" size="${buf.length}" crc="${crc(buf)}" md5="${md5(buf)}" sha1="${sha1(buf)}"/>
  </game>`;

  const xml = `<?xml version="1.0"?>
<!DOCTYPE datafile PUBLIC "-//Logiqx//DTD ROM Management Datafile//EN" "http://www.logiqx.com/Dats/datafile.dtd">
<datafile>
  <header>
    <name>Nintendo - Super Nintendo Entertainment System</name>
    <description>Nintendo - Super Nintendo Entertainment System</description>
    <version>20240101-000000</version>
  </header>
${entry('Super Metroid (Japan, USA) (En,Ja)', 'Super Metroid (Japan, USA) (En,Ja).sfc', GAMES.metroid)}
${entry('Chrono Trigger (USA)', 'Chrono Trigger (USA).sfc', GAMES.chrono)}
  <game name="Corrupt Dump (USA)" flags="bad">
    <description>Corrupt Dump (USA)</description>
    <rom name="Corrupt Dump (USA).sfc" size="512" crc="deadbeef"/>
  </game>
</datafile>`;

  const file = path.join(TMP, 'snes.dat');
  fs.writeFileSync(file, xml);
  return file;
}

before(async () => {
  // A library whose files hash to the DAT entries, plus one the DAT cannot know.
  library = path.join(TMP, 'roms');
  fs.mkdirSync(path.join(library, 'SNES'), { recursive: true });
  fs.writeFileSync(path.join(library, 'SNES', 'sm (USA).sfc'), GAMES.metroid);
  fs.writeFileSync(path.join(library, 'SNES', 'ct.sfc'), GAMES.chrono);
  fs.writeFileSync(path.join(library, 'SNES', 'mystery.sfc'), GAMES.unknown);

  datPath = writeDat();

  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'datadmin', password: 'dat-admin-password-1' })
  });
  token = (await login.json()).token;
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  const { db } = await import('../src/db.js');
  db.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

/* ────────────────────────── parsing ────────────────────────── */

test('normaliseHash pads and lowercases inconsistently-cased DAT hashes', async () => {
  const { normaliseHash } = await import('../src/lib/dat.js');
  assert.equal(normaliseHash('ABC', 32), '00000abc');
  assert.equal(normaliseHash('2D206BF7', 32), '2d206bf7');
  assert.equal(normaliseHash('  0xA2BC3D4E  ', 160), 'a2bc3d4e'.padStart(40, '0'));
  assert.equal(normaliseHash('', 32), null);
});

test('flags mark a dump as bad or a variant', async () => {
  const { statusFromFlags } = await import('../src/lib/dat.js');
  assert.equal(statusFromFlags(''), 'verified');
  assert.equal(statusFromFlags('b1'), 'bad');
  assert.equal(statusFromFlags('bad'), 'bad');
  assert.equal(statusFromFlags('hack'), 'variant');
  assert.equal(statusFromFlags('translation'), 'variant');
});

test('the DAT header gives source, system and version', async () => {
  const { describeDat } = await import('../src/lib/dat.js');
  const meta = describeDat({ name: 'Nintendo - Super Nintendo Entertainment System', version: '20240101-000000' });
  assert.equal(meta.source, 'no-intro');
  assert.equal(meta.version, '20240101-000000');
  assert.equal(meta.system, 'Nintendo - Super Nintendo Entertainment System');
});

test('platform is inferred from the DAT name, and the longest match wins', async () => {
  const { guessPlatform } = await import('../src/dats.js');
  assert.equal(guessPlatform({ systemName: 'Nintendo - Super Nintendo Entertainment System' }), 'snes');
  assert.equal(guessPlatform({ systemName: 'Nintendo - Entertainment System' }), 'nes');
  assert.equal(guessPlatform({ systemName: 'Sega - Mega Drive - Genesis' }), 'genesis');
  assert.equal(guessPlatform({ systemName: 'Sony - PlayStation 2 (Redump)' }), 'ps2');
  assert.equal(guessPlatform({ systemName: 'Sony - PlayStation' }), 'ps1');
  // An explicit choice beats the guess.
  assert.equal(guessPlatform({ systemName: 'Sony - PlayStation' }, 'ps3'), 'ps3');
});

/* ────────────────────────── import ────────────────────────── */

test('importing a DAT reports what it found', async () => {
  const res = await call('/api/dats', {
    method: 'POST',
    body: { path: datPath }
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.entries, 3);
  assert.equal(res.body.platform, 'snes');
  assert.equal(res.body.source, 'no-intro');
  assert.equal(res.body.version, '20240101-000000');
});

test('a non-DAT file is rejected', async () => {
  const notDat = path.join(TMP, 'notes.xml');
  fs.writeFileSync(notDat, '<html><body>hello</body></html>');
  const res = await call('/api/dats', { method: 'POST', body: { path: notDat } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /does not look like a DAT/);
});

test('re-importing the same DAT does not duplicate entries', async () => {
  const res = await call('/api/dats', { method: 'POST', body: { path: datPath } });
  assert.equal(res.status, 201);
  assert.equal(res.body.entries, 0);
  assert.equal(res.body.duplicates, 3);
});

/* ────────────────────────── matching ────────────────────────── */

test('scanning matches ROMs against the DAT and takes the canonical title', async () => {
  const source = await call('/api/sources', { method: 'POST', body: { name: 'SNES', path: library, platform_hint: 'snes' } });
  assert.equal(source.status, 201);

  const scan = await call(`/api/sources/${source.body.id}/scan`, { method: 'POST' });
  assert.equal(scan.body.added, 3);

  const roms = (await call('/api/roms?limit=50')).body.items;
  const byPath = Object.fromEntries(roms.map((r) => [path.basename(r.source_path), r]));

  // Filename said "sm (USA).sfc"; the DAT knows better.
  assert.equal(byPath['sm (USA).sfc'].title, 'Super Metroid (Japan, USA) (En,Ja)');
  assert.equal(byPath['sm (USA).sfc'].dat_status, 'verified');
  assert.equal(byPath['sm (USA).sfc'].dat_title, 'Super Metroid (Japan, USA) (En,Ja)');

  // Filename said "ct.sfc".
  assert.equal(byPath['ct.sfc'].title, 'Chrono Trigger (USA)');

  // The DAT has never heard of this one.
  assert.equal(byPath['mystery.sfc'].dat_status, 'not-in-dat');
  assert.equal(byPath['mystery.sfc'].title, 'mystery');
});

test('coverage reports verified vs unknown per platform', async () => {
  const res = await call('/api/dats');
  assert.equal(res.status, 200);
  assert.equal(res.body.coverage.status.verified, 2);
  assert.equal(res.body.coverage.status['not-in-dat'], 1);

  const snes = res.body.coverage.byPlatform.find((p) => p.slug === 'snes');
  assert.equal(snes.roms, 3);
  assert.equal(snes.matched, 2);
});

test('a hand-edited title is not overwritten by a rematch', async () => {
  const roms = (await call('/api/roms?q=Chrono')).body.items;
  const rom = roms[0];

  await call(`/api/roms/${rom.id}`, {
    method: 'PATCH',
    body: { title: 'Chrono Trigger (my own label)' }
  });

  const res = await call('/api/dats/rematch', { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  assert.ok(res.body.checked >= 3);

  const after = (await call(`/api/roms/${rom.id}`)).body;
  assert.equal(after.title, 'Chrono Trigger (my own label)', 'manual title survives');
  assert.equal(after.dat_status, 'verified', 'but the verification is still recorded');
});

test('rematch with force does take the DAT title', async () => {
  const roms = (await call('/api/roms?q=Chrono')).body.items;
  const res = await call('/api/dats/rematch', { method: 'POST', body: { force: true } });
  assert.equal(res.status, 200);

  const after = (await call(`/api/roms/${roms[0].id}`)).body;
  assert.equal(after.title, 'Chrono Trigger (USA)');
});

test('a ROM can be filtered by its DAT status', async () => {
  const unknown = await call('/api/roms?dat_status=not-in-dat');
  assert.equal(unknown.body.total, 1);
  assert.equal(unknown.body.items[0].dat_status, 'not-in-dat');

  const verified = await call('/api/roms?dat_status=verified');
  assert.equal(verified.body.total, 2);
});

test('have/want reports each DAT entry against what the library holds', async () => {
  const list = await call('/api/dats');
  const datfile = list.body.items[0];
  assert.ok(datfile, 'a DAT is imported');
  assert.equal(datfile.roms_matched, 2);
  assert.equal(datfile.missing_count, 1, 'one DAT entry has no matching ROM');

  const missing = await call(`/api/dats/${datfile.id}/have-want?want=missing`);
  assert.equal(missing.status, 200);
  assert.equal(missing.body.total, 1);
  assert.equal(missing.body.items[0].title, 'Corrupt Dump (USA)');
  assert.equal(missing.body.items[0].have, false);

  const have = await call(`/api/dats/${datfile.id}/have-want?want=have`);
  assert.equal(have.body.total, 2);
  assert.ok(have.body.items.every((e) => e.have === true), 'have rows carry have=true');
  assert.ok(have.body.items.every((e) => Number.isInteger(e.have_rom_id)), 'have rows point at the matching ROM');
  const titles = have.body.items.map((e) => e.title).sort();
  assert.deepEqual(titles, ['Chrono Trigger (USA)', 'Super Metroid (Japan, USA) (En,Ja)']);

  // Default view is the missing list, searchable by title, paginated.
  const all = await call(`/api/dats/${datfile.id}/have-want?want=all`);
  assert.equal(all.body.total, 3);
  const search = await call(`/api/dats/${datfile.id}/have-want?want=all&q=chrono`);
  assert.equal(search.body.total, 1);
  assert.equal(search.body.items[0].title, 'Chrono Trigger (USA)');
  const page = await call(`/api/dats/${datfile.id}/have-want?want=all&limit=2&offset=2`);
  assert.equal(page.body.items.length, 1, 'pagination slices the report');
});

test('have/want for an unknown DAT is a 404', async () => {
  const res = await call('/api/dats/999999/have-want');
  assert.equal(res.status, 404);
});

test('deleting a DAT clears the verification it gave', async () => {
  const list = await call('/api/dats');
  // Two rows exist (the original import and the duplicate import).
  for (const dat of list.body.items) {
    const del = await call(`/api/dats/${dat.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
  }

  const roms = (await call('/api/roms?limit=50')).body.items;
  // The ROM the DAT never knew keeps its "not-in-dat" verdict (that answer came
  // from the hash, not from the DAT's contents); nothing keeps a verification.
  assert.ok(
    roms.every((r) => !['verified', 'bad', 'variant'].includes(r.dat_status)),
    `no ROM claims a verification from a removed DAT; got ${JSON.stringify(roms.map((r) => [r.title, r.dat_status]))}`
  );

  // Titles stay as the user last saw them; we do not silently revert names.
  assert.ok(roms.some((r) => r.title === 'Chrono Trigger (USA)'));
});

test('DAT endpoints are admin-only', async () => {
  await call('/api/auth/users', {
    method: 'POST',
    body: { username: 'datplayer', password: 'dat-player-password-1', role: 'user' }
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'datplayer', password: 'dat-player-password-1' })
  });
  const playerToken = (await login.json()).token;

  const res = await fetch(`${base}/api/dats`, { headers: { Authorization: `Bearer ${playerToken}` } });
  assert.equal(res.status, 403);
});
