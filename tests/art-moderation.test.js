// The admin can deal with a problem picture that sharing has spread between accounts, without being shown anyone's library: only pictures that are on
// more than one account (or that sharing has copied) are listed, with no word of whose they are.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-artmod-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'amadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'am-admin-password-1';

let server, base, db, phys, mod, COVERS, tok = {}, ids = {};
const call = async (p, { method = 'GET', body, as = 'admin' } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + tok[as], 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString()); } catch { /* a picture */ }
  return { status: res.status, body: json, buf, headers: res.headers };
};
before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default; phys = await import('../src/lib/physical.js');
  mod = await import('../src/lib/artmoderation.js');
  ({ COVER_DIR: COVERS } = await import('../src/lib/storage.js'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok.admin = await login('amadmin', 'am-admin-password-1');
  for (const u of ['annmod', 'benmod', 'catmod']) {
    await call('/api/auth/users', { method: 'POST', body: { username: u, password: `${u}-password-12`, role: 'user' } });
    tok[u] = await login(u, `${u}-password-12`);
  }
  for (const u of ['amadmin', 'annmod', 'benmod', 'catmod']) ids[u] = db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
});
beforeEach(async () => {
  await idle();
  for (const t of ['physical_games', 'art_shared', 'art_blocked', 'image_conversions']) db.prepare(`DELETE FROM ${t}`).run();
});
after(async () => { server?.closeAllConnections(); await new Promise((r) => server?.close(r)); db?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ } });

const idle = async () => { while (phys?.matchJobStatus().running) await new Promise((r) => setTimeout(r, 25)); };
const png = (w, h, shade) => { const p = new PNG({ width: w, height: h }); p.data.fill(shade); return PNG.sync.write(p); };
const SPINE = png(60, 400, 40), BACK = png(300, 420, 80), PRIVATE = png(300, 420, 120), OTHER_SPINE = png(60, 400, 200);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const row = (id) => db.prepare('SELECT * FROM physical_games WHERE id = ?').get(id);
const add = async (who, title = 'Wheelman') => { const g = phys.addPhysical(ids[who], { platform: 'ps3', title }); await idle(); return g.id; };
const list = async () => (await call('/api/art/shared')).body;

test('only the admin reaches any of it', async () => {
  const id = sha(SPINE);
  for (const [method, url] of [['GET', '/api/art/shared'], ['GET', `/api/art/shared/${id}/picture`], ['POST', `/api/art/shared/${id}/remove`], ['DELETE', `/api/art/blocked/${id}`]]) {
    assert.equal((await call(url, { as: 'annmod', method, body: method === 'POST' ? {} : undefined })).status, 403, `${method} ${url}`);
  }
});

test('a picture only one account has is never listed or shown; a shared one is, without saying whose', async () => {
  const a = await add('annmod');
  phys.setPhysicalArt(ids.annmod, a, 'spine', SPINE);
  const secret = await add('annmod', 'Only Mine');
  phys.setPhysicalArt(ids.annmod, secret, 'cover', PRIVATE);
  assert.deepEqual((await list()).items, [], 'nothing has been shared yet');
  for (const b of [SPINE, PRIVATE]) assert.equal((await call(`/api/art/shared/${sha(b)}/picture`)).status, 404);
  assert.equal((await call(`/api/art/shared/${sha(PRIVATE)}/remove`, { method: 'POST', body: {} })).status, 404, 'nor can what is not listed be removed');

  await add('benmod');   // the background run brings ann's spine across
  const out = await list();
  assert.deepEqual(out.items, [{ id: sha(SPINE), kind: 'spine', title: 'Wheelman', platform: 'ps3', accounts: 2 }]);
  assert.ok(!JSON.stringify(out).match(/annmod|benmod|user_id|Only Mine/));
  const pic = await call(`/api/art/shared/${sha(SPINE)}/picture`);
  assert.equal(pic.status, 200); assert.ok(pic.buf.equals(SPINE)); assert.match(pic.headers.get('content-type'), /image\/png/);
  assert.match(pic.headers.get('cache-control'), /no-store/);
});

test('copies made before the app kept a record are found too: the same uploaded file on two accounts', async () => {
  const a = await add('annmod', 'Alpha'), b = await add('benmod', 'Beta');
  phys.setPhysicalArt(ids.annmod, a, 'back', BACK); phys.setPhysicalArt(ids.benmod, b, 'back', BACK);
  assert.deepEqual((await list()).items.map((i) => [i.id, i.accounts]), [[sha(BACK), 2]]);
});

test('removing takes it from every account, touches nothing else, and it is not shared again', async () => {
  const a = await add('annmod');
  phys.setPhysicalArt(ids.annmod, a, 'spine', SPINE); phys.setPhysicalArt(ids.annmod, a, 'back', BACK);
  phys.setManualLink(ids.annmod, a, 'https://example.com/manual.pdf');
  db.prepare("UPDATE physical_games SET notes = 'mine' WHERE id = ?").run(a);
  const b = await add('benmod');
  const files = [row(a).spine_path, row(b).spine_path];
  const r = await call(`/api/art/shared/${sha(SPINE)}/remove`, { method: 'POST', body: {} });
  assert.deepEqual(r.body, { removed: 2 });
  for (const id of [a, b]) { assert.equal(row(id).spine_path, null); assert.equal(row(id).spine_locked, 0); assert.ok(row(id).back_path, 'the other picture stays'); }
  for (const f of files) assert.ok(!fs.existsSync(f), 'the uploaded files are gone');
  assert.equal(row(a).notes, 'mine'); assert.equal(row(a).manual_link, 'https://example.com/manual.pdf');
  const after = await list();
  assert.deepEqual(after.items.map((i) => i.id), [sha(BACK)]);
  assert.deepEqual(after.blocked.map((x) => [x.id, x.kind, x.title, x.platform]), [[sha(SPINE), 'spine', 'Wheelman', 'ps3']]);

  assert.equal(phys.reuseArt(ids.benmod, b), 0, 'nobody has it any more');
  // its owner may still put it back on their own shelf; it just never travels again
  phys.setPhysicalArt(ids.annmod, a, 'spine', SPINE);
  const c = await add('catmod');
  assert.equal(row(c).spine_path, null, 'not copied'); assert.ok(row(c).back_path, 'while what is allowed still is');
});

test('with the blocked one set aside, another account\'s different picture is shared instead', async () => {
  const a = await add('annmod'), b = await add('benmod');
  await call('/api/art/sharing', { method: 'PUT', body: { on: false } });
  phys.setPhysicalArt(ids.annmod, a, 'spine', SPINE); phys.setPhysicalArt(ids.benmod, b, 'spine', OTHER_SPINE);
  db.prepare("INSERT INTO art_blocked (hash, block_id, title, platform, kind) VALUES (?, ?, 'Wheelman', 'ps3', 'spine')").run(sha(SPINE), sha(SPINE));
  await call('/api/art/sharing', { method: 'PUT', body: { on: true } });
  const c = await add('catmod');
  assert.ok(fs.readFileSync(row(c).spine_path).equals(OTHER_SPINE));
});

test('"Allow sharing again" undoes the block', async () => {
  const a = await add('annmod');
  phys.setPhysicalArt(ids.annmod, a, 'spine', SPINE);
  await add('benmod');
  await call(`/api/art/shared/${sha(SPINE)}/remove`, { method: 'POST', body: {} });
  assert.equal((await call(`/api/art/blocked/${sha(SPINE)}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await list()).blocked, []);
  assert.equal((await call(`/api/art/blocked/${sha(SPINE)}`, { method: 'DELETE' })).status, 404);
  phys.setPhysicalArt(ids.annmod, a, 'spine', SPINE);
  const c = await add('catmod');
  assert.ok(fs.readFileSync(row(c).spine_path).equals(SPINE));
});

test('a picture from a provider is taken off the shelves but its file is left (other things may use it)', async () => {
  const shared = path.join(COVERS, 'provider-0001.png'); fs.writeFileSync(shared, PRIVATE);
  await call('/api/art/sharing', { method: 'PUT', body: { on: false } });
  const a = await add('annmod');
  db.prepare('UPDATE physical_games SET cover_path = ? WHERE id = ?').run(shared, a);
  await call('/api/art/sharing', { method: 'PUT', body: { on: true } });
  const b = await add('benmod');
  assert.equal(row(b).cover_path, shared, 'sharing points at the same file');
  assert.deepEqual((await list()).items.map((i) => [i.id, i.accounts]), [[sha(PRIVATE), 2]], 'listed because sharing copied it');
  await call(`/api/art/shared/${sha(PRIVATE)}/remove`, { method: 'POST', body: {} });
  assert.equal(row(a).cover_path, null); assert.equal(row(b).cover_path, null);
  assert.ok(fs.existsSync(shared));
});

test('the block still holds after pictures are converted, whichever way round it happened', async () => {
  const converted = Buffer.concat([SPINE, Buffer.from('as-webp')]), original = path.join(TMP, 'original.png');
  fs.writeFileSync(original, SPINE);
  const blocked = (b) => { const f = path.join(TMP, 'check.bin'); fs.writeFileSync(f, b); return mod.isBlockedFile(f); };
  // blocked first, converted afterwards
  db.prepare("INSERT INTO art_blocked (hash, block_id, title, platform, kind) VALUES (?, ?, 't', 'ps3', 'spine')").run(sha(SPINE), sha(SPINE));
  mod.noteConverted(original, converted);
  assert.equal(blocked(converted), true);
  await call(`/api/art/blocked/${sha(SPINE)}`, { method: 'DELETE' });
  assert.equal(blocked(converted), false, 'allowing it again allows every form of it');
  assert.equal(blocked(SPINE), false);
  // converted first (the original kept aside), blocked afterwards
  const live = path.join(COVERS, 'physical-1-1-spine-1.webp'), kept = path.join(TMP, 'kept.png');
  fs.writeFileSync(live, converted); fs.writeFileSync(kept, SPINE);
  const a = await add('annmod', 'Gamma'), b = await add('benmod', 'Gamma Two');
  for (const id of [a, b]) db.prepare('UPDATE physical_games SET spine_path = ? WHERE id = ?').run(live, id);
  db.prepare('INSERT INTO image_conversions (old_path, new_path, kept_path, old_bytes, new_bytes, quality) VALUES (?, ?, ?, 1, 1, 80)').run(path.join(COVERS, 'x.png'), live, kept);
  assert.equal((await call(`/api/art/shared/${sha(converted)}/remove`, { method: 'POST', body: {} })).status, 200);
  assert.equal(blocked(SPINE), true, 'the original is blocked as well');
  assert.equal(blocked(converted), true);
});
