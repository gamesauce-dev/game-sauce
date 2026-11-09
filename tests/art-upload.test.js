import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-art-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'aadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'a-admin-password-1';

let server, base, db, phys, tok = {}, ids = {};
const call = async (p, { method = 'GET', body, as = 'admin', raw } = {}) => {
  const headers = { Authorization: 'Bearer ' + tok[as] };
  if (!raw) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: raw || (body ? JSON.stringify(body) : undefined) });
  return { status: res.status, body: await res.json().catch(() => null), res };
};
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
/** A PNG header that says it is w x h pixels (enough for the checks, which read the header). */
const png = (w, h, extra = 40) => { const b = Buffer.alloc(33 + extra); Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const form = (buf, name = 'pic.png', field = 'image') => { const f = new FormData(); f.append(field, new Blob([buf], { type: 'image/png' }), name); return f; };
const add = async (platform, title) => (await call('/api/physical/games', { method: 'POST', body: { platform, title } })).body;
const art = (id, kind, buf, as = 'admin') => call(`/api/physical/games/${id}/art/${kind}`, { method: 'POST', as, raw: form(buf) });
const files = () => fs.readdirSync(path.join(TMP, 'storage', 'covers')).filter((f) => f.startsWith('physical-'));

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  phys = await import('../src/lib/physical.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok.admin = await login('aadmin', 'a-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'ann', password: 'ann-password-12', role: 'user' } });
  tok.ann = await login('ann', 'ann-password-12');
  for (const u of ['aadmin', 'ann']) ids[u] = db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('Physical: your own cover, spine or disc, each checked for what it is said to be', async () => {
  const g = await add('ps4', 'Art Test');
  const cover = await art(g.id, 'cover', png(300, 420));
  assert.equal(cover.status, 200); assert.equal(cover.body.has_cover, true); assert.equal(cover.body.cover_locked, true); assert.ok(cover.body.cover_url);
  assert.equal(cover.body.cover_ar, 0.7143);
  const spine = await art(g.id, 'spine', png(40, 400));
  assert.equal(spine.status, 200); assert.equal(spine.body.has_spine, true); assert.equal(spine.body.spine_locked, true); assert.equal(spine.body.spine_ar, 0.1);
  const disc = await art(g.id, 'disc', png(300, 300));
  assert.equal(disc.status, 200); assert.equal(disc.body.has_disc, true); assert.equal(disc.body.disc_locked, true);
  assert.equal((await fetch(base + disc.body.disc_url, { headers: { Authorization: 'Bearer ' + tok.admin } })).status, 200);
  // a cover used as a disc is accepted: the page crops it to the disc's shape
  const coverAsDisc = await art(g.id, 'disc', png(300, 420));
  assert.equal(coverAsDisc.status, 200);
  // refusals, each with the reason, and nothing kept
  const before = files().length;
  for (const [kind, buf, re] of [
    ['spine', png(200, 300), /tall and narrow/], ['spine', png(8, 400), /tall and narrow/],
    ['disc', png(100, 400), /roughly square/], ['disc', png(20, 20), /at least 64 pixels/],
    ['cover', png(20, 20), /does not look like a cover/], ['cover', png(3000, 100), /does not look like a cover/],
    ['cover', png(20000, 300), /too large/], ['cover', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), /not a JPEG, PNG or WebP/],
    ['cover', Buffer.concat([png(300, 420), Buffer.alloc(9 * 1024 * 1024)]), /over 8 MB/], ['logo', png(300, 420), /cover, spine or disc/]
  ]) { const r = await art(g.id, kind, buf); assert.equal(r.status, 400, `${kind} ${re}`); assert.match(r.body.error, re); }
  assert.equal(files().length, before, 'a refused picture leaves no file behind');
  assert.equal((await call(`/api/physical/games/${g.id}/art/cover`, { method: 'POST', raw: new FormData() })).status, 400, 'no file at all');
  // a cartridge game has no disc
  const snes = await add('snes', 'Cart Test');
  const noDisc = await art(snes.id, 'disc', png(300, 300)); assert.equal(noDisc.status, 400); assert.match(noDisc.body.error, /Only disc games/);
  assert.equal((await art(snes.id, 'cover', png(300, 420))).status, 200, 'but it can have a cover');
  assert.equal((await art(g.id, 'cover', png(300, 420), 'ann')).status, 404, 'not ann\'s game');
});

test('Physical: an uploaded picture is not replaced by a lookup (a match picked by hand replaces the cover), and putting it back works', async () => {
  const g = await add('ps4', 'Lock Test');
  await art(g.id, 'cover', png(300, 420)); await art(g.id, 'spine', png(40, 400)); await art(g.id, 'disc', png(300, 300));
  const row = () => db.prepare('SELECT cover_path, spine_path, disc_path, cover_locked FROM physical_games WHERE id = ?').get(g.id);
  const mine = row();
  const other = path.join(TMP, 'other.png'); fs.writeFileSync(other, png(10, 10));
  const cacheImpl = async () => other;
  // an automatic match brings its own pictures but keeps yours
  await phys.applyMatch(ids.aadmin, g.id, { title: 'x', media: { box2d: 'http://x/c', spine: 'http://x/s', disc: 'http://x/d' }, source: 'launchbox' }, { cacheImpl });
  assert.deepEqual(row(), mine, 'automatic: cover, spine and disc all stay');
  // the spine and disc lookups skip it as well, without asking
  let asked = 0;
  assert.equal(await phys.fetchSpine(ids.aadmin, g.id, { spineImpl: async () => { asked++; return 'http://x/s'; }, cacheImpl }), false);
  assert.equal(await phys.fetchDisc(ids.aadmin, g.id, { discImpl: async () => { asked++; return 'http://x/d'; }, cacheImpl }), false);
  assert.equal(asked, 0);
  // picking a match by hand does replace the cover (and unlocks it), but not your spine or disc
  await phys.applyMatch(ids.aadmin, g.id, { title: 'x', media: { box2d: 'http://x/c2', spine: 'http://x/s2' }, source: 'igdb' }, { cacheImpl, explicit: true });
  const after = row();
  assert.equal(after.cover_path, other); assert.equal(after.cover_locked, 0); assert.equal(after.spine_path, mine.spine_path); assert.equal(after.disc_path, mine.disc_path);
  // back to automatic: the file goes
  assert.ok(fs.existsSync(mine.disc_path));
  const gone = await call(`/api/physical/games/${g.id}/art/disc`, { method: 'DELETE' });
  assert.equal(gone.body.has_disc, false); assert.equal(gone.body.disc_locked, false); assert.ok(!fs.existsSync(mine.disc_path));
  assert.equal((await call(`/api/physical/games/${g.id}/art/nonsense`, { method: 'DELETE' })).status, 400);
  // removing the game removes what it uploaded
  const sp = row().spine_path; assert.ok(fs.existsSync(sp));
  await call(`/api/physical/games/${g.id}`, { method: 'DELETE' });
  assert.ok(!fs.existsSync(sp), 'the game is removed, and so is its spine picture');
});

test('Digital: your own cover for a console game (yours alone), not for Steam games, checked, and put back', async () => {
  const added = await call('/api/digital/games', { method: 'POST', body: { platform: 'switch', title: 'Hades' } });
  assert.equal(added.status, 201);
  const appId = db.prepare("SELECT app_id FROM digital_games WHERE user_id = ? AND name = 'Hades'").get(ids.aadmin).app_id;
  const url = `/api/digital/games/nintendo/${appId}`;
  assert.equal((await call(url)).body.game.own_cover, false);
  const up = await call(`${url}/cover`, { method: 'POST', raw: form(png(300, 420), 'x.png', 'cover') });
  assert.equal(up.status, 200); assert.deepEqual(up.body, { own_cover: true });
  const g = (await call(url)).body.game;
  assert.equal(g.own_cover, true); assert.match(g.cover_url, /^\/api\/digital\/cover\/nintendo\//);
  assert.equal((await call(g.cover_url)).status, 200, 'the picture is served');
  for (const [buf, re] of [[Buffer.from('not a picture at all, just words here'), /not a JPEG, PNG or WebP/], [Buffer.concat([png(300, 420), Buffer.alloc(9 * 1024 * 1024)]), /over 8 MB/]]) {
    const r = await call(`${url}/cover`, { method: 'POST', raw: form(buf, 'y.png', 'cover') }); assert.equal(r.status, 400); assert.match(r.body.error, re);
  }
  assert.equal((await call(`${url}/cover`, { method: 'POST', raw: new FormData() })).status, 400, 'no file at all');
  db.prepare("INSERT INTO digital_games (user_id, store, app_id, name, minutes) VALUES (?, 'steam', '220', 'Half-Life 2', 0)").run(ids.aadmin);
  assert.equal((await call('/api/digital/games/steam/220/cover', { method: 'POST', raw: form(png(300, 420), 'x.png', 'cover') })).status, 400, 'Steam\'s covers come from Steam');
  const file = db.prepare('SELECT cover_path FROM digital_user_meta WHERE user_id = ? AND app_id = ?').get(ids.aadmin, appId).cover_path;
  assert.ok(file.includes('digital-') && fs.existsSync(file));
  const back = await call(`${url}/cover`, { method: 'DELETE' });
  assert.deepEqual(back.body, { own_cover: false }); assert.ok(!fs.existsSync(file));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM digital_user_meta WHERE user_id = ? AND app_id = ?').get(ids.aadmin, appId).n, 0, 'nothing else was edited, so the entry goes');
});

test('the provider picker with a star (your default) is in Physical and Digital too, and the screens offer the pictures', () => {
  const id = read('public/identify.js'), ph = read('public/physical.js'), dg = read('public/digital.js'), css = read('public/physical.css');
  assert.ok(id.includes('export function wireProviderPicker(el, ctx)') && id.includes("'/prefs/identify_provider'") && id.includes('Make this my default provider'));
  assert.ok(id.includes('class="provpick" id="${idp}-id-prov"') && id.includes('wireProviderPicker($(`#${idp}-id-prov`, root), ctx);'), 'replaces the plain list in the shared block');
  assert.ok(ph.includes("identifyBlock({ idp: 'ph'") && dg.includes("identifyBlock({ idp: 'dg'"), 'both pages use the shared block');
  assert.ok(ph.includes('function artMenu(g)') && ph.includes("data-art=\"${k}\"") && ph.includes('data-art-reset=') && ph.includes("isDisc(g.platform) ? [['disc'"), 'cover, spine, and disc only for disc games');
  assert.ok(ph.includes('`/physical/games/${id}/art/${kind}`'));
  assert.ok(dg.includes('data-d="cover"') && dg.includes('`${gameUrl(store, appId)}/cover`') && dg.includes('g.own_cover'));
  assert.ok(css.includes('.ph-disc.has-art.is-own::after') && css.includes('object-fit: cover; border-radius: 50%'), 'an uploaded cover is cropped to the disc shape with its hole and rim drawn over it');
});
