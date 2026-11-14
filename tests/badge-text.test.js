import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-badge-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'badmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'b-admin-password-1';

let server, base, db, tok = {};
const call = async (p, { method = 'GET', body, as = 'admin' } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + tok[as], 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok.admin = await login('badmin', 'b-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'ann', password: 'ann-password-12', role: 'user' } });
  tok.ann = await login('ann', 'ann-password-12');
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

const ps4 = async () => (await call('/api/platforms')).body.items.find((p) => p.slug === 'ps4');

test('a platform can have its own badge text: set by an admin, trimmed to 12 characters, empty means the default, members cannot', async () => {
  assert.equal((await ps4()).badge, null, 'the default to begin with');
  const set = await call('/api/platforms/ps4', { method: 'PATCH', body: { badge: '  Play   Station 4  ' } });
  assert.equal(set.status, 200); assert.equal(set.body.badge, 'Play Station');   // spaces tidied, then cut at 12 characters
  assert.equal((await ps4()).badge, 'Play Station', 'and the list everyone reads carries it');
  const short = await call('/api/platforms/ps4', { method: 'PATCH', body: { badge: 'PS-4' } });
  assert.equal(short.body.badge, 'PS-4');
  assert.equal((await call('/api/platforms/ps4', { method: 'PATCH', as: 'ann', body: { badge: 'HACK' } })).status, 403);
  assert.equal((await ps4()).badge, 'PS-4', 'a member changed nothing');
  const cleared = await call('/api/platforms/ps4', { method: 'PATCH', body: { badge: '   ' } });
  assert.equal(cleared.body.badge, null); assert.equal((await ps4()).badge, null);
  await call('/api/platforms/ps4', { method: 'PATCH', body: { badge: 'PS-4' } });
});

test('the Physical Library carries the badge text for its tiles, chips and spines', async () => {
  const added = await call('/api/physical/games', { method: 'POST', body: { platform: 'ps4', title: 'Bloodborne' } });
  assert.equal(added.status, 201);
  const list = (await call('/api/physical')).body;
  assert.equal(list.platforms.find((p) => p.slug === 'ps4').badge, 'PS-4', 'the platform list');
  const one = (await call(`/api/physical/games/${added.body.id}`)).body;
  assert.equal(one.platform_badge, 'PS-4', 'and one game\'s details');
});

test('the badge text wins on every cover badge, in capitals; the chips follow the short name; and the settings form has the field', () => {
  const pn = read('public/platform-names.js'), dg = read('public/digital.js'), app = read('public/app.js'), mj = read('public/modern.js');
  assert.ok(pn.includes("String(p?.badge || BADGE[p?.slug] || p?.short_name"), 'Physical badges and spines');
  assert.ok(pn.includes("platformChip = (p) => platformBadge({ ...p, badge: '' })"), 'a chip never uses the badge text');
  assert.ok(read('public/physical.js').includes('<span>${esc(platformChip(p))}</span> <small>'), 'Physical chips');
  assert.ok(dg.includes('customBadge(g.platform) || st.short') && dg.includes('<span>${esc(platformChip({'), 'Digital tiles use the badge text, its chips the short name');
  assert.ok(app.includes('rom.platform_badge ? String(rom.platform_badge).toUpperCase() : rom.platform_short'), 'the ROM Library tiles');
  assert.ok(mj.includes('<span>${esc(String(p.short_name || p.name).toUpperCase())}</span> <small>${pc(p)'), 'the ROM Library chips');
  assert.ok(read('public/carousel.js').includes('${esc(String(p.short_name || p.name).toUpperCase())}<small>'), 'the Carousel chips');
  assert.ok(app.includes('data-pf="badge" maxlength="12"'), 'Settings > Platforms > Edit');
  const sv = read('src/app.js');
  assert.ok(sv.includes("'icon', 'badge'];") && (sv.match(/p\.badge AS platform_badge/g) || []).length === 2);
});

test('the ROM Library list and a collection carry the badge text, so the tiles show it instead of the short name', async () => {
  const id = Number(db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1) VALUES ((SELECT id FROM platforms WHERE slug = 'ps4'), 'Badge Game', 'badge game', 'badge.pkg', 'x', 3, 'ba0000000000000000000000000000000000dge1')").run().lastInsertRowid);
  const list = (await call('/api/roms?q=Badge+Game')).body;
  const row = list.items.find((r) => r.id === id) || assert.fail('not listed: ' + JSON.stringify(list).slice(0, 200));
  assert.equal(row.platform_badge, 'PS-4', 'the library list');
  assert.equal(row.platform_short, 'PS4');
  const coll = (await call('/api/collections', { method: 'POST', body: { name: 'Badge shelf' } })).body;
  await call(`/api/collections/${coll.id}/roms`, { method: 'POST', body: { rom_ids: [id] } });
  const inside = (await call(`/api/collections/${coll.id}`)).body;
  assert.equal((inside.roms || inside.items).find((r) => r.id === id).platform_badge, 'PS-4', 'a collection');
});
