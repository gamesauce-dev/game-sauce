import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-emulatest-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'eadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'e-admin-password-1';

let db, mod, realFetch, calls, mode;
const release = { tag_name: 'v9', name: 'Nine', published_at: '2026-01-01T00:00:00Z', html_url: 'https://x/y', assets: [{ name: 'win.zip', size: 10, download_count: 1, browser_download_url: 'https://x/win.zip' }] };

before(async () => {
  await import('../src/app.js');
  db = (await import('../src/db.js')).default;
  mod = await import('../src/routes/emulators.js');
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!String(url).includes('api.github.com')) return realFetch(url);
    calls++;
    if (mode === 'limited') return new Response('{}', { status: 403, headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) } });
    return new Response(JSON.stringify(release), { status: 200 });
  };
});
after(() => { globalThis.fetch = realFetch; db?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('a good answer is kept: the second ask does not go to GitHub', async () => {
  mod._resetReleaseCache(); calls = 0; mode = 'ok';
  const a = await mod.fetchLatestRelease('o/r1'); const b = await mod.fetchLatestRelease('o/r1');
  assert.equal(a.payload.assets.length, 1); assert.equal(b.cached, true); assert.equal(calls, 1);
});

test('the answer survives a restart (stored copy)', async () => {
  mod._resetReleaseCache(); calls = 0;
  const r = await mod.fetchLatestRelease('o/r1');   // memory emptied, database copy used
  assert.equal(r.cached, true); assert.equal(calls, 0); assert.equal(r.payload.tag, 'v9');
});

test('when GitHub says slow down, the last good answer is still shown and nothing more is sent', async () => {
  mod._resetReleaseCache(); calls = 0; mode = 'limited';
  const r = await mod.fetchLatestRelease('o/r1', { manual: true }); // forced fresh: answer is older than 10 min? no (just stored), so cached
  assert.equal(r.payload.tag, 'v9');
  db.prepare("UPDATE metadata_cache SET fetched_at = datetime('now', '-1 hour') WHERE key = 'ghrel:o/r1'").run();
  mod._resetReleaseCache();
  const s = await mod.fetchLatestRelease('o/r1', { manual: true });
  assert.equal(s.payload.tag, 'v9', 'stale answer rather than nothing'); assert.match(s.stale, /limiting requests/);
  const before = calls;
  await mod.fetchLatestRelease('o/r1', { manual: true }); await mod.fetchLatestRelease('o/r2');
  assert.equal(calls, before, 'GitHub is not asked again until its time is up');
  const none = await mod.fetchLatestRelease('o/never-seen');
  assert.match(none.missing, /limiting requests/, 'a repo with no stored answer gets the real reason');
});
