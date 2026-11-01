import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-lbcov-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'cadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'c-admin-password-1';

let img, imgPort, hits = 0, failFirst = 2, db, mod;
before(async () => {
  img = http.createServer((q, r) => { hits++; if (hits <= failFirst) { r.statusCode = 503; return r.end('busy'); } r.setHeader('Content-Type', 'image/png'); r.end(Buffer.from('89504e470d0a1a0a', 'hex')); });
  await new Promise((r) => img.listen(0, '127.0.0.1', r));
  imgPort = img.address().port;
  mod = await import('../src/lib/providers.js');
  db = (await import('../src/db.js')).default;
});
after(async () => {
  await new Promise((r) => img.close(r));
  try { db?.close(); } catch { /* may be shared */ }
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('a busy image server is retried, so a cover is not lost to one bad moment', async () => {
  hits = 0; failFirst = 2;
  const file = await mod.cacheMedia(`http://127.0.0.1:${imgPort}/a.png`, 'box2d');
  assert.ok(file && fs.existsSync(file), 'the cover was saved on the third try');
  assert.equal(hits, 3);
});

test('a missing image (404) is not retried', async () => {
  const t = http.createServer((q, r) => { hits++; r.statusCode = 404; r.end(); });
  await new Promise((r) => t.listen(0, '127.0.0.1', r));
  hits = 0;
  const file = await mod.cacheMedia(`http://127.0.0.1:${t.address().port}/gone.png`, 'box2d');
  await new Promise((r) => t.close(r));
  assert.equal(file, null);
  assert.equal(hits, 1);
});

test('"Fetch missing covers" also picks up games LaunchBox matched but left without a cover', () => {
  const src = fs.readFileSync(new URL('../src/routes/roms.js', import.meta.url), 'utf8');
  const sql = src.slice(src.indexOf('const CANDIDATES_SQL'), src.indexOf('const enrichJob'));
  assert.match(sql, /'launchbox'/);
});

test('every provider the identify box offers can be starred as the default (LaunchBox gave "Invalid value")', async () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const ui = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const offered = [...ui.match(/const IDENT_PROVIDERS = \[([^\]]*(?:\[[^\]]*\][^\]]*)*)\];/)[1].matchAll(/\['([a-z]+)'/g)].map((m) => m[1]);
  const allowed = [...app.match(/PREF_KEYS = \{ identify_provider: \[([^\]]*)\]/)[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(offered.includes('launchbox'));
  for (const id of offered) assert.ok(allowed.includes(id), `${id} can be saved as the default provider`);
});
