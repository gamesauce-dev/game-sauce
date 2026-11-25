// The server must not be usable to reach addresses on its own machine or home network, whether someone sends it an address or a service redirects it to one.
// Nothing here talks to the internet: every server is on 127.0.0.1.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-safedl-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'sdadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'sd-admin-password-1';
delete process.env.GAMESAUCE_FETCH_ALLOW_HOSTS;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
let server, base, db, adminTok, memberTok, inside, outside, romId;
const hits = [];
const serve = async (handler) => { const s = http.createServer(handler); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return { s, host: `127.0.0.1:${s.address().port}`, url: `http://127.0.0.1:${s.address().port}` }; };
const call = async (p, { token = adminTok, method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
/** Run with these hosts allowed, as an owner would with GAMESAUCE_FETCH_ALLOW_HOSTS. */
const allowing = async (hosts, fn) => { process.env.GAMESAUCE_FETCH_ALLOW_HOSTS = hosts; try { return await fn(); } finally { delete process.env.GAMESAUCE_FETCH_ALLOW_HOSTS; } };

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  adminTok = await login('sdadmin', 'sd-admin-password-1');
  await call('/api/auth/users', { method: 'POST', body: { username: 'sdmember', password: 'sd-member-pass-12', role: 'user' } });
  memberTok = await login('sdmember', 'sd-member-pass-12');
  romId = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, meta_source) VALUES ('Plain', 'plain', 'plain.sfc', (SELECT id FROM platforms WHERE slug = 'snes'), 'x', 1, 'filename')").run().lastInsertRowid);
  inside = await serve((q, r) => { hits.push(q.url); r.writeHead(200, { 'Content-Type': 'image/png' }); r.end(PNG); });
  outside = await serve((q, r) => {
    if (q.url === '/to-inside') { r.writeHead(302, { Location: `${inside.url}/by-redirect` }); return r.end(); }
    if (q.url === '/to-file') { r.writeHead(302, { Location: 'file:///etc/passwd' }); return r.end(); }
    if (q.url === '/loop') { r.writeHead(302, { Location: '/loop' }); return r.end(); }
    if (q.url === '/hop') { r.writeHead(301, { Location: '/picture' }); return r.end(); }
    if (q.url === '/endless') {   // says nothing about its size and never stops
      r.writeHead(200, { 'Content-Type': 'image/png' });
      const chunk = Buffer.alloc(64 * 1024, 1);
      const pump = () => { while (!r.destroyed && r.write(chunk)); if (!r.destroyed) r.once('drain', pump); };
      return pump();
    }
    r.writeHead(200, { 'Content-Type': 'image/png' }); r.end(PNG);
  });
});
beforeEach(() => { hits.length = 0; });
after(async () => {
  for (const s of [server, inside?.s, outside?.s]) if (s) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
});

const sent = (u) => ({ title: 'Picked', source: 'igdb', cover_url: `${u}/cover`, spine_url: `${u}/spine`, disc_url: `${u}/disc`, back_url: `${u}/back`, media: { box2d: `${u}/box`, spine: `${u}/mspine`, disc: `${u}/mdisc`, back: `${u}/mback` } });

test('a member picking a match cannot make the server fetch an address of their choosing', async () => {
  const disc = (await call('/api/physical/games', { token: memberTok, method: 'POST', body: { title: 'My Disc', platform: 'ps2' } })).body;
  const r = await call(`/api/physical/games/${disc.id}/match`, { token: memberTok, method: 'POST', body: { candidate: sent(inside.url) } });
  assert.equal(r.status, 200);
  assert.equal(r.body.has_cover, false);
  await call('/api/digital/games', { token: memberTok, method: 'POST', body: { platform: 'Xbox 360', title: 'My Digital' } });
  const mine = db.prepare("SELECT store, app_id FROM digital_games WHERE store <> 'steam'").get();
  assert.equal((await call(`/api/digital/games/${mine.store}/${mine.app_id}/match`, { token: memberTok, method: 'POST', body: { candidate: sent(inside.url) } })).status, 200);
  assert.equal((await call(`/api/metadata/${romId}/apply`, { method: 'POST', body: { candidate: sent(inside.url) } })).status, 200, 'an admin picking for the Library');
  assert.deepEqual(hits, []);
  assert.equal(db.prepare('SELECT cover_url FROM roms WHERE id = ?').get(romId).cover_url, null, 'nor is the address kept');
  assert.equal(db.prepare('SELECT cover_url FROM physical_games WHERE id = ?').get(disc.id).cover_url, null);
});

test('only secure addresses on the search services are accepted from a browser', async () => {
  const { pickedCandidate } = await import('../src/lib/safefetch.js');
  const good = ['https://cdn.thegamesdb.net/images/original/boxart/front/1-1.jpg', 'https://images.igdb.com/igdb/image/upload/t_cover_big/a.jpg', 'https://images.launchbox-app.com/a.jpg'];
  for (const u of good) assert.equal(pickedCandidate({ cover_url: u }).cover_url, u, u);
  const bad = ['http://images.igdb.com/a.jpg', 'https://images.igdb.com.example.test/a.jpg', 'https://notthegamesdb.net/a.jpg', 'https://images.igdb.com@127.0.0.1/a.jpg', 'https://user:pw@images.igdb.com/a.jpg',
    'https://images.igdb.com:8443/a.jpg', 'https://127.0.0.1/a.jpg', 'https://api.screenscraper.fr/api2/ssuserInfos.php', 'file:///etc/passwd', 'images.igdb.com/a.jpg', 42, ['https://images.igdb.com/a.jpg']];
  for (const u of bad) {
    const out = pickedCandidate({ title: 't', cover_url: u, spine_url: u, media: { box2d: u, back: u, other: u } });
    assert.ok(!out.cover_url && !out.spine_url && !out.media.box2d && !out.media.back && !out.media.other, JSON.stringify(u));
    assert.equal(out.title, 't', 'the details are kept');
  }
});

test('home, local and other special addresses are not public', async () => {
  const { isPublicAddress } = await import('../src/lib/safefetch.js');
  for (const a of ['127.0.0.1', '127.9.9.9', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.27', '169.254.169.254', '100.100.43.104', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fd7a:115c:a1e0::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '2001::1', 'not-an-address', '']) assert.equal(isPublicAddress(a), false, a);
  for (const a of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.0.1', '2606:4700::1111', '2a00:1450:4009::200e']) assert.equal(isPublicAddress(a), true, a);
});

test('a name is accepted only when every address it stands for is public', async () => {
  const { publicLookup } = await import('../src/lib/safefetch.js');
  const ask = (found, all) => new Promise((done) => publicLookup('pictures.example.test', { all }, (...got) => done(got), (name, options, cb) => cb(null, found)));
  const pub = { address: '1.1.1.1', family: 4 }, pub6 = { address: '2606:4700::1111', family: 6 }, home = { address: '192.168.0.27', family: 4 };
  // the two shapes Node asks for: a list, or one address and its family
  assert.deepEqual(await ask([pub, pub6], true), [null, [pub, pub6]]);
  assert.deepEqual(await ask([pub, pub6], false), [null, '1.1.1.1', 4]);
  for (const found of [[home], [pub, home], [home, pub], []]) { const [err] = await ask(found, true); assert.match(String(err), /not allowed/, JSON.stringify(found)); }
});

test('a stored or provider address that points inward is not fetched, by number or by name', async () => {
  const { cacheMedia } = await import('../src/lib/providers.js');
  const { downloadCover } = await import('../src/lib/storage.js');
  const port = new URL(inside.url).port;
  for (const u of [`${inside.url}/direct`, `http://localhost:${port}/by-name`, `http://2130706433:${port}/as-one-number`, `http://[::ffff:127.0.0.1]:${port}/mapped`]) {
    assert.equal(await cacheMedia(u, 'box2d'), null, u);
    assert.equal(await downloadCover(u, 'x'), null, u);
  }
  assert.deepEqual(hits, []);
});

test('every redirect is checked, and an allowed host still works', async () => {
  const { cacheMedia } = await import('../src/lib/providers.js');
  const { fetchRemote } = await import('../src/lib/safefetch.js');
  await allowing(outside.host, async () => {
    assert.equal(await cacheMedia(`${outside.url}/to-inside`, 'box2d'), null);
    assert.deepEqual(hits, [], 'the redirect was not followed inward');
    await assert.rejects(fetchRemote(`${outside.url}/to-file`, { maxBytes: 1000 }), /not allowed/);
    await assert.rejects(fetchRemote(`${outside.url}/loop`, { maxBytes: 1000 }), /redirect/);
    for (const p of ['/picture', '/hop']) {
      const got = await cacheMedia(`${outside.url}${p}`, 'box2d');
      assert.ok(got && fs.readFileSync(got).equals(PNG), p);
    }
  });
});

test('a download stops at the size limit, whatever the server says', async () => {
  const { fetchRemote } = await import('../src/lib/safefetch.js');
  await allowing(outside.host, async () => {
    await assert.rejects(fetchRemote(`${outside.url}/endless`, { maxBytes: 200_000 }), /size limit/);
    await assert.rejects(fetchRemote(`${outside.url}/picture`, { maxBytes: 10 }), /size limit/);
  });
});
