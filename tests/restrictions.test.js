// Age restrictions: groups, age limits, blocks, what is remembered about a game apart from its entry, and members who may edit games.
// That a ruled-out game reaches nobody by any route is tests/visibility-rule.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-restrict-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'readmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 're-admin-password-1';
process.env.GAMESAUCE_RATE_LIMIT = '0';
process.env.GAMESAUCE_UPDATE_CHECK = '0';

let server, base, db, realFetch, restrictions, ratings;
const token = {}, ids = {};

async function call(who, method, url, body, form) {
  const res = await realFetch(base + '/api' + url, {
    method,
    headers: { ...(token[who] ? { Authorization: `Bearer ${token[who]}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: form || (body ? JSON.stringify(body) : undefined)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}
const ok = async (who, method, url, body) => { const r = await call(who, method, url, body); assert.ok(r.status < 300, `${method} ${url}: ${r.status} ${r.text.slice(0, 200)}`); return r.json; };

before(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => (base && String(u).startsWith(base) ? realFetch(u, o) : Promise.reject(new Error('no outside requests in this test')));
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  restrictions = await import('../src/lib/restrictions.js');
  ratings = await import('../src/lib/ratings.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  token.admin = (await ok('nobody', 'POST', '/auth/login', { username: 'readmin', password: 're-admin-password-1' })).token;
  ids.admin = db.prepare("SELECT id FROM users WHERE username = 'readmin'").get().id;
  for (const who of ['kid', 'teen', 'player']) {
    ids[who] = (await ok('admin', 'POST', '/auth/users', { username: `re${who}`, password: `re-${who}-password-12`, role: 'user' })).id;
    token[who] = (await ok('nobody', 'POST', '/auth/login', { username: `re${who}`, password: `re-${who}-password-12` })).token;
  }
  await ok('admin', 'PATCH', `/auth/users/${ids.player}`, { mode: 'play' });
});
after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ }
});

let made = 0;
/** A game, written straight to the database as a scan would. */
function addRom(title, { slug = 'snes', filename, sha1 = null, sort = title.toLowerCase() } = {}) {
  const name = filename || `game-${++made}.sfc`;
  return Number(db.prepare(`INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, meta_source)
    VALUES (?, ?, ?, (SELECT id FROM platforms WHERE slug = ?), ?, 1, ?, 'filename')`).run(title, sort, name, slug, path.join(TMP, 'nowhere', name), sha1).lastInsertRowid);
}
const remove = (id) => { restrictions.flushRecords(); db.prepare('DELETE FROM roms WHERE id = ?').run(id); };
const sees = async (who, id) => (await call(who, 'GET', `/roms/${id}`)).status === 200;
const column = (id, name) => db.prepare(`SELECT ${name} AS v FROM roms WHERE id = ?`).get(id)?.v;
let groups = {};
const makeGroup = async (name, extra = {}) => (await ok('admin', 'POST', '/groups', { name, ...extra })).items.find((g) => g.name === name).id;
const putIn = (who, list) => ok('admin', 'PATCH', `/auth/users/${ids[who]}`, { groups: list });
const block = (id, users = [], inGroups = []) => ok('admin', 'PUT', `/groups/blocks/${id}`, { users, groups: inGroups });

test('groups are checked, and an account is never made without the restriction chosen for it', async () => {
  groups.little = await makeGroup('Little ones', { age_limit: 1 });
  groups.older = await makeGroup('Older', { age_limit: 3 });
  for (const bad of [{ name: '' }, { name: 'x'.repeat(41) }, { name: 'little ONES' }, { name: 'A', age_limit: 6 }, { name: 'A', age_limit: 0 }, { name: 'A', age_limit: '3' }, { name: 'A', can_edit: 'yes' }]) {
    assert.ok((await call('admin', 'POST', '/groups', bad)).status >= 400, JSON.stringify(bad));
  }
  for (const bad of [{ groups: [999] }, { groups: 'Older' }, { age_limit: 9 }]) {
    const r = await call('admin', 'POST', '/auth/users', { username: 'renever', password: 're-never-password-12', role: 'user', ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'renever'").get().n, 0);
  assert.equal((await call('admin', 'PATCH', `/auth/users/${ids.kid}`, { groups: [999], disabled: true })).status, 400);
  assert.equal(db.prepare('SELECT disabled FROM users WHERE id = ?').get(ids.kid).disabled, 0, 'a refused change changes nothing');
  const withGroup = (await ok('admin', 'POST', '/auth/users', { username: 'rewith', password: 're-with-password-12', role: 'user', groups: [groups.little], age_limit: 2 })).id;
  const listed = (await ok('admin', 'GET', '/auth/users')).items.find((u) => u.id === withGroup);
  assert.deepEqual([listed.groups, listed.age_limit], [[groups.little], 2]);
  assert.deepEqual((await ok('admin', 'GET', '/groups')).limits.map((l) => l.label), ['G', 'PG', 'M', 'MA 15+', 'R 18+']);
});

test('the strictest limit on a person wins; unrated games stay; admins are never limited', async () => {
  const g = addRom('Limit G'), pg = addRom('Limit PG'), m = addRom('Limit M'), rc = addRom('Limit RC'), unrated = addRom('Limit Unrated');
  for (const [id, level] of [[g, 1], [pg, 2], [m, 3], [rc, 6]]) ratings.setAdminRating([id], level);
  const shown = async (who) => (await Promise.all([g, pg, m, rc, unrated].map((id) => sees(who, id)))).map(Number).join('');
  assert.equal(await shown('kid'), '11111', 'no group and no limit: nothing changes, refused ratings included');
  await putIn('kid', [groups.older]);
  assert.equal(await shown('kid'), '11101');
  await ok('admin', 'PATCH', `/auth/users/${ids.kid}`, { age_limit: 5 });
  assert.equal(await shown('kid'), '11101', 'their own looser limit does not widen the group\'s');
  await ok('admin', 'PATCH', `/auth/users/${ids.kid}`, { age_limit: 2 });
  assert.equal(await shown('kid'), '11001', 'their own stricter limit tightens it');
  await putIn('kid', [groups.older, groups.little]);
  assert.equal(await shown('kid'), '10001', 'two groups: the stricter');
  await putIn('kid', []);
  await ok('admin', 'PATCH', `/auth/users/${ids.kid}`, { age_limit: 5 });
  assert.equal(await shown('kid'), '11101', 'the highest limit still holds back refused ratings');
  await ok('admin', 'PATCH', `/auth/users/${ids.kid}`, { age_limit: null });
  await ok('admin', 'PATCH', `/auth/users/${ids.admin}`, { groups: [groups.little], age_limit: 1 });
  assert.equal(await shown('admin'), '11111');
});

test('a block covers every version on the same platform, now and later, and nothing on another platform', async () => {
  const usa = addRom('Block Me', { sort: 'block me' }), europe = addRom('Block Me', { sort: 'block me' });
  const other = addRom('Block Me', { slug: 'genesis', sort: 'block me' });
  await block(usa, [ids.kid]);
  assert.deepEqual([await sees('kid', usa), await sees('kid', europe), await sees('kid', other), await sees('teen', usa)], [false, false, true, true]);
  assert.deepEqual((await ok('admin', 'GET', `/groups/blocks/${europe}`)).blocked, { users: [ids.kid], groups: [] });
  const japan = addRom('Block Me', { sort: 'block me' });
  assert.equal(await sees('kid', japan), false, 'a version added later');
  // retitled away from the others, a version keeps its block
  await ok('admin', 'PATCH', `/roms/${europe}`, { title: 'Something Else' });
  assert.equal(await sees('kid', europe), false);
  // and the block is taken off all of them together, whichever one it is done from
  await block(japan, [], []);
  assert.deepEqual([await sees('kid', usa), await sees('kid', japan)], [true, true]);
  await block(europe, [], []);
  assert.equal(await sees('kid', europe), true);
});

test('only an account that is limited can be blocked', async () => {
  const id = addRom('Who Can');
  assert.equal((await call('admin', 'PUT', `/groups/blocks/${id}`, { users: [ids.admin], groups: [] })).status, 400);
  assert.equal((await call('admin', 'PUT', `/groups/blocks/${id}`, { users: [999999], groups: [] })).status, 400);
  assert.equal((await call('admin', 'PUT', `/groups/blocks/${id}`, { users: [], groups: [999999] })).status, 400);
  assert.equal((await call('admin', 'PUT', `/groups/blocks/${id}`, {})).status, 400, 'nothing sent does not mean unblock');
  assert.equal((await call('admin', 'PUT', '/groups/blocks/999999', { users: [], groups: [] })).status, 404);
});

test('a block is remembered when its game is removed and added again, by name and by fingerprint', async () => {
  const first = addRom('Remember Block', { filename: 'remember.sfc', sha1: 'sha-remember' });
  await block(first, [], [groups.older]);
  await putIn('kid', [groups.older]);
  remove(first);
  const back = addRom('Remember Block Again', { filename: 'remember.sfc' });
  assert.equal(await sees('kid', back), false, 'by its name');
  remove(back);
  const renamed = addRom('New Name', { filename: 'renamed.sfc' });
  assert.equal(await sees('kid', renamed), true, 'a renamed file is not known yet');
  db.prepare("UPDATE roms SET sha1 = 'sha-remember' WHERE id = ?").run(renamed);
  assert.equal(await sees('kid', renamed), false, 'known once it is fingerprinted');
  const elsewhere = addRom('Other Console', { slug: 'genesis', filename: 'remember.sfc' });
  assert.equal(await sees('kid', elsewhere), true);
  await block(renamed);
  remove(renamed);
  assert.equal(await sees('kid', addRom('Remember Block', { filename: 'remember.sfc' })), true, 'an unblock is remembered too');
  await putIn('kid', []);
});

test('taking a block off also forgets it for versions that have been removed', async () => {
  const a = addRom('Gone Version', { filename: 'gone-a.sfc', sort: 'gone version' }), b = addRom('Gone Version', { filename: 'gone-b.sfc', sort: 'gone version' });
  await block(a, [ids.kid]);
  remove(b);
  await block(a);
  const again = addRom('Gone Version', { filename: 'gone-b.sfc', sort: 'gone version' });
  assert.deepEqual([await sees('kid', a), await sees('kid', again)], [true, true]);
});

test('deleting a person or a group takes their blocks with them, so a reused number inherits nothing', async () => {
  const id = addRom('Block Cleanup');
  const person = (await ok('admin', 'POST', '/auth/users', { username: 'retemp', password: 're-temp-password-12', role: 'user' })).id;
  const group = await makeGroup('Temporary');
  await putIn('kid', [group]);
  await block(id, [person], [group]);
  assert.equal(await sees('kid', id), false);
  await ok('admin', 'DELETE', `/auth/users/${person}`);
  await ok('admin', 'DELETE', `/groups/${group}`);
  assert.equal(await sees('kid', id), true);
  for (const table of ['game_blocks', 'rom_blocks']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE (kind = 'user' AND subject_id = ?) OR (kind = 'group' AND subject_id = ?)`).get(person, group).n, 0, table);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_group_members WHERE user_id = ? OR group_id = ?').get(person, group).n, 0);
});

test('hidden from everyone is remembered when a game is removed and added again', async () => {
  const first = addRom('Hide Memory', { filename: 'hidememory.sfc', sha1: 'sha-hidememory' });
  await ok('admin', 'POST', `/roms/${first}/hide-all`, { hidden: true });
  remove(first);
  const back = addRom('Hide Memory', { filename: 'hidememory.sfc' });
  assert.equal(await sees('kid', back), false);
  assert.equal(column(back, 'hidden_all'), 1);
  remove(back);
  const renamed = addRom('Hide Memory Renamed', { filename: 'hidememory-renamed.sfc' });
  db.prepare("UPDATE roms SET sha1 = 'sha-hidememory' WHERE id = ?").run(renamed);
  assert.equal(await sees('kid', renamed), false, 'by fingerprint');
  await ok('admin', 'POST', '/roms/bulk/hide-all', { ids: [renamed], hidden: false });
  remove(renamed);
  const shown = addRom('Hide Memory', { filename: 'hidememory.sfc', sha1: 'sha-hidememory' });
  assert.equal(await sees('kid', shown), true, 'showing it again is remembered too');
});

test('the admin\'s own Hide and bulk Hide are remembered the same way', async () => {
  const a = addRom('Own Hide', { filename: 'ownhide.sfc' }), b = addRom('Bulk Hide', { filename: 'bulkhide.sfc' });
  await ok('admin', 'POST', `/roms/${a}/hide`, { hidden: true });
  await ok('admin', 'POST', '/roms/bulk/hide', { ids: [b] });
  remove(a); remove(b);
  assert.equal(await sees('kid', addRom('Own Hide', { filename: 'ownhide.sfc' })), false);
  assert.equal(await sees('kid', addRom('Bulk Hide', { filename: 'bulkhide.sfc' })), false);
});

test('showing one file again does not forget another of the same name that is still hidden', async () => {
  const one = addRom('Same Name One', { filename: 'samename.sfc' }), two = addRom('Same Name Two', { filename: 'samename.sfc' });
  await ok('admin', 'POST', '/roms/bulk/hide-all', { ids: [one, two], hidden: true });
  await ok('admin', 'POST', `/roms/${one}/hide-all`, { hidden: false });
  assert.deepEqual([await sees('kid', one), await sees('kid', two)], [true, false]);
  remove(two);
  assert.equal(await sees('kid', addRom('Same Name Two', { filename: 'samename.sfc' })), false);
});

test('games hidden before the memory existed are taken into it', async () => {
  const id = addRom('Hidden Before', { filename: 'hiddenbefore.sfc' });
  db.prepare('UPDATE roms SET hidden_all = 1 WHERE id = ?').run(id);
  db.prepare('DELETE FROM memory_dirty').run();
  db.prepare("INSERT INTO memory_dirty (rom_id, event) SELECT id, 'hidden' FROM roms WHERE hidden_all = 1").run();   // what the upgrade does
  remove(id);
  assert.equal(await sees('kid', addRom('Hidden Before', { filename: 'hiddenbefore.sfc' })), false);
});

test('a video is not borrowed from a console where the title is blocked', async () => {
  const blocked = addRom('Borrowed Video', { slug: 'genesis', sort: 'borrowed video' });
  const allowed = addRom('Borrowed Video', { slug: 'snes', sort: 'borrowed video' });
  const file = path.join(TMP, 'borrowed.mp4'); fs.writeFileSync(file, 'video bytes');
  db.prepare("INSERT INTO game_videos (platform, title_key, path, bytes, source, fetched_at, tried_at) VALUES ('genesis', 'borrowed video', ?, 11, 'folder', datetime('now'), datetime('now'))").run(file);
  assert.equal((await call('kid', 'GET', `/videos/file?kind=rom&id=${allowed}`)).status, 200, 'the Mega Drive video serves the SNES game too');
  await block(blocked, [ids.kid]);
  assert.equal(await sees('kid', allowed), true);
  assert.equal((await call('kid', 'GET', `/videos/file?kind=rom&id=${allowed}`)).status, 404);
  assert.equal((await ok('kid', 'GET', '/roms?q=Borrowed')).items[0].has_video, undefined);
  assert.equal((await call('teen', 'GET', `/videos/file?kind=rom&id=${allowed}`)).status, 200);
});

/* ───────── members who may edit ───────── */

const patch = (who, id, body) => call(who, 'PATCH', `/roms/${id}`, body);
const png = () => { const f = new FormData(); f.append('cover', new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')], { type: 'image/png' }), 'c.png'); return f; };

test('editing needs a group, and every one of the person\'s groups to allow it', async () => {
  const id = addRom('Edit Rights');
  const editors = await makeGroup('Editors', { can_edit: true }), readers = await makeGroup('Readers');
  groups.editors = editors; groups.readers = readers;
  const canEdit = async (who) => {
    const flag = (await ok(who, 'GET', '/auth/me')).user.can_edit;
    const r = await patch(who, id, { developer: who });
    assert.equal(r.status === 200, flag, `${who}: ${r.status} ${r.text}`);
    return flag;
  };
  assert.equal(await canEdit('teen'), false, 'no group');
  await putIn('teen', [readers]);
  assert.equal(await canEdit('teen'), false);
  await putIn('teen', [editors, readers]);
  assert.equal(await canEdit('teen'), false, 'one of the two does not allow it');
  await putIn('teen', [editors]);
  assert.equal(await canEdit('teen'), true);
  await putIn('player', [editors]);
  assert.equal((await patch('player', id, { developer: 'x' })).status, 403, 'play only never edits');
});

test('a member who may edit changes text, match and cover, and nothing else', async () => {
  const id = addRom('Editable');
  assert.equal((await patch('teen', id, { title: 'Edited By Member', genre: 'Puzzle' })).status, 200);
  assert.equal(column(id, 'genre'), 'Puzzle');
  assert.equal((await patch('teen', id, { platform: 'megadrive' })).status, 403);
  const applied = await call('teen', 'POST', `/metadata/${id}/apply`, { candidate: { title: 'Picked', source: 'igdb', age_ratings: [{ source: 'igdb', board: 'ACB', rating: 'G' }] } });
  assert.equal(applied.status, 200, applied.text);
  assert.equal(column(id, 'title'), 'Picked');
  assert.equal(column(id, 'age_level'), null, 'ratings are the admin\'s');
  assert.ok(!applied.text.includes('nowhere'), 'no folder on the server is sent to a member');
  assert.equal(applied.json.rom.favourite_of, undefined);
  assert.equal((await call('teen', 'POST', `/metadata/${id}/apply`, { candidate: { title: 'X', source: 'admin' } })).status, 400);
  assert.equal((await call('teen', 'POST', `/metadata/${id}/refresh`, {})).status, 200);
  const cover = await call('teen', 'POST', `/roms/${id}/cover`, null, png());
  assert.equal(cover.status, 200, cover.text);
  assert.equal((await call('teen', 'DELETE', `/roms/${id}/cover`)).status, 200);
  for (const [method, url, body] of [['DELETE', `/roms/${id}`], ['POST', `/roms/${id}/hide-all`, {}], ['POST', '/ratings/set', { ids: [id], level: 1 }], ['PUT', `/groups/blocks/${id}`, { users: [], groups: [] }], ['POST', '/roms/bulk/lock', { ids: [id] }]]) {
    assert.equal((await call('teen', method, url, body)).status, 403, `${method} ${url}`);
  }
});

test('nobody edits a game they cannot see', async () => {
  const id = addRom('Cannot See');
  await block(id, [ids.teen]);
  for (const [method, url, body] of [['PATCH', `/roms/${id}`, { title: 'x' }], ['DELETE', `/roms/${id}/cover`], ['POST', `/metadata/${id}/refresh`, {}], ['POST', `/metadata/${id}/apply`, { candidate: { title: 'x', source: 'igdb' } }]]) {
    assert.equal((await call('teen', method, url, body)).status, 404, `${method} ${url}`);
  }
  assert.equal((await call('teen', 'POST', `/roms/${id}/cover`, null, png())).status, 404);
  assert.equal(column(id, 'title'), 'Cannot See');
});

test('a member\'s change of title takes no rating away, from this game or from its other versions', async () => {
  for (const source of ['admin', 'igdb']) {
    const rate = (id) => (source === 'admin' ? ratings.setAdminRating([id], 4) : ratings.addFetched(id, [{ board: 'acb', level: 4, source: 'igdb' }]));
    // the one retitled had its rating from the other version
    const rated = addRom(`Hold ${source}`, { sort: `hold ${source}` }), copy = addRom(`Hold ${source}`, { sort: `hold ${source}` });
    rate(rated);
    restrictions.flushRecords();
    assert.deepEqual([column(copy, 'age_level'), column(copy, 'age_inherited')], [4, 1]);
    assert.equal((await patch('teen', copy, { title: `Moved ${source}` })).status, 200);
    assert.deepEqual([column(copy, 'age_level'), column(copy, 'age_source')], [4, source]);
    // the other way round: the rated one is retitled, and the version left behind keeps what it had
    const lead = addRom(`Lead ${source}`, { sort: `lead ${source}` }), follower = addRom(`Lead ${source}`, { sort: `lead ${source}` });
    rate(lead);
    restrictions.flushRecords();
    assert.equal((await call('teen', 'POST', `/metadata/${lead}/apply`, { candidate: { title: `Elsewhere ${source}`, source: 'launchbox' } })).status, 200);
    assert.deepEqual([column(lead, 'age_level'), column(follower, 'age_level')], [4, 4]);
  }
});

/* A member who may edit writes what everyone else is shown, the admin included. */

test('only numbers go in the number fields, and only text in the others, however the change is made', async () => {
  const id = addRom('Safe Values');
  const mark = '<img src=x onerror=alert(1)>';
  const before = () => db.prepare('SELECT title, release_year, players, rating, region, revision, description FROM roms WHERE id = ?').get(id);
  const start = before();
  for (const who of ['teen', 'admin']) {
    for (const bad of [{ release_year: mark }, { release_year: 12 }, { release_year: 1999.5 }, { players: mark }, { players: -1 }, { rating: mark }, { rating: '1e9' }, { region: { a: 1 } }, { region: 'x'.repeat(201) },
      { revision: ['a'] }, { title: { a: 1 } }, { title: '' }, { title: null }, { description: 'x'.repeat(100001) }, { tags: 'one' }, { tags: [{ a: 1 }] }, { tags: ['x'.repeat(101)] }, { tags: Array(101).fill('t') },
      { genre: 'Fine', players: mark }]) {
      assert.equal((await patch(who, id, bad)).status, 400, `${who} ${JSON.stringify(bad).slice(0, 80)}`);
    }
  }
  assert.deepEqual(before(), start, 'a refused edit changes nothing');
  assert.equal((await patch('teen', id, { release_year: '1994', players: 2, rating: 4.5, region: 'USA', revision: 2, developer: '', tags: ['one'] })).status, 200);
  assert.deepEqual([column(id, 'release_year'), column(id, 'players'), column(id, 'rating'), column(id, 'revision'), column(id, 'developer')], [1994, 2, 4.5, '2', null]);

  // a picked match is whatever the request says it is: what does not fit is left out
  const r = await call('teen', 'POST', `/metadata/${id}/apply`, { candidate: { title: { a: 1 }, source: 'igdb', release_year: mark, players: mark, rating: mark, developer: { a: 1 }, publisher: 'p'.repeat(5000) } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([column(id, 'title'), column(id, 'release_year'), column(id, 'players'), column(id, 'rating'), column(id, 'developer'), column(id, 'publisher').length], ['Safe Values', null, null, null, null, 1000]);
});

test('the pages show a game\'s year, players, region and revision as text, never as page code', () => {
  // The second lock: whatever is stored, a value put into a page's HTML goes through esc() first. These are the shapes that once did not.
  const raw = /\$\{\s*(?:rom|r|c|g|v|it)\??\.(?:release_year|players|region|revision)(?:\s*(?:\|\||\?\?)\s*'[^']*')?\s*\}|\['(?:Year|Released|Players|Region|Revision)',\s*(?:rom|g)\.\w+\s*(?:\|\||\])/;
  const dir = new URL('../public/', import.meta.url);
  const wrong = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    fs.readFileSync(new URL(file, dir), 'utf8').split('\n').forEach((line, i) => {
      if (/const (chips|facts) = \[/.test(line)) return;   // Big Screen builds plain text there and escapes the whole of it
      if (raw.test(line.replace('esc(v.revision ? `Rev ${v.revision}` : \'\')', ''))) wrong.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  assert.deepEqual(wrong, []);
});

test('what a provider said when it failed goes to the admin only', () => {
  const source = fs.readFileSync(new URL('../src/routes/metadata.js', import.meta.url), 'utf8');
  assert.match(source, /reason: errorFor\(req\.user, result\.error\)/);
  assert.doesNotMatch(source, /json\(\{[^\n]*error: hits\.error(,| \|\|)/);
});
