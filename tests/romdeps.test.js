// Files that go with a MAME-family game: the CHD folder beside the zip, its parent set and its BIOS set.
// Covers the list the server works out (src/lib/romdeps.js), what the launcher does with it, and the safety rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-romdeps-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'rdadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'rd-admin-password-1';
const LTMP = path.join(TMP, 'launcher-tmp');
fs.mkdirSync(LTMP);
process.env.GAMESAUCE_LAUNCHER_TMP = LTMP;
process.env.GAMESAUCE_LAUNCHER_LOG = path.join(TMP, 'launcher.log');
process.env.GAMESAUCE_LAUNCHER_QUIET = '1';
process.env.GAMESAUCE_LAUNCHER_RESCUE = path.join(TMP, 'rescued');

let server, base, db, adminTok, launcher, deps;
const ROMS = path.join(TMP, 'naomi');
const ids = {};

const call = async (p, { token, method = 'GET' } = {}) => {
  const res = await fetch(base + p, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer()) };
};
const put = (rel, text) => { const f = path.join(ROMS, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };

// A stand-in emulator: lists everything in the folder of the game it was given.
const FAKE = path.join(TMP, 'fake-emulator.mjs');
const OUT = path.join(TMP, 'emulator-saw.json');
fs.writeFileSync(FAKE, `
import fs from 'node:fs';
import path from 'node:path';
const dir = path.dirname(process.argv[2]);
const files = {};
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8'); } };
walk(dir);
fs.writeFileSync(${JSON.stringify(OUT)}, JSON.stringify({ rom: process.argv[2], files }));
`);
const writeConfig = (emulators) => {
  const f = path.join(TMP, `cfg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ servers: [base], emulators }));
  return f;
};

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  launcher = await import('../launcher/gamesauce-launcher.mjs');
  deps = await import('../src/lib/romdeps.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'rdadmin', password: 'rd-admin-password-1' }) })).json()).token;

  // beachspi.zip with a CHD folder beside it; the BIOS naomi.zip; a clone (beachspic) of beachspi.
  const add = (title, file, slug, sha) => db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1) VALUES (?,?,?,(SELECT id FROM platforms WHERE slug = ?),?,?,?)")
    .run(title, title.toLowerCase(), path.basename(file), slug, file, fs.statSync(file).size, sha).lastInsertRowid;
  ids.beach = add('Beach Spikers', put('beachspi.zip', 'beach-zip'), 'naomi', 'rd1');
  put('beachspi/gds-0014.chd', 'big-disk-image');   // the disk is named by MAME's own list, not like the zip; the folder name is what ties it to the game
  put('Beachspi/notes/extra.bin', 'nested');
  ids.bios = add('Naomi BIOS', put('naomi.zip', 'bios-zip'), 'naomi', 'rd2');
  ids.clone = add('Beach Spikers (clone)', put('beachspic.zip', 'clone-zip'), 'naomi', 'rd3');
  ids.plain = add('Plain', put('plain.zip', 'plain-zip'), 'naomi', 'rd4');
  ids.snes = add('A snes zip', put('snes thing.zip', 'x'), 'snes', 'rd5');
  const nm = db.prepare('INSERT INTO mame_names (name, title, romof, cloneof) VALUES (?,?,?,?)');
  nm.run('beachspi', 'Beach Spikers', 'naomi', null);
  nm.run('beachspic', 'Beach Spikers (clone)', 'beachspi', 'beachspi');
  nm.run('plain', 'Plain', 'neogeo', null);   // a BIOS the library does not have
  nm.run('naomi', 'Sega NAOMI Bios', null, null);
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

const romOf = (id) => db.prepare('SELECT r.filename, r.storage_path, p.slug AS platform FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?').get(id);

test('the CHD folder beside the zip, and the BIOS set, are listed for a game', () => {
  const c = deps.findCompanions(romOf(ids.beach));
  const rels = c.files.map((f) => f.rel).sort();
  assert.ok(rels.includes('beachspi/gds-0014.chd'), 'the CHD in the folder named like the zip');
  assert.ok(rels.includes('naomi.zip'), 'the BIOS set named by romof');
  assert.ok(!rels.includes('beachspi.zip'), 'the game itself is the main download, not a companion');
  assert.deepEqual(c.missing, []);
});

test('a clone brings its parent set, the parent\'s CHD folder and the BIOS', () => {
  const rels = deps.findCompanions(romOf(ids.clone)).files.map((f) => f.rel);
  assert.ok(rels.includes('beachspi.zip'));
  assert.ok(rels.includes('beachspi/gds-0014.chd'));
  assert.ok(rels.includes('naomi.zip'));
});

test('a BIOS the library does not have is reported, and a game needing nothing has no companions', () => {
  assert.deepEqual(deps.findCompanions(romOf(ids.plain)).missing, ['neogeo']);
  assert.equal(deps.findCompanions(romOf(ids.plain)).files.length, 0);
  assert.equal(deps.findCompanions(romOf(ids.snes)).files.length, 0, 'only MAME-family platforms');
});

test('the launch response says how many companions there are, and the fingerprint changes with them', async () => {
  const a = (await call(`/api/roms/${ids.beach}/launch`, { token: adminTok, method: 'POST' })).body;
  assert.ok(a.companions >= 2);
  const plain = (await call(`/api/roms/${ids.plain}/launch`, { token: adminTok, method: 'POST' })).body;
  assert.equal(plain.companions, 0);
  assert.deepEqual(plain.missing_sets, ['neogeo']);
  assert.match(a.fp, /-x\d/);
  assert.doesNotMatch(plain.fp, /-x/);
});

test('the game response lists companions in a header; each companion downloads once', async () => {
  const m = (await call(`/api/roms/${ids.beach}/launch`, { token: adminTok, method: 'POST' })).body;
  const r = await call(`/api/launch/${m.token}`);
  assert.equal(r.status, 200);
  const list = launcher.parseExtras(r.headers.get('x-gamesauce-extras'));
  const chd = list.find((f) => f.p === 'beachspi/gds-0014.chd');
  assert.ok(chd);
  const got = await call(`/api/launch-extra/${chd.t}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.toString(), 'big-disk-image');
  assert.equal((await call(`/api/launch-extra/${chd.t}`)).status, 404, 'a second use is refused');
  assert.equal((await call('/api/launch-extra/not-a-real-token-at-all-0123456789')).status, 404);
});

test('the launcher puts the companions beside the game in the same layout, then deletes them all', async () => {
  const m = (await call(`/api/roms/${ids.beach}/launch`, { token: adminTok, method: 'POST' })).body;
  const link = 'gamesauce://launch?' + new URLSearchParams({ server: base, token: m.token, platform: m.platform, ext: m.ext, title: m.title, file: m.file, size: String(m.size) });
  fs.rmSync(OUT, { force: true });
  await launcher.launch(link, { configFile: writeConfig({ naomi: { command: process.execPath, args: [FAKE, '{rom}'] } }) });
  const saw = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  assert.equal(path.basename(saw.rom), 'beachspi.zip', 'the game keeps its set name');
  assert.equal(saw.files['beachspi/gds-0014.chd'], 'big-disk-image');
  assert.equal(saw.files['naomi.zip'], 'bios-zip');
  assert.deepEqual(fs.readdirSync(LTMP).filter((n) => n.startsWith('gamesauce-launch-')), []);
  assert.equal(fs.existsSync(path.join(TMP, 'rescued')) && fs.readdirSync(path.join(TMP, 'rescued')).length, false, 'companions are not mistaken for saves');
});

test('parseExtras drops anything that could land outside the game\'s folder', () => {
  const t = 'a'.repeat(24);
  const enc = (l) => Buffer.from(JSON.stringify(l)).toString('base64');
  const out = launcher.parseExtras(enc([
    { p: 'ok/file.chd', s: 5, t },
    { p: '../escape.chd', s: 5, t },
    { p: 'a/../../b', s: 5, t },
    { p: '/abs/file', s: 5, t },
    { p: 'C:/win', s: 5, t },
    { p: 'back\\slash', s: 5, t },
    { p: 'no/token', s: 5, t: 'short' }
  ]));
  assert.deepEqual(out.map((f) => f.p), ['ok/file.chd']);
  assert.deepEqual(launcher.parseExtras('not base64 json'), []);
  assert.deepEqual(launcher.parseExtras(null), []);
});
