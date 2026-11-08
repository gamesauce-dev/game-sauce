import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-messages-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'madmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'm-admin-password-1';

let server, base, db, msgs, tok = {}, id = {};
const call = async (p, { method = 'GET', body, as = 'admin' } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + tok[as], 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const say = (as, to, body, extra = {}) => call(`/api/messages/with/${id[to]}`, { method: 'POST', as, body: { body, ...extra } });
const thread = async (as, other) => (await call(`/api/messages/with/${id[other]}`, { as })).body.items;
const unread = async (as) => (await call('/api/messages/summary', { as })).body.unread;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  msgs = await import('../src/lib/messages.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok.admin = await login('madmin', 'm-admin-password-1');
  for (const u of ['ann', 'bob', 'pat', 'dan']) { await call('/api/auth/users', { method: 'POST', body: { username: u, password: `${u}-password-12`, role: 'user' } }); }
  for (const u of ['admin', 'ann', 'bob', 'pat', 'dan']) id[u] = db.prepare('SELECT id FROM users WHERE username = ?').get(u === 'admin' ? 'madmin' : u).id;
  db.prepare('UPDATE users SET play_only = 1 WHERE id = ?').run(id.pat);       // pat has the cut-down play screen
  for (const u of ['ann', 'bob', 'pat', 'dan']) tok[u] = await login(u, `${u}-password-12`);
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
const fresh = () => { db.prepare('DELETE FROM messages').run(); msgs._resetRate(); };

test('who one can write to: enabled people with chat, as names and pictures only', async () => {
  const names = (await call('/api/messages/people', { as: 'ann' })).body.items;
  assert.deepEqual(names.map((p) => p.username).sort(), ['bob', 'dan', 'madmin'], 'not herself, and not pat (play-only)');
  assert.deepEqual(Object.keys(names[0]).sort(), ['avatar_v', 'colour', 'id', 'name', 'username']);
  db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(id.dan);
  assert.ok(!(await call('/api/messages/people', { as: 'ann' })).body.items.some((p) => p.username === 'dan'), 'a disabled account is not offered');
  assert.equal((await say('ann', 'dan', 'hello')).status, 404);
  db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(id.dan);
});

test('send, unread, read, and the conversation list', async () => {
  fresh();
  assert.equal((await say('ann', 'bob', 'Fancy Mario Kart tonight?')).status, 201);
  assert.equal((await say('ann', 'bob', 'Bring snacks')).status, 201);
  assert.equal(await unread('bob'), 2); assert.equal(await unread('ann'), 0);
  const convs = (await call('/api/messages/conversations', { as: 'bob' })).body.items;
  assert.equal(convs.length, 1); assert.equal(convs[0].user.username, 'ann'); assert.equal(convs[0].unread, 2); assert.equal(convs[0].last.text, 'Bring snacks'); assert.equal(convs[0].last.mine, false);
  const t = await thread('bob', 'ann');
  assert.deepEqual(t.map((m) => [m.mine, m.body]), [[false, 'Fancy Mario Kart tonight?'], [false, 'Bring snacks']]);
  assert.ok(t.every((m) => !m.seen), 'not yet seen by bob');
  await call(`/api/messages/with/${id.ann}/read`, { method: 'POST', as: 'bob' });
  assert.equal(await unread('bob'), 0);
  assert.ok((await thread('ann', 'bob')).every((m) => m.seen), 'ann can see that bob has read them');
  await say('bob', 'ann', 'Yes please');
  assert.equal(await unread('ann'), 1);
  assert.equal((await call('/api/messages/conversations', { as: 'ann' })).body.items[0].last.mine, false);
});

test('only the two people in a conversation can read it: nobody else, the admin included', async () => {
  fresh();
  const m = await say('ann', 'bob', 'secret plan');
  // a third person asking about the same pair only ever gets their own conversation with that person
  assert.deepEqual(await thread('pat' === 'x' ? 'admin' : 'admin', 'bob'), [], 'the admin\'s conversation with bob is empty: ann\'s is not theirs');
  assert.deepEqual(await thread('admin', 'ann'), []);
  assert.equal((await call('/api/messages/conversations', { as: 'admin' })).body.items.length, 0);
  assert.equal((await call(`/api/messages/${m.body.id}`, { method: 'DELETE', as: 'admin' })).status, 404, 'cannot delete someone else\'s message');
  assert.equal((await call(`/api/messages/${m.body.id}/recall`, { method: 'POST', as: 'admin' })).status, 404);
  assert.equal((await call(`/api/messages/${m.body.id}/recall`, { method: 'POST', as: 'bob' })).status, 404, 'only the sender can recall');
  // nothing in the API lists or reads other people's messages
  for (const p of ['/api/messages', '/api/messages/all', `/api/messages/user/${id.ann}`, '/api/admin/messages']) assert.ok([404].includes((await call(p, { as: 'admin' })).status), p);
  assert.equal((await call('/api/messages/summary', { as: 'admin' })).body.unread, 0);
});

test('plain text of at most 200 characters, with no links', async () => {
  fresh();
  assert.equal((await say('ann', 'bob', '')).status, 400); assert.equal((await say('ann', 'bob', '   ')).status, 400);
  assert.equal((await say('ann', 'bob', 'x'.repeat(200))).status, 201);
  const long = await say('ann', 'bob', 'x'.repeat(201));
  assert.equal(long.status, 400); assert.match(long.body.error, /at most 200/);
  assert.equal((await say('ann', 'bob', '😀'.repeat(200))).status, 201, 'counted in characters, not bytes');
  assert.equal((await say('ann', 'bob', 'Hello    there\n\nfriend')).status, 201);
  assert.equal((await thread('bob', 'ann')).pop().body, 'Hello there friend', 'whitespace is tidied');
  for (const link of ['look at https://example.com/rom', 'http://x.y', 'www.example.org', 'get it at romsite.com', 'try foo.io now', 'dl.to/abc', 'mailto me at a@b.net']) {
    const r = await say('ann', 'bob', link);
    assert.equal(r.status, 400, link); assert.match(r.body.error, /Links can't be sent/, link);
  }
  assert.equal((await say('ann', 'bob', 'Mr. Do and Sonic 2 are great. See you at 7.30')).status, 201, 'ordinary punctuation and numbers are fine');
  assert.equal((await say('ann', 'bob', 'I am a <b>bold</b> "quoted" & friend')).status, 201);
  assert.equal((await thread('bob', 'ann')).pop().body, 'I am a <b>bold</b> "quoted" & friend', 'stored as text; the page escapes it');
});

test('delete is for me only; the other person keeps their copy; when both delete it is gone', async () => {
  fresh();
  const a = (await say('ann', 'bob', 'one')).body.id; await say('bob', 'ann', 'two');
  assert.equal((await call(`/api/messages/${a}`, { method: 'DELETE', as: 'ann' })).status, 200);
  assert.deepEqual((await thread('ann', 'bob')).map((m) => m.body), ['two'], 'gone for ann');
  assert.deepEqual((await thread('bob', 'ann')).map((m) => m.body), ['one', 'two'], 'bob still has it');
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(a));
  await call(`/api/messages/${a}`, { method: 'DELETE', as: 'bob' });
  assert.equal(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(a), undefined, 'deleted by both: removed for good');
  // a conversation with nothing left disappears from the list
  for (const m of await thread('ann', 'bob')) await call(`/api/messages/${m.id}`, { method: 'DELETE', as: 'ann' });
  assert.equal((await call('/api/messages/conversations', { as: 'ann' })).body.items.length, 0);
  assert.equal((await call(`/api/messages/${a}`, { method: 'DELETE', as: 'ann' })).status, 404);
});

test('replying quotes a message in this conversation; a quote of something you deleted is not shown', async () => {
  fresh();
  const a = (await say('ann', 'bob', 'Which game?')).body.id;
  assert.equal((await say('bob', 'ann', 'Astro Bot', { reply_to: a })).status, 201);
  const t = await thread('ann', 'bob');
  assert.deepEqual(t[1].reply, { id: a, mine: true, text: 'Which game?' });
  assert.equal((await say('bob', 'dan', 'nope', { reply_to: a })).status, 400, 'a message from another conversation cannot be quoted');
  assert.equal((await say('bob', 'ann', 'x', { reply_to: 99999 })).status, 400);
  await call(`/api/messages/${a}`, { method: 'DELETE', as: 'ann' });
  assert.equal((await thread('ann', 'bob'))[0].reply, null, 'ann deleted the quoted message, so her copy shows no quote');
  assert.equal((await thread('bob', 'ann'))[1].reply.text, 'Which game?', 'bob still has both');
});

test('the sender can recall a message for a few minutes: wiped for both, "recalled" left in its place', async () => {
  fresh();
  const m = (await say('ann', 'bob', 'wrong chat!')).body.id;
  assert.equal((await thread('ann', 'bob'))[0].can_recall, true); assert.equal((await thread('bob', 'ann'))[0].can_recall, false);
  assert.equal(await unread('bob'), 1);
  assert.equal((await call(`/api/messages/${m}/recall`, { method: 'POST', as: 'ann' })).status, 200);
  for (const [who, other] of [['ann', 'bob'], ['bob', 'ann']]) { const x = (await thread(who, other))[0]; assert.equal(x.recalled, true); assert.equal(x.body, ''); assert.equal(x.can_recall, false); }
  assert.equal(db.prepare('SELECT body, game FROM messages WHERE id = ?').get(m).body, '', 'the words are wiped, not just hidden');
  assert.equal(await unread('bob'), 0, 'a recalled message is no longer unread');
  assert.equal((await call('/api/messages/conversations', { as: 'bob' })).body.items[0].last.text, 'Message recalled');
  assert.equal((await call(`/api/messages/${m}/recall`, { method: 'POST', as: 'ann' })).status, 200, 'recalling twice is harmless');
  // after the window it is too late
  const old = (await say('ann', 'bob', 'too late')).body.id;
  db.prepare("UPDATE messages SET created_at = datetime('now', '-10 minutes') WHERE id = ?").run(old);
  assert.equal((await thread('ann', 'bob')).pop().can_recall, false);
  const late = await call(`/api/messages/${old}/recall`, { method: 'POST', as: 'ann' });
  assert.equal(late.status, 409); assert.match(late.body.error, /first 5 minutes/);
});

test('no more than 10 messages a minute from one person', async () => {
  fresh();
  for (let i = 0; i < 10; i++) assert.equal((await say('ann', 'bob', `m${i}`)).status, 201);
  const r = await say('ann', 'bob', 'one too many'); assert.equal(r.status, 429); assert.match(r.body.error, /too fast/);
  assert.equal((await say('bob', 'ann', 'bob has his own allowance')).status, 201);
  assert.equal((await thread('bob', 'ann')).filter((m) => !m.mine).length, 10, 'ann\'s eleventh was refused and not stored');
  msgs._resetRate();
});

test('sharing a game: only a note (title and platform) goes in the message; a game you do not have cannot be shared', async () => {
  fresh();
  const snes = db.prepare("SELECT id FROM platforms WHERE slug = 'snes'").get().id;
  const rom = db.prepare("INSERT INTO roms (platform_id, title, sort_title, filename, storage_path, size_bytes, sha1) VALUES (?, 'Super Metroid', 'super metroid', 'sm.sfc', 'x/sm.sfc', 1, 'sha-sm')").run(snes).lastInsertRowid;
  assert.equal((await say('ann', 'bob', 'play this', { game: { type: 'rom', id: rom } })).status, 201);
  const g = (await thread('bob', 'ann'))[0].game;
  assert.deepEqual(g, { type: 'rom', id: Number(rom), title: 'Super Metroid', platform: 'Super Nintendo' });
  assert.equal((await say('ann', 'bob', '', { game: { type: 'rom', id: rom } })).status, 201, 'a game alone is a message');
  assert.equal((await say('ann', 'bob', 'x', { game: { type: 'rom', id: 999999 } })).status, 400);
  // Digital and Physical are each person's own: only the owner can share from them, and only the title and platform travel
  db.prepare("INSERT INTO digital_games (user_id, store, app_id, name, platform) VALUES (?, 'playstation', 'astro-bot-ps5', 'Astro Bot', 'ps5')").run(id.ann);
  db.prepare("INSERT INTO digital_games (user_id, store, app_id, name, minutes) VALUES (?, 'steam', '620', 'Portal 2', 100)").run(id.ann);
  db.prepare("INSERT INTO physical_games (user_id, platform, title, sort_title, dedupe_key, cover_path, spine_path) VALUES (?, 'ps2', 'Gran Turismo 4', 'gran turismo 4', 'gt4|', '/secret/cover.png', '/secret/spine.png')").run(id.ann);
  const phys = db.prepare("SELECT id FROM physical_games WHERE title = 'Gran Turismo 4'").get().id;
  assert.equal((await say('ann', 'bob', 'a', { game: { type: 'digital', store: 'playstation', app_id: 'astro-bot-ps5' } })).status, 201);
  assert.equal((await say('ann', 'bob', 'b', { game: { type: 'digital', store: 'steam', app_id: '620' } })).status, 201);
  assert.equal((await say('ann', 'bob', 'c', { game: { type: 'physical', id: phys } })).status, 201);
  const shared = (await thread('bob', 'ann')).map((m) => m.game).filter(Boolean);
  assert.deepEqual(shared.slice(2).map((s) => [s.type, s.title, s.platform]), [['digital', 'Astro Bot', 'PlayStation 5'], ['digital', 'Portal 2', 'Steam'], ['physical', 'Gran Turismo 4', 'Sony PlayStation 2']]);
  assert.ok(!JSON.stringify(shared).includes('/secret'), 'no file paths or pictures travel with a share');
  assert.equal((await say('bob', 'ann', 'mine?', { game: { type: 'digital', store: 'steam', app_id: '620' } })).status, 400, 'bob does not have that in his Digital Library');
  assert.equal((await say('bob', 'ann', 'mine?', { game: { type: 'physical', id: phys } })).status, 400, 'nor ann\'s physical game');
  assert.equal((await say('ann', 'bob', 'x', { game: { type: 'file', path: '/etc/passwd' } })).status, 400, 'nothing but a game can be attached');
  // a recall takes the shared game back too
  const last = (await thread('ann', 'bob')).pop(); await call(`/api/messages/${last.id}/recall`, { method: 'POST', as: 'ann' });
  assert.equal(db.prepare('SELECT game FROM messages WHERE id = ?').get(last.id).game, null);
  msgs._resetRate();
});

test('a play-only account has no chat, cannot be written to, and still reads the admin\'s notices', async () => {
  fresh();
  assert.equal((await call('/api/messages/people', { as: 'pat' })).status, 403);
  assert.equal((await call('/api/messages/conversations', { as: 'pat' })).status, 403);
  assert.equal((await say('pat', 'ann', 'hi')).status, 403);
  assert.equal((await say('ann', 'pat', 'hi')).status, 404, 'play-only accounts cannot receive messages');
  assert.equal((await call('/api/messages/summary', { as: 'pat' })).body.chat, false);
  const n = await call('/api/messages/notices', { method: 'POST', body: { body: 'Maintenance tonight at 10' } });
  assert.equal(n.status, 201);
  const mine = (await call('/api/messages/notices', { as: 'pat' })).body.items;
  assert.equal(mine.length, 1); assert.equal(mine[0].body, 'Maintenance tonight at 10');
  assert.equal((await call(`/api/messages/notices/${n.body.id}/read`, { method: 'POST', as: 'pat' })).status, 200);
  assert.equal((await call(`/api/messages/notices/${n.body.id}`, { method: 'DELETE', as: 'pat' })).status, 200, 'and can dismiss it');
  assert.equal((await call('/api/messages/notices', { method: 'POST', as: 'pat', body: { body: 'x' } })).status, 403, 'but cannot post one');
  const { playOnlyAllows } = await import('../src/lib/playonly.js');
  assert.equal(playOnlyAllows('GET', '/messages/notices'), true); assert.equal(playOnlyAllows('GET', '/messages/conversations'), false); assert.equal(playOnlyAllows('POST', '/messages/with/3'), false);
  await call(`/api/messages/notices/${n.body.id}/withdraw`, { method: 'POST' });
});

test('notices: the admin posts to everyone; each person reads and dismisses their own; the admin can withdraw; they lapse', async () => {
  db.prepare('DELETE FROM notices').run(); db.prepare('DELETE FROM notice_state').run();
  assert.equal((await call('/api/messages/notices', { method: 'POST', as: 'ann', body: { body: 'hi all' } })).status, 403, 'only an admin');
  assert.equal((await call('/api/messages/notices', { method: 'POST', body: { body: '' } })).status, 400);
  assert.equal((await call('/api/messages/notices', { method: 'POST', body: { body: 'y'.repeat(201) } })).status, 400);
  assert.equal((await call('/api/messages/notices', { method: 'POST', body: { body: 'see https://x.com' } })).status, 400, 'no links in notices either');
  assert.equal((await call('/api/messages/notices', { method: 'POST', body: { body: 'x', hours: 0 } })).status, 400);
  const n = (await call('/api/messages/notices', { method: 'POST', body: { body: 'The server restarts at 10pm', hours: 24 } })).body.id;
  for (const who of ['ann', 'bob', 'pat']) { const list = (await call('/api/messages/notices', { as: who })).body.items; assert.equal(list.length, 1, who); assert.equal(list[0].unread, true); assert.equal(list[0].mine, false); }
  assert.equal((await call('/api/messages/summary', { as: 'ann' })).body.notices_unread, 1);
  assert.deepEqual((await call('/api/messages/summary', { as: 'ann' })).body.notice, { id: n, body: 'The server restarts at 10pm', from: 'madmin' });
  await call(`/api/messages/notices/${n}/read`, { method: 'POST', as: 'ann' });
  assert.equal((await call('/api/messages/summary', { as: 'ann' })).body.notices_unread, 0); assert.equal((await call('/api/messages/summary', { as: 'bob' })).body.notices_unread, 1, 'bob has not read it');
  await call(`/api/messages/notices/${n}`, { method: 'DELETE', as: 'bob' });
  assert.equal((await call('/api/messages/notices', { as: 'bob' })).body.items.length, 0, 'dismissed for bob');
  assert.equal((await call('/api/messages/notices', { as: 'ann' })).body.items.length, 1, 'still there for ann');
  assert.equal((await call(`/api/messages/notices/${n}/withdraw`, { method: 'POST', as: 'ann' })).status, 403);
  assert.equal((await call(`/api/messages/notices/${n}/withdraw`, { method: 'POST' })).status, 200);
  assert.equal((await call('/api/messages/notices', { as: 'ann' })).body.items.length, 0, 'withdrawn for everyone');
  const lapsing = (await call('/api/messages/notices', { method: 'POST', body: { body: 'short lived', hours: 1 } })).body.id;
  db.prepare("UPDATE notices SET expires_at = datetime('now', '-1 minutes') WHERE id = ?").run(lapsing);
  assert.equal((await call('/api/messages/notices', { as: 'ann' })).body.items.length, 0, 'lapsed');
});

test('the summary the page polls: unread count and the newest message, for the badge and the toast', async () => {
  fresh();
  let s = (await call('/api/messages/summary', { as: 'bob' })).body;
  assert.equal(s.unread, 0); assert.equal(s.latest, null); assert.equal(s.chat, true); assert.equal(s.max_length, 200); assert.equal(s.recall_minutes, 5);
  const a = (await say('ann', 'bob', 'first')).body.id, b = (await say('ann', 'bob', 'second')).body.id;
  s = (await call('/api/messages/summary', { as: 'bob' })).body;
  assert.equal(s.unread, 2); assert.deepEqual(s.latest, { id: b, from_id: id.ann, from: 'ann' });
  assert.ok(b > a);
  await call(`/api/messages/${b}`, { method: 'DELETE', as: 'bob' });
  assert.equal((await call('/api/messages/summary', { as: 'bob' })).body.unread, 1, 'a message deleted for me is no longer unread');
});

test('what is said, and who said it to whom, is never in the audit log an admin reads; a notice is', async () => {
  fresh();
  await say('ann', 'bob', 'private chatter xyzzy');
  const m = (await thread('ann', 'bob'))[0]; await call(`/api/messages/${m.id}/recall`, { method: 'POST', as: 'ann' });
  await call(`/api/messages/${m.id}`, { method: 'DELETE', as: 'ann' });
  const n = await call('/api/messages/notices', { method: 'POST', body: { body: 'audited notice' } });
  const log = JSON.stringify((await call('/api/auth/audit?limit=300')).body);
  assert.ok(!log.includes('xyzzy'), 'no message text');
  assert.ok(!/messages\/with|messages\/\d+/.test(log), 'no entry for sending, recalling or deleting a message');
  assert.ok(log.includes('messages/notices'), 'but an admin\'s notice is logged, as any admin act is');
  await call(`/api/messages/notices/${n.body.id}/withdraw`, { method: 'POST' });
});

test('when an account is deleted, every message it sent or received goes, on both sides', async () => {
  fresh();
  await say('ann', 'dan', 'hello dan'); await say('dan', 'ann', 'hello ann'); await say('ann', 'bob', 'bob stays');
  const dan = db.prepare('SELECT id FROM users WHERE username = ?').get('dan').id;
  const n = (await call('/api/messages/notices', { method: 'POST', body: { body: 'notice before dan goes' } })).body.id;
  db.prepare("INSERT INTO notice_state (user_id, notice_id, read_at) VALUES (?, ?, datetime('now'))").run(dan, n);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE sender_id = ? OR recipient_id = ?').get(dan, dan).c, 2);
  assert.equal((await call(`/api/auth/users/${dan}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE sender_id = ? OR recipient_id = ?').get(dan, dan).c, 0, 'both directions removed');
  assert.deepEqual((await thread('ann', 'bob')).map((x) => x.body), ['bob stays'], 'other conversations are untouched');
  assert.equal((await call('/api/messages/conversations', { as: 'ann' })).body.items.length, 1, 'ann no longer has a conversation with dan');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notice_state WHERE user_id = ?').get(dan).c, 0);
  await call(`/api/messages/notices/${n}/withdraw`, { method: 'POST' });
  // a notice outlives the admin who wrote it
  await call('/api/auth/users', { method: 'POST', body: { username: 'zed', password: 'zed-password-12', role: 'admin' } });
  const zed = db.prepare('SELECT id FROM users WHERE username = ?').get('zed').id; tok.zed = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'zed', password: 'zed-password-12' }) })).json()).token;
  const zn = (await call('/api/messages/notices', { method: 'POST', as: 'zed', body: { body: 'from zed' } })).body.id;
  assert.equal((await call(`/api/auth/users/${zed}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/messages/notices', { as: 'ann' })).body.items.find((x) => x.id === zn)?.from, 'Admin', 'the notice stays, from "Admin"');
});

test('the rules are in the code and in the words people read', () => {
  const lib = read('src/lib/messages.js'), route = read('src/routes/messages.js'), app = read('src/app.js'), mig = read('src/migrations.js');
  assert.match(lib, /MAX_LEN = 200/); assert.match(lib, /RECALL_MINUTES = 5/); assert.match(lib, /At most 10 messages a minute|max: 10/);
  assert.match(app, /api\.use\('\/messages', messagesRouter\)/); assert.match(app, /messages\(\?!\\\/notices\)/, 'messages are skipped by the audit log');
  assert.match(mig, /CREATE TABLE IF NOT EXISTS messages/); assert.match(mig, /schema_version', '40'/);
  assert.doesNotMatch(route, /requireAdmin[^;]*thread|requireAdmin[^;]*conversations/, 'no admin route reads a conversation');
  assert.match(read('src/auth.js'), /purgeMessages\(userId\)/);
});

test('the Messages page: menu entries with an unread badge, the two panes, a composer with a counter and share, notices, and the app wiring', () => {
  const html = read('public/index.html'), js = read('public/messages.js'), css = read('public/messages.css'), app = read('public/app.js'), modern = read('public/modern.js'), mcss = read('public/modern.css');
  for (const id of ['view-messages', 'msg-wrap', 'msg-notices', 'msg-convs', 'msg-main', 'msg-new', 'msg-admin', 'msg-notice-text', 'msg-notice-hours', 'msg-notice-send']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /data-view="messages"/); assert.match(html, /href="\/messages\.css/);
  // a person who writes is checked on the page too: 200 characters, no links, plain text
  assert.match(js, /\[\.\.\.e\.target\.value\]\.slice\(0, max\)/, 'the box stops at the limit, counted in characters'); assert.match(js, /Plain text only, no links\. Private to you two\./);
  assert.match(js, /esc\(m\.body\)/, 'a message is shown as text, never as markup'); assert.doesNotMatch(js, /innerHTML = [^;]*m\.body(?!\))/, 'no unescaped message text');
  // the badge, the toast and the polling
  assert.match(js, /setAttribute\('data-badge'/); assert.match(js, /ctx\.toast\(`New message from \$\{s\.latest\.from\}`\)/); assert.match(js, /viewOpen\(\) \? 8000 : 30000/);
  assert.match(js, /if \(!ctx\?\.user\?\.\(\)\) return;/, 'stops asking when signed out'); assert.match(js, /if \(!document\.hidden\)/, 'and while the tab is hidden');
  assert.match(css, /\.nav-item\[data-badge\]::after \{ content: attr\(data-badge\);/); assert.match(mcss, /body\.ui-modern \.mb-navbtn\[data-badge\]::after \{ content: attr\(data-badge\);/);
  // what a message offers: reply, delete for me, recall (only while it can be), share
  for (const a of ['reply', 'delete', 'recall', 'share', 'send', 'open-rom', 'dismiss', 'withdraw', 'notice-send']) assert.match(js, new RegExp(`data-msg-act="${a}"|act === '${a}'`), a);
  assert.match(js, /m\.can_recall/); assert.match(js, /Delete for me/); assert.match(js, /The other person keeps their copy/);
  // a shared game carries its title and platform; opening a ROM goes through the Library
  assert.match(js, /ref: \{ type: 'rom', id: g\.id \}/); assert.match(js, /ctx\.openRom\?\.\(id\)/);
  // wired in like the other pages, with Modern icons for the buttons and the menu entry
  assert.match(app, /import \* as messages from '\.\/messages\.js'/); assert.match(app, /messages\.initMessages\(/); assert.match(app, /if \(view === 'messages'\) messages\.load\(\);/);
  assert.match(modern, /view: 'messages', icon: 'messages'/); assert.ok(fs.existsSync(new URL('../public/modern/icons/messages.svg', import.meta.url)));
  for (const sel of ['#msg-send', '#msg-share', '#msg-notice-send']) assert.ok(modern.includes(`['${sel}'`), sel);
  // the page reads what it needs from modules that export it
  const exported = new Set([...read('public/messages.js').matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map((m) => m[1]));
  for (const name of ['initMessages', 'load']) assert.ok(exported.has(name), name);
  assert.match(read('public/digital.js'), /export const badgeLabel = /);
  // narrow windows show the list or the conversation, one at a time
  assert.match(css, /\.msg-wrap\.in-thread \.msg-side \{ display: none; \}/);
});

test('a whole conversation can be deleted: for me only, the other person keeps theirs, and a message both delete is gone', async () => {
  fresh();
  await say('ann', 'bob', 'one'); await say('bob', 'ann', 'two'); await say('ann', 'bob', 'three'); await say('admin', 'bob', 'admin to bob');
  assert.equal(await unread('bob'), 3);
  assert.equal((await call(`/api/messages/with/${id.ann}`, { method: 'DELETE', as: 'bob' })).body.deleted, 3, 'all three, sent and received');
  assert.equal((await call('/api/messages/conversations', { as: 'bob' })).body.items.map((c) => c.user.username).join(), 'madmin', 'bob\'s conversation with ann is gone from his list; the admin\'s stays');
  assert.deepEqual(await thread('bob', 'ann'), []);
  assert.equal(await unread('bob'), 1, 'what he deleted no longer counts as unread');
  assert.deepEqual((await thread('ann', 'bob')).map((m) => m.body), ['one', 'two', 'three'], 'ann still has all of it');
  assert.equal((await call('/api/messages/conversations', { as: 'ann' })).body.items.length, 1);
  // a message arriving afterwards starts a fresh conversation for bob, without the old messages
  await say('ann', 'bob', 'fresh start');
  assert.deepEqual((await thread('bob', 'ann')).map((m) => m.body), ['fresh start']); assert.equal((await thread('ann', 'bob')).length, 4);
  // when ann deletes hers too, everything older is gone for good
  await call(`/api/messages/with/${id.bob}`, { method: 'DELETE', as: 'ann' });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE body IN (?, ?, ?)').get('one', 'two', 'three').c, 0, 'deleted by both: removed for good');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE body = 'fresh start'").get().c, 1, 'bob still has the new one');
  // it only ever touches the caller's own conversation with that person; another pair is untouched, and a stranger's id does nothing
  assert.equal((await call(`/api/messages/with/${id.ann}`, { method: 'DELETE', as: 'admin' })).body.deleted, 0, 'the admin has no conversation with ann, so there is nothing to delete');
  assert.deepEqual((await thread('admin', 'bob')).map((m) => m.body), ['admin to bob']);
  assert.equal((await call(`/api/messages/with/${id.ann}`, { method: 'DELETE', as: 'pat' })).status, 403, 'no chat for a play-only account');
  const log = JSON.stringify((await call('/api/auth/audit?limit=300')).body);
  assert.ok(!/messages\/with/.test(log), 'and it is not in the audit log either');
  assert.match(read('public/messages.js'), /data-msg-act="delete-conv"/); assert.match(read('public/messages.js'), /Every message in it is deleted for you only\. The other person keeps their copy/);
});

test('in a conversation, what I wrote is green on the right and what I received is purple on the left (the colour of the highlighted conversation)', () => {
  const css = read('public/messages.css');
  assert.match(css, /\.msg \{ --mine: #2e9e5b; \}/);
  assert.match(css, /\.msg\.mine \{ align-self: flex-end; background: color-mix\(in srgb, var\(--mine\) 26%, var\(--panel\)\);/);
  assert.match(css, /\.msg\.theirs \{ align-self: flex-start; background: color-mix\(in srgb, var\(--who, var\(--accent, #7c5cff\)\) 18%, var\(--panel\)\);/, 'a received message takes the sender\'s colour');
  assert.doesNotMatch(css.slice(css.indexOf('.msg.mine {'), css.indexOf('.msg.mine {') + 200), /--accent/, 'my bubble is not the accent colour the highlighted conversation uses');
  assert.match(css, /\.msg-conv\.on \{ background: color-mix\(in srgb, var\(--who, var\(--accent, #7c5cff\)\) 18%, transparent\); \}/, 'the highlighted conversation has the same tint as the messages received from that person');
});

test('a new game-sauce: the admins are told once per version in Messages (from game-sauce, with how to update), and members never see it', async () => {
  const { noticeFromCheck } = await import('../src/lib/updatenotify.js');
  db.prepare("DELETE FROM meta WHERE key = 'update_notified'").run();
  const check = { enabled: true, newer: true, latest: 'v9.9.9', current: '0.3.0', how: 'Download the new installer and run it.' };
  const first = noticeFromCheck(check);
  assert.ok(first > 0, 'a notice was made');
  const seen = (await call('/api/messages/notices', { as: 'admin' })).body.items.find((n) => n.id === first);
  assert.ok(seen); assert.equal(seen.from, 'game-sauce'); assert.equal(seen.unread, true);
  assert.match(seen.body, /game-sauce 9\.9\.9 is available \(you have 0\.3\.0\)\. Download the new installer/); assert.ok(!msgs.hasLink(seen.body), 'no link in it');
  assert.equal((await call('/api/messages/summary', { as: 'admin' })).body.notice.id, first, 'so the admin gets the usual toast and badge');
  for (const who of ['ann', 'bob', 'pat']) assert.ok(!(await call('/api/messages/notices', { as: who })).body.items.some((n) => n.id === first), who + ' does not see it');
  assert.equal(noticeFromCheck(check), null, 'the same version is never announced twice');
  // dismissed, and still not announced again
  assert.equal((await call(`/api/messages/notices/${first}`, { method: 'DELETE', as: 'admin' })).status, 200);
  assert.equal(noticeFromCheck(check), null);
  const next = noticeFromCheck({ ...check, latest: 'v10.0.0' });
  assert.ok(next > first, 'a later version is a new announcement');
  assert.equal(noticeFromCheck({ ...check, newer: false }), null); assert.equal(noticeFromCheck(null), null); assert.equal(noticeFromCheck({ newer: true }), null);
  const admins = db.prepare("SELECT audience FROM notices WHERE id = ?").get(next);
  assert.equal(admins.audience, 'admins');
  // an admin's own notice is still for everyone
  const own = await call('/api/messages/notices', { method: 'POST', body: { body: 'Maintenance at 10' } });
  assert.ok((await call('/api/messages/notices', { as: 'ann' })).body.items.some((n) => n.id === own.body.id));
  await call(`/api/messages/notices/${own.body.id}/withdraw`, { method: 'POST' });
  await call(`/api/messages/notices/${next}/withdraw`, { method: 'POST' });
});

test('the notifier runs from the server (a first check soon after start, then every six hours) and when an admin looks at the update notice', () => {
  const srv = read('src/server.js'), app = read('src/app.js'), un = read('src/lib/updatenotify.js');
  assert.ok(srv.includes('startUpdateNotifier(fetchLatestRelease)'));
  assert.ok(app.includes("noticeFromCheck(result)"));
  assert.ok(un.includes('2 * 60 * 1000') && un.includes('6 * 60 * 60 * 1000') && un.includes('.unref()'));
  assert.ok(read('src/migrations.js').includes("ADD COLUMN audience TEXT NOT NULL DEFAULT 'all'"));
});
