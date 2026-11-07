import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-launch-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'lnadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'ln-admin-password-1';
// The launcher must never touch the real home folder or temp folder while tested.
const LTMP = path.join(TMP, 'launcher-tmp');
fs.mkdirSync(LTMP);
process.env.GAMESAUCE_LAUNCHER_TMP = LTMP;
process.env.GAMESAUCE_LAUNCHER_LOG = path.join(TMP, 'launcher.log');
process.env.GAMESAUCE_LAUNCHER_QUIET = '1';

let server, base, db, adminTok, memberTok, romId, launcher;
const ROM_BYTES = Buffer.from('pretend this is a super nintendo rom');

const call = async (p, { token, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer()) };
};
const login = async (u, p) => (await call('/api/auth/login', { method: 'POST', body: { username: u, password: p } })).body.token;
const mint = async (token = adminTok) => (await call(`/api/roms/${romId}/launch`, { token, method: 'POST' }));
const linkFor = (m, extra = {}) => 'gamesauce://launch?' + new URLSearchParams({ server: base, token: m.token, platform: m.platform, ext: m.ext, title: m.title, ...extra });

// A stand-in "emulator": records what it was given, then exits.
const FAKE = path.join(TMP, 'fake-emulator.mjs');
const OUT = path.join(TMP, 'emulator-saw.json');
fs.writeFileSync(FAKE, `
import fs from 'node:fs';
const rom = process.argv[2];
fs.writeFileSync(${JSON.stringify(OUT)}, JSON.stringify({ rom, exists: fs.existsSync(rom), content: fs.existsSync(rom) ? fs.readFileSync(rom, 'utf8') : null, extra: process.argv.slice(3) }));
`);
const writeConfig = (emulators, servers = [base]) => {
  const f = path.join(TMP, `cfg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ servers, emulators }));
  return f;
};
const leftovers = () => fs.readdirSync(LTMP).filter((n) => n.startsWith('gamesauce-launch-'));

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  launcher = await import('../launcher/gamesauce-launcher.mjs');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('lnadmin', 'ln-admin-password-1');
  await call('/api/auth/users', { method: 'POST', token: adminTok, body: { username: 'lnmember', password: 'ln-member-pass-12', role: 'user' } });
  memberTok = await login('lnmember', 'ln-member-pass-12');

  const file = path.join(TMP, 'Test Game.sfc');
  fs.writeFileSync(file, ROM_BYTES);
  const snes = db.prepare("SELECT id FROM platforms WHERE slug = 'snes'").get().id;
  romId = db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1) VALUES ('Test Game','test game','Test Game.sfc',?,?,?,'ln1')")
    .run(snes, file, ROM_BYTES.length).lastInsertRowid;
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

/* ───────────── server side ───────────── */

test('an admin gets a launch token describing the game; a member without download permission does not', async () => {
  const a = await mint();
  assert.equal(a.status, 200);
  assert.equal(a.body.platform, 'snes');
  assert.equal(a.body.ext, '.sfc');
  assert.equal(a.body.title, 'Test Game');
  assert.ok(a.body.token.length >= 40);
  const m = await mint(memberTok);
  assert.equal(m.status, 403);
  assert.match(m.body.error, /downloads are turned off/);
  assert.equal((await call('/api/roms/999999/launch', { token: adminTok, method: 'POST' })).status, 404);
  assert.equal((await call(`/api/roms/${romId}/launch`, { method: 'POST' })).status, 401, 'signed-out is refused');
});

test('a member allowed to download can get a token', async () => {
  const id = (await call('/api/auth/users', { token: adminTok })).body.users?.find?.((u) => u.username === 'lnmember')?.id
    ?? db.prepare("SELECT id FROM users WHERE username = 'lnmember'").get().id;
  await call(`/api/auth/users/${id}`, { token: adminTok, method: 'PATCH', body: { download: 'allow' } });
  assert.equal((await mint(memberTok)).status, 200);
  await call(`/api/auth/users/${id}`, { token: adminTok, method: 'PATCH', body: { download: 'default' } });
  assert.equal((await mint(memberTok)).status, 403);
});

test('the token fetches the ROM without a session, exactly once', async () => {
  const m = (await mint()).body;
  const first = await call(`/api/launch/${m.token}`);
  assert.equal(first.status, 200);
  assert.equal(first.body.toString(), ROM_BYTES.toString());
  const second = await call(`/api/launch/${m.token}`);
  assert.equal(second.status, 404);
  assert.match(second.body.error, /expired or was already used/);
  assert.equal((await call('/api/launch/not-a-real-token-at-all-0123456789')).status, 404);
});

test('an expired token is refused', async () => {
  const m = (await mint()).body;
  const realNow = Date.now;
  Date.now = () => realNow() + 3 * 60 * 1000;
  try { assert.equal((await call(`/api/launch/${m.token}`)).status, 404); } finally { Date.now = realNow; }
});

test('a launch is logged as its own kind and does not count as a download', async () => {
  const count = (kind) => db.prepare('SELECT COUNT(*) AS n FROM downloads WHERE kind = ?').get(kind).n;
  const dl = count('download'), ln = count('launch');
  await call(`/api/launch/${(await mint()).body.token}`);
  assert.equal(count('launch'), ln + 1);
  assert.equal(count('download'), dl);
});

/* ───────────── launcher: link, config, command ───────────── */

test('parseLaunchUrl accepts a real link and rejects odd ones', () => {
  const ok = launcher.parseLaunchUrl('gamesauce://launch?server=http://Host:3000/&token=' + 'a'.repeat(43) + '&platform=SNES&ext=.sfc&title=Sonic');
  assert.deepEqual(ok, { server: 'http://host:3000', token: 'a'.repeat(43), platform: 'snes', ext: '.sfc', title: 'Sonic' });
  const t = 'a'.repeat(43);
  for (const bad of [
    'https://launch?server=http://h&token=' + t + '&platform=snes',
    'gamesauce://other?server=http://h&token=' + t + '&platform=snes',
    'gamesauce://launch?server=ftp://h&token=' + t + '&platform=snes',
    'gamesauce://launch?server=http://h&token=short&platform=snes',
    'gamesauce://launch?server=http://h&token=' + t + '&platform=sn%20es;rm',
    'not a url'
  ]) assert.throws(() => launcher.parseLaunchUrl(bad), /link|server|token|platform/i, bad);
  // A hostile extension is dropped rather than trusted.
  assert.equal(launcher.parseLaunchUrl('gamesauce://launch?server=http://h&token=' + t + '&platform=snes&ext=.a/../b').ext, '');
});

test('safeFileName keeps the title but never a path', () => {
  assert.equal(launcher.safeFileName('Super Mario World (USA)', '.sfc'), 'Super Mario World (USA).sfc');
  assert.equal(launcher.safeFileName('../../etc/passwd', '.bin'), '_.._etc_passwd.bin');
  assert.ok(!launcher.safeFileName('a/b\\c:d*e', '.nes').match(/[\\/:*]/));
  assert.equal(launcher.safeFileName('', ''), 'game');
});

test('buildCommand fills {rom} and {romdir}, appends the ROM when missing, and never uses a shell string', () => {
  const rom = path.join(TMP, 'x', 'g.sfc');
  assert.deepEqual(launcher.buildCommand({ command: 'emu', args: ['-f', '{rom}'] }, rom), { command: 'emu', args: ['-f', rom] });
  assert.deepEqual(launcher.buildCommand({ command: 'emu', args: ['--dir', '{romdir}'] }, rom), { command: 'emu', args: ['--dir', path.dirname(rom), rom] });
  assert.deepEqual(launcher.buildCommand({ command: 'emu' }, rom), { command: 'emu', args: [rom] });
  assert.throws(() => launcher.buildCommand({}, rom), /command/);
  assert.throws(() => launcher.buildCommand({ command: 'emu', args: 'nope' }, rom), /args/);
});

/* ───────────── launcher: the whole trip ───────────── */

test('download, launch the emulator with the ROM, then delete the temporary copy', async () => {
  fs.rmSync(OUT, { force: true });
  const cfg = writeConfig({ snes: { command: process.execPath, args: [FAKE, '{rom}', '--fullscreen'] } });
  const m = (await mint()).body;
  const r = await launcher.launch(linkFor(m), { configFile: cfg });
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);

  const saw = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  assert.equal(saw.exists, true, 'the ROM was there while the emulator ran');
  assert.equal(saw.content, ROM_BYTES.toString(), 'with the real bytes');
  assert.equal(path.basename(saw.rom), 'Test Game.sfc');
  assert.deepEqual(saw.extra, ['--fullscreen']);
  assert.ok(saw.rom.startsWith(LTMP), 'inside the temporary area');
  assert.equal(fs.existsSync(saw.rom), false, 'the copy is gone afterwards');
  assert.deepEqual(leftovers(), [], 'and so is its folder');
});

test('"deleteOnExit": false keeps the copy', async () => {
  fs.rmSync(OUT, { force: true });
  const cfg = writeConfig({ snes: { command: process.execPath, args: [FAKE, '{rom}'], deleteOnExit: false } });
  await launcher.launch(linkFor((await mint()).body), { configFile: cfg });
  const kept = leftovers();
  assert.equal(kept.length, 1);
  fs.rmSync(path.join(LTMP, kept[0]), { recursive: true, force: true });
});

test('a server that is not in the config is refused before anything is downloaded', async () => {
  const cfg = writeConfig({ snes: { command: process.execPath, args: [FAKE, '{rom}'] } }, ['http://somewhere-else.example:3000']);
  const m = (await mint()).body;
  await assert.rejects(launcher.launch(linkFor(m), { configFile: cfg }), /not listed under "servers"/);
  assert.deepEqual(leftovers(), []);
  assert.equal((await call(`/api/launch/${m.token}`)).status, 200, 'the token was never spent');
});

test('no emulator set for the platform is explained, and nothing is left behind', async () => {
  const cfg = writeConfig({ gba: { command: process.execPath } });
  const m = (await mint()).body;
  await assert.rejects(launcher.launch(linkFor(m), { configFile: cfg }), /No emulator is set for "snes"/);
  assert.deepEqual(leftovers(), []);
});

test('an emulator that cannot start is reported and the copy is still deleted', async () => {
  const cfg = writeConfig({ snes: { command: path.join(TMP, 'no-such-emulator'), args: ['{rom}'] } });
  await assert.rejects(launcher.launch(linkFor((await mint()).body), { configFile: cfg }), /Could not start .*file not found/);
  assert.deepEqual(leftovers(), []);
});

test('a used-up token is explained and leaves no files', async () => {
  const cfg = writeConfig({ snes: { command: process.execPath, args: [FAKE, '{rom}'] } });
  const m = (await mint()).body;
  await call(`/api/launch/${m.token}`);
  await assert.rejects(launcher.launch(linkFor(m), { configFile: cfg }), /expired or was already used/);
  assert.deepEqual(leftovers(), []);
});

test('a missing config gets a template written and an explanation', async () => {
  const cfg = path.join(TMP, 'fresh', 'launcher.json');
  const m = (await mint()).body;
  await assert.rejects(launcher.launch(linkFor(m), { configFile: cfg }), /No config yet/);
  assert.ok(JSON.parse(fs.readFileSync(cfg, 'utf8')).emulators, 'template written');
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')).servers, [], 'the server is NOT auto-trusted');
});

test('sweepStale removes only old gamesauce-launch folders', () => {
  const old = path.join(LTMP, 'gamesauce-launch-old'), fresh = path.join(LTMP, 'gamesauce-launch-fresh'), other = path.join(LTMP, 'someone-elses');
  for (const d of [old, fresh, other]) fs.mkdirSync(d);
  const t = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(old, t, t); fs.utimesSync(other, t, t);
  assert.equal(launcher.sweepStale(LTMP), 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(other), true);
  fs.rmSync(fresh, { recursive: true }); fs.rmSync(other, { recursive: true });
});
