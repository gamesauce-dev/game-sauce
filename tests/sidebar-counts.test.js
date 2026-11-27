// The Library offers "No source" and "Needs match" only when there is something to show. It learns that from /api/stats, which must count
// the same games the two filtered lists hold.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-counts-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'cadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'c-admin-password-1';

let server, base, db, adminTok, memberTok;
const call = async (p, { token = adminTok, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (u, p) => (await call('/api/auth/login', { token: null, method: 'POST', body: { username: u, password: p } })).body.token;
const library = async (token) => (await call('/api/stats', { token })).body.library;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('cadmin', 'c-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'cmember', password: 'c-member-pass-12', role: 'user' } });
  memberTok = await login('cmember', 'c-member-pass-12');
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('an empty library has nothing without a source and nothing to match', async () => {
  const l = await library();
  assert.equal(l.orphaned, 0); assert.equal(l.never_enriched, 0);
});

test('the counts are the sizes of the two filtered lists, and a member is told nothing', async () => {
  const source = db.prepare("INSERT INTO sources (name, path, platform_hint) VALUES ('Shelf', ?, 'snes')").run(TMP).lastInsertRowid;
  const file = path.join(TMP, 'a.sfc'); fs.writeFileSync(file, 'rom');
  let n = 0;
  const ins = (title, { src = null, meta = null, system = 0, hiddenSource = 0, scanned = 1 } = {}) => db.prepare(`INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1, source_id, meta_source, is_system, source_hidden, in_place)
    VALUES ((SELECT id FROM platforms WHERE slug = 'snes'), ?, ?, ?, ?, 3, ?, ?, ?, ?, ?, ?)`).run(title, title.toLowerCase(), `${title}.sfc`, file, `cn00000${n++}`, src, meta, system, hiddenSource, scanned);
  ins('In a source, matched', { src: source, meta: 'screenscraper' });
  ins('In a source, name only', { src: source, meta: 'filename' });
  ins('No source, matched', { meta: 'screenscraper' });
  ins('No source, never looked up');
  ins('Added through Add ROMs', { scanned: 0, meta: 'screenscraper' });   // never had a source: not an orphan
  ins('A system file', { system: 1 });                 // the lists leave System items out
  ins('From a hidden source', { hiddenSource: 1 });    // the admin's lists keep it, though the totals leave it out

  const l = await library();
  for (const [field, query] of [['orphaned', 'orphan=only'], ['never_enriched', 'unmatched=only']]) {
    const list = (await call(`/api/roms?${query}&hidden=all&limit=50`)).body;
    assert.equal(l[field], list.total, field);
  }
  assert.equal(l.orphaned, 3); assert.equal(l.never_enriched, 3);

  const member = await library(memberTok);
  assert.equal(member.orphaned, 0); assert.equal(member.never_enriched, 0);
});
