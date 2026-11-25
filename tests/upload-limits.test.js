// An upload may carry a file and a few short words, nothing more: text fields are held in memory, so their number and size are limited on every upload.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-uplimit-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'uladmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'ul-admin-password-1';
process.env.GAMESAUCE_RATE_LIMIT = '0';
process.env.GAMESAUCE_MAX_EMULATOR = String(200 * 1024);

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
let server, base, db, admin, play, rom;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body, token) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();
  const login = async (u, p) => (await post('/api/auth/login', { username: u, password: p })).token;
  admin = await login('uladmin', 'ul-admin-password-1');
  const made = await post('/api/auth/users', { username: 'ulplay', password: 'ul-play-pass-123', role: 'user' }, admin);
  await fetch(`${base}/api/auth/users/${made.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }, body: JSON.stringify({ mode: 'play' }) });
  play = await login('ulplay', 'ul-play-pass-123');
  rom = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes) VALUES ('U', 'u', 'u.sfc', (SELECT id FROM platforms WHERE slug = 'snes'), 'x', 1)").run().lastInsertRowid);
});
after(async () => {
  server?.closeAllConnections(); await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

// Every address that takes a file: [address, the name its file goes under, who is asking].
const uploads = () => [
  ['/api/auth/avatar', 'avatar', play], ['/api/platforms/snes/logo', 'logo', admin], ['/api/platforms/families/logo', 'logo', admin],
  [`/api/roms/${rom}/cover`, 'cover', admin], ['/api/roms/upload', 'roms', admin], ['/api/roms/bulk/import-covers', 'zip', admin], ['/api/roms/bulk/import-names', 'csv', admin],
  ['/api/physical/games/1/art/cover', 'image', admin], ['/api/physical/games/1/manual', 'manual', admin], ['/api/digital/games/xbox/nothing/cover', 'cover', admin],
  ['/api/dats', 'dat', admin], ['/api/backup/restore/inspect', 'backup', admin], ['/api/emulators/vault/upload', 'file', admin]
];

const send = async (url, token, form) => {
  const res = await fetch(base + url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, text: await res.text() };
};
const formWith = (field, fields, { fileBytes = PNG, name = 'a.png' } = {}) => {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  fd.append(field, new Blob([fileBytes]), field === 'dat' ? 'a.dat' : name);
  return fd;
};

test('every upload turns away a pile of text fields', async () => {
  const pile = Array.from({ length: 40 }, (_, i) => [`f${i}`, 'x']);
  for (const [url, field, token] of uploads()) {
    const r = await send(url, token, formWith(field, pile));
    assert.ok([400, 413].includes(r.status), `${url} ${r.status} ${r.text.slice(0, 120)}`);
    assert.match(r.text, /too many/i, `${url} ${r.text.slice(0, 160)}`);
  }
});

test('every upload turns away a very long text field', async () => {
  for (const [url, field, token] of uploads()) {
    const r = await send(url, token, formWith(field, [['platform', 'x'.repeat(100_000)]]));
    assert.ok([400, 413].includes(r.status), `${url} ${r.status}`);
    assert.match(r.text, /too long/i, `${url} ${r.text.slice(0, 160)}`);
  }
});

test('one extra file is turned away where one is expected', async () => {
  const fd = formWith('avatar', []); fd.append('avatar', new Blob([PNG]), 'b.png');
  assert.ok([400, 413].includes((await send('/api/auth/avatar', play, fd)).status));
});

test('real uploads still work, with the words the pages send', async () => {
  assert.equal((await send('/api/auth/avatar', play, formWith('avatar', []))).status, 200);
  assert.equal((await send('/api/platforms/snes/logo', admin, formWith('logo', []))).status, 200);
  assert.equal((await send(`/api/roms/${rom}/cover`, admin, formWith('cover', []))).status, 200);
  const names = await send('/api/roms/bulk/import-names', admin, formWith('csv', ['platform', 'replace_covers', 'rom_col', 'name_col', 'apply', 'flag_system', 'hide_system'].map((k) => [k, k === 'platform' ? 'snes' : '']), { fileBytes: Buffer.from('rom_name,short_game_name\nu.sfc,U\n'), name: 'n.csv' }));
  assert.equal(names.status, 200, names.text);
});

test('the emulator upload keeps its file, its limit and its tidying up', async () => {
  const leftovers = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('gs-emu-')).length;
  const had = leftovers();
  const bytes = Buffer.alloc(150 * 1024, 7);
  const words = [['platform_slug', 'snes'], ['name', 'My Emulator'], ['version', '1.2'], ['os', 'windows'], ['arch', 'x64'], ['notes', 'Notes with accents: é ü']];
  const ok = await send('/api/emulators/vault/upload', admin, formWith('file', words, { fileBytes: bytes, name: 'emu-1.2.zip' }));
  assert.equal(ok.status, 201, ok.text);
  const row = db.prepare("SELECT * FROM emulators WHERE name = 'My Emulator'").get();
  assert.equal(row.filename, 'emu-1.2.zip'); assert.equal(row.size_bytes, bytes.length); assert.equal(row.notes, 'Notes with accents: é ü'); assert.equal(row.version, '1.2');
  assert.ok(fs.readFileSync(row.storage_path).equals(bytes));
  assert.equal((await send('/api/emulators/vault/upload', admin, formWith('file', words, { fileBytes: bytes, name: 'again.zip' }))).status, 200, 'the same file again is the same entry');
  const big = await send('/api/emulators/vault/upload', admin, formWith('file', words, { fileBytes: Buffer.alloc(300 * 1024, 8), name: 'big.zip' }));
  assert.equal(big.status, 413, big.text); assert.match(big.text, /too large/);
  assert.equal((await send('/api/emulators/vault/upload', admin, formWith('file', [], { fileBytes: Buffer.from('other'), name: 'x.zip' }))).status, 400, 'no platform');
  const none = new FormData(); none.append('platform_slug', 'snes');
  assert.equal((await send('/api/emulators/vault/upload', admin, none)).status, 400, 'no file');
  assert.equal(leftovers(), had, 'nothing is left in the temporary folder');
});

test('no upload is set up without the shared limits', () => {
  const files = ['src/app.js', ...fs.readdirSync('src/routes').map((f) => `src/routes/${f}`), ...fs.readdirSync('src/lib').map((f) => `src/lib/${f}`)];
  let found = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\bmulter\(\{/g)) {
      found++;
      // the options object that belongs to this call: up to its matching brace
      let depth = 0, i = m.index + m[0].length - 1;
      do { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; i++; } while (depth && i < text.length);
      assert.match(text.slice(m.index, i), /limits:\s*uploadLimits\(/, `${f}: every multer() must use uploadLimits`);
    }
    assert.ok(!/content-type'\]\s*\|\|\s*''[\s\S]{0,80}boundary/.test(text), `${f}: reads multipart by hand`);
  }
  assert.ok(found >= 10, `only ${found} uploads found: has the way they are written changed?`);
});
