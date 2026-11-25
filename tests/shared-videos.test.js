// A game's videos are shared by everyone. A member's import may give a video to a game that has none, but only an admin's may change one.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-sharedvid-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'svadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'sv-admin-password-1';

const ART = path.join(TMP, 'art');
let server, base, db, admin, member, game;
const call = async (p, { token = admin, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* a video */ }
  return { status: res.status, text, body: json };
};
const mp4 = (mark) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12), Buffer.from(mark)]);
const put = (rel, mark) => { const f = path.join(ART, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, mp4(mark)); return f; };
/** Preview, then import, as the pages do. */
const bring = async (token, body) => {
  const folder = (await call('/api/art/folders', { token })).body.folders[0].path;
  const preview = await call('/api/art/import', { token, method: 'POST', body: { folder, ...body } });
  assert.equal(preview.status, 200, preview.text);
  assert.equal((await call('/api/art/import', { token, method: 'POST', body: { folder, apply: true, ...body } })).status, 200);
  let job; for (let i = 0; i < 200; i++) { job = (await call('/api/art/import/status', { token })).body; if (!job.running) break; await new Promise((r) => setTimeout(r, 25)); }
  return { preview: preview.body, job };
};
const sees = async (theme = false) => (await call(`/api/videos/file?kind=rom&id=${game}${theme ? '&variant=theme' : ''}`, { token: member })).text.slice(24);
// Two videos for one game; with "cut at" a person can choose the other one.
const OTHER = { replace: true, kind: 'video', platform: 'snes', cut: ' ~' };

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  admin = await login('svadmin', 'sv-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'svmember', password: 'sv-member-pass-12', role: 'user' } });
  member = await login('svmember', 'sv-member-pass-12');
  game = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes) VALUES ('Plain Game', 'plain game', 'zzq9.sfc', (SELECT id FROM platforms WHERE slug = 'snes'), 'x', 1)").run().lastInsertRowid);
  put('snes/videos/Plain Game.mp4', 'FIRST');
  put('snes/videos/Plain Game ~outtake.mp4', 'OTHER');
  put('snes/theme/Plain Game.mp4', 'THEME-FIRST');
  put('snes/theme/Plain Game ~outtake.mp4', 'THEME-OTHER');
  await call('/api/art/folders', { method: 'PUT', body: { folders: [ART] } });
});
beforeEach(() => { db.prepare('DELETE FROM game_videos').run(); db.prepare('DELETE FROM theme_videos').run(); });
after(async () => {
  server?.closeAllConnections(); await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('a member can give a video to a game that has none', async () => {
  const { job } = await bring(member, { target: 'video' });
  assert.equal(job.failed, 0, JSON.stringify(job));
  assert.equal(await sees(), 'FIRST'); assert.equal(await sees(true), 'THEME-FIRST');
});

test('no kind of import lets a member change a video that is there', async () => {
  await bring(admin, { target: 'video' });
  for (const target of ['video', 'physical', 'digital', 'both', 'something-else']) {
    for (const kind of ['video', 'theme']) {
      const { preview, job } = await bring(member, { ...OTHER, target, kind });
      assert.equal(preview.will[kind] || 0, 0, `${target} ${kind}: the preview offers nothing`);
      assert.equal(job.applied[kind] || 0, 0, `${target} ${kind}`);
    }
    assert.equal(await sees(), 'FIRST', target); assert.equal(await sees(true), 'THEME-FIRST', target);
  }
  // sending the server's own word for it changes nothing
  await bring(member, { ...OTHER, target: 'video', admin: true });
  assert.equal(await sees(), 'FIRST');
});

test('an admin can still replace both kinds, and only when asked', async () => {
  await bring(admin, { target: 'video' });
  await bring(admin, { ...OTHER, target: 'video', replace: false });
  assert.equal(await sees(), 'FIRST', 'not without Replace');
  await bring(admin, { ...OTHER, target: 'video' });
  assert.match(await sees(), /OTHER$/);   // forcing a kind takes every file for that kind, so either folder's other file may be picked
  await bring(admin, { ...OTHER, target: 'video', kind: 'theme' });
  assert.match(await sees(true), /OTHER$/);
});

test("a video that arrives while a member's import is waiting is kept", async () => {
  const { planArtImport, scanArtFolder, startArtImport, artJobIdle, artJobStatus } = await import('../src/lib/artimport.js');
  const { setThemeVideo } = await import('../src/lib/themevideos.js');
  const memberId = db.prepare("SELECT id FROM users WHERE username = 'svmember'").get().id;
  assert.equal(planArtImport(memberId, await scanArtFolder(ART, { fresh: true }), { target: 'video' }).will.video, 1, 'nothing there when it is planned');
  const started = startArtImport(memberId, { target: 'video', folder: ART });
  // someone else's arrive after the plan is made and before the files are written
  await started;
  db.prepare('DELETE FROM game_videos').run(); db.prepare('DELETE FROM theme_videos').run();
  const theirs = put('theirs.mp4', 'THEIRS');
  db.prepare("INSERT INTO game_videos (platform, title_key, path, bytes, source, fetched_at, tried_at) VALUES ('snes', 'plain game', ?, 1, 'folder', datetime('now'), datetime('now'))").run(theirs);
  setThemeVideo('snes', 'plain game', theirs, 1);
  await artJobIdle(memberId);
  assert.equal(await sees(), 'THEIRS', JSON.stringify(artJobStatus(memberId))); assert.equal(await sees(true), 'THEIRS');
});
