import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-cv-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'cvadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'cv-admin-password-1';

let server, base, tok, db, a, b;
const hdr = () => ({ Authorization: `Bearer ${tok}` });
const j = async (p, opt = {}) => {
  const res = await fetch(base + p, { ...opt, headers: { ...hdr(), ...(opt.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => null), res };
};
const send = (id, bytes, name = 'c.png', type = 'image/png') => {
  const fd = new FormData(); fd.append('cover', new Blob([bytes], { type }), name);
  return j(`/api/roms/${id}/cover`, { method: 'POST', body: fd });
};
// Smallest real images (decode in any viewer): 1x1 PNG, a JPEG header + padding, a WebP header.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0'), Buffer.alloc(40, 1), Buffer.from([0xff, 0xd9])]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(40, 2)]);

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'cvadmin', password: 'cv-admin-password-1' }) })).json()).token;
  const plat = db.prepare("SELECT id FROM platforms WHERE slug = 'nes'").get().id;
  const ins = (t, sha) => db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1) VALUES (?,?,?,?,'x',1,?)").run(t, t, `${sha}.nes`, plat, sha).lastInsertRowid;
  a = ins('Cover A', 'cva'); b = ins('Cover B', 'cvb');
});
after(() => { server?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('real JPEG, PNG and WebP covers are accepted and served back byte-for-byte', async () => {
  for (const [bytes, type, name] of [[PNG, 'image/png', 'a.png'], [JPG, 'image/jpeg', 'a.jpg'], [WEBP, 'image/webp', 'a.webp']]) {
    const r = await send(a, bytes, name, type);
    assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.cover_locked, 1);
    const got = await fetch(`${base}/api/roms/${a}/cover`, { headers: hdr() });
    assert.equal(got.status, 200);
    assert.ok(Buffer.from(await got.arrayBuffer()).equals(bytes), `${name} served unchanged`);
  }
});

test('files that are not images are refused, whatever name or type they claim', async () => {
  const before = db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(b).cover_path;
  for (const [bytes, name, type] of [
    [Buffer.from('<html><script>alert(1)</script></html>'), 'cover.png', 'image/png'],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'cover.svg', 'image/svg+xml'],
    [Buffer.from('GIF89a' + 'x'.repeat(30)), 'cover.gif', 'image/gif'],
    [Buffer.from('just some text, not an image at all'), 'cover.jpg', 'image/jpeg'],
    [Buffer.alloc(4), 'tiny.png', 'image/png']
  ]) {
    const r = await send(b, bytes, name, type);
    assert.equal(r.status, 400, `${name} refused`);
  }
  assert.equal(db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(b).cover_path, before, 'nothing was stored');
  assert.equal((await j(`/api/roms/999999/cover`, { method: 'POST', body: (() => { const f = new FormData(); f.append('cover', new Blob([PNG]), 'x.png'); return f; })() })).status, 404);
});

test('covers are stored per game: one game replacing or removing its cover never touches another', async () => {
  await send(a, PNG); await send(b, PNG);
  const pa = db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(a).cover_path;
  const pb = db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(b).cover_path;
  assert.notEqual(pa, pb, 'identical images still get separate files');
  await j(`/api/roms/${a}/cover`, { method: 'DELETE' });
  assert.ok(!fs.existsSync(pa), "A's file is gone");
  assert.ok(fs.existsSync(pb), "B's file is untouched");
});

test('a custom cover survives a metadata refresh and the admin clear-covers tool; removing it unlocks auto covers', async () => {
  const { applyMetadataRecord } = await import('../src/routes/roms.js');
  await send(b, JPG);
  const mine = db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(b).cover_path;

  await applyMetadataRecord(b, { title: 'Provider Title', source: 'thegamesdb', cover_url: null, media: {} });
  const afterRefresh = db.prepare('SELECT cover_path, cover_locked, title FROM roms WHERE id = ?').get(b);
  assert.equal(afterRefresh.cover_path, mine, 'provider refresh did not replace the custom cover');
  assert.equal(afterRefresh.cover_locked, 1);

  const cleared = await j('/api/roms/clear-covers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'nes', dry_run: false }) });
  assert.equal(cleared.status, 200);
  assert.equal(db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(b).cover_path, mine, 'clear-covers skipped the custom cover');
  assert.ok(fs.existsSync(mine));

  const back = await j(`/api/roms/${b}/cover`, { method: 'DELETE' });
  assert.equal(back.status, 200);
  assert.equal(back.body.cover_locked, 0);
  assert.ok(!fs.existsSync(mine), 'custom file removed');
  assert.equal((await fetch(`${base}/api/roms/${b}/cover`, { headers: hdr() })).status, 404);
  // and now a provider cover may be applied again (path column becomes provider-managed)
  const unlocked = db.prepare('SELECT cover_locked FROM roms WHERE id = ?').get(b).cover_locked;
  assert.equal(unlocked, 0);
});
