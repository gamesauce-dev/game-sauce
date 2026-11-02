import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-hidegames-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'hadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'h-admin-password-1';

let server, base, db, tok, memberTok, dirA, dirB, srcA, srcB;
const call = async (p, { method = 'GET', body, token } = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || tok) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok = await login('hadmin', 'h-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'hmember', password: 'h-member-password-1', role: 'user' } });
  memberTok = await login('hmember', 'h-member-password-1');
  dirA = path.join(TMP, 'genesis'); dirB = path.join(TMP, 'snes'); fs.mkdirSync(dirA); fs.mkdirSync(dirB);
  fs.writeFileSync(path.join(dirA, 'Alpha Sega (USA).md'), 'alpha-bytes-'.repeat(8));
  fs.writeFileSync(path.join(dirA, 'Beta Sega (USA).md'), 'beta-bytes-'.repeat(8));
  fs.writeFileSync(path.join(dirB, 'Gamma Nintendo (USA).sfc'), 'gamma-bytes-'.repeat(8));
  srcA = (await call('/api/sources', { method: 'POST', body: { name: 'genesis', path: dirA, platform_hint: 'genesis' } })).body.id;
  srcB = (await call('/api/sources', { method: 'POST', body: { name: 'snes', path: dirB, platform_hint: 'snes' } })).body.id;
  await call(`/api/sources/${srcA}/scan`, { method: 'POST', body: {} });
  await call(`/api/sources/${srcB}/scan`, { method: 'POST', body: {} });
});
after(async () => { await new Promise((r) => server?.close(r)); db?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

const titles = async (token, q = '') => (await call('/api/roms?limit=100' + q, { token })).body.items.map((r) => r.title).sort();
const counts = async (token) => Object.fromEntries((await call('/api/platforms', { token })).body.items.filter((p) => p.count || p.visible_count).map((p) => [p.slug, p.visible_count]));

test('Hide games leaves a source out of the list, search, counts and Home for everyone; Show games brings it back; nothing is deleted', async () => {
  assert.deepEqual(await titles(tok), ['Alpha Sega', 'Beta Sega', 'Gamma Nintendo']);
  const r = await call(`/api/sources/${srcA}`, { method: 'PATCH', body: { hide_games: true } });
  assert.equal(r.status, 200); assert.equal(r.body.hide_games, true); assert.equal(r.body.enabled, true, 'scanning is a separate switch');
  for (const t of [tok, memberTok]) {
    assert.deepEqual(await titles(t), ['Gamma Nintendo'], 'gone from the list');
    assert.deepEqual(await titles(t, '&q=Alpha'), [], 'gone from search');
  }
  assert.equal((await counts(tok)).genesis || 0, 0, 'gone from the platform counts (admin)');
  assert.equal((await counts(memberTok)).genesis || 0, 0, 'and for a member');
  assert.equal((await call('/api/stats', { token: memberTok })).body.library.roms, 1, 'and the Home totals');
  assert.equal((await call('/api/stats')).body.recent.every((x) => x.title === 'Gamma Nintendo'), true, 'and the Recently added row');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM roms').get().n, 3, 'nothing was deleted');
  // a member opening one directly gets "not found"; an admin still can
  const id = db.prepare("SELECT id FROM roms WHERE title = 'Alpha Sega'").get().id;
  assert.equal((await call(`/api/roms/${id}`, { token: memberTok })).status, 404);
  assert.equal((await call(`/api/roms/${id}`)).status, 200);
  // the admin finds them under Hidden
  assert.deepEqual(await titles(tok, '&hidden=only'), ['Alpha Sega', 'Beta Sega']);
  // show again
  await call(`/api/sources/${srcA}`, { method: 'PATCH', body: { hide_games: false } });
  assert.deepEqual(await titles(memberTok), ['Alpha Sega', 'Beta Sega', 'Gamma Nintendo']);
  assert.equal((await counts(tok)).genesis, 2);
});

test('hiding and scanning are independent: a paused source still shows its games, and a hiding source can still be scanned', async () => {
  await call(`/api/sources/${srcB}`, { method: 'PATCH', body: { enabled: false } });
  assert.deepEqual(await titles(memberTok, '&platform=snes'), ['Gamma Nintendo'], 'paused scanning does not hide anything');
  await call(`/api/sources/${srcB}`, { method: 'PATCH', body: { enabled: true, hide_games: true } });
  fs.writeFileSync(path.join(dirB, 'Delta Nintendo (USA).sfc'), 'delta-bytes-'.repeat(8));
  await call(`/api/sources/${srcB}/scan`, { method: 'POST', body: {} });
  assert.equal(db.prepare("SELECT source_hidden FROM roms WHERE title = 'Delta Nintendo'").get().source_hidden, 1, 'a game a scan adds to a hiding source starts hidden');
  assert.deepEqual(await titles(memberTok, '&platform=snes'), []);
  await call(`/api/sources/${srcB}`, { method: 'PATCH', body: { hide_games: false } });
  assert.deepEqual(await titles(memberTok, '&platform=snes'), ['Delta Nintendo', 'Gamma Nintendo']);
});

test('removing a source clears its hide mark, so kept games are not hidden by a source that no longer exists', async () => {
  await call(`/api/sources/${srcA}`, { method: 'PATCH', body: { hide_games: true } });
  assert.equal((await call(`/api/sources/${srcA}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM roms WHERE source_hidden = 1').get().n, 0);
  assert.ok((await titles(memberTok)).includes('Alpha Sega'), 'the kept games are visible again (as "no source")');
});

test('the Sources page has the Hide games switch and the pills say what they mean', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), js = fs.readFileSync(new URL('../public/modern.js', import.meta.url), 'utf8');
  assert.match(app, /data-act="hidegames"/); assert.match(app, /scanning paused/); assert.match(app, /games hidden/); assert.match(app, /hide_games: hiding/);
  assert.match(js, /data-act="hidegames"\]\[data-hidden="0"\]', 'hidden'/); assert.match(js, /data-act="hidegames"\]\[data-hidden="1"\]', 'visible'/);
});
