// Who may use what, checked against the table in route-rules.js, so that a new route cannot ship without somebody deciding who may use it,
// and an existing one cannot quietly become open to more accounts (or closed to some). It proves who gets past the permission check, not every
// rule inside a route: a route whose meaning changes with what is sent needs its own entry in BY_CONTENT, or its own test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROUTES, BY_CONTENT } from './route-rules.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-routes-test-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'rtadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'rt-admin-password-1';
process.env.GAMESAUCE_RATE_LIMIT = '0';
process.env.GAMESAUCE_UPDATE_CHECK = '0';

// who is who, lowest first; each level includes the ones after it
const ACCOUNTS = ['anonymous', 'play', 'member', 'admin'];
const LOWEST = { public: 'anonymous', play: 'play', member: 'member', admin: 'admin' };
const below = (who) => ACCOUNTS.slice(0, ACCOUNTS.indexOf(LOWEST[who]));
const fromLevel = (who) => ACCOUNTS.slice(ACCOUNTS.indexOf(LOWEST[who]));

let app, server, base, db, realFetch, plainRom, token = { anonymous: null }, ids = {};

async function call(account, method, url, { body, raw } = {}) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 15000);
  try {
    const res = await realFetch(base + '/api' + url, {
      method, redirect: 'manual', signal: stop.signal,
      headers: { ...(token[account] ? { Authorization: `Bearer ${token[account]}` } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) },
      body: raw || (body ? JSON.stringify(body) : undefined)
    });
    // a page that streams for as long as it is open (progress) is only asked for its first answer
    if (/event-stream/.test(res.headers.get('content-type') || '')) { stop.abort(); return { status: res.status, text: '' }; }
    return { status: res.status, text: Buffer.from(await res.arrayBuffer()).toString('utf8') };
  } finally { clearTimeout(timer); }
}

/** Was this refused because of WHO asked (not signed in, or the wrong kind of account)? A 404, or "downloads are off", is not that. */
const refused = (account, r) => (account === 'anonymous' ? r.status === 401 : r.status === 403 && /Admin only|playing games only|Only an admin/.test(r.text));

/** Every route the app really has, as "METHOD /path" without the /api in front. Reads Express 4's own list. */
function appRoutes() {
  const out = new Set();
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) for (const p of [].concat(layer.route.path)) out.add(`${m.toUpperCase()} ${prefix + (p === '/' ? '' : p)}`);
      } else if (layer.handle?.stack) {
        const mount = layer.regexp.fast_slash ? '' : layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/');
        walk(layer.handle.stack, prefix + mount);
      }
    }
  };
  walk(app._router.stack, '');
  return [...out].filter((r) => r.split(' ')[1].startsWith('/api/')).map((r) => r.replace(' /api', ' ').replace(/\(\\d\+\)/g, ''));
}

const SAMPLE = { slug: 'nosuch', platform: 'nosuch', store: 'xbox', appId: 'nosuch', kind: 'logo', token: 'x'.repeat(30), lid: 'x'.repeat(30), key: 'nosuch', name: 'nosuch', filename: 'a.sfc' };
/** A real address for a route: a real ROM where it takes one (so "not found" cannot stand in for a missing permission check). */
const fill = (p, rom = plainRom) => p.replace(/^\/roms\/:id\b/, `/roms/${rom}`).replace(/:(\w+)/g, (_, n) => SAMPLE[n] || '999999');
const entries = () => Object.entries(ROUTES).flatMap(([who, list]) => list.map((r) => { const [method, route] = r.split(' '); return { who, method, route, name: r }; }));

/** Everything in the database that a request must not be able to change by being refused. */
function fingerprint() {
  const skip = new Set(['sessions', 'audit_log', 'login_attempts', 'sqlite_sequence']);
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%'").all()) {
    if (!skip.has(name)) out[name] = crypto.createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).digest('hex');
  }
  return out;
}

const addRom = (title, filename, extra = {}) => {
  const file = path.join(TMP, filename);
  fs.writeFileSync(file, `bytes of ${title}`);
  const id = Number(db.prepare("INSERT INTO roms (title, sort_title, filename, platform_id, storage_path, size_bytes, sha1, meta_source, genre, region) VALUES (?, ?, ?, (SELECT id FROM platforms WHERE slug = 'snes'), ?, 1, ?, 'filename', ?, ?)")
    .run(title, title.toLowerCase(), filename, file, `sha-${filename}`, extra.genre || null, extra.region || null).lastInsertRowid);
  return id;
};

before(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => (base && String(u).startsWith(base) ? realFetch(u, o) : Promise.reject(new Error('no outside requests in this test')));
  const { prepareApp } = await import('../src/app.js');
  ({ app } = await prepareApp());
  db = (await import('../src/db.js')).default;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => JSON.parse((await call('anonymous', 'POST', '/auth/login', { body: { username: u, password: p } })).text).token;
  token.admin = await login('rtadmin', 'rt-admin-password-1');
  for (const [name, user] of [['member', 'rtmember'], ['play', 'rtplay'], ['other', 'rtother']]) {
    const made = JSON.parse((await call('admin', 'POST', '/auth/users', { body: { username: user, password: `${user}-password-12`, role: 'user' } })).text);
    ids[name] = made.id;
    if (name === 'play') await call('admin', 'PATCH', `/auth/users/${made.id}`, { body: { mode: 'play' } });
    token[name] = await login(user, `${user}-password-12`);
  }
  plainRom = addRom('Plain Game', 'plain.sfc');
});
after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  db?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ }
});

test('every route is in the table exactly once, and the table has no routes the app does not', () => {
  const real = appRoutes(), listed = entries().map((e) => e.name);
  assert.ok(real.length >= 250, `only ${real.length} routes found: the way they are read may no longer work`);
  assert.deepEqual(real.filter((r) => !listed.includes(r)), [], 'NEW ROUTES: decide who may use each and add it to tests/route-rules.js');
  assert.deepEqual(listed.filter((r) => !real.includes(r)), [], 'in tests/route-rules.js but gone from the app');
  assert.equal(new Set(listed).size, listed.length, 'listed twice');
});

test('accounts below a route\'s level are refused, and being refused changes nothing', async () => {
  const wrong = [], start = fingerprint();
  for (const e of entries()) {
    if (e.who === 'public' || e.who === 'token') continue;
    for (const account of below(e.who)) {
      const r = await call(account, e.method, fill(e.route), { body: e.method === 'GET' ? undefined : {} });
      if (!refused(account, r)) wrong.push(`${e.name} let ${account} through (${r.status})`);
    }
  }
  for (const [who, entry] of BY_CONTENT) {
    const q = real(entry);
    for (const account of below(who)) {
      const r = await call(account, q.method, q.url, { body: q.body });
      if (!refused(account, r)) wrong.push(`${q.method} ${q.url} ${JSON.stringify(q.body || '')} let ${account} through (${r.status})`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.deepEqual(fingerprint(), start, 'a refused request changed the database');
});

// Only requests that read are made here: letting every account really use every route that changes things would delete the test's own accounts and games.
test('accounts at a route\'s level or above are not turned away (routes that only read)', async () => {
  const wrong = [];
  for (const e of entries()) {
    if (e.method !== 'GET' || e.who === 'token') continue;
    for (const account of fromLevel(e.who)) {
      const r = await call(account, 'GET', fill(e.route));
      if (refused(account, r)) wrong.push(`${e.name} refused ${account}: ${r.text.slice(0, 100)}`);
    }
  }
  for (const [who, entry] of BY_CONTENT) {
    const q = real(entry);
    if (q.method !== 'GET') continue;
    for (const account of fromLevel(who)) if (refused(account, await call(account, 'GET', q.url))) wrong.push(`${q.url} refused ${account}`);
  }
  assert.deepEqual(wrong, []);
});

test('a code that is not real gets nothing from the routes that take a code instead of a sign-in', async () => {
  for (const e of entries().filter((x) => x.who === 'token')) {
    const r = await call('anonymous', e.method, fill(e.route), { body: e.method === 'GET' ? undefined : {} });
    assert.ok(r.status >= 400, `${e.name} answered ${r.status}`);
  }
});

const real = (q) => JSON.parse(JSON.stringify(q).split('{rom}').join(String(plainRom)));

/* ───────── one game hidden from members ───────── */

const WORD = 'Qvxhidden';   // in everything about the hidden games; it must reach no member
let hidden;

test('every route that takes a game answers "not found" for a hidden one, however its number is written', async () => {
  const byAdmin = addRom(`${WORD} By Admin`, `${WORD}-a.sfc`, { genre: `${WORD}Genre`, region: `${WORD}Region` });
  const bySource = addRom(`${WORD} By Source`, `${WORD}-b.sfc`, { genre: `${WORD}Genre2` });
  // while still visible, the member saves a game of it and puts it in a collection: neither may name it afterwards
  assert.equal((await call('member', 'POST', `/roms/${byAdmin}/saves?kind=state`, { raw: Buffer.from('state') })).status, 201);
  const collection = JSON.parse((await call('member', 'POST', '/collections', { body: { name: 'Kept' } })).text).id;
  await call('member', 'POST', `/collections/${collection}/roms`, { body: { rom_id: byAdmin, rom_ids: [byAdmin] } });
  db.prepare('UPDATE roms SET hidden_all = 1 WHERE id = ?').run(byAdmin);
  db.prepare('UPDATE roms SET source_hidden = 1 WHERE id = ?').run(bySource);
  hidden = { byAdmin, bySource };

  const takesGame = entries().filter((e) => /^\/roms\/:id(\/|$)/.test(e.route) && (e.who === 'play' || e.who === 'member'));
  assert.ok(takesGame.length >= 15, 'the routes that take a game');
  const wrong = [];
  for (const id of [byAdmin, bySource]) {
    const spellings = [`${id}`, `${id}.0`, `${id}e0`, `+${id}`, `%20${id}`, `${id}%20`, `0${id}`];
    for (const e of takesGame) {
      for (const account of e.who === 'play' ? ['play', 'member'] : ['member']) {
        for (const spelled of spellings) {
          const r = await call(account, e.method, fill(e.route, spelled), { body: e.method === 'GET' ? undefined : {} });
          // a play-only account may be turned away before the game is looked at, if the address is not one it is allowed at all
          if (r.status !== 404 && !(account === 'play' && refused(account, r))) wrong.push(`${e.name} as ${account} with ${spelled}: ${r.status}`);
        }
      }
    }
  }
  assert.deepEqual(wrong, []);
});

test('nothing a member can read mentions a hidden game, or where files are on the server', async () => {
  assert.ok(hidden, 'the hidden games of the test above');
  const folder = TMP.split(path.sep).join('/').toLowerCase();
  const wrong = [];
  const reads = entries().filter((e) => e.method === 'GET' && (e.who === 'public' || e.who === 'play' || e.who === 'member')).map((e) => [e.who, fill(e.route), e.name]);
  reads.push(['play', '/roms?limit=500', 'the whole list'], ['member', '/roms?hidden=1', 'the hidden filter'], ['member', `/collections`, 'collections']);
  for (const { id } of db.prepare('SELECT id FROM collections WHERE user_id = ?').all(ids.member)) reads.push(['member', `/collections/${id}`, 'the collection']);
  for (const [who, url, name] of reads) {
    for (const account of who === 'member' ? ['member'] : ['play', 'member']) {
      const r = await call(account, 'GET', url);
      const text = r.text.replace(/\\+/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
      if (text.includes(WORD.toLowerCase())) wrong.push(`${name} as ${account} names a hidden game`);
      if (text.includes(folder)) wrong.push(`${name} as ${account} shows a server folder`);
    }
  }
  assert.deepEqual(wrong, []);
});

/* ───────── things that belong to one person ───────── */

test('another person, the admin included, cannot read, change or delete what is one person\'s own', async () => {
  const MINE = 'Wjkprivate';
  const made = async (url, body, opts) => { const r = await call('member', 'POST', url, opts || { body }); assert.ok(r.status < 300, `${url}: ${r.status} ${r.text}`); return JSON.parse(r.text); };
  const physical = (await made('/physical/games', { platform: 'ps3', title: `${MINE} Disc`, notes: `${MINE} notes` })).id;
  const link = await call('member', 'PUT', `/physical/games/${physical}/manual`, { body: { link: `https://example.com/${MINE}.pdf` } });
  assert.equal(link.status, 200, link.text);
  const collection = (await made('/collections', { name: `${MINE} list` })).id;
  const digital = await made('/digital/games', { platform: 'ps5', title: `${MINE} Download` });
  const save = (await made(`/roms/${plainRom}/saves?kind=state`, null, { raw: Buffer.from(`${MINE} state`) })).id;
  const theirs = () => JSON.stringify([
    db.prepare('SELECT * FROM physical_games WHERE id = ?').get(physical),
    db.prepare('SELECT * FROM collections WHERE id = ?').get(collection),
    db.prepare('SELECT * FROM digital_games WHERE user_id = ? AND app_id = ?').get(ids.member, digital.app_id),
    db.prepare('SELECT * FROM save_states WHERE id = ?').get(save)
  ]);
  const start = theirs();

  const address = (route) => {
    if (/^\/physical\/games\/:id(\/|$)/.test(route) || /^\/physical\/(cover|back|disc|spine|manual)\/:id$/.test(route)) return fill(route.replace(':id', String(physical)).replace(':kind', 'cover'));
    if (/^\/collections\/:id(\/|$)/.test(route)) return fill(route.replace(':id', String(collection)).replace(':romId', String(plainRom)));
    if (/^\/digital\/(games|cover)\/:store\/:appId(\/|$)/.test(route)) return fill(route.replace(':store', digital.store).replace(':appId', digital.app_id));
    if (route === '/saves/:sid') return `/saves/${save}`;
    if (/^\/roms\/:id\/saves\/:sid(\/|$)/.test(route)) return fill(route.replace(':sid', String(save)));
    return null;
  };
  const own = entries().map((e) => ({ ...e, url: address(e.route) })).filter((e) => e.url && e.who !== 'admin');
  assert.ok(own.length >= 30, `only ${own.length} routes to one person's things`);
  const wrong = [];
  for (const e of own) {
    for (const account of ['other', 'admin']) {
      const r = await call(account, e.method, e.url, { body: e.method === 'GET' ? undefined : { name: 'taken', title: 'taken', notes: 'taken', field: 'hidden', value: true, link: 'https://example.com/taken.pdf', rom_id: plainRom } });
      if (r.text.includes(MINE)) wrong.push(`${e.name} showed it to ${account}`);
      if (theirs() !== start) { wrong.push(`${e.name} let ${account} change it`); break; }
    }
  }
  assert.deepEqual(wrong, []);
});
