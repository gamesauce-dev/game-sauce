import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-artimport-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'iadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'i-admin-password-1';

let server, base, db, art, tok = {}, ids = {};
const call = async (p, { method = 'GET', body, as = 'admin' } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + tok[as], 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const png = (w, h) => { const b = Buffer.alloc(80); Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const put = (rel, buf) => { const f = path.join(TMP, 'art', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return f; };
const LB = path.join(TMP, 'art', 'Launchbox', 'images'), RB = path.join(TMP, 'art', 'RetroBat', 'roms');
const add = async (platform, title, region = '', as = 'admin') => (await call('/api/physical/games', { method: 'POST', as, body: { platform, title, region } })).body;
const row = (id) => db.prepare('SELECT * FROM physical_games WHERE id = ?').get(id);
const preview = (folder, extra = {}, as = 'admin') => call('/api/art/import', { method: 'POST', as, body: { target: 'physical', folder, ...extra } });

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  art = await import('../src/lib/artimport.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok.admin = await login('iadmin', 'i-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'ann', password: 'ann-password-12', role: 'user' } });
  tok.ann = await login('ann', 'ann-password-12');
  for (const u of ['iadmin', 'ann']) ids[u] = db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('reading names: where a file sits says what it is; titles match on letters and numbers, brackets and -01 ignored', () => {
  const c = art.classify;
  assert.deepEqual(pick(c(['images', 'sony playstation 3', 'box - front', 'north america'], 'Killzone HD-01.jpg')), { layout: 'launchbox', kind: 'cover', platform: 'sony playstation 3', region: 'north america', title: 'Killzone HD', n: 1 });
  assert.equal(c(['images', 'sony playstation 3', 'box - spine'], 'Armored Core 4-02.png').kind, 'spine'); assert.equal(c(['images', 'sony playstation 3', 'box - spine'], 'Armored Core 4-02.png').n, 2);
  assert.equal(c(['images', 'sony playstation 3', 'disc', 'japan'], 'x-01.png').kind, 'disc');
  assert.equal(c(['images', 'sony playstation 3', 'box - front - reconstructed'], 'x-01.png').weak, true);
  assert.equal(c(['images', 'sony playstation 3', 'box - back'], 'x-01.png'), null, 'other kinds of picture are left alone');
  assert.equal(c(['roms', 'ps2', 'images'], '24 - The Game-thumb.png').kind, 'cover'); assert.equal(c(['roms', 'ps2', 'images'], '24 - The Game-thumb.png').title, '24 - The Game');
  assert.equal(c(['roms', 'ps2', 'images'], '24 - The Game-image.png'), null, 'RetroBat -image and -marquee are not box art');
  assert.equal(c(['roms', 'ps2', 'images'], '24 - The Game-marquee.png'), null);
  assert.deepEqual(pick(c(['roms', 'ps2', 'manuals'], 'AirBlade-manual.pdf')), { layout: 'retrobat', kind: 'manual', platform: 'ps2', region: '', title: 'AirBlade', n: 1 });
  assert.equal(c(['roms', 'ps2', 'manuals'], 'notes.txt'), null);
  const k = art.titleKey;
  assert.equal(k('Marvel_ Ultimate Alliance 2'), k('Marvel: Ultimate Alliance 2'));
  assert.equal(k('Armored Core - Nexus (USA) (Disc 1) (Evolution)'), k('Armored Core: Nexus'));
  assert.equal(k('007_ Quantum of Solace [Collector_s Edition]'), k('007: Quantum of Solace'));
  assert.equal(k('1945 i & ii'), k('1945 I & II'));
  assert.notEqual(k('Armored Core 4'), k('Armored Core V'));
  // the game's own region picks among regions: lower is better
  const r = art.regionRank;
  assert.ok(r('PAL', 'europe') < r('PAL', 'north america') && r('PAL', 'north america') > r('PAL', 'world') && r('PAL', 'world') < r('PAL', ''));
  assert.ok(r('NTSC-U', 'united states') < r('NTSC-U', 'europe') && r('NTSC-J', 'japan') < r('NTSC-J', 'world'));
  function pick(o) { const { layout, kind, platform, region, title, n } = o; return { layout, kind, platform, region, title, n }; }
});

test('the artwork folders: only an admin sets them, each must be a real folder on the server, and only listed folders can be read', async () => {
  fs.mkdirSync(LB, { recursive: true }); fs.mkdirSync(RB, { recursive: true });
  assert.equal((await call('/api/art/folders', { method: 'PUT', as: 'ann', body: { folders: [LB] } })).status, 403);
  for (const bad of ['images', '../x', path.join(TMP, 'nope')]) { const r = await call('/api/art/folders', { method: 'PUT', body: { folders: [bad] } }); assert.equal(r.status, 400, bad); }
  const ok = await call('/api/art/folders', { method: 'PUT', body: { folders: [LB, RB + path.sep, LB] } });
  assert.equal(ok.status, 200); assert.deepEqual(ok.body.folders.map((f) => f.path), [LB, RB], 'tidied, no repeats'); assert.ok(ok.body.folders.every((f) => f.exists));
  const seen = await call('/api/art/folders', { as: 'ann' }); assert.deepEqual(seen.body.folders.map((f) => f.path), [LB, RB]); assert.equal(seen.body.can_edit, false);
  // a folder that is not on the list cannot be read, however it is spelled
  for (const f of [TMP, path.join(TMP, 'art'), path.join(LB, '..'), path.join(LB, 'sony playstation 3'), 'C:\\Windows', '/etc']) { const r = await preview(f); assert.equal(r.status, 400, f); assert.match(r.body.error, /artwork folders the admin has listed/); }
});

test('preview and import from a LaunchBox + RetroBat layout: matched by platform and title, region chosen by the game, gaps filled, a manual copied, nothing outside the shelf touched', async () => {
  const ps3 = 'sony playstation 3';
  const kz = await add('ps3', 'Killzone HD', 'PAL'), muaa = await add('ps3', 'Marvel: Ultimate Alliance 2', 'NTSC-U'), blade = await add('ps3', 'Bladestorm: Nightmare', 'NTSC-J'), ac = await add('ps3', 'Armored Core 4');
  const gt = await add('ps2', 'Gran Turismo 4'), snes = await add('snes', 'Chrono Trigger');
  put(`Launchbox/images/${ps3}/box - front/North America/Killzone HD-01.png`, png(300, 420));
  const eu = put(`Launchbox/images/${ps3}/box - front/Europe/Killzone HD-01.png`, png(310, 430));
  put(`Launchbox/images/${ps3}/box - front/North America/Not On My Shelf-01.png`, png(300, 420));
  put(`Launchbox/images/${ps3}/box - spine/United States/Marvel_ Ultimate Alliance 2-01.png`, png(40, 400));
  put(`Launchbox/images/${ps3}/box - spine/Armored Core 4-01.png`, png(36, 400));
  put(`Launchbox/images/${ps3}/disc/japan/bladestorm_ nightmare-01.png`, png(300, 300));
  put('Launchbox/images/weird platform/box - front/Zork-01.png', png(300, 420));
  put('Launchbox/images/nintendo switch/disc/Chrono Trigger-01.png', png(300, 300));   // a cartridge platform has no disc: never offered
  put('RetroBat/roms/ps2/images/Gran Turismo 4 (USA)-thumb.png', png(300, 420)); put('RetroBat/roms/ps2/images/Gran Turismo 4 (USA)-image.png', png(640, 480)); put('RetroBat/roms/ps2/images/Gran Turismo 4 (USA)-marquee.png', png(400, 100));
  put('RetroBat/roms/ps2/manuals/Gran Turismo 4 (USA)-manual.pdf', PDF);

  const lb = (await preview(LB)).body;
  assert.deepEqual(lb.matched, { cover: 1, spine: 2, disc: 1, manual: 0 }, 'Killzone cover, two spines, one disc');
  assert.deepEqual(lb.will, lb.matched); assert.equal(lb.games, 6);
  assert.deepEqual(lb.unmatched.map((u) => u.title), ['Not On My Shelf']); assert.equal(lb.unmatched_total, 1);
  assert.deepEqual(lb.unknown_platforms, [{ name: 'weird platform', files: 1 }]);
  assert.equal(row(kz.id).cover_path, null, 'a preview saves nothing');
  const rb = (await preview(RB)).body;
  assert.deepEqual(rb.matched, { cover: 1, spine: 0, disc: 0, manual: 1 }); assert.equal(rb.files, 2, 'only -thumb and the manual are used');

  // importing runs in the background and reports its progress
  const started = await call('/api/art/import', { method: 'POST', body: { target: 'physical', folder: LB, apply: true } });
  assert.equal(started.status, 200); assert.equal(started.body.total, 4);
  await art.artJobIdle(ids.iadmin);
  const done = (await call('/api/art/import/status')).body;
  assert.equal(done.running, false); assert.equal(done.done, 4); assert.deepEqual(done.applied, { cover: 1, spine: 2, disc: 1, manual: 0 }); assert.equal(done.failed, 0);
  const k = row(kz.id);
  assert.equal(k.cover_locked, 1); assert.ok(fs.existsSync(k.cover_path)); assert.equal(fs.statSync(k.cover_path).size, fs.statSync(eu).size, 'a PAL game took the Europe cover, not North America\'s');
  assert.equal(row(muaa.id).spine_locked, 1); assert.equal(row(ac.id).spine_locked, 1, 'a file with no region folder matches too'); assert.equal(row(blade.id).disc_locked, 1);
  assert.equal(row(snes.id).disc_path, null, 'a cartridge game never gets a disc');
  // the RetroBat part, with its manual
  await call('/api/art/import', { method: 'POST', body: { target: 'physical', folder: RB, apply: true } }); await art.artJobIdle(ids.iadmin);
  const g = row(gt.id); assert.equal(g.cover_locked, 1); assert.ok(g.manual_path && fs.existsSync(g.manual_path) && /Gran Turismo 4/.test(g.manual_name));
  // fill gaps: a second run changes nothing, and says why
  const again = (await preview(LB)).body;
  assert.deepEqual(again.will, { cover: 0, spine: 0, disc: 0, manual: 0 }); assert.deepEqual(again.skipped, { cover: 1, spine: 2, disc: 1, manual: 0 });
  // someone else's shelf is theirs: ann's preview sees none of these games
  assert.equal((await preview(LB, {}, 'ann')).body.games, 0);
  // a game that has an automatic cover keeps it unless asked, and an uploaded one is never replaced
  const auto = await add('ps3', 'Lollipop Chainsaw'); put(`Launchbox/images/${ps3}/box - front/North America/Lollipop Chainsaw-01.png`, png(300, 420));
  const autoFile = path.join(TMP, 'auto.png'); fs.writeFileSync(autoFile, png(10, 10));
  db.prepare('UPDATE physical_games SET cover_path = ?, cover_locked = 0 WHERE id = ?').run(autoFile, auto.id);
  assert.equal((await preview(LB)).body.will.cover, 0, 'automatic cover: kept by default');
  assert.equal((await preview(LB, { replace: true })).body.will.cover, 1, 'replace ticked: the automatic one is replaced');
  assert.equal((await preview(LB, { replace: true })).body.matched.cover, 2); // Killzone (own, locked) + Lollipop; only Lollipop will change
  await call('/api/art/import', { method: 'POST', body: { target: 'physical', folder: LB, replace: true, apply: true } }); await art.artJobIdle(ids.iadmin);
  assert.notEqual(row(auto.id).cover_path, autoFile); assert.equal(row(auto.id).cover_locked, 1); assert.equal(row(kz.id).cover_path, k.cover_path, 'the one imported earlier is kept: it is the person\'s own now');
});

test('Digital: covers for console games from the same folders, a cover of their own is kept', async () => {
  const sw = 'nintendo switch';
  for (const t of ['Hades', 'Celeste']) assert.equal((await call('/api/digital/games', { method: 'POST', body: { platform: 'switch', title: t } })).status, 201);
  put(`Launchbox/images/${sw}/box - front/North America/Hades-01.png`, png(300, 420)); put(`Launchbox/images/${sw}/box - front/North America/Celeste-01.png`, png(300, 420));
  put(`Launchbox/images/${sw}/box - spine/Hades-01.png`, png(40, 400));   // not used for Digital
  const pv = (await call('/api/art/import', { method: 'POST', body: { target: 'digital', folder: LB } })).body;
  assert.deepEqual(pv.matched, { cover: 2, spine: 0, disc: 0, manual: 0 }); assert.equal(pv.games, 2);
  const celeste = db.prepare("SELECT app_id FROM digital_games WHERE name = 'Celeste' AND user_id = ?").get(ids.iadmin).app_id;
  const own = path.join(TMP, 'own-digital.png'); fs.writeFileSync(own, png(10, 10));
  db.prepare("INSERT INTO digital_user_meta (user_id, store, app_id, json, cover_path, source, updated_at) VALUES (?, 'nintendo', ?, '{}', ?, NULL, datetime('now'))").run(ids.iadmin, celeste, own);
  const pv2 = (await call('/api/art/import', { method: 'POST', body: { target: 'digital', folder: LB, replace: true } })).body;
  assert.equal(pv2.will.cover, 1, 'their own cover is never replaced, even when replacing is asked for');
  await call('/api/art/import', { method: 'POST', body: { target: 'digital', folder: LB, apply: true } }); await art.artJobIdle(ids.iadmin);
  const hades = db.prepare("SELECT app_id FROM digital_games WHERE name = 'Hades' AND user_id = ?").get(ids.iadmin).app_id;
  const um = db.prepare("SELECT cover_path FROM digital_user_meta WHERE app_id = ? AND user_id = ?").get(hades, ids.iadmin);
  assert.ok(um.cover_path.includes('digital-') && fs.existsSync(um.cover_path));
  assert.equal(db.prepare('SELECT cover_path FROM digital_user_meta WHERE app_id = ? AND user_id = ?').get(celeste, ids.iadmin).cover_path, own, 'Celeste kept its own cover');
});

test('the screens and the settings: Artwork folders (admin), Import pictures & manuals in Physical and Digital, with a preview first', () => {
  const html = read('public/index.html'), app = read('public/app.js'), ph = read('public/physical.js'), dg = read('public/digital.js');
  assert.ok(html.includes('id="mod-artfolders"') && html.includes('id="artfolders-text"') && html.includes('id="artfolders-save"'));
  assert.ok(app.includes("id: 'artfolders'") && app.includes("'/art/folders'"));
  const ui = read('public/artimport-ui.js');
  assert.ok(ui.includes("'/art/import'") && ui.includes("'/art/import/status'") && ui.includes('Replace pictures that are already there') && ui.includes('id="art-preview"') && ui.includes('id="art-apply" type="button" disabled'), 'preview first, then Import');
  assert.ok(ph.includes("renderArtImport(ctx, $('#drawer-body'), { target: 'physical'") && dg.includes("renderArtImport(ctx, $('#drawer-body'), { target: 'digital'"));
  assert.ok(html.includes('data-ph-act="art"') && html.includes('data-dg-act="art"'));
  // an admin can add a folder from the import screen itself: type or paste a path, or browse the server's folders
  assert.ok(ui.includes('function wireAddFolder(') && ui.includes('id="art-newpath"') && ui.includes('id="art-browse"') && ui.includes("`/sources/browse${p ? `?path=${encodeURIComponent(p)}` : ''}`") && ui.includes("'/art/folders', { method: 'PUT'"), 'type, paste or browse, then Add');
  assert.ok(ui.includes('if (can_edit) wireAddFolder('), 'only for an admin (the folders list is theirs to set)');
  assert.ok(ui.includes('O:\\\\Launchbox\\\\images'), 'the example path keeps its backslashes (doubled in the source, as it is inside a template)');
  for (const id of ['#art-preview', '#art-apply']) assert.ok(read('public/modern.js').includes(`'${id}'`), `Modern gives ${id} an icon`);
});
