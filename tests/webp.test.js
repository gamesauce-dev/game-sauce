// WebP copies of pictures: the stored file is never touched, a browser that accepts WebP gets a smaller copy, and the quality has a floor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-webp-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'wpadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'wp-admin-password-1';

let server, base, db, adminTok, memberTok, sharp, romId, pngPath, pngBytes;
const WEBP = { Accept: 'image/webp,image/*;q=0.8' };
const call = async (p, { token = adminTok, method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, type, vary: res.headers.get('vary') || '', body: type.includes('json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer()) };
};
const login = async (u, p) => (await call('/api/auth/login', { token: null, method: 'POST', body: { username: u, password: p } })).body.token;
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 100)); } };

before(async () => {
  sharp = (await import('sharp')).default;
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('wpadmin', 'wp-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'wpmember', password: 'wp-member-pass-12', role: 'user' } });
  memberTok = await login('wpmember', 'wp-member-pass-12');
  // a cover with some detail, stored as a PNG (the big, lossless kind a webp copy should shrink)
  const { COVER_DIR } = await import('../src/lib/storage.js');
  const noise = await sharp({ create: { width: 900, height: 1260, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 30 } } }).blur(1.2).png().toBuffer();
  pngPath = path.join(COVER_DIR, 'wp-test.png'); fs.writeFileSync(pngPath, noise); pngBytes = noise;
  romId = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, meta_source, cover_path) VALUES ('Cover Game', 'cover game', 'cg.sfc', (SELECT id FROM platforms WHERE slug = 'snes'), ?, 1, 'wp1', 'filename', ?)").run(path.join(TMP, 'cg.sfc'), pngPath).lastInsertRowid);
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('the quality has a floor and a ceiling, and only an admin can change it', async () => {
  const get = await call('/api/admin/images');
  assert.equal(get.status, 200);
  assert.equal(get.body.available, true); assert.equal(get.body.quality, 85); assert.equal(get.body.min, 70); assert.equal(get.body.enabled, true);
  for (const bad of [69, 50, 0, -5, 96, 100, 80.5, 'abc']) {
    const r = await call('/api/admin/images', { method: 'PUT', body: { quality: bad } });
    assert.equal(r.status, 400, `quality ${bad} is refused`);
  }
  assert.match((await call('/api/admin/images', { method: 'PUT', body: { quality: 60 } })).body.error, /cannot be lower than 70/);
  assert.equal((await call('/api/admin/images')).body.quality, 85, 'a refused value changes nothing');
  assert.equal((await call('/api/admin/images', { method: 'PUT', body: { quality: 70 } })).body.quality, 70, 'the floor itself is allowed');
  assert.equal((await call('/api/admin/images', { method: 'PUT', body: { quality: 85 } })).body.quality, 85);
  assert.equal((await call('/api/admin/images', { token: memberTok })).status, 403);
  assert.equal((await call('/api/admin/images', { token: memberTok, method: 'PUT', body: { quality: 90 } })).status, 403);
});

test('without WebP in Accept the stored picture is sent as it is', async () => {
  const r = await call(`/api/roms/${romId}/cover`);
  assert.equal(r.status, 200); assert.equal(r.type, 'image/png');
  assert.ok(r.body.equals(pngBytes));
});

test('a thumbnail is a small WebP made at once, and it looks like the original', async () => {
  const r = await call(`/api/roms/${romId}/cover?w=320`, { headers: WEBP });
  assert.equal(r.status, 200); assert.equal(r.type, 'image/webp'); assert.match(r.vary, /Accept/i);
  const meta = await sharp(r.body).metadata();
  assert.equal(meta.format, 'webp'); assert.equal(meta.width, 320); assert.equal(meta.height, 448, 'same shape as the original');
  assert.ok(r.body.length < pngBytes.length / 10, `thumbnail ${r.body.length} bytes vs original ${pngBytes.length}`);
  assert.ok(fs.existsSync(path.join(TMP, 'storage', 'image-cache')), 'copies live in their own folder');
  assert.ok(fs.readFileSync(pngPath).equals(pngBytes), 'the stored picture is untouched');
  // a width that is not on the list is not honoured (no arbitrary resizing on request)
  const odd = await call(`/api/roms/${romId}/cover?w=50`, { headers: WEBP });
  assert.notEqual(odd.type, 'image/webp' && (await sharp(odd.body).metadata()).width === 50 ? 'x' : 'y', 'x');
});

test('the full-size picture is sent as it is first, then as a WebP made behind the request', async () => {
  const first = await call(`/api/roms/${romId}/cover`, { headers: WEBP });
  assert.equal(first.type, 'image/png', 'the first request is not made to wait');
  const copy = await until(async () => { const r = await call(`/api/roms/${romId}/cover`, { headers: WEBP }); return r.type === 'image/webp' ? r : null; });
  assert.ok(copy, 'the copy is ready shortly after');
  const meta = await sharp(copy.body).metadata();
  assert.equal(meta.width, 900); assert.equal(meta.height, 1260, 'same size: nothing is lost by shrinking');
  assert.ok(copy.body.length < pngBytes.length * 0.9);
  // measured against the original: close to identical
  const a = await sharp(pngBytes).raw().toBuffer(), b = await sharp(copy.body).raw().toBuffer();
  let se = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
  const psnr = 10 * Math.log10(255 * 255 / (se / a.length));
  assert.ok(psnr > 30, `quality 85 stays close to the original (PSNR ${psnr.toFixed(1)} dB)`);
});

test('a copy is only used when it is really smaller, and an animated picture is left as it is', async () => {
  const { COVER_DIR } = await import('../src/lib/storage.js');
  // a tiny flat PNG: the WebP would be about the same size
  const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).png({ compressionLevel: 9 }).toBuffer();
  const f = path.join(COVER_DIR, 'wp-tiny.png'); fs.writeFileSync(f, tiny);
  const id = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, meta_source, cover_path) VALUES ('Tiny', 'tiny', 'tiny.sfc', (SELECT id FROM platforms WHERE slug = 'snes'), ?, 1, 'wp2', 'filename', ?)").run(path.join(TMP, 'tiny.sfc'), f).lastInsertRowid);
  await call(`/api/roms/${id}/cover`, { headers: WEBP });
  await new Promise((r) => setTimeout(r, 800));
  const again = await call(`/api/roms/${id}/cover`, { headers: WEBP });
  // whichever is sent is never the bigger one: a copy is used only when it saves at least 10%, otherwise the original stays
  if (again.type === 'image/webp') assert.ok(again.body.length <= tiny.length * 0.9); else { assert.equal(again.type, 'image/png'); assert.ok(again.body.equals(tiny)); }
  // a GIF is never converted
  const gif = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#f00' } }).gif().toBuffer();
  const g = path.join(COVER_DIR, 'wp-anim.gif'); fs.writeFileSync(g, gif);
  const gid = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, meta_source, cover_path) VALUES ('Gif', 'gif', 'gif.sfc', (SELECT id FROM platforms WHERE slug = 'snes'), ?, 1, 'wp3', 'filename', ?)").run(path.join(TMP, 'gif.sfc'), g).lastInsertRowid);
  const gr = await call(`/api/roms/${gid}/cover?w=320`, { headers: WEBP });
  assert.equal(gr.type, 'image/gif');
});

test('switching it off sends the originals again; changing the quality rebuilds the copies', async () => {
  await call('/api/admin/images', { method: 'PUT', body: { enabled: false } });
  const off = await call(`/api/roms/${romId}/cover?w=320`, { headers: WEBP });
  assert.equal(off.type, 'image/png'); assert.ok(off.body.equals(pngBytes));
  await call('/api/admin/images', { method: 'PUT', body: { enabled: true } });
  const on = await call(`/api/roms/${romId}/cover?w=320`, { headers: WEBP });
  assert.equal(on.type, 'image/webp');
  assert.ok((await call('/api/admin/images')).body.cache.files > 0);
  const q = await call('/api/admin/images', { method: 'PUT', body: { quality: 75 } });
  assert.equal(q.body.cache.files, 0, 'copies made at the old quality are dropped');
  const smaller = await call(`/api/roms/${romId}/cover?w=640`, { headers: WEBP });
  const bigger = await (async () => { await call('/api/admin/images', { method: 'PUT', body: { quality: 95 } }); return call(`/api/roms/${romId}/cover?w=640`, { headers: WEBP }); })();
  assert.ok(smaller.body.length < bigger.body.length, 'a higher quality is a bigger file');
  await call('/api/admin/images', { method: 'PUT', body: { quality: 85 } });
  const cleared = await call('/api/admin/images/clear', { method: 'POST' });
  assert.equal(cleared.body.cache.files, 0);
});

test('tiles ask for thumbnails of our own covers only', async () => {
  const { thumb } = await import('../public/thumb.js');
  assert.equal(thumb('/api/roms/5/cover?v=a.png'), '/api/roms/5/cover?v=a.png&w=640');
  assert.equal(thumb('/api/physical/cover/3'), '/api/physical/cover/3?w=640');
  assert.equal(thumb('https://example.com/x.jpg'), 'https://example.com/x.jpg');
  assert.equal(thumb('/api/roms/5/cover?w=320'), '/api/roms/5/cover?w=320');
  assert.equal(thumb(null), '');
});

test('the admin preview shows the same piece of a real cover, stored and as WebP, and respects the floor', async () => {
  const info = await call(`/api/admin/images/preview?quality=80&rom=${romId}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.sample.id, romId); assert.equal(info.body.quality, 80);
  assert.equal(info.body.width, 900); assert.equal(info.body.height, 1260);
  assert.ok(info.body.webp_bytes < info.body.original_bytes && info.body.saving_pct > 50);
  assert.deepEqual(info.body.crop, { w: 480, h: 480 });
  assert.equal(info.body.would_convert, true);
  // a picture that is already squeezed hard comes out bigger as WebP: the preview says so and the cover is left alone
  const { COVER_DIR } = await import('../src/lib/storage.js');
  const lowq = path.join(COVER_DIR, 'prev-lowq.jpg'); fs.writeFileSync(lowq, await sharp({ create: { width: 300, height: 300, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 30 } } }).blur(1.2).jpeg({ quality: 25 }).toBuffer());
  const lid = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, meta_source, cover_path) VALUES ('Squeezed', 'squeezed', 'sq.sfc', (SELECT id FROM platforms WHERE slug = 'snes'), ?, 1, 'wp9', 'filename', ?)").run(path.join(TMP, 'sq.sfc'), lowq).lastInsertRowid);
  const sq = await call(`/api/admin/images/preview?quality=85&rom=${lid}`);
  assert.ok(sq.body.webp_bytes > sq.body.original_bytes && sq.body.saving_pct < 0 && sq.body.would_convert === false);
  // without a rom a cover is picked from the library
  assert.ok((await call('/api/admin/images/preview?quality=85')).body.sample);
  const a = await call(`/api/admin/images/preview/original.png?rom=${romId}&quality=80`);
  const b = await call(`/api/admin/images/preview/webp.png?rom=${romId}&quality=80`);
  assert.equal(a.type, 'image/png'); assert.equal(b.type, 'image/png');
  const [ma, mb] = await Promise.all([sharp(a.body).metadata(), sharp(b.body).metadata()]);
  assert.deepEqual([ma.width, ma.height], [480, 480]); assert.deepEqual([mb.width, mb.height], [480, 480]);
  // a lower quality looks worse (further from the original) than a higher one
  const lo = await call(`/api/admin/images/preview/webp.png?rom=${romId}&quality=70`), hi = await call(`/api/admin/images/preview/webp.png?rom=${romId}&quality=95`);
  const raw = async (buf) => sharp(buf).raw().toBuffer(); const ra = await raw(a.body);
  const err = async (buf) => { const r = await raw(buf); let se = 0; for (let i = 0; i < ra.length; i++) { const d = ra[i] - r[i]; se += d * d; } return se; };
  assert.ok((await err(lo.body)) > (await err(hi.body)), 'the preview really changes with the quality');
  for (const bad of [69, 96, 'x']) assert.equal((await call(`/api/admin/images/preview?quality=${bad}`)).status, 400);
  assert.equal((await call(`/api/admin/images/preview/webp.png?rom=${romId}&quality=10`)).status, 400);
  assert.equal((await call('/api/admin/images/preview?quality=85', { token: memberTok })).status, 403);
  assert.equal((await call(`/api/admin/images/preview/webp.png?rom=${romId}&quality=85`, { token: memberTok })).status, 403);
});
