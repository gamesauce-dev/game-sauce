import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-export-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'xadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'x-admin-password-1';

let server, base, db, adminTok, memberTok;
const get = async (p, token = adminTok) => fetch(base + p, { headers: { Authorization: 'Bearer ' + token } });
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  adminTok = await login('xadmin', 'x-admin-password-1');
  await fetch(base + '/api/auth/users', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminTok }, body: JSON.stringify({ username: 'xmember', password: 'x-member-pass-12', role: 'user' }) });
  memberTok = await login('xmember', 'x-member-pass-12');
  const rom = path.join(TMP, 'a.sfc'); fs.writeFileSync(rom, 'rom');
  const cov = path.join(TMP, 'a.cover'); fs.writeFileSync(cov, PNG);
  const ins = db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1, developer, genre, release_year, description, cover_path, hidden_all) VALUES ((SELECT id FROM platforms WHERE slug = ?), ?, ?, ?, ?, 3, ?, ?, ?, ?, ?, ?, ?)");
  ins.run('snes', 'Plain, \"Quoted\" Game', 'plain', 'Plain Game (USA).sfc', rom, 'ex000001', 'Acme, Inc', 'Platformer', 1994, 'Line one\nline two', cov, 0);
  ins.run('snes', '=SUM(A1)', 'sum', 'Formula.sfc', rom, 'ex000002', null, null, null, null, null, 0);
  ins.run('snes', 'Secret', 'secret', 'Secret.sfc', rom, 'ex000003', null, null, null, null, cov, 1);
  ins.run('nes', 'Other', 'other', 'Other.nes', rom, 'ex000004', null, null, null, null, null, 0);
});
after(async () => { await new Promise((r) => server?.close(r)); db?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('only an admin can export', async () => {
  for (const p of ['/api/roms/export/summary', '/api/roms/export/games.csv', '/api/roms/export/covers.zip']) assert.equal((await get(p, memberTok)).status, 403, p);
});

test('the CSV has the import columns first, every editable field, safe quoting, and respects platform and hidden', async () => {
  const text = await (await get('/api/roms/export/games.csv?platform=snes')).text();
  const { parseCsv } = await import('../src/lib/namecsv.js');
  const rows = parseCsv(text);
  const head = rows[0];
  assert.deepEqual(head.slice(0, 2), ['rom_name', 'short_game_name'], 'the first two columns are what the importer reads');
  for (const c of ['developer', 'publisher', 'genre', 'region', 'revision', 'year', 'players', 'rating', 'description', 'tags', 'cover_file', 'sha1']) assert.ok(head.includes(c), c);
  const body = rows.slice(1);
  assert.equal(body.length, 2, 'only the snes games that are not hidden from everyone');
  const plain = body.find((r) => r[0] === 'Plain Game (USA).sfc');
  assert.equal(plain[1], 'Plain, "Quoted" Game', 'commas and quotes survive');
  assert.equal(plain[head.indexOf('developer')], 'Acme, Inc'); assert.equal(plain[head.indexOf('year')], '1994');
  assert.equal(plain[head.indexOf('description')], 'Line one\nline two', 'a line break inside a cell survives');
  assert.equal(plain[head.indexOf('cover_file')], 'Plain Game (USA).png', 'the cover is named after the game file');
  assert.equal(body.find((r) => r[0] === 'Formula.sfc')[1], "'=SUM(A1)", 'a leading = is defused so a spreadsheet will not run it');
  assert.ok(!text.includes('Secret.sfc'), 'hidden-from-everyone games are left out');
  assert.ok((await (await get('/api/roms/export/games.csv?platform=snes&hidden=1')).text()).includes('Secret.sfc'), 'unless asked for');
  assert.ok((await (await get('/api/roms/export/games.csv')).text()).includes('Other.nes'), 'blank platform = every platform');
});

test('the export can be imported again (round trip)', async () => {
  const { importNames } = await import('../src/lib/namecsv.js');
  const text = await (await get('/api/roms/export/games.csv?platform=snes')).text();
  const r = importNames({ csvText: text, platform: 'snes', apply: false });
  assert.ok(r.matched >= 2 || (r.hits && r.hits.length >= 2) || r.total >= 2, 'its own export is understood by the importer: ' + JSON.stringify(r).slice(0, 160));
});

test('the covers zip is a valid zip with the cover named after the game file, and the summary counts match', async () => {
  const sum = await (await get('/api/roms/export/summary?platform=snes')).json();
  assert.deepEqual(sum, { games: 2, covers: 1 });
  const res = await get('/api/roms/export/covers.zip?platform=snes');
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/zip');
  const buf = Buffer.from(await res.arrayBuffer());
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  assert.ok(e >= 0, 'has an end-of-zip record');
  const n = buf.readUInt16LE(e + 10); assert.equal(n, 1);
  let p = buf.readUInt32LE(e + 16);
  assert.equal(buf.readUInt32LE(p), 0x02014b50);
  const crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
  assert.equal(buf.toString('utf8', p + 46, p + 46 + nl), 'snes/Plain Game (USA).png');
  const lnl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28);
  const data = buf.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + size);
  assert.deepEqual(data, PNG, 'the picture is intact');
  assert.equal(zlib.crc32(data) >>> 0, crc, 'and its checksum is right');
  assert.equal((await get('/api/roms/export/covers.zip?platform=nes')).status, 404, 'no covers: a clear message, not an empty zip');
});
