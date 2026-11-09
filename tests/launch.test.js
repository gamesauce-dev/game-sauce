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
process.env.GAMESAUCE_LAUNCHER_RESCUE = path.join(TMP, 'rescued');

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

// An emulator that, like many, saves next to the ROM it was given (here: the temporary copy).
const SAVER = path.join(TMP, 'saving-emulator.mjs');
fs.writeFileSync(SAVER, `
import fs from 'node:fs';
fs.writeFileSync(process.argv[2] + '.srm', 'my battery save');
fs.mkdirSync(process.argv[2] + '-states', { recursive: true });
fs.writeFileSync(process.argv[2] + '-states/slot1.state', 'my save state');
`);

test('files an emulator wrote next to the ROM are rescued before the copy is deleted', async () => {
  const cfg = writeConfig({ snes: { command: process.execPath, args: [SAVER, '{rom}'] } });
  await launcher.launch(linkFor((await mint()).body), { configFile: cfg });
  assert.deepEqual(leftovers(), [], 'the temporary folder is gone');
  const rescued = path.join(TMP, 'rescued');
  const dirs = fs.readdirSync(rescued);
  assert.equal(dirs.length, 1);
  assert.match(dirs[0], /^Test Game-/);
  assert.equal(fs.readFileSync(path.join(rescued, dirs[0], 'Test Game.sfc.srm'), 'utf8'), 'my battery save');
  assert.equal(fs.readFileSync(path.join(rescued, dirs[0], 'Test Game.sfc-states', 'slot1.state'), 'utf8'), 'my save state');
  assert.ok(!fs.existsSync(path.join(rescued, dirs[0], 'Test Game.sfc')), 'the ROM itself is not kept');
});

test('a normal run (only the ROM) rescues nothing', async () => {
  const before = fs.readdirSync(path.join(TMP, 'rescued')).length;
  const cfg = writeConfig({ snes: { command: process.execPath, args: [FAKE, '{rom}'] } });
  await launcher.launch(linkFor((await mint()).body), { configFile: cfg });
  assert.equal(fs.readdirSync(path.join(TMP, 'rescued')).length, before);
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

/* ───────────── "Check my PC": the launcher reports which platforms it can start ───────────── */

const syncLink = (token, server = base) => 'gamesauce://sync?' + new URLSearchParams({ server, token }).toString();
const prefsOf = async (token) => (await call('/api/prefs', { token })).body;

test('Check my PC: a sync token is for people who may download, works once, and stores platform names only', async () => {
  assert.equal((await call('/api/launcher/sync-token', { token: memberTok, method: 'POST' })).status, 403, 'a member without download permission has no launcher');
  assert.equal((await call('/api/launcher/sync-token', { method: 'POST' })).status, 401);
  const { body: t } = await call('/api/launcher/sync-token', { token: adminTok, method: 'POST' });
  assert.ok(t.token.length >= 40);
  const send = (token, platforms) => call('/api/launcher/sync', { method: 'POST', body: { token, platforms } });
  const ok = await send(t.token, ['snes', 'GBA', 'ps2', '../etc/passwd', 'not a slug', 'snes']);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.platforms, ['gba', 'ps2', 'snes'], 'only valid platform names, lower case, no repeats');
  assert.equal((await send(t.token, ['nes'])).status, 404, 'the token is single use');
  assert.equal((await send('x'.repeat(40), ['nes'])).status, 404);
  const stored = JSON.parse((await prefsOf(adminTok)).launcher_platforms);
  assert.deepEqual(stored.platforms, ['gba', 'ps2', 'snes']); assert.ok(stored.at);
  assert.equal((await prefsOf(memberTok)).launcher_platforms, undefined, 'it is kept for that account only');
});

test('Check my PC: a sync token does not open a game file, and a launch token does not sync', async () => {
  const { body: t } = await call('/api/launcher/sync-token', { token: adminTok, method: 'POST' });
  assert.equal((await call(`/api/launch/${t.token}`)).status, 404, 'a sync token cannot download a ROM');
  const m = (await mint()).body;
  assert.equal((await call('/api/launcher/sync', { method: 'POST', body: { token: m.token, platforms: ['snes'] } })).status, 404, 'a launch token cannot sync');
});

test('launcher: parseSyncUrl and configuredPlatforms (a missing program file is left out, a bare program name is taken as it is)', () => {
  const tok = 'a'.repeat(30);
  assert.deepEqual(launcher.parseSyncUrl(`gamesauce://sync?server=http://h:3000&token=${tok}`), { server: 'http://h:3000', token: tok });
  assert.throws(() => launcher.parseSyncUrl(`gamesauce://launch?server=http://h:3000&token=${tok}`), /not a game-sauce sync link/);
  assert.throws(() => launcher.parseSyncUrl('gamesauce://sync?server=ftp://h&token=' + tok), /server address/);
  assert.throws(() => launcher.parseSyncUrl('gamesauce://sync?server=http://h:3000&token=short'), /token/);
  const cfg = { emulators: { snes: { command: 'C:\\Emu\\snes9x.exe' }, gba: { command: 'C:\\Emu\\gone.exe' }, nes: { command: 'retroarch' }, ps2: { command: '' }, '../x': { command: 'y' }, gb: {} } };
  assert.deepEqual(launcher.configuredPlatforms(cfg, (p) => p.endsWith('snes9x.exe')), ['nes', 'snes']);
});

test('launcher: syncPlatforms reports the platforms to the server, only for a server listed in the config', async () => {
  const cfg = writeConfig({ snes: { command: process.execPath }, gba: { command: process.execPath } });
  const { body: t } = await call('/api/launcher/sync-token', { token: adminTok, method: 'POST' });
  const r = await launcher.syncPlatforms(syncLink(t.token), { configFile: cfg });
  assert.deepEqual(r.platforms, ['gba', 'snes']);
  assert.deepEqual(JSON.parse((await prefsOf(adminTok)).launcher_platforms).platforms, ['gba', 'snes']);
  const other = writeConfig({ snes: { command: process.execPath } }, ['http://somewhere-else.example:3000']);
  const { body: t2 } = await call('/api/launcher/sync-token', { token: adminTok, method: 'POST' });
  await assert.rejects(launcher.syncPlatforms(syncLink(t2.token), { configFile: other }), /not listed under "servers"/);
  await assert.rejects(launcher.syncPlatforms(syncLink(t.token), { configFile: cfg }), /expired or was already used/, 'a spent token is explained');
});

/* ───────────── the setup page for launcher.json ───────────── */

const cfgUrl = async (extra = {}) => {
  const { startConfigServer } = await import('../launcher/configure.mjs');
  const file = path.join(TMP, `setup-${Math.random().toString(36).slice(2)}.json`);
  const s = await startConfigServer({ configFile: file, open: false, pick: async () => process.execPath, ...extra });
  const get = (p, init = {}) => fetch(`http://127.0.0.1:${s.port}${p}`, { ...init, headers: { 'x-key': s.key, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const post = (p, body) => get(p, { method: 'POST', body: JSON.stringify(body || {}) });
  return { s, file, get, post };
};

test('setup page: only reachable with its secret key, only as this machine, and it closes when asked', async () => {
  const { s, get, post } = await cfgUrl();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/`)).status, 403, 'the page needs the key in its address');
    assert.equal((await fetch(s.url)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/config`)).status, 403, 'the API needs the key');
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/config`, { headers: { 'x-key': 'wrong' } })).status, 403);
    const http = await import('node:http');
    const status = await new Promise((resolve) => { const rq = http.request({ host: '127.0.0.1', port: s.port, path: '/api/config', headers: { host: 'evil.example', 'x-key': s.key } }, (r) => resolve(r.statusCode)); rq.end(); });
    assert.equal(status, 403, 'a request for another host name (a DNS trick) is refused');
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/save`, { method: 'POST', headers: { 'x-key': s.key, 'Content-Type': 'text/plain' }, body: '{}' })).status, 400, 'JSON only');
    assert.equal((await get('/api/config')).status, 200);
    assert.equal((await post('/api/done')).status, 200);
    await s.closed;
  } finally { s.close(); }
});

test('setup page: it saves launcher.json from the choices (keeping a backup), and reads it back', async () => {
  const { s, file, get, post } = await cfgUrl({ addServer: base });
  try {
    const first = await (await get('/api/config')).json();
    assert.deepEqual(first.servers, []); assert.equal(first.add_server, base); assert.ok(first.platforms.some((p) => p.slug === 'snes'));
    const save = await post('/api/save', { servers: [base + '/', 'http://nas.local:8765'], emulators: [
      { slug: 'snes', command: process.execPath, args: ['--fullscreen', '{rom}'] },
      { slug: 'gba', command: process.execPath, deleteOnExit: false },
      { slug: '', command: '' }] });
    assert.equal(save.status, 200);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(onDisk.servers, [base, 'http://nas.local:8765']);
    assert.deepEqual(onDisk.emulators.snes, { command: process.execPath, args: ['--fullscreen', '{rom}'] });
    assert.deepEqual(onDisk.emulators.gba, { command: process.execPath, deleteOnExit: false });
    assert.deepEqual(Object.keys(onDisk.emulators), ['snes', 'gba'], 'the empty line is dropped');
    const back = await (await get('/api/config')).json();
    assert.equal(back.emulators.find((e) => e.slug === 'snes').found, true, 'it says the program is there');
    await post('/api/save', { servers: [base], emulators: [] });
    assert.ok(fs.existsSync(file + '.bak'), 'the old file is kept as a backup');
    await post('/api/save', { servers: [base], emulators: [{ slug: 'snes', command: process.execPath, args: [FAKE, '{rom}'] }] });
    const m = (await mint()).body;
    assert.equal((await launcher.launch(linkFor(m), { configFile: file })).ok, true, 'the launcher can really use what the page wrote');
  } finally { s.close(); }
});

test('setup page: mistakes are explained, and nothing is written', async () => {
  const { s, file, post } = await cfgUrl();
  try {
    const bad = async (body, re) => { const r = await post('/api/save', body); assert.equal(r.status, 400); assert.match((await r.json()).error, re); };
    await bad({ servers: ['not a server'], emulators: [] }, /not a server address/);
    await bad({ servers: ['ftp://x'], emulators: [] }, /not a server address/);
    await bad({ servers: [], emulators: [{ slug: 'snes', command: '' }] }, /Choose the emulator program for snes/);
    await bad({ servers: [], emulators: [{ slug: '', command: 'x.exe' }] }, /Choose a platform/);
    await bad({ servers: [], emulators: [{ slug: '../x', command: 'x.exe' }] }, /Choose a platform/);
    await bad({ servers: [], emulators: [{ slug: 'snes', command: 'a' }, { slug: 'snes', command: 'b' }] }, /appears twice/);
    assert.equal(fs.existsSync(file), false);
  } finally { s.close(); }
});

test('setup page: Browse gives back the chosen program, a refused window is explained, and Save and tell game-sauce reports the platforms', async () => {
  const a = await cfgUrl();
  try { assert.equal((await (await a.post('/api/pick')).json()).path, process.execPath); } finally { a.s.close(); }
  const b = await cfgUrl({ pick: async () => { throw new Error('No file window is available here: type the path instead.'); } });
  try { const r = await b.post('/api/pick'); assert.equal(r.status, 400); assert.match((await r.json()).error, /type the path/); } finally { b.s.close(); }
  const { body: t } = await call('/api/launcher/sync-token', { token: adminTok, method: 'POST' });
  const c = await cfgUrl({ syncToken: { server: base, token: t.token } });
  try {
    assert.equal((await (await c.get('/api/config')).json()).can_sync, true);
    await c.post('/api/save', { servers: [base], emulators: [{ slug: 'snes', command: process.execPath }, { slug: 'ps2', command: path.join(TMP, 'no-such-emulator.exe') }] });
    const r = await (await c.post('/api/sync')).json();
    assert.deepEqual(r.platforms, ['snes'], 'a program that is not there is left out');
    assert.deepEqual(JSON.parse((await prefsOf(adminTok)).launcher_platforms).platforms, ['snes']);
    assert.equal((await c.post('/api/sync')).status, 400, 'the token was spent');
  } finally { c.s.close(); }
  const d = await cfgUrl();
  try { assert.equal((await d.post('/api/sync')).status, 400, 'not opened from game-sauce: nothing to report to'); } finally { d.s.close(); }
});

test('setup page: parseConfigureUrl, programExists, and the platform list matches the app', async () => {
  const tok = 'b'.repeat(30);
  assert.deepEqual(launcher.parseConfigureUrl('gamesauce://configure'), { server: null, token: null });
  assert.deepEqual(launcher.parseConfigureUrl(`gamesauce://configure?server=http://h:1&token=${tok}`), { server: 'http://h:1', token: tok });
  assert.throws(() => launcher.parseConfigureUrl(`gamesauce://configure?token=${tok}`), /token/);
  assert.throws(() => launcher.parseConfigureUrl('gamesauce://launch?server=http://h:1'), /not a game-sauce setup link/);
  const { programExists, platformList } = await import('../launcher/configure.mjs');
  assert.equal(programExists(process.execPath), true); assert.equal(programExists(path.join(TMP, 'nope.exe')), false); assert.equal(programExists(''), false);
  const { PLATFORMS } = await import('../src/lib/platforms.js');
  assert.deepEqual(platformList().map((p) => p.slug).sort(), PLATFORMS.map((p) => p.slug).sort(), 'launcher/platforms.json is the platform list of the app (regenerate it when platforms change)');
});
