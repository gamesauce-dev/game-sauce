import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-adminhide-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'aadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'a-admin-password-1';

let server, base, db, adminTok, memberTok, meta;
const call = async (p, { token = adminTok, method = 'GET', body } = {}) => {
  if (p.startsWith('/api/admin/duplicates')) (await import('../src/lib/duplicates.js')).clearDuplicateCache();
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (u, p) => (await call('/api/auth/login', { token: null, method: 'POST', body: { username: u, password: p } })).body.token;
const titles = (r) => r.body.items.map((i) => i.title).sort();
let n = 0;
const rom = (filename, slug = 'genesis') => {
  const parsed = meta.parseFilename(filename);
  return Number(db.prepare(`INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1)
    VALUES ((SELECT id FROM platforms WHERE slug = ?), ?, ?, ?, ?, 3, ?)`).run(slug, parsed.title, meta.sortTitle(parsed.title), filename, `/nowhere/${filename}`, `ah${String(++n).padStart(6, '0')}`).lastInsertRowid);
};

before(async () => {
  meta = await import('../src/lib/metadata.js');
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminTok = await login('aadmin', 'a-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'amember', password: 'a-member-pass-12', role: 'user' } });
  memberTok = await login('amember', 'a-member-pass-12');
});
after(async () => {
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

test('an admin\'s Hide hides the game from members too; only admins see it, under Hidden', async () => {
  const a = rom('Alpha Game (USA).md'), b = rom('Beta Game (USA).md');
  assert.equal((await call(`/api/roms/${a}/hide`, { method: 'POST', body: {} })).body.hidden, 1);
  assert.deepEqual(titles(await call('/api/roms?limit=50', { token: memberTok })), ['Beta Game'], 'the member no longer sees it');
  assert.equal((await call(`/api/roms/${a}`, { token: memberTok })).status, 404, 'nor can they open it');
  assert.deepEqual(titles(await call('/api/roms?limit=50')), ['Beta Game'], 'it leaves the admin\'s own library too');
  assert.deepEqual(titles(await call('/api/roms?limit=50&hidden=1')), ['Alpha Game'], 'the admin finds it under Hidden');
  const one = (await call(`/api/roms/${a}`)).body;
  assert.equal(one.hidden, 1, 'and it shows as hidden for the admin');
  assert.equal((await call(`/api/roms/${a}/hide`, { method: 'POST', body: {} })).body.hidden, 0, 'the same button brings it back');
  assert.deepEqual(titles(await call('/api/roms?limit=50', { token: memberTok })), ['Alpha Game', 'Beta Game']);
  // the bulk route does the same
  await call('/api/roms/bulk/hide', { method: 'POST', body: { ids: [a, b], hidden: true } });
  assert.deepEqual(titles(await call('/api/roms?limit=50', { token: memberTok })), []);
  await call('/api/roms/bulk/hide', { method: 'POST', body: { ids: [a, b], hidden: false } });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM roms WHERE hidden_all = 1').get().n, 0);
});

test('a member\'s Hide still only changes their own view', async () => {
  const c = rom('Gamma Game (USA).md');
  await call(`/api/roms/${c}/hide`, { token: memberTok, method: 'POST', body: {} });
  assert.equal(db.prepare('SELECT hidden_all FROM roms WHERE id = ?').get(c).hidden_all, 0);
  assert.ok(titles(await call('/api/roms?limit=50')).includes('Gamma Game'), 'the admin still sees it');
  assert.ok(!titles(await call('/api/roms?limit=50', { token: memberTok })).includes('Gamma Game'));
});

test('the duplicate finder does not list games that are hidden', async () => {
  const x = rom('Delta Quest (USA).md'), y = rom('Delta Quest (Europe).md');
  assert.equal((await call('/api/admin/duplicates')).body.groups.some((g) => g.title === 'Delta Quest'), true);
  await call('/api/roms/bulk/hide', { method: 'POST', body: { ids: [y], hidden: true } });
  assert.equal((await call('/api/admin/duplicates')).body.groups.some((g) => g.title === 'Delta Quest'), false, 'one copy left: no longer a duplicate');
  await call('/api/roms/bulk/hide', { method: 'POST', body: { ids: [x, y], hidden: false } });
});

test('volumes of one compilation are not duplicates ("Mega Games 6 Vol. 1/2/3")', async () => {
  assert.equal(meta.parseFilename('Mega Games 6 Vol. 1 (Europe).zip').title, 'Mega Games 6 Vol. 1');
  assert.equal(meta.parseFilename('Mega Games 6 Vol. 3 (Europe).zip').title, 'Mega Games 6 Vol. 3');
  assert.equal(meta.parseFilename('Dr. Mario (USA).nes').title, 'Dr. Mario');
  assert.equal(meta.parseFilename('Sonic.The.Hedgehog.2.USA.md').title, 'Sonic The Hedgehog 2');
  for (const v of [1, 2, 3]) rom(`Mega Games 6 Vol. ${v} (Europe).zip`);
  const r = (await call('/api/admin/duplicates')).body;
  assert.equal(r.groups.some((g) => /mega games 6/i.test(g.title)), false);
});

test('database v22 carries games an admin hid earlier over to "hidden from everyone"', async () => {
  const z = rom('Zeta Game (USA).md');
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin'").get().id;
  db.prepare('INSERT OR IGNORE INTO hidden_roms (user_id, rom_id) VALUES (?, ?)').run(admin, z);
  db.prepare("UPDATE meta SET value = '21' WHERE key = 'schema_version'").run();
  const sql = fs.readFileSync(new URL('../src/migrations.js', import.meta.url), 'utf8');
  assert.match(sql, /v22/);
  db.exec("UPDATE roms SET hidden_all = 1 WHERE hidden_all = 0 AND id IN (SELECT hr.rom_id FROM hidden_roms hr JOIN users u ON u.id = hr.user_id WHERE u.role = 'admin')");
  assert.equal(db.prepare('SELECT hidden_all FROM roms WHERE id = ?').get(z).hidden_all, 1);
  assert.ok(!titles(await call('/api/roms?limit=50', { token: memberTok })).includes('Zeta Game'));
});

test('the library accepts several platforms at once (comma separated) and a single slug still works', async () => {
  rom('Chip One (USA).sfc', 'snes'); rom('Chip Two (USA).nes', 'nes'); rom('Chip Three (USA).md', 'genesis');
  const t = (q) => call(`/api/roms?limit=100&${q}`).then((r) => r.body.items.map((i) => i.title).filter((x) => x.startsWith('Chip')).sort());
  assert.deepEqual(await t('platform=snes'), ['Chip One'], 'one platform, as before');
  assert.deepEqual(await t('platform=snes,nes'), ['Chip One', 'Chip Two'], 'two platforms');
  assert.deepEqual(await t('platform=snes,nes,genesis'), ['Chip One', 'Chip Three', 'Chip Two']);
  assert.deepEqual(await t('platform=all'), ['Chip One', 'Chip Three', 'Chip Two'], 'all still means everything');
  assert.deepEqual(await t('platform=snes,,%20nes%20,'), ['Chip One', 'Chip Two'], 'stray commas and spaces are ignored');
  assert.deepEqual(await t('platform=nosuch,snes'), ['Chip One'], 'an unknown slug in the list matches nothing, it does not break the query');
});
