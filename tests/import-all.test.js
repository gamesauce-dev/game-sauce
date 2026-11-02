import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-impall-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'iadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'i-admin-password-1';

let server, base, db, tok, memberTok;
const call = async (p, { token = tok, method = 'GET', body, form } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: 'Bearer ' + token }, body: form || (body ? JSON.stringify(body) : undefined) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' + ' '.repeat(20));

/** A tiny zip writer for the tests (stored or deflated), the same layout real tools make. */
function makeZip(entries) {
  const parts = [], central = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), raw = e.data, deflate = e.deflate; const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(deflate ? 8 : 0, 8); l.writeUInt32LE(zlib.crc32(raw) >>> 0, 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(deflate ? 8 : 0, 10); c.writeUInt32LE(zlib.crc32(raw) >>> 0, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(l, name, data); central.push(Buffer.concat([c, name])); off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const coverForm = (zip, extra = {}) => { const f = new FormData(); f.append('zip', new Blob([zip]), 'covers.zip'); for (const [k, v] of Object.entries(extra)) f.append(k, v); return f; };
const csvForm = (text, extra = {}) => { const f = new FormData(); f.append('csv', new Blob([text]), 'g.csv'); f.append('platform', 'snes'); for (const [k, v] of Object.entries(extra)) f.append(k, v); return f; };
const row = (id) => db.prepare('SELECT * FROM roms WHERE id = ?').get(id);
let a, b, c;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  tok = await login('iadmin', 'i-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'imember', password: 'i-member-pass-12', role: 'user' } });
  memberTok = await login('imember', 'i-member-pass-12');
  const f = path.join(TMP, 'g.sfc'); fs.writeFileSync(f, 'rom');
  const ins = db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1, developer, genre, description) VALUES ((SELECT id FROM platforms WHERE slug = ?), ?, ?, ?, ?, 3, ?, ?, ?, ?)");
  a = Number(ins.run('snes', 'Alpha', 'alpha', 'Alpha (USA).sfc', f, 'im000001', 'Old Dev', 'Platformer', 'Old text').lastInsertRowid);
  b = Number(ins.run('snes', 'Beta', 'beta', 'Beta (USA).sfc', f, 'im000002', null, null, null).lastInsertRowid);
  c = Number(ins.run('nes', 'Gamma', 'gamma', 'Alpha (USA).nes', f, 'im000003', null, null, null).lastInsertRowid);
});
after(async () => { await new Promise((r) => server?.close(r)); db?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('the CSV import reads every exported detail column; empty cells never wipe what a game has', async () => {
  const csv = 'rom_name,short_game_name,developer,publisher,genre,region,revision,year,players,rating,description,tags\r\n'
    + 'Alpha (USA).sfc,Alpha Deluxe,,Acme,Shooter,USA,1,1995,2,4.5,"New, text\nline two",fun; classic\r\n'
    + 'Beta (USA).sfc,Beta,Beta Dev,,,,,,,,,\r\n';
  const prev = await call('/api/roms/bulk/import-names', { method: 'POST', form: csvForm(csv) });
  assert.equal(prev.status, 200); assert.equal(prev.body.matched, 2);
  assert.ok(prev.body.detail_columns.includes('genre') && prev.body.detail_columns.includes('tags'), 'it says which detail columns it found');
  assert.equal(row(a).title, 'Alpha', 'a preview changes nothing');
  const ap = await call('/api/roms/bulk/import-names', { method: 'POST', form: csvForm(csv, { apply: '1' }) });
  assert.equal(ap.body.applied, true);
  const A = row(a);
  assert.equal(A.title, 'Alpha Deluxe'); assert.equal(A.publisher, 'Acme'); assert.equal(A.genre, 'Shooter'); assert.equal(A.region, 'USA');
  assert.equal(A.release_year, 1995); assert.equal(A.players, 2); assert.equal(A.rating, 4.5); assert.equal(A.description, 'New, text\nline two');
  assert.equal(A.developer, 'Old Dev', 'an empty developer cell leaves the old value alone');
  const tags = db.prepare('SELECT t.name FROM rom_tags rt JOIN tags t ON t.id = rt.tag_id WHERE rt.rom_id = ? ORDER BY t.name').all(a).map((x) => x.name);
  assert.deepEqual(tags, ['classic', 'fun']);
  assert.equal(row(b).developer, 'Beta Dev'); assert.equal(row(b).genre, null, 'empty cells on another row stay empty');
  assert.equal(db.prepare('SELECT count(*) n FROM rom_tags WHERE rom_id = ?').get(b).n, 0);
  // junk numbers are ignored, not stored
  const bad = 'rom_name,short_game_name,players,rating\r\nBeta (USA).sfc,Beta,99,9\r\n';
  await call('/api/roms/bulk/import-names', { method: 'POST', form: csvForm(bad, { apply: '1' }) });
  assert.equal(row(b).players, null); assert.equal(row(b).rating, null);
});

test('an old name-only CSV (no detail columns) still works exactly as before', async () => {
  const r = await call('/api/roms/bulk/import-names', { method: 'POST', form: csvForm('rom_name,short_game_name\r\nBeta (USA).sfc,Beta Two\r\n', { apply: '1' }) });
  assert.equal(r.body.matched, 1); assert.deepEqual(r.body.detail_columns, []); assert.equal(row(b).title, 'Beta Two'); assert.equal(row(b).developer, 'Beta Dev');
});

test('cover import: matched by file name and folder, previewed before applied, kept as the person\'s own covers', async () => {
  const zip = makeZip([
    { name: 'snes/Alpha (USA).png', data: PNG },
    { name: 'snes/Beta (USA).jpg', data: JPG, deflate: true },
    { name: 'nes/Alpha (USA).png', data: PNG },
    { name: 'snes/Nothing Here.png', data: PNG },
    { name: 'snes/readme.txt', data: Buffer.from('hello') },
    { name: '__MACOSX/snes/._Alpha (USA).png', data: PNG }
  ]);
  const prev = await call('/api/roms/bulk/import-covers', { method: 'POST', form: coverForm(zip) });
  assert.equal(prev.status, 200); assert.equal(prev.body.applied, false);
  assert.equal(prev.body.pictures, 4, 'four pictures (the text file and the macOS litter are ignored)');
  assert.equal(prev.body.matched, 3); assert.equal(prev.body.will_set, 3); assert.equal(prev.body.unmatched, 1);
  assert.equal(row(a).cover_path, null, 'a preview saves nothing');
  const ap = await call('/api/roms/bulk/import-covers', { method: 'POST', form: coverForm(zip, { apply: '1' }) });
  assert.equal(ap.body.set, 3);
  for (const id of [a, b, c]) { const r = row(id); assert.ok(r.cover_path && fs.existsSync(r.cover_path), 'cover saved for ' + id); assert.equal(r.cover_locked, 1, 'kept as an own cover'); }
  assert.deepEqual(fs.readFileSync(row(a).cover_path), PNG);
  assert.notEqual(row(a).cover_path, row(c).cover_path, 'the same file name on two platforms gets two separate pictures');
  // a second run: everyone has a cover now
  const again = await call('/api/roms/bulk/import-covers', { method: 'POST', form: coverForm(zip) });
  assert.equal(again.body.will_set, 0); assert.equal(again.body.already_have, 3);
  const rep = await call('/api/roms/bulk/import-covers', { method: 'POST', form: coverForm(zip, { replace: '1' }) });
  assert.equal(rep.body.will_set, 3, 'with the box ticked it would replace them');
});

test('cover import: a folder-less picture uses the chosen platform; fake or unsafe pictures are refused', async () => {
  db.prepare('UPDATE roms SET cover_path = NULL, cover_locked = 0 WHERE id = ?').run(b);
  const zip = makeZip([{ name: 'Beta (USA).png', data: PNG }, { name: 'snes/Alpha (USA).svg', data: SVG }, { name: 'snes/Fake.png', data: Buffer.from('this is not a picture at all') }]);
  const noPlat = await call('/api/roms/bulk/import-covers', { method: 'POST', form: coverForm(zip) });
  assert.equal(noPlat.body.matched, 0, 'no folder and no platform: nothing to match it to (and the SVG is not even counted as a usable picture)');
  assert.equal(noPlat.body.not_image, 1, 'the preview already says the SVG will be refused');
  const ap = await call('/api/roms/bulk/import-covers', { method: 'POST', form: coverForm(zip, { platform: 'snes', replace: '1', apply: '1' }) });
  assert.equal(ap.body.set, 1, 'only the real PNG for Beta');
  assert.equal(ap.body.not_image, 1, 'the SVG (it can carry scripts) is refused');
  assert.ok(!/<script/.test(fs.readFileSync(row(a).cover_path).toString('latin1')), 'the SVG never became a cover');
  assert.equal((await call('/api/roms/bulk/import-covers', { method: 'POST', form: coverForm(Buffer.from('not a zip at all, just text')) })).status, 400);
  assert.equal((await call('/api/roms/bulk/import-covers', { method: 'POST', form: coverForm(zip, { platform: 'nowhere' }) })).status, 400);
});

test('only an admin can import', async () => {
  assert.equal((await call('/api/roms/bulk/import-covers', { token: memberTok, method: 'POST', form: coverForm(makeZip([{ name: 'a.png', data: PNG }])) })).status, 403);
  assert.equal((await call('/api/roms/bulk/import-names', { token: memberTok, method: 'POST', form: csvForm('rom_name,short_game_name\r\nx,y\r\n') })).status, 403);
});

test('round trip: what Export covers writes, Import covers reads back', async () => {
  const z = await call('/api/roms/export/covers.zip?platform=snes');
  assert.equal(z.status, 200);
  for (const id of [a, b]) { fs.unlinkSync(row(id).cover_path); db.prepare('UPDATE roms SET cover_path = NULL, cover_locked = 0 WHERE id = ?').run(id); }
  const prev = await call('/api/roms/bulk/import-covers', { method: 'POST', form: coverForm(z.body) });
  assert.equal(prev.body.will_set, 2, 'both pictures from the export find their games');
  const ap = await call('/api/roms/bulk/import-covers', { method: 'POST', form: coverForm(z.body, { apply: '1' }) });
  assert.equal(ap.body.set, 2); assert.ok(fs.existsSync(row(a).cover_path));
});
