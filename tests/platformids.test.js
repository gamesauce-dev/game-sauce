import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nameScore, candidatesFor, judge, buildReport } from '../src/lib/platformids.js';

test('console names are compared sensibly (case, brackets, wording) and numbers matter', () => {
  assert.equal(nameScore('Nintendo 64', 'nintendo 64 (N64)'), 100);
  assert.ok(nameScore('Super Nintendo', 'Super Nintendo Entertainment System') >= 75);
  assert.ok(nameScore('Sony PlayStation 2', 'Sony PlayStation 3') < 40, 'PS2 is not PS3');
  assert.ok(nameScore('Sega Genesis', 'Sega Mega Drive') < 75, 'different words are not guessed alike');
  assert.equal(nameScore('', 'x'), 0);
});

const LIST = [{ id: 3, name: 'Nintendo Entertainment System' }, { id: 4, name: 'Super Nintendo Entertainment System' }, { id: 1, name: 'Mega Drive', alias: 'Sega Genesis' }, { id: 58, name: 'Sony PlayStation 2' }, { id: 59, name: 'Sony PlayStation 3' }, { id: 9, name: 'Game Boy' }];
const P = (name, short_name) => ({ name, short_name });

test('judge: ok / missing / unresolved / suspicious, with a suggestion by name', () => {
  assert.equal(judge(P('Nintendo Entertainment System', 'NES'), 3, LIST).status, 'ok');
  const miss = judge(P('Super Nintendo', 'SNES'), null, LIST);
  assert.equal(miss.status, 'missing'); assert.equal(miss.suggestion.id, 4); assert.equal(miss.confident, true);
  const gone = judge(P('Game Boy', 'GB'), 999, LIST);
  assert.equal(gone.status, 'unresolved'); assert.equal(gone.suggestion.id, 9);
  const wrong = judge(P('Sony PlayStation 2', 'PS2'), 59, LIST);
  assert.equal(wrong.status, 'suspicious'); assert.equal(wrong.suggestion.id, 58); assert.equal(wrong.current.name, 'Sony PlayStation 3');
  assert.equal(judge(P('Atari Jaguar', 'JAG'), null, LIST).suggestion, null, 'nothing close: no guess');
  assert.equal(candidatesFor(P('Sega Genesis', 'GEN'), LIST)[0].id, 1, 'the provider\'s alias is used too');
});

test('buildReport lists only what needs a look, and counts everything', () => {
  const plats = [{ slug: 'nes', name: 'Nintendo Entertainment System', short_name: 'NES', screenscraper_id: 3 }, { slug: 'snes', name: 'Super Nintendo', short_name: 'SNES', screenscraper_id: null }];
  const r = buildReport(plats, { screenscraper: { list: LIST, field: 'screenscraper_id' } });
  assert.equal(r.counts.screenscraper.ok, 1); assert.equal(r.counts.screenscraper.missing, 1);
  assert.equal(r.rows.length, 1); assert.equal(r.rows[0].slug, 'snes'); assert.equal(r.rows[0].field, 'screenscraper_id');
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-pid-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'padmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'p-admin-password-1';
let server, base, db, tok, memberTok, realFetch;
const call = async (p, { method = 'GET', body, token } = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || tok) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
before(async () => {
  process.env.TGDB_API_KEY = 'test-key';
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('api.thegamesdb.net/v1/Platforms')) return new Response(JSON.stringify({ code: 200, data: { count: 3, platforms: { 7: { id: 7, name: 'Nintendo Entertainment System (NES)', alias: 'nes' }, 6: { id: 6, name: 'Super Nintendo (SNES)', alias: 'snes' }, 18: { id: 18, name: 'Sega Genesis', alias: 'sega-genesis' } } } }), { status: 200 });
    return realFetch(url, opt);
  };
  const login = async (u, p) => (await (await realFetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok = await login('padmin', 'p-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'pmember', password: 'p-member-password-1', role: 'user' } });
  memberTok = await login('pmember', 'p-member-password-1');
});
after(async () => { globalThis.fetch = realFetch; delete process.env.TGDB_API_KEY; await new Promise((r) => server?.close(r)); db?.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('platform-ids route: admin only, checks TheGamesDB against its list, suggests, and changes nothing by itself', async () => {
  assert.equal((await call('/api/metadata/platform-ids', { token: memberTok })).status, 403);
  db.prepare("UPDATE platforms SET tgdb_id = NULL WHERE slug = 'snes'").run();
  db.prepare("UPDATE platforms SET tgdb_id = 999 WHERE slug = 'nes'").run();
  const r = await call('/api/metadata/platform-ids');
  assert.equal(r.status, 200); assert.deepEqual(r.body.providers, ['thegamesdb']);
  assert.ok(r.body.notes.some((n) => /ScreenScraper is not set up/.test(n)), 'says what it could not check');
  const snes = r.body.rows.find((x) => x.slug === 'snes' && x.provider === 'thegamesdb');
  assert.equal(snes.status, 'missing'); assert.equal(snes.suggestion.id, 6);
  const nes = r.body.rows.find((x) => x.slug === 'nes' && x.provider === 'thegamesdb');
  assert.equal(nes.status, 'unresolved'); assert.equal(nes.suggestion.id, 7);
  assert.equal(db.prepare("SELECT tgdb_id FROM platforms WHERE slug = 'snes'").get().tgdb_id, null, 'the check wrote nothing');
  // accepting a suggestion is an ordinary platform edit
  assert.equal((await call('/api/platforms/snes', { method: 'PATCH', body: { tgdb_id: snes.suggestion.id } })).status, 200);
  assert.equal(db.prepare("SELECT tgdb_id FROM platforms WHERE slug = 'snes'").get().tgdb_id, 6);
});

test('page: Verify shows suggestions with a Use button; the slug field explains itself and fills from the name', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="pid-report"/); assert.match(html, /It cannot be changed later/);
  assert.match(app, /async function verifyPlatformIds\(\)/); assert.match(app, /data-pid-use/); assert.match(app, /\/metadata\/platform-ids/);
  assert.match(app, /slugIn\.value = nameIn\.value\.toLowerCase\(\)/);
});

test('an entry with exactly our name beats one that only reads the same without its brackets, and the Xbox 360 default is ScreenScraper 33', async () => {
  const { judge } = await import('../src/lib/platformids.js');
  const { PLATFORMS } = await import('../src/lib/platforms.js');
  const x360 = PLATFORMS.find((p) => p.slug === 'xbox360');
  assert.equal(x360.screenscraper, 33);
  const list = [{ id: 56, name: 'Xbox 360 (Arcade)' }, { id: 33, name: 'Xbox 360' }];
  const wrong = judge({ name: 'Xbox 360', short_name: 'X360' }, 56, list);
  assert.equal(wrong.status, 'suspicious'); assert.equal(wrong.suggestion.id, 33); assert.equal(wrong.confident, true);
  assert.equal(judge({ name: 'Xbox 360', short_name: 'X360' }, 33, list).status, 'ok');
  // a platform whose own name matches nothing exactly is judged as before
  assert.equal(judge({ name: 'Sega Genesis', short_name: 'GEN' }, 1, [{ id: 1, name: 'Sega Genesis / Mega Drive' }]).status, 'ok');
});
