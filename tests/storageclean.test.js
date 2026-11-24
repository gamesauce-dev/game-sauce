// The unused-files check must never call a file unused while the database still points at it.
// A console game's cover in the Digital Library is a picture in storage/media named for the hash of the address it came from, but the database keeps only its PATH (the address is not kept),
// so the first version of the check deleted them as "unused".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-storageclean-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'scadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'sc-admin-password-1';

let db, clean;
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');
const old = (f) => { const t = new Date(Date.now() - 3 * 3600 * 1000); fs.utimesSync(f, t, t); };   // older than the ten minutes the check leaves alone
const put = (rel, text = 'picture') => { const f = path.join(TMP, 'storage', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); old(f); return f; };

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  await prepareApp();
  db = (await import('../src/db.js')).default;
  clean = await import('../src/lib/storageclean.js');
});
after(() => {
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

const unusedNames = () => clean.scanStorage()._unused.map((u) => path.basename(u.file));

test('a console cover in the Digital Library is kept: its path is in the database even though its address is not', () => {
  const shared = put(`media/box2d-${hash('https://example.test/shared.jpg')}.jpg`);
  const own = put(`media/box2d-${hash('https://example.test/own.jpg')}.jpg`);
  const stray = put(`media/box2d-${hash('https://example.test/stray.jpg')}.jpg`);
  db.prepare("INSERT INTO digital_details (store, app_id, json, fetched_at, found, cover_path) VALUES ('xbox', 'A1', '{}', datetime('now'), 1, ?)").run(shared);
  const uid = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  db.prepare("INSERT INTO digital_user_meta (user_id, store, app_id, json, cover_path) VALUES (?, 'xbox', 'A2', '{}', ?)").run(uid, own);
  const names = unusedNames();
  assert.ok(!names.includes(path.basename(shared)), 'the shared cover of a console game is in use');
  assert.ok(!names.includes(path.basename(own)), 'a cover a person picked for a console game is in use');
  assert.ok(names.includes(path.basename(stray)), 'a picture nothing points at is still unused');
});

test('a picture named for an address that is still in the database is kept, as before', () => {
  const url = 'https://example.test/fetched/cover.png';
  const f = put(`media/box2d-${hash(url)}.png`);
  db.prepare("INSERT INTO digital_details (store, app_id, json, fetched_at, found) VALUES ('xbox', 'A3', ?, datetime('now'), 1)").run(JSON.stringify({ cover_url: url }));
  assert.ok(!unusedNames().includes(path.basename(f)));
});

test('clearing out deletes only what is unused', () => {
  const kept = put(`media/box2d-${hash('https://example.test/keepme.jpg')}.jpg`);
  db.prepare("INSERT INTO digital_details (store, app_id, json, fetched_at, found, cover_path) VALUES ('xbox', 'A4', '{}', datetime('now'), 1, ?)").run(kept);
  const stray = put(`media/box2d-${hash('https://example.test/gone.jpg')}.jpg`);
  const r = clean.clearOut(['media']);
  assert.ok(r.removed >= 1);
  assert.equal(fs.existsSync(kept), true, 'the console cover is still there');
  assert.equal(fs.existsSync(stray), false, 'the stray picture is gone');
});
