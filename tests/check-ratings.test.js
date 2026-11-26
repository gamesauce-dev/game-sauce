// scripts/check-ratings.mjs asks the providers which age ratings they return. It runs against a person's real database with their real keys, so what matters most:
// it changes nothing, it never prints a key (even one a provider echoes back), and it shows what came back. Run here against pretend providers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-ratingscheck-test-'));
const DATA = path.join(TMP, 'data');
process.env.GAMESAUCE_DATA_DIR = DATA;
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'rcadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'rc-admin-password-1';

const KEYS = { TGDB_API_KEY: 'tgdb-secret-key-123', IGDB_CLIENT_ID: 'igdb-client-id-456', IGDB_CLIENT_SECRET: 'igdb-client-secret-789', SS_DEV_ID: 'ss-dev-id-abc', SS_DEV_PASSWORD: 'ss-dev-pass-def', SS_USER: 'ss-user-ghi', SS_PASSWORD: 'ss pass&jkl' };
let db, server, base;
const requests = [];

/** A zip holding one deflated file, enough for the script's reader. */
function zipOf(name, text) {
  const data = Buffer.from(text), comp = zlib.deflateRawSync(data), n = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28);
  const body = Buffer.concat([local, n, comp]), dir = Buffer.concat([cd, n]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, dir, end]);
}

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  await prepareApp();
  db = (await import('../src/db.js')).default;
  const { encryptSecret } = await import('../src/settings.js');
  const put = db.prepare('INSERT OR REPLACE INTO app_settings (key, value, encrypted) VALUES (?, ?, 1)');
  for (const [k, v] of Object.entries(KEYS)) put.run(k, encryptSecret(v));
  db.prepare("UPDATE platforms SET screenscraper_id = 4, tgdb_id = 6 WHERE slug = 'snes'").run();
  db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1) VALUES ('Library Game (USA)','library game','lg.sfc',(SELECT id FROM platforms WHERE slug='snes'),'x',1,'rc1')").run();

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push(req.url);
      const u = new URL(req.url, 'http://x');
      const json = (o, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/tgdb/Games/ByGameName') return json({ remaining_monthly_allowance: 987, data: { games: [{ game_title: u.searchParams.get('name'), rating: 'E - Everyone' }] } });
      if (u.pathname === '/twitch') return json({ access_token: 'igdb-token-xyz-000' });
      if (u.pathname === '/igdb/games') {
        const title = /search "([^"]*)"/.exec(body)?.[1];
        return json([{ name: title, age_ratings: [{ id: 1, organization: { id: 7, name: 'ACB' }, rating_category: { id: 9, rating: 'PG' } }, { id: 2, echo: `token ${req.headers.authorization}` }] }]);
      }
      if (u.pathname === '/ss/jeuRecherche.php') return json({ response: { jeux: [{ id: '12', noms: [{ text: u.searchParams.get('recherche') }] }] } });
      if (u.pathname === '/ss/jeuInfos.php') return json({ response: { jeu: { noms: [{ text: 'Found on SS' }], classifications: [{ type: 'PEGI', text: '7' }, { type: 'ESRB', text: `E (asked by ${u.searchParams.get('ssid')} / ${u.searchParams.get('sspassword')})` }] } } });
      if (u.pathname === '/lb.zip') { res.writeHead(200, { 'Content-Type': 'application/zip' }); return res.end(zipOf('Metadata.xml', '<?xml version="1.0"?><LaunchBox><Game><Name>Super Mario World</Name><ESRB>E - Everyone</ESRB></Game><Game><Name>Other &amp; Game</Name></Game></LaunchBox>')); }
      return json({ error: 'nothing here' }, 404);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

const runScript = (extra = [], env = {}) => new Promise((resolve) => {
  const clean = { ...process.env };
  for (const k of [...Object.keys(KEYS), 'GAMESAUCE_SECRET_KEY', 'SS_DEV_ID_SHARED', 'SS_DEV_PASSWORD_SHARED', 'GAMESAUCE_DB_FILE']) delete clean[k];
  const child = spawn(process.execPath, ['scripts/check-ratings.mjs', ...extra], { env: { ...clean, GAMESAUCE_DATA_DIR: DATA, RATINGS_TGDB_BASE: `${base}/tgdb`, RATINGS_TWITCH_URL: `${base}/twitch`, RATINGS_IGDB_BASE: `${base}/igdb`, SS_API_BASE: `${base}/ss`, RATINGS_LAUNCHBOX_URL: `${base}/lb.zip`, RATINGS_NO_PAUSE: '1', ...env } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.on('close', (code) => resolve({ code, out }));
});
const snapshot = () => JSON.stringify(['roms', 'app_settings', 'platforms', 'users'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));

test('it shows what each provider returns, never prints a key, and changes nothing', async () => {
  const before = snapshot();
  const files = fs.readdirSync(DATA).filter((f) => !/-(wal|shm)$/.test(f)).sort();
  const { code, out } = await runScript(['--launchbox']);
  assert.equal(code, 0, out);
  assert.match(out, /rating = "E - Everyone"/, 'TheGamesDB: the value as it came');
  assert.match(out, /lookups left this month: 987/);
  assert.match(out, /ACB PG/, 'IGDB: the readable board and label');
  assert.match(out, /one rating exactly as IGDB sends it/);
  assert.match(out, /PEGI 7/, 'ScreenScraper');
  assert.match(out, /games in the database: 2; with a value in the ESRB field: 1/, 'LaunchBox');
  assert.match(out, /Library Game {2}\[snes; your library\]/, 'a game from the library is asked about, without its bracketed part');
  assert.match(out, /=== Summary ===/);
  for (const v of [...Object.values(KEYS), 'igdb-token-xyz-000', encodeURIComponent(KEYS.SS_PASSWORD)]) assert.ok(!out.includes(v), `a key or token was printed: ${v.slice(0, 6)}...`);
  assert.match(out, /\*\*\*/, 'an echoed key is blanked');
  assert.equal(snapshot(), before, 'the database is unchanged');
  assert.deepEqual(fs.readdirSync(DATA).filter((f) => !/-(wal|shm)$/.test(f)).sort(), files, 'no new file in the data folder');
});

test('without the key that unlocks the saved ones, it says so and asks nobody with a broken key', async () => {
  const asked = requests.length;
  const { code, out } = await runScript(['--library', '0'], { GAMESAUCE_SECRET_KEY: 'the-wrong-key' });
  assert.equal(code, 0, out);
  assert.match(out, /saved key\(s\) could not be read/);
  assert.match(out, /TheGamesDB ===\s+not set up/);
  assert.equal(requests.length, asked, 'nothing was sent');
});

test('--only limits which providers are asked, and LaunchBox is left alone unless asked for', async () => {
  const asked = requests.length;
  const { out } = await runScript(['--only', 'thegamesdb', '--library', '0']);
  assert.ok(!out.includes('=== IGDB') && !out.includes('=== ScreenScraper'));
  assert.ok(requests.slice(asked).every((u) => u.startsWith('/tgdb/')));
  const plain = await runScript(['--library', '0']);
  assert.ok(!plain.out.includes('=== LaunchBox'), 'the 110 MB download only happens with --launchbox');
});
