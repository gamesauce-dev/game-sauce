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
  assert.equal(c(['images', 'sony playstation 3', 'box - 3d'], 'x-01.png'), null, 'other kinds of picture are left alone'); assert.equal(c(['images', 'sony playstation 3', 'box - back', 'europe'], 'x-01.png').kind, 'back');
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
  put('Launchbox/images/super nintendo/disc/Chrono Trigger-01.png', png(300, 300));   // a cartridge platform with no case has no disc: never offered
  put('RetroBat/roms/ps2/images/Gran Turismo 4 (USA)-thumb.png', png(300, 420)); put('RetroBat/roms/ps2/images/Gran Turismo 4 (USA)-image.png', png(640, 480)); put('RetroBat/roms/ps2/images/Gran Turismo 4 (USA)-marquee.png', png(400, 100));
  put('RetroBat/roms/ps2/manuals/Gran Turismo 4 (USA)-manual.pdf', PDF);

  const lb = (await preview(LB)).body;
  assert.deepEqual(lb.matched, { cover: 1, spine: 2, disc: 1, manual: 0, back: 0 }, 'Killzone cover, two spines, one disc');
  assert.deepEqual(lb.will, lb.matched); assert.equal(lb.games, 6);
  assert.deepEqual(lb.unmatched.map((u) => u.title), ['Not On My Shelf']); assert.equal(lb.unmatched_total, 1);
  assert.deepEqual(lb.unknown_platforms, [{ name: 'weird platform', files: 1 }]);
  assert.equal(row(kz.id).cover_path, null, 'a preview saves nothing');
  const rb = (await preview(RB)).body;
  assert.deepEqual(rb.matched, { cover: 1, spine: 0, disc: 0, manual: 1, back: 0 }); assert.equal(rb.files, 2, 'only -thumb and the manual are used');

  // importing runs in the background and reports its progress
  const started = await call('/api/art/import', { method: 'POST', body: { target: 'physical', folder: LB, apply: true } });
  assert.equal(started.status, 200); assert.equal(started.body.total, 4);
  await art.artJobIdle(ids.iadmin);
  const done = (await call('/api/art/import/status')).body;
  assert.equal(done.running, false); assert.equal(done.done, 4); assert.deepEqual(done.applied, { cover: 1, spine: 2, disc: 1, manual: 0, back: 0 }); assert.equal(done.failed, 0);
  const k = row(kz.id);
  assert.equal(k.cover_locked, 1); assert.ok(fs.existsSync(k.cover_path)); assert.equal(fs.statSync(k.cover_path).size, fs.statSync(eu).size, 'a PAL game took the Europe cover, not North America\'s');
  assert.equal(row(muaa.id).spine_locked, 1); assert.equal(row(ac.id).spine_locked, 1, 'a file with no region folder matches too'); assert.equal(row(blade.id).disc_locked, 1);
  assert.equal(row(snes.id).disc_path, null, 'a cartridge game never gets a disc');
  // the RetroBat part, with its manual
  await call('/api/art/import', { method: 'POST', body: { target: 'physical', folder: RB, apply: true } }); await art.artJobIdle(ids.iadmin);
  const g = row(gt.id); assert.equal(g.cover_locked, 1); assert.ok(g.manual_path && fs.existsSync(g.manual_path) && /Gran Turismo 4/.test(g.manual_name));
  // fill gaps: a second run changes nothing, and says why
  const again = (await preview(LB)).body;
  assert.deepEqual(again.will, { cover: 0, spine: 0, disc: 0, manual: 0, back: 0 }); assert.deepEqual(again.skipped, { cover: 1, spine: 2, disc: 1, manual: 0, back: 0 });
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
  assert.deepEqual(pv.matched, { cover: 2, spine: 0, disc: 0, manual: 0, back: 0 }); assert.equal(pv.games, 2);
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

test('the simple layout (a media pack): platform folder, a folder per kind of picture, names cut at the text the person gives', async () => {
  const c = art.classify; const pick = (o) => { const { fileRegion, ...rest } = o; return rest; };
  assert.deepEqual(pick(c(['downloads', 'xbox 360', 'images'], 'Ace Combat 6 - Fires of Liberation (USA, Japan) (En,Fr,De,Es,It).png')), { layout: 'simple', kind: 'cover', platform: 'xbox 360', region: '', title: 'Ace Combat 6 - Fires of Liberation (USA, Japan) (En,Fr,De,Es,It)', n: 1, weak: false });
  assert.equal(c(['xbox 360', 'spines', 'europe'], 'x (Europe).png').kind, 'spine'); assert.equal(c(['xbox 360', 'spines', 'europe'], 'x (Europe).png').region, 'europe');
  assert.equal(c(['xbox 360', 'discs'], 'x.jpg').kind, 'disc'); assert.equal(c(['xbox 360', 'Box Art'.toLowerCase()], 'x.png').kind, 'cover');
  assert.equal(c(['xbox 360', 'images'], 'x.txt'), null); assert.equal(c(['xbox 360', 'misc'], 'x.png'), null, 'a folder with an unknown name is left alone');
  assert.equal(art.cutTitle('Ace Combat 6 (USA) (En,Fr)', ' ('), 'Ace Combat 6'); assert.equal(art.cutTitle('Zork - USA', ' - '), 'Zork'); assert.equal(art.cutTitle('Zork', ' ('), 'Zork'); assert.equal(art.cutTitle('Zork', ''), 'Zork');
  assert.equal(art.cutTitle('Zork_USA_v1', '_'), 'Zork');

  const root = path.join(TMP, 'art', 'Downloads');
  const g1 = await add('xbox360', 'Ace Combat 6 - Fires of Liberation'), g2 = await add('xbox360', '007 - Blood Stone');
  put('Downloads/xbox 360/images/Ace Combat 6 - Fires of Liberation (USA, Japan) (En,Fr,De,Es,It).png', png(300, 420));
  put('Downloads/xbox 360/images/007 - Blood Stone (USA, Europe) (En,Fr,De).png', png(300, 420));
  put('Downloads/xbox 360/spines/Ace Combat 6 - Fires of Liberation (USA, Japan) (En,Fr,De,Es,It).png', png(40, 400));
  put('Downloads/xbox 360/discs/Ace Combat 6 - Fires of Liberation (USA, Japan) (En,Fr,De,Es,It).png', png(300, 300));
  art.setArtFolders([...art.getArtFolders(), root]);
  const p = (await preview(root)).body;
  assert.deepEqual(p.matched, { cover: 2, spine: 1, disc: 1, manual: 0, back: 0 }, 'the brackets after the title are ignored');
  const q = (await preview(root, { cut: ' - ' })).body;   // cut at " - ": "007" and "Ace Combat 6" alone: Blood Stone no longer matches, Ace Combat 6 no longer matches the longer title
  assert.equal(q.matched.cover, 0);
  assert.equal(row(g1.id).cover_path, null);
});

test('the pickers: the person says what a folder holds and which platform, whatever the folders are called', async () => {
  const odd = path.join(TMP, 'art', 'Odd Pack');
  const g = await add('xbox360', 'Halo 3');
  put('Odd Pack/stuff/Halo 3 (USA).png', png(40, 400));
  art.setArtFolders([...art.getArtFolders(), odd]);
  assert.equal((await preview(odd)).body.files, 0, 'unknown folder names say nothing');
  const bare = (await preview(odd, { kind: 'spine' })).body;
  assert.equal(bare.files, 1); assert.equal(bare.matched.spine, 0, 'no platform could be read from "stuff" or "Odd Pack"');
  assert.deepEqual(bare.unknown_platforms.map((u) => u.name), ['stuff']);
  const withPlat = (await preview(odd, { kind: 'spine', platform: 'xbox360' })).body;
  assert.deepEqual(withPlat.matched, { cover: 0, spine: 1, disc: 0, manual: 0, back: 0 }); assert.equal(withPlat.will.spine, 1);
  assert.equal(row(g.id).spine_path, null, 'a preview saves nothing');
  assert.ok((await call('/api/art/platforms')).body.items.some((p) => p.slug === 'xbox360'));
  assert.equal((await call('/api/art/platforms', { as: 'ann' })).status, 200, 'anyone may read the list');
});

test('full wraps: cut into a cover and a spine at the fractions set for the platform, a real cover beats one cut from a wrap, an odd-shaped wrap is listed and left alone', async () => {
  const { PNG } = await import('pngjs'); const jpeg = (await import('jpeg-js')).default; const wc = await import('../src/lib/wrapcut.js');
  // a wrap: red back, blue spine, green front (the spine at 47.1 % to 52.6 % of the width, as measured on PS3 packs)
  const wrapPng = (w, h, f = 0.471, t = 0.526) => { const p = new PNG({ width: w, height: h }); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, c = x < w * f ? [220, 30, 30] : x < w * t ? [30, 30, 220] : [30, 200, 30]; p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2]; p.data[i + 3] = 255; } return PNG.sync.write(p); };
  const mid = (file) => { const d = jpeg.decode(fs.readFileSync(file), { useTArray: true, formatAsRGBA: true }); const i = ((d.height >> 1) * d.width + (d.width >> 1)) * 4; return { w: d.width, h: d.height, rgb: [d.data[i], d.data[i + 1], d.data[i + 2]] }; };

  // the cutting itself
  const parts = wc.splitWrap(wrapPng(1440, 800), wc.PLATFORM_SPLIT.ps3);
  fs.writeFileSync(path.join(TMP, 'c.jpg'), parts.cover); fs.writeFileSync(path.join(TMP, 's.jpg'), parts.spine); fs.writeFileSync(path.join(TMP, 'b.jpg'), parts.back);
  const cv = mid(path.join(TMP, 'c.jpg')), sp = mid(path.join(TMP, 's.jpg')), bk = mid(path.join(TMP, 'b.jpg'));
  assert.equal(cv.h, 800); assert.ok(Math.abs(cv.w - 683) <= 2, `front width ${cv.w}`); assert.ok(Math.abs(sp.w - 79) <= 2, `spine width ${sp.w}`); assert.ok(Math.abs(bk.w - 678) <= 2, `back width ${bk.w}`);
  assert.ok(cv.rgb[1] > 150 && cv.rgb[0] < 90, 'the front is the green part'); assert.ok(sp.rgb[2] > 150 && sp.rgb[0] < 90, 'the spine is the blue part'); assert.ok(bk.rgb[0] > 150, 'the back is the red part');
  assert.throws(() => wc.splitWrap(Buffer.from('RIFF....WEBPVP8 '), { from: 0.4, to: 0.5 }), /WebP/); assert.throws(() => wc.splitWrap(Buffer.from('nope')), /not a JPEG or PNG/);
  assert.equal(wc.cleanSplit({ from: 0.6, to: 0.5 }), null); assert.equal(wc.cleanSplit({ from: 0.1, to: 0.2 }), null); assert.deepEqual(wc.splitFor('ps3', { ps3: { from: 0.3, to: 0.4 } }), { from: 0.3, to: 0.4 }); assert.deepEqual(wc.splitFor('ps3', {}), wc.PLATFORM_SPLIT.ps3); assert.deepEqual(wc.splitFor('snes', {}), wc.DEFAULT_SPLIT);

  // the importer
  const root = path.join(TMP, 'art', 'Wraps');
  const w1 = await add('ps3', 'Wheelman'), w2 = await add('ps3', 'WipEout HD Fury'), w3 = await add('ps3', 'Odd One'), w4 = await add('ps3', 'Has A Cover');
  put('Wraps/PlayStation 3/wrap/Wheelman (USA).png', wrapPng(1440, 800)); put('Wraps/PlayStation 3/wrap/WipEout HD Fury (Europe).png', wrapPng(1440, 800));
  put('Wraps/PlayStation 3/wrap/Odd One (USA).png', wrapPng(1000, 800));   // another shape: left alone
  put('Wraps/PlayStation 3/wrap/Has A Cover (USA).png', wrapPng(1440, 800)); put('Wraps/PlayStation 3/images/Has A Cover (USA).png', png(300, 420));   // a real cover for this one
  art.setArtFolders([...art.getArtFolders(), root]);
  const p = (await preview(root)).body;
  assert.equal(p.wraps.files, 4); assert.equal(p.wraps.odd, 1); assert.equal(p.wraps.odd_list[0].title, 'Odd One (USA)');
  assert.deepEqual(p.matched, { cover: 3, spine: 3, disc: 0, manual: 0, back: 3 }, 'three wraps cut; Odd One is left alone; Has A Cover has a real cover (its wrap still gives its spine)');
  assert.equal(p.wraps.platforms[0].slug, 'ps3'); assert.deepEqual(p.wraps.platforms[0].split, wc.PLATFORM_SPLIT.ps3); assert.ok(Number.isInteger(p.wraps.platforms[0].sample));
  const img = await fetch(`${base}/api/art/wrap-image?folder=${encodeURIComponent(root)}&i=${p.wraps.platforms[0].sample}`, { headers: { Authorization: 'Bearer ' + tok.admin } });
  assert.equal(img.status, 200); assert.match(img.headers.get('content-type'), /png/);
  assert.equal((await fetch(`${base}/api/art/wrap-image?folder=${encodeURIComponent(root)}&i=99999`, { headers: { Authorization: 'Bearer ' + tok.admin } })).status, 404);
  assert.equal((await fetch(`${base}/api/art/wrap-image?folder=${encodeURIComponent(path.join(TMP, 'elsewhere'))}&i=0`, { headers: { Authorization: 'Bearer ' + tok.admin } })).status, 400, 'only a listed folder');

  // import with the person's own cut for PS3 (47 % to 52 % of the width): the cover is what is right of it
  const started = await call('/api/art/import', { method: 'POST', body: { target: 'physical', folder: root, apply: true, split: { ps3: { from: 0.47, to: 0.52 } } } });
  assert.equal(started.status, 200); await art.artJobIdle(ids.iadmin);
  const done = (await call('/api/art/import/status')).body; assert.equal(done.failed, 0); assert.deepEqual(done.applied, { cover: 3, spine: 3, disc: 0, manual: 0, back: 3 });
  const r1 = row(w1.id), r3 = row(w3.id);
  assert.ok(r1.cover_path && r1.spine_path); assert.equal(r3.cover_path, null, 'the odd wrap is not cut');
  const c1 = mid(r1.cover_path), s1 = mid(r1.spine_path); assert.ok(Math.abs(c1.w - 691) <= 2, `front ${c1.w}`); assert.ok(Math.abs(s1.w - 72) <= 2, `spine ${s1.w}`); assert.ok(c1.rgb[1] > 150 && s1.rgb[2] > 150);
  assert.ok(row(w4.id).spine_path, 'the wrap gave the spine'); assert.equal(fs.readFileSync(row(w4.id).cover_path).length, 80, 'the real cover was used (not one cut from the wrap)');
  // remembered for next time
  const again = (await preview(root)).body; assert.deepEqual(again.wraps.platforms[0].split, { from: 0.47, to: 0.52 });
  // the "everything in this folder is" picker offers it too
  assert.equal((await preview(path.join(TMP, 'art', 'Wraps', 'PlayStation 3', 'wrap'), { kind: 'wrap', platform: 'ps3' })).status, 400, 'not a listed folder');
});

test('full wraps: the importer screen has the cut editor (two lines on a sample), the "full wraps" choice, and the odd wraps list', () => {
  const ui = read('public/artimport-ui.js'), css = read('public/physical.css');
  assert.ok(ui.includes('export function mountWraps') && ui.includes('/api/art/wrap-image?folder=') && ui.includes('wl-a') && ui.includes('wl-b') && ui.includes('split: edited'));
  assert.ok(ui.includes('value="wrap">Full wraps') && ui.includes('a different shape from the rest: left alone'));
  assert.ok(css.includes('.wrap-stage') && css.includes('.wl-shade') && css.includes('.wrap-out canvas'));
  assert.ok(read('src/routes/art.js').includes("router.get('/wrap-image'") && read('package.json').includes('"jpeg-js"') && read('package.json').includes('"pngjs"'), 'pure-JavaScript readers, nothing native');
});
