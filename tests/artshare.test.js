import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-artshare-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'sadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 's-admin-password-1';

let server, base, db, phys, tok = {}, ids = {};
const call = async (p, { method = 'GET', body, as = 'admin' } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + tok[as], 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default; phys = await import('../src/lib/physical.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok.admin = await login('sadmin', 's-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'ann', password: 'ann-password-12', role: 'user' } });
  tok.ann = await login('ann', 'ann-password-12');
  for (const u of ['sadmin', 'ann']) ids[u] = db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ } });

const row = (id) => db.prepare('SELECT * FROM physical_games WHERE id = ?').get(id);

test('shared artwork: a picture one account has is copied to another account\'s copy of the same game; manuals and everything else never; removing one copy leaves the other', async () => {
  const { PNG } = await import('pngjs');
  const png = (w, h) => { const p = new PNG({ width: w, height: h }); p.data.fill(200); return PNG.sync.write(p); };
  const a = phys.addPhysical(ids.sadmin, { platform: 'ps3', title: 'Wheelman', region: 'NTSC-U' });
  phys.setPhysicalArt(ids.sadmin, a.id, 'spine', png(60, 400));            // uploaded: a file of the admin's own
  phys.setPhysicalArt(ids.sadmin, a.id, 'back', png(300, 420));
  phys.setPhysicalArt(ids.sadmin, a.id, 'cover', png(300, 420));
  phys.setManualLink(ids.sadmin, a.id, 'https://example.com/manual.pdf');
  db.prepare("UPDATE physical_games SET notes = 'my private note', rating = 4 WHERE id = ?").run(a.id);

  // ann adds the same game (the title with other brackets still counts as the same) and a different one
  const b = phys.addPhysical(ids.ann, { platform: 'ps3', title: 'Wheelman [Greatest Hits]' });
  const other = phys.addPhysical(ids.ann, { platform: 'ps3', title: 'Something Else' });
  assert.equal(phys.artSharing(), true, 'on unless an admin turns it off');
  // adding a game starts the background run, which brings the pictures across by itself; wait for it, then look
  while (phys.matchJobStatus().running) await new Promise((r) => setTimeout(r, 25));
  assert.equal(phys.reuseArt(ids.ann, b.id), 0, 'the background run already filled them');
  const rb = row(b.id), ra = row(a.id);
  for (const k of ['cover', 'spine', 'back']) { assert.ok(rb[`${k}_path`] && fs.existsSync(rb[`${k}_path`])); assert.notEqual(rb[`${k}_path`], ra[`${k}_path`], `${k}: a file of her own`); assert.equal(rb[`${k}_locked`], 0, `${k}: not locked, so a lookup or import may replace it`); }
  assert.equal(rb.manual_link, null); assert.equal(rb.notes, null); assert.equal(rb.rating, null, 'only pictures cross over');
  assert.equal(phys.reuseArt(ids.ann, other.id), 0, 'a different game gets nothing');
  assert.equal(phys.reuseArt(ids.ann, b.id), 0, 'nothing left to fill');

  // each copy is its own
  phys.removePhysicalArt(ids.ann, b.id, 'spine');
  assert.ok(fs.existsSync(ra.spine_path), 'the admin\'s spine is untouched');
  assert.equal(row(b.id).spine_path, null);

  // turned off: nothing is copied
  const off = await call('/api/art/sharing', { method: 'PUT', body: { on: false } }); assert.deepEqual(off.body, { on: false });
  assert.equal((await call('/api/art/sharing', { as: 'ann' })).body.on, false); assert.equal((await call('/api/art/sharing', { as: 'ann' })).body.can_edit, false);
  assert.equal((await call('/api/art/sharing', { method: 'PUT', as: 'ann', body: { on: true } })).status, 403, 'only an admin');
  assert.equal(phys.reuseArt(ids.ann, b.id), 0);
  await call('/api/art/sharing', { method: 'PUT', body: { on: true } });
  assert.equal(phys.reuseArt(ids.ann, b.id), 1, 'and on again');

  // a cartridge platform: no disc or back is taken (nothing to turn over)
  const s1 = phys.addPhysical(ids.sadmin, { platform: 'snes', title: 'Chrono Trigger' }), s2 = phys.addPhysical(ids.ann, { platform: 'snes', title: 'Chrono Trigger' });
  phys.setPhysicalArt(ids.sadmin, s1.id, 'cover', png(300, 420));
  while (phys.matchJobStatus().running) await new Promise((r) => setTimeout(r, 25));
  phys.reuseArt(ids.ann, s2.id); assert.ok(row(s2.id).cover_path, 'the cover came across'); assert.equal(row(s2.id).disc_path, null); assert.equal(row(s2.id).back_path, null);

  // the screen and the job use it
  const ui = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), src = fs.readFileSync(new URL('../src/lib/physical.js', import.meta.url), 'utf8');
  assert.ok(ui.includes('id="art-share"') && src.includes('reuseArt(g.user_id, g.id)'));
});
