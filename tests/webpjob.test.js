// Converting the stored pictures to WebP on a schedule: careful, journalled, and undoable while the originals are kept.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-webpjob-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'wjadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'wj-admin-password-1';

let server, base, db, adminTok, memberTok, sharp, job, COVER_DIR;
const ids = {}, files = {};
const call = async (p, { token = adminTok, method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, type, body: type.includes('json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer()) };
};
const login = async (u, p) => (await call('/api/auth/login', { token: null, method: 'POST', body: { username: u, password: p } })).body.token;
const noisy = (w, h, mean = 120) => sharp({ create: { width: w, height: h, channels: 3, noise: { type: 'gaussian', mean, sigma: 30 } } }).blur(1.2);
const addRom = (title, sha, cover) => Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, meta_source, cover_path) VALUES (?, ?, ?, (SELECT id FROM platforms WHERE slug = 'snes'), ?, 1, ?, 'filename', ?)").run(title, title.toLowerCase(), sha + '.sfc', path.join(TMP, sha + '.sfc'), sha, cover).lastInsertRowid);

before(async () => {
  sharp = (await import('sharp')).default;
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  job = await import('../src/lib/webpjob.js');
  ({ COVER_DIR } = await import('../src/lib/storage.js'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('wjadmin', 'wj-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'wjmember', password: 'wj-member-pass-12', role: 'user' } });
  memberTok = await login('wjmember', 'wj-member-pass-12');

  files.shared = path.join(COVER_DIR, 'shared.png'); fs.writeFileSync(files.shared, await noisy(700, 980).png().toBuffer());
  files.jpg = path.join(COVER_DIR, 'photo.jpg'); fs.writeFileSync(files.jpg, await noisy(700, 980, 90).jpeg({ quality: 95 }).toBuffer());
  files.tiny = path.join(COVER_DIR, 'lowq.jpg'); fs.writeFileSync(files.tiny, await noisy(300, 300).jpeg({ quality: 25 }).toBuffer());   // already squeezed hard: WebP at 85 would be bigger, so it is left alone
  files.media = path.join(COVER_DIR, 'box.png'); fs.writeFileSync(files.media, await noisy(600, 800, 150).png().toBuffer());
  files.spine = path.join(TMP, 'storage', 'rom-files', 'spine-1.png'); fs.mkdirSync(path.dirname(files.spine), { recursive: true }); fs.writeFileSync(files.spine, await noisy(200, 900, 100).png().toBuffer());
  files.outside = path.join(TMP, 'my-own-folder', 'mine.png'); fs.mkdirSync(path.dirname(files.outside), { recursive: true }); fs.writeFileSync(files.outside, await noisy(500, 700).png().toBuffer());
  files.phys = path.join(COVER_DIR, 'physical-1-1-cover.png'); fs.writeFileSync(files.phys, await noisy(500, 700, 110).png().toBuffer());
  for (const k of Object.keys(files)) files[k + 'Bytes'] = fs.readFileSync(files[k]);

  ids.a = addRom('Shared A', 'wj1', files.shared); ids.b = addRom('Shared B', 'wj2', files.shared);   // one cover file, two games
  ids.jpg = addRom('Photo', 'wj3', files.jpg); ids.tiny = addRom('Tiny', 'wj4', files.tiny); ids.out = addRom('Outside', 'wj5', files.outside);
  ids.media = addRom('Media', 'wj6', null);
  db.prepare('UPDATE roms SET provider_media = ? WHERE id = ?').run(JSON.stringify({ box2d: { path: files.media, url: 'https://example.com/x.png' } }), ids.media);
  db.prepare("INSERT INTO rom_files (rom_id, kind, path, name, type, bytes) VALUES (?, 'spine', ?, 'spine.png', 'image/png', ?)").run(ids.a, files.spine, files.spineBytes.length);
  const uid = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  db.prepare("INSERT INTO physical_games (user_id, platform, title, sort_title, dedupe_key, cover_path) VALUES (?, 'snes', 'Boxed', 'boxed', 'bx', ?)").run(uid, files.phys);
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('the schedule is validated and admin-only; it is off until switched on', async () => {
  const s = await call('/api/admin/images/convert');
  assert.equal(s.body.mode, 'off'); assert.equal(s.body.keep_days, 14);
  for (const bad of [{ keep_days: 0 }, { keep_days: 91 }, { keep_days: 1.5 }, { mode: 'always' }, { window_start: '25:00' }, { window_end: 'late' }]) assert.equal((await call('/api/admin/images/convert', { method: 'PUT', body: bad })).status, 400, JSON.stringify(bad));
  assert.equal((await call('/api/admin/images/convert', { method: 'PUT', body: { mode: 'overnight', window_start: '01:30', window_end: '05:00', keep_days: 7 } })).body.keep_days, 7);
  for (const [m, p] of [['GET', '/api/admin/images/convert'], ['PUT', '/api/admin/images/convert'], ['GET', '/api/admin/images/convert/estimate'], ['POST', '/api/admin/images/convert/run'], ['POST', '/api/admin/images/convert/restore']]) assert.equal((await call(p, { token: memberTok, method: m, body: m === 'PUT' ? { keep_days: 3 } : undefined })).status, 403, p);
  await call('/api/admin/images/convert', { method: 'PUT', body: { mode: 'off', keep_days: 14 } });
});

test('only pictures inside storage are candidates, and the estimate changes nothing', async () => {
  const c = job.candidates().map((x) => x.abs);
  assert.ok(c.includes(files.shared) && c.includes(files.jpg) && c.includes(files.spine) && c.includes(files.phys) && c.includes(files.media));
  assert.ok(!c.includes(files.outside), 'a file in the person\'s own folder is never touched');
  const e = await call('/api/admin/images/convert/estimate');
  assert.equal(e.status, 200); assert.ok(e.body.pictures >= 6 && e.body.estimated_saving_pct > 20 && e.body.would_convert_pct > 0);
  assert.ok(fs.readFileSync(files.shared).equals(files.sharedBytes) && !fs.existsSync(path.join(TMP, 'storage', 'image-originals')), 'nothing changed');
});

test('outside its window a scheduled run does not start; Run now does, and replaces the pictures safely', async () => {
  const now = new Date(), hh = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const later = (h) => new Date(now.getTime() + h * 3600_000);
  await call('/api/admin/images/convert', { method: 'PUT', body: { mode: 'overnight', window_start: hh(later(2)), window_end: hh(later(3)) } });
  assert.equal(job.startJob().running, false, 'closed window: no run');
  assert.ok(fs.readFileSync(files.shared).equals(files.sharedBytes));
  await call('/api/admin/images/convert', { method: 'PUT', body: { mode: 'off' } });

  const r = await call('/api/admin/images/convert/run', { method: 'POST' });
  assert.equal(r.status, 200);
  await job.jobIdle();
  const st = (await call('/api/admin/images/convert')).body;
  assert.equal(st.running, false); assert.ok(st.converted >= 5, `converted ${st.converted}`); assert.ok(st.skipped >= 1, 'the tiny one is left as it was'); assert.equal(st.failed, 0);

  // the shared cover: one new file, both games point at it, the original moved (not deleted)
  const root = path.join(TMP, 'storage');
  const sharedWebp = files.shared.replace(/\.png$/, '.webp');
  assert.ok(fs.existsSync(sharedWebp) && !fs.existsSync(files.shared));
  assert.equal(db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(ids.a).cover_path, sharedWebp);
  assert.equal(db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(ids.b).cover_path, sharedWebp);
  const kept = path.join(root, 'image-originals', 'covers', 'shared.png');
  assert.ok(fs.readFileSync(kept).equals(files.sharedBytes), 'the original is kept, byte for byte');
  assert.ok(fs.statSync(sharedWebp).size < files.sharedBytes.length * 0.9);
  const meta = await sharp(sharedWebp).metadata(); assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 700, 980]);
  // every other kind of reference
  assert.equal(db.prepare('SELECT path, type FROM rom_files WHERE rom_id = ?').get(ids.a).path, files.spine.replace(/\.png$/, '.webp'));
  assert.equal(db.prepare('SELECT type FROM rom_files WHERE rom_id = ?').get(ids.a).type, 'image/webp');
  assert.equal(db.prepare("SELECT cover_path FROM physical_games WHERE dedupe_key = 'bx'").get().cover_path, files.phys.replace(/\.png$/, '.webp'));
  assert.equal(JSON.parse(db.prepare('SELECT provider_media FROM roms WHERE id = ?').get(ids.media).provider_media).box2d.path, files.media.replace(/\.png$/, '.webp'));
  assert.equal(db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(ids.jpg).cover_path, files.jpg.replace(/\.jpg$/, '.webp'));
  // untouched: the skipped one and the one outside storage
  assert.ok(fs.readFileSync(files.tiny).equals(files.tinyBytes)); assert.ok(fs.readFileSync(files.outside).equals(files.outsideBytes));
  assert.equal(db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(ids.out).cover_path, files.outside);
  assert.ok(db.prepare('SELECT 1 FROM image_skips WHERE path = ?').get(files.tiny), 'a picture that would not shrink is remembered');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_conversions WHERE restored_at IS NULL').get().n, st.converted);

  // the app serves it
  const cover = await call(`/api/roms/${ids.a}/cover`);
  assert.equal(cover.status, 200); assert.equal(cover.type, 'image/webp');
  const thumb = await call(`/api/roms/${ids.a}/cover?w=320`, { headers: { Accept: 'image/webp' } });
  assert.equal((await sharp(thumb.body).metadata()).width, 320, 'a converted picture still gets tile thumbnails');
  const spine = await call(`/api/roms/${ids.a}/file/spine`);
  assert.equal(spine.type, 'image/webp');

  // a second run has nothing to do (the skipped one is not tried again)
  const again = job.startJob({ forced: true });
  await job.jobIdle();
  assert.equal(again.total, 0);
});

test('Put the originals back undoes everything', async () => {
  const r = await call('/api/admin/images/convert/restore', { method: 'POST' });
  assert.equal(r.status, 200); assert.ok(r.body.restored >= 5); assert.equal(r.body.unavailable, 0);
  assert.ok(fs.readFileSync(files.shared).equals(files.sharedBytes), 'byte-identical');
  assert.ok(fs.readFileSync(files.jpg).equals(files.jpgBytes));
  assert.ok(!fs.existsSync(files.shared.replace(/\.png$/, '.webp')));
  assert.equal(db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(ids.a).cover_path, files.shared);
  assert.equal(db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(ids.b).cover_path, files.shared);
  assert.equal(db.prepare('SELECT type FROM rom_files WHERE rom_id = ?').get(ids.a).type, 'image/png');
  assert.equal(JSON.parse(db.prepare('SELECT provider_media FROM roms WHERE id = ?').get(ids.media).provider_media).box2d.path, files.media);
  assert.equal((await call(`/api/roms/${ids.a}/cover`)).type, 'image/png');
});

test('originals are removed after the days chosen, and then the conversion is final', async () => {
  await call('/api/admin/images/convert/run', { method: 'POST' }); await job.jobIdle();
  const kept = path.join(TMP, 'storage', 'image-originals', 'covers', 'shared.png');
  assert.ok(fs.existsSync(kept));
  await call('/api/admin/images/convert', { method: 'PUT', body: { keep_days: 1 } });
  assert.equal(job.purgeOriginals(Date.now() + 3 * 86400_000).purged >= 5, true);
  assert.ok(!fs.existsSync(kept));
  assert.ok(fs.existsSync(files.shared.replace(/\.png$/, '.webp')), 'the WebP stays');
  const r = await call('/api/admin/images/convert/restore', { method: 'POST' });
  assert.equal(r.body.restored, 0); assert.ok(r.body.unavailable >= 5, 'nothing to put back once the originals are gone');
  assert.equal((await call(`/api/roms/${ids.a}/cover`)).type, 'image/webp', 'and the library still works');
});

test('a trial run stops after the number of pictures asked for', async () => {
  const mk = async (n) => { const f = path.join(COVER_DIR, `trial-${n}.png`); fs.writeFileSync(f, await noisy(500, 700, 100 + n * 10).png().toBuffer()); addRom(`Trial ${n}`, `wt${n}`, f); return f; };
  const t = [await mk(1), await mk(2), await mk(3)];
  const r = await call('/api/admin/images/convert/run', { method: 'POST', body: { limit: 2 } });
  assert.equal(r.status, 200); assert.equal(r.body.limit, 2);
  await job.jobIdle();
  const st = (await call('/api/admin/images/convert')).body;
  assert.equal(st.converted, 2); assert.equal(st.limit_reached, true);
  const done = t.filter((f) => fs.existsSync(f.replace(/\.png$/, '.webp')));
  assert.equal(done.length, 2, 'exactly two were converted');
  assert.equal(t.filter((f) => fs.existsSync(f)).length, 1, 'the third is still the original, waiting');
  // the next run (no limit) carries on with the rest
  await call('/api/admin/images/convert/run', { method: 'POST', body: {} }); await job.jobIdle();
  const after = (await call('/api/admin/images/convert')).body;
  assert.equal(after.converted, 1); assert.equal(after.limit, 0); assert.equal(after.limit_reached, false);
  assert.ok(t.every((f) => !fs.existsSync(f)));
});

test('Keep until I remove them: nothing is purged automatically, and a button removes them on request', async () => {
  const set = await call('/api/admin/images/convert', { method: 'PUT', body: { keep_forever: true, keep_days: 1 } });
  assert.equal(set.body.keep_forever, true);
  const kept = db.prepare('SELECT kept_path FROM image_conversions WHERE restored_at IS NULL AND purged_at IS NULL AND kept_path IS NOT NULL').all().map((r) => r.kept_path);
  assert.ok(kept.length >= 3 && kept.every((k) => fs.existsSync(k)));
  const p = job.purgeOriginals(Date.now() + 400 * 86400_000);
  assert.equal(p.purged, 0); assert.equal(p.kept_by_choice, true);
  assert.ok(kept.every((k) => fs.existsSync(k)), 'still there a year on');
  assert.equal((await call('/api/admin/images/convert', { token: memberTok, method: 'POST' })).status !== 200, true);
  assert.equal((await call('/api/admin/images/convert/remove-originals', { token: memberTok, method: 'POST' })).status, 403);
  const rm = await call('/api/admin/images/convert/remove-originals', { method: 'POST' });
  assert.equal(rm.status, 200); assert.equal(rm.body.removed, kept.length); assert.ok(rm.body.bytes > 0);
  assert.ok(kept.every((k) => !fs.existsSync(k)));
  assert.equal(rm.body.originals_kept, 0);
  // the WebP pictures are untouched and the library still serves them
  assert.equal((await call(`/api/roms/${ids.a}/cover`)).type, 'image/webp');
  // back to days
  assert.equal((await call('/api/admin/images/convert', { method: 'PUT', body: { keep_forever: false } })).body.keep_forever, false);
});

test('the converted-pictures list names the game and picture, and lets the admin compare before and after', async () => {
  const f = path.join(COVER_DIR, 'report-me.png'); const bytes = await noisy(520, 720, 140).png().toBuffer(); fs.writeFileSync(f, bytes);
  addRom('Report Me', 'wr1', f);
  await call('/api/admin/images/convert/run', { method: 'POST', body: {} }); await job.jobIdle();
  const log = await call('/api/admin/images/convert/log?q=report-me');
  assert.equal(log.status, 200); assert.equal(log.body.total, 1);
  const it = log.body.items[0];
  assert.equal(it.title, 'Report Me'); assert.equal(it.kind, 'cover'); assert.equal(it.list, 'ROM Library'); assert.equal(it.platform, 'Super Nintendo');
  assert.equal(it.state, 'converted'); assert.equal(it.can_compare, true); assert.ok(it.saving_pct > 20 && it.old_bytes === bytes.length);
  // before and after
  const before = await call(`/api/admin/images/convert/log/${it.id}/original`);
  assert.equal(before.status, 200); assert.ok(before.body.equals(bytes), 'the original, byte for byte');
  const now = await call(`/api/admin/images/convert/log/${it.id}/webp`);
  assert.equal((await sharp(now.body).metadata()).format, 'webp');
  // the state filter and paging
  const all = await call('/api/admin/images/convert/log?limit=2');
  assert.equal(all.body.items.length, 2); assert.ok(all.body.total > 2);
  assert.ok((await call('/api/admin/images/convert/log?state=converted&limit=100')).body.items.every((i) => i.state === 'converted'));
  assert.ok((await call('/api/admin/images/convert/log?state=final&limit=100')).body.items.every((i) => i.state === 'final'), 'pictures whose original is gone are final');
  assert.ok((await call('/api/admin/images/convert/log?q=no-such-file')).body.total === 0);
  // search by the game's name, not only the file's: partial, any case, covers its other pictures and the games that share a picture
  const byName = async (q) => (await call(`/api/admin/images/convert/log?limit=100&q=${encodeURIComponent(q)}`)).body.items;
  assert.deepEqual((await byName('REPORT m')).map((i) => i.title), ['Report Me'], 'by title, any case, partial');
  assert.ok((await byName('shared a')).some((i) => i.kind === 'spine') && (await byName('shared a')).some((i) => i.kind === 'cover'), "a game's cover and its spine");
  assert.ok((await byName('shared b')).some((i) => i.kind === 'cover'), 'the other game that shares the cover finds it too');
  assert.ok((await byName('boxed')).some((i) => i.list === 'Physical'), 'a Physical game by its title');
  assert.ok((await byName('media')).some((i) => i.kind === 'provider picture'), "a provider's picture by the game's title");
  assert.equal((await byName('zzz no such game')).length, 0);
  // admin only
  for (const p of ['/api/admin/images/convert/log', `/api/admin/images/convert/log/${it.id}/original`]) assert.equal((await call(p, { token: memberTok })).status, 403, p);
  assert.equal((await call(`/api/admin/images/convert/log/${it.id}/other`)).status, 404);
  // once the original is removed there is nothing to compare, and the list says so
  await call('/api/admin/images/convert/remove-originals', { method: 'POST' });
  assert.equal((await call(`/api/admin/images/convert/log/${it.id}/original`)).status, 404);
  const after = (await call('/api/admin/images/convert/log?q=report-me')).body.items[0];
  assert.equal(after.state, 'final'); assert.equal(after.can_compare, false);
  // a put-back picture is listed as put back
  const f2 = path.join(COVER_DIR, 'report-two.png'); fs.writeFileSync(f2, await noisy(520, 720, 60).png().toBuffer()); addRom('Report Two', 'wr2', f2);
  await call('/api/admin/images/convert/run', { method: 'POST', body: {} }); await job.jobIdle();
  await call('/api/admin/images/convert/restore', { method: 'POST' });
  const back = (await call('/api/admin/images/convert/log?q=report-two')).body.items[0];
  assert.equal(back.state, 'restored'); assert.equal(back.title, 'Report Two');
});

test('the progress bar and the list are wired into the Pictures panel', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['imgc-box', 'imgc-bar', 'imgc-pct', 'imgc-log-box', 'imgc-compare']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.indexOf('id="imgc-msg"') < html.indexOf('id="imgc-status"'), 'the status box sits below the buttons');
  assert.match(app, /function loadImageLog\(\)/); assert.match(app, /about \$\{span\(left\)\} left/);
});
