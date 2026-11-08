import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-ucolour-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'cadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'c-admin-password-1';

let server, base, db, colours, tok = {};
const call = async (p, { method = 'GET', body, as = 'admin' } = {}) => {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + tok[as], 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const add = (username, extra = {}) => call('/api/auth/users', { method: 'POST', body: { username, password: `${username}-password-12`, role: 'user', ...extra } });
const users = async () => (await call('/api/auth/users')).body;
const colourOf = async (name) => (await users()).items.find((u) => u.username === name).colour;

before(async () => {
  const { prepareApp } = await import('../src/app.js');
  const { app } = await prepareApp();
  db = (await import('../src/db.js')).default;
  colours = await import('../src/lib/colours.js');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  tok.admin = await login('cadmin', 'c-admin-password-1');
});
after(() => { server?.close(); try { db?.close(); } catch { /* shared */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

test('the palette: every colour is readable on both themes and none is green', () => {
  assert.equal(new Set(colours.USER_COLOURS).size, colours.USER_COLOURS.length, 'no repeats');
  for (const c of colours.USER_COLOURS) { assert.equal(colours.userColour(c).ok, true, c); assert.equal(colours.isGreen(c), false, c + ' is not green'); }
});

test('a person\'s colour must be readable on both themes, and not green (green is for your own messages in the chat)', () => {
  for (const green of ['#2e9e5b', '#107c10', '#4ade80', '#16a34a', '#34d399', '#22c55e']) { const r = colours.userColour(green); assert.equal(r.ok, false, green); assert.match(r.reason, /Green is kept for your own messages/, green); }
  assert.match(colours.userColour('#101010').reason, /too dark/); assert.match(colours.userColour('#fafafa').reason, /too light/); assert.equal(colours.userColour('#00ff00').ok, false, 'pure green is refused too (as too light)'); assert.match(colours.userColour('red').reason, /Use a colour like/);
  for (const ok of ['#7c5cff', '#3b82f6', '#ec4899', '#f97316', '#ef4444', '#f59e0b', '#06b6d4', '#a855f7']) assert.equal(colours.userColour(ok).ok, true, ok);
  assert.equal(colours.userColour('#7C5CFF').colour, '#7c5cff', 'stored in lower case');
});

test('the next free colour: the first palette colour nobody has, then round again', () => {
  const P = colours.USER_COLOURS;
  assert.equal(colours.nextUserColour([]), P[0]); assert.equal(colours.nextUserColour([P[0], P[1]]), P[2]); assert.equal(colours.nextUserColour([P[1].toUpperCase()]), P[0], 'case does not matter');
  assert.equal(colours.nextUserColour([...P]), P[0], 'all taken: round again');
});

test('the first admin account has a colour, and so does every account made without one (each the next free colour)', async () => {
  const list = await users();
  const admin = list.items.find((u) => u.username === 'cadmin');
  assert.equal(admin.colour, colours.USER_COLOURS[0], 'the first account starts the palette');
  assert.equal(list.suggested, colours.USER_COLOURS[1], 'the form suggests the next colour nobody has');
  assert.deepEqual(list.palette, colours.USER_COLOURS);
  const a = await add('ann'); assert.equal(a.status, 201); assert.equal(a.body.colour, colours.USER_COLOURS[1]);
  const b = await add('bob'); assert.equal(b.body.colour, colours.USER_COLOURS[2], 'a different one each time');
  assert.equal((await users()).suggested, colours.USER_COLOURS[3]);
  assert.ok((await users()).items.every((u) => /^#[0-9a-f]{6}$/.test(u.colour)), 'nobody is without one');
});

test('an admin can choose the colour when the account is made; a bad one is refused with the reason and nothing is created', async () => {
  const r = await add('cat', { colour: '#F97316' });
  assert.equal(r.status, 201); assert.equal(r.body.colour, '#f97316'); assert.equal(await colourOf('cat'), '#f97316');
  for (const [colour, reason] of [['#2e9e5b', /Green is kept/], ['#0a0a0a', /too dark/], ['#ffffff', /too light/], ['blue', /Use a colour like/]]) {
    const bad = await add(`bad${colour.replace(/\W/g, '')}`, { colour }); assert.equal(bad.status, 400, colour); assert.match(bad.body.error, reason, colour);
  }
  assert.equal((await users()).items.some((u) => u.username.startsWith('bad')), false, 'a refused colour creates no account');
  const blank = await add('dan', { colour: '' }); assert.equal(blank.status, 201); assert.match(blank.body.colour, /^#[0-9a-f]{6}$/, 'an empty colour means the next free one');
});

test('an admin can change anyone\'s colour later; members cannot; empty gives the next free colour', async () => {
  const ann = (await users()).items.find((u) => u.username === 'ann');
  const set = await call(`/api/auth/users/${ann.id}`, { method: 'PATCH', body: { colour: '#3B82F6' } });
  assert.equal(set.status, 200); assert.equal(set.body.colour, '#3b82f6');
  const green = await call(`/api/auth/users/${ann.id}`, { method: 'PATCH', body: { colour: '#22c55e' } });
  assert.equal(green.status, 400); assert.match(green.body.error, /Green is kept/); assert.equal(await colourOf('ann'), '#3b82f6', 'the old colour stays');
  assert.equal((await call(`/api/auth/users/${ann.id}`, { method: 'PATCH', body: { colour: '#111111' } })).status, 400);
  const reset = await call(`/api/auth/users/${ann.id}`, { method: 'PATCH', body: { colour: '' } });
  assert.equal(reset.status, 200); assert.match(reset.body.colour, /^#[0-9a-f]{6}$/);
  const login = async (u) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: `${u}-password-12` }) })).json()).token;
  tok.ann = await login('ann');
  assert.equal((await call(`/api/auth/users/${ann.id}`, { method: 'PATCH', as: 'ann', body: { colour: '#ec4899' } })).status, 403, 'a member cannot change colours, not even their own');
  assert.equal((await call('/api/auth/users', { as: 'ann' })).status, 403, 'nor read the list of accounts');
});

test('the chat carries each person\'s colour: the people list, the conversations and the thread\'s person', async () => {
  const bob = (await users()).items.find((u) => u.username === 'bob');
  await call(`/api/auth/users/${bob.id}`, { method: 'PATCH', body: { colour: '#ec4899' } });
  const people = (await call('/api/messages/people', { as: 'ann' })).body.items;
  assert.equal(people.find((p) => p.username === 'bob').colour, '#ec4899');
  assert.ok(people.every((p) => /^#[0-9a-f]{6}$/.test(p.colour)));
  tok.bob = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'bob-password-12' }) })).json()).token;
  await call(`/api/messages/with/${(await call('/api/auth/me', { as: 'ann' })).body.user.id}`, { method: 'POST', as: 'bob', body: { body: 'hi ann' } });
  const convs = (await call('/api/messages/conversations', { as: 'ann' })).body.items;
  assert.equal(convs[0].user.username, 'bob'); assert.equal(convs[0].user.colour, '#ec4899', 'the conversation list shows bob in his colour');
  // a person with no colour (impossible from the app, but an old row could be) is simply not tinted
  db.prepare("UPDATE users SET colour = NULL WHERE username = 'bob'").run();
  assert.equal((await call('/api/messages/conversations', { as: 'ann' })).body.items[0].user.colour, null);
});

test('an account\'s colour is in the admin screens and the chat uses it for the avatar, the row and received messages', () => {
  const html = read('public/index.html'), app = read('public/app.js'), js = read('public/messages.js'), css = read('public/messages.css');
  assert.match(html, /<input name="colour" type="color" value="#7c5cff" \/>/); assert.match(html, /grid-template-columns:1fr 1fr 1fr 5\.5rem auto/);
  assert.match(html, /Green is kept for your own messages/);
  assert.match(app, /colour: fd\.get\('colour'\)/, 'sent when the account is made');
  assert.match(app, /newColour\.value = suggested/, 'the form starts on the first colour nobody has');
  assert.match(app, /data-act="colour-setting"/); assert.match(app, /JSON\.stringify\(\{ colour: e\.target\.value \}\)/);
  assert.match(js, /const tint = \(p\) =>/); assert.match(js, /style="\$\{tint\(c\.user\)\}"/); assert.match(js, /id="msg-list" style="\$\{tint\(who\)\}"/);
  assert.match(css, /\.msg-av \{[^}]*var\(--who, var\(--accent, #7c5cff\)\)/);
  assert.match(css, /\.msg\.theirs \{[^}]*var\(--who, var\(--accent, #7c5cff\)\)/); assert.match(css, /\.msg-conv\.on \{[^}]*var\(--who, var\(--accent, #7c5cff\)\)/);
  assert.match(css, /\.msg\.mine \{[^}]*var\(--mine\)/, 'what I wrote stays green');
});
