// A limit on a person, added to src/lib/visibility.js, must hold on every route: the game it rules out reaches them by no way at all.
// Most of this is done with blocks (one member blocked as a person, the other through a group); an age limit is then put through the same checks.
// The last tests add rules of their own with addLimit. A game hidden from everyone is covered in tests/route-permissions.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROUTES } from './route-rules.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-limit-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'lmadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'lm-admin-password-1';
process.env.GAMESAUCE_RATE_LIMIT = '0';
process.env.GAMESAUCE_UPDATE_CHECK = '0';

const WORD = 'Qvxlimited';   // in everything about the games the limit rules out; after the limit it must reach neither member
let app, server, base, db, realFetch, vis, restrictions, ratings, adminId, lift;
const token = {}, ids = {}, games = {};
let collection, physical, digital, launchCode, artLabel;

async function call(who, method, url, { body, raw } = {}) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 15000);
  try {
    const res = await realFetch(base + '/api' + url, {
      method, redirect: 'manual', signal: stop.signal,
      headers: { ...(token[who] ? { Authorization: `Bearer ${token[who]}` } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) },
      body: raw || (body ? JSON.stringify(body) : undefined)
    });
    if (/event-stream/.test(res.headers.get('content-type') || '')) { stop.abort(); return { status: res.status, text: '', json: null }; }
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json };
  } finally { clearTimeout(timer); }
}
const ok = async (who, method, url, opts) => { const r = await call(who, method, url, opts); assert.ok(r.status < 300, `${method} ${url}: ${r.status} ${r.text.slice(0, 200)}`); return r.json; };

const addRom = (title, filename, slug) => {
  const file = path.join(TMP, 'games', filename);
  fs.writeFileSync(file, `bytes of ${filename}`);
  const id = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, meta_source, genre, region, cover_path) VALUES (?, lower(?), ?, (SELECT id FROM platforms WHERE slug = ?), ?, 1, 'filename', ?, ?, ?)")
    .run(title, title, filename, slug, file, title.includes(WORD) ? `${WORD}Genre` : 'Plain', title.includes(WORD) ? `${WORD}Region` : 'World', path.join(TMP, 'cover.png')).lastInsertRowid);
  const tag = title.includes(WORD) ? `${WORD}-tag` : 'plain-tag';
  db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tag);
  db.prepare('INSERT INTO rom_tags (rom_id, tag_id) SELECT ?, id FROM tags WHERE name = ?').run(id, tag);
  return id;
};

/** Block these games for the two members: one as a person, the other through a group. Returns what takes the blocks away again. */
let groupId;
const restrict = (romIds) => {
  for (const id of romIds) restrictions.setBlocks(id, { users: [ids.member], groups: [groupId] });
  return () => { for (const id of romIds) restrictions.setBlocks(id, {}); };
};
const ruledOut = () => [games.snes, games.ps5, games.parent];

before(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => (base && String(u).startsWith(base) ? realFetch(u, o) : Promise.reject(new Error('no outside requests in this test')));
  const { prepareApp } = await import('../src/app.js');
  ({ app } = await prepareApp());
  db = (await import('../src/db.js')).default;
  vis = await import('../src/lib/visibility.js');
  restrictions = await import('../src/lib/restrictions.js');
  ratings = await import('../src/lib/ratings.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await ok('anonymous', 'POST', '/auth/login', { body: { username: u, password: p } })).token;
  token.admin = await login('lmadmin', 'lm-admin-password-1');
  adminId = db.prepare("SELECT id FROM users WHERE username = 'lmadmin'").get().id;
  for (const [who, user] of [['member', 'lmmember'], ['play', 'lmplay']]) {
    ids[who] = (await ok('admin', 'POST', '/auth/users', { body: { username: user, password: `${user}-password-12`, role: 'user' } })).id;
    if (who === 'play') await ok('admin', 'PATCH', `/auth/users/${ids[who]}`, { body: { mode: 'play' } });
    token[who] = await login(user, `${user}-password-12`);
  }
  await ok('admin', 'PUT', '/auth/policy', { body: { members_can_download: true } });
  groupId = (await ok('admin', 'POST', '/groups', { body: { name: 'Blocked' } })).items[0].id;
  await ok('admin', 'PATCH', `/auth/users/${ids.play}`, { body: { groups: [groupId] } });

  fs.mkdirSync(path.join(TMP, 'games'));
  fs.writeFileSync(path.join(TMP, 'cover.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  games.plain = addRom('Plain Game', 'plain.sfc', 'snes');
  games.snes = addRom(`${WORD} Quest`, `${WORD}-quest.sfc`, 'snes');
  games.ps5 = addRom(`${WORD} Racer`, `${WORD}-racer.iso`, 'ps5');
  games.parent = addRom(`${WORD} Parent`, `${WORD.toLowerCase()}parent.zip`, 'mame');
  games.clone = addRom('Plain Clone', 'plainclone.zip', 'mame');
  db.prepare("INSERT INTO mame_names (name, title, cloneof, romof) VALUES ('plainclone', 'Plain Clone', ?, ?)").run(`${WORD.toLowerCase()}parent`, `${WORD.toLowerCase()}parent`);

  // Everything a person can have to do with a game, done while it is still allowed.
  collection = (await ok('member', 'POST', '/collections', { body: { name: 'Kept' } })).id;
  await ok('member', 'POST', `/collections/${collection}/roms`, { body: { rom_ids: Object.values(games) } });
  for (const who of ['member', 'play']) {
    for (const id of Object.values(games)) await ok(who, 'POST', `/roms/${id}/favorite`, { body: {} });
    await ok(who, 'POST', `/roms/${games.snes}/saves?kind=state`, { raw: Buffer.from('state') });
    for (const id of [games.plain, games.snes]) for (const kind of ['play', 'download']) db.prepare('INSERT INTO downloads (rom_id, bytes, user_id, kind) VALUES (?, 1, ?, ?)').run(id, ids[who], kind);
  }
  await ok('member', 'POST', `/roms/${games.ps5}/hide`, { body: { hidden: true } });   // their own Hide
  await ok('admin', 'POST', `/messages/with/${ids.member}`, { body: { body: 'try this', game: { type: 'rom', id: games.snes } } });
  launchCode = (await ok('member', 'POST', `/roms/${games.snes}/launch`, { body: {} })).token;
  const video = path.join(TMP, 'v.mp4'); fs.writeFileSync(video, 'video bytes');
  for (const [platform, title] of [['snes', `${WORD} Quest`], ['ps5', `${WORD} Racer`]]) {
    db.prepare("INSERT INTO game_videos (platform, title_key, path, bytes, source, fetched_at, tried_at) VALUES (?, ?, ?, 11, 'folder', datetime('now'), datetime('now'))").run(platform, `${WORD.toLowerCase()} ${title.split(' ')[1].toLowerCase()}`, video);
    db.prepare('INSERT INTO theme_videos (platform, title_key, path, bytes) VALUES (?, ?, ?, 11)').run(platform, `${WORD.toLowerCase()} ${title.split(' ')[1].toLowerCase()}`, video);
  }
  const art = path.join(TMP, 'Art', 'snes', 'videos'); fs.mkdirSync(art, { recursive: true });
  fs.writeFileSync(path.join(art, `${WORD} Quest.mp4`), 'not a video');
  await ok('admin', 'PUT', '/art/folders', { body: { folders: [path.join(TMP, 'Art')] } });
  artLabel = (await ok('member', 'GET', '/art/folders')).folders[0];
  artLabel = typeof artLabel === 'string' ? artLabel : artLabel.path || artLabel.label || artLabel.folder;
});
after(async () => {
  lift?.();
  globalThis.fetch = realFetch;
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ }
});

/** Every route a member can read, with real numbers in it, and the list's filters. [who may use it, address] */
function reads() {
  const out = [];
  for (const level of ['public', 'play', 'member']) {
    for (const entry of ROUTES[level]) {
      const [method, route] = entry.split(' ');
      if (method !== 'GET' || /^\/roms\/:id(\/|$)/.test(route)) continue;   // the /roms/:id routes have a test of their own below
      const url = route === '/collections/:id' ? `/collections/${collection}` : route === '/messages/with/:id' ? `/messages/with/${adminId}` : route.replace(/:slug|:platform/g, 'snes').replace(/:\w+/g, '999999');
      out.push([level === 'member' ? 'member' : 'play', url]);
    }
  }
  for (const q of ['?limit=500', '?hidden=1', '?hidden=all', '?system=only', '?system=all&hidden=all', '?letters=1', '?playable=1', '?favorite=1', `?collection=999999`, `?q=${WORD}&hidden=all`, '?missing=0', '?cover=1', `?tag=${WORD}-tag`, `?genre=${WORD}Genre`, '?platform=snes,ps5,mame&hidden=all']) out.push(['play', `/roms${q}`]);
  out.push(['member', `/roms?collection=${collection}&hidden=all`]);
  return out;
}
async function namingIt() {
  const found = [];
  for (const [who, url] of reads()) {
    for (const account of who === 'play' ? ['play', 'member'] : ['member']) {
      if ((await call(account, 'GET', url)).text.toLowerCase().includes(WORD.toLowerCase())) found.push(`${account} ${url.split('?')[0]}${url.includes('?') ? '?…' : ''}`);
    }
  }
  return [...new Set(found)];
}

test('before the limit, the members do see these games (so the checks below mean something)', async () => {
  const found = await namingIt();
  for (const url of ['/roms?…', '/roms/facets', '/roms/recently-played', '/stats', '/saves', `/collections/${collection}`, `/messages/with/${adminId}`]) assert.ok(found.includes(`member ${url}`), `${url} should mention the game before the limit: ${found.join(', ')}`);
  for (const id of ruledOut()) assert.equal((await call('member', 'GET', `/roms/${id}`)).status, 200);
});

test('with the limit, no route a member can read mentions a ruled-out game', async () => {
  lift = restrict(ruledOut());
  assert.deepEqual(await namingIt(), []);
});

test('with the limit, every route that takes one of these games answers "not found"', async () => {
  const takesGame = Object.entries(ROUTES).filter(([level]) => level === 'play' || level === 'member').flatMap(([level, list]) => list.map((e) => [level, ...e.split(' ')])).filter(([, , route]) => /^\/roms\/:id(\/|$)/.test(route));
  assert.ok(takesGame.length >= 15);
  const wrong = [];
  for (const id of ruledOut()) {
    for (const [level, method, route] of takesGame) {
      const url = route.replace(':id', String(id)).replace(':kind', 'logo').replace(/:\w+/g, '1');
      for (const account of level === 'play' ? ['play', 'member'] : ['member']) {
        const r = await call(account, method, url, { body: method === 'GET' ? undefined : {} });
        if (r.status !== 404 && !(account === 'play' && r.status === 403)) wrong.push(`${method} ${route} as ${account}: ${r.status}`);
      }
    }
    for (const q of [`/videos/status?kind=rom&id=${id}`, `/videos/file?kind=rom&id=${id}`]) for (const account of ['play', 'member']) assert.equal((await call(account, 'GET', q)).status, 404, `${account} ${q}`);
  }
  assert.deepEqual(wrong, []);
});

test('counts leave the ruled-out games out', async () => {
  const stats = await ok('member', 'GET', '/stats');
  assert.equal(stats.library.roms, 2);
  assert.equal(stats.library.favorites, 2);
  assert.equal(stats.mine.favorites, 2);
  assert.equal(stats.mine.downloads, 1, 'their downloads of the other game only');
  assert.equal(stats.downloads, 2, 'the server\'s total, one for each member');
  const facets = await ok('member', 'GET', '/roms/facets');
  assert.equal(facets.stats.roms, 2);
  assert.equal(facets.stats.favorites, 2);
  assert.equal(facets.stats.hidden, 0, 'their own Hide of a ruled-out game is not counted');
  assert.deepEqual(facets.platforms.map((p) => [p.slug, p.count]).sort(), [['mame', 1], ['snes', 1]]);
  assert.equal((await ok('member', 'GET', '/collections')).items[0].count, 2);
  const platforms = (await ok('member', 'GET', '/platforms')).items;
  for (const [slug, n] of [['snes', 1], ['ps5', 0], ['mame', 1]]) {
    const p = platforms.find((x) => x.slug === slug);
    assert.deepEqual([p.count, p.visible_count], [n, n], slug);
  }
  assert.equal((await ok('member', 'GET', '/roms?hidden=all')).total, 2);
});

test('naming a ruled-out game in a change does nothing, and tells nothing', async () => {
  const fresh = (await ok('member', 'POST', '/collections', { body: { name: 'New' } })).id;
  for (const id of ruledOut()) {
    assert.deepEqual((await ok('member', 'POST', `/collections/${fresh}/roms`, { body: { rom_ids: [id] } })), { added: 0 });
    assert.equal((await ok('member', 'POST', '/roms/bulk/hide', { body: { ids: [id] } })).changed, 0);
    assert.equal((await ok('member', 'POST', '/roms/bulk/hide', { body: { ids: [id], hidden: false } })).changed, 0);
    assert.equal((await call('member', 'POST', `/messages/with/${adminId}`, { body: { game: { type: 'rom', id } } })).status, 400, 'a member sharing it');
    assert.equal((await call('admin', 'POST', `/messages/with/${ids.member}`, { body: { game: { type: 'rom', id } } })).status, 400, 'sharing it with a member');
  }
  const thread = (await ok('member', 'GET', `/messages/with/${adminId}`)).items;
  assert.deepEqual([thread[0].body, thread[0].game], ['try this', null], 'the message stays, the note about the game does not');
});

test('a person\'s own copy of the same title does not play the video', async () => {
  physical = (await ok('member', 'POST', '/physical/games', { body: { platform: 'snes', title: `${WORD} Quest` } })).id;
  digital = await ok('member', 'POST', '/digital/games', { body: { platform: 'ps5', title: `${WORD} Racer` } });
  const urls = [`kind=physical&id=${physical}`, `kind=digital&store=${digital.store}&id=${encodeURIComponent(digital.app_id)}`];
  const flags = async () => {
    const p = (await ok('member', 'GET', '/physical/games')).items.find((g) => g.id === physical);
    const d = (await ok('member', 'GET', '/digital/games')).items.find((g) => g.app_id === digital.app_id);
    return [p.has_video, p.has_theme, d.has_video, d.has_theme].map(Boolean);
  };
  for (const q of urls) for (const variant of ['', '&variant=theme']) assert.equal((await call('member', 'GET', `/videos/file?${q}${variant}`)).status, 404, q + variant);
  assert.deepEqual(await flags(), [false, false, false, false]);
  lift(); lift = null;   // without the limit it plays, so the refusals above were the limit's doing
  for (const q of urls) for (const variant of ['', '&variant=theme']) assert.equal((await call('member', 'GET', `/videos/file?${q}${variant}`)).status, 200, q + variant);
  assert.deepEqual(await flags(), [true, true, true, true]);
  db.prepare('UPDATE roms SET hidden_all = 1 WHERE id = ?').run(games.snes);   // hidden from everyone is not a limit: the video by title still plays (as before)
  assert.equal((await call('member', 'GET', `/videos/file?${urls[0]}`)).status, 200);
  db.prepare('UPDATE roms SET hidden_all = 0 WHERE id = ?').run(games.snes);
  lift = restrict(ruledOut());
});

test('a launch code made before the limit, and companion files, give nothing that is ruled out', async () => {
  assert.equal((await call('anonymous', 'GET', `/launch/${launchCode}`)).status, 404);
  const clone = await ok('member', 'POST', `/roms/${games.clone}/launch`, { body: {} });
  assert.equal(clone.companions, 0, 'the parent set is not sent');
  lift(); lift = null;
  assert.equal((await ok('member', 'POST', `/roms/${games.clone}/launch`, { body: {} })).companions, 1);
  lift = restrict(ruledOut());
});

test('an artwork folder import by a member neither matches nor names a ruled-out game', async () => {
  const preview = await ok('member', 'POST', '/art/import', { body: { target: 'video', folder: artLabel } });
  assert.equal(preview.games, 4, 'the two games they may see, and their own two');
  // their own copy has that title, so their import still finds it: only the Library's games are left out of the match
  db.prepare('DELETE FROM physical_games WHERE id = ?').run(physical);
  const without = await ok('member', 'POST', '/art/import', { body: { target: 'video', folder: artLabel } });
  assert.equal(without.matched.video, 0);
});

test('an age limit holds on every route in the same way', async () => {
  lift?.(); lift = null;
  ratings.setAdminRating(ruledOut(), 5);
  assert.equal((await call('member', 'GET', `/roms/${games.snes}`)).status, 200, 'rated, with no limit yet');
  db.prepare('DELETE FROM digital_games WHERE user_id = ?').run(ids.member);   // their own copy of that title is theirs to see
  await ok('admin', 'PATCH', `/auth/users/${ids.member}`, { body: { age_limit: 4 } });   // their own limit
  await ok('admin', 'PATCH', '/groups/' + groupId, { body: { age_limit: 3 } });          // and the group's, for the other
  assert.deepEqual(await namingIt(), []);
  for (const id of ruledOut()) for (const account of ['member', 'play']) assert.equal((await call(account, 'GET', `/roms/${id}`)).status, 404, `${account} ${id}`);
  assert.equal((await ok('member', 'GET', '/roms?hidden=all')).total, 2, 'the unrated games still show');
  await ok('admin', 'PATCH', `/auth/users/${ids.member}`, { body: { age_limit: null } });
  await ok('admin', 'PATCH', '/groups/' + groupId, { body: { age_limit: null } });
  ratings.setAdminRating(ruledOut(), null);
  assert.equal((await call('member', 'GET', `/roms/${games.snes}`)).status, 200);
});

test('the admin is never limited', async () => {
  lift?.();
  lift = vis.addLimit((user, alias) => `${alias}.id <> ${games.snes}`);   // a rule that spares nobody it is asked about
  assert.equal((await call('admin', 'GET', `/roms/${games.snes}`)).status, 200);
  assert.ok((await ok('admin', 'GET', '/roms?limit=500')).items.some((r) => r.id === games.snes));
  assert.equal((await call('member', 'GET', `/roms/${games.snes}`)).status, 404);
});

test('a limit that cannot be answered (NULL) counts as not allowed, in lists and in counts alike', async () => {
  lift?.();
  lift = vis.addLimit((user, alias) => `${alias}.release_year < 2000`);   // no game here has a year
  assert.equal((await ok('member', 'GET', '/roms?hidden=all')).total, 0);
  assert.equal((await ok('member', 'GET', '/stats')).mine.downloads, 0);
  assert.equal((await call('member', 'GET', `/roms/${games.plain}`)).status, 404);
});
