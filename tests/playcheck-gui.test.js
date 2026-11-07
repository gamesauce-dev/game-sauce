// Tests for the play-check engine (scripts/lib/check-play-core.mjs) and the window around it (scripts/check-play-gui.mjs).
// A tiny fake game-sauce server stands in for the real one: it answers the few API calls the tool makes and serves a "player"
// page that draws a RetroArch-style menu for games called "... Menu" and a busy picture for everything else.
// The tests that really play games need the test browser (npx playwright install chromium); without it they are skipped.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { connect, runCheck, loadResults, pendingChanges, applyResults, normaliseOptions, offeredGames } from '../scripts/lib/check-play-core.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playcheck-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeServer(games) {
  const flips = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (u.pathname === '/api/auth/login') { const b = JSON.parse(raw || '{}'); return b.password === 'secret' ? send(200, { token: 'tok', user: { role: b.username === 'viewer' ? 'user' : 'admin' } }) : send(401, { error: 'Wrong username or password' }); }
      if (u.pathname === '/api/platforms') return send(200, { items: [{ slug: 'mame', name: 'MAME', count: games.length }, { slug: 'fba', name: 'FBNeo', count: 0 }] });
      if (u.pathname === '/api/roms') {
        let list = games.filter((g) => g.slug === u.searchParams.get('platform'));
        if (u.searchParams.get('playable') === '1') list = list.filter((g) => g.playable);
        if (u.searchParams.get('skip_on') === '1') list = list.filter((g) => g.play_override !== 1);
        const off = Number(u.searchParams.get('offset') || 0), lim = Number(u.searchParams.get('limit') || 50);
        return send(200, { total: list.length, items: list.slice(off, off + lim) });
      }
      let m = u.pathname.match(/^\/api\/roms\/(\d+)\/play-override$/);
      if (m && req.method === 'POST') { const g = games.find((x) => x.id === Number(m[1])); const v = JSON.parse(raw).value; g.play_override = v ? 1 : 0; g.playable = v; flips.push([g.id, v]); return send(200, { ok: true }); }
      if (u.pathname === '/ejs-player.html') {
        return send(200, `<!doctype html><body style="margin:0"><div id="game"><canvas width="640" height="480"></canvas></div><script>
          const t = new URLSearchParams(location.search).get('title') || '';
          const c = document.querySelector('canvas'), x = c.getContext('2d');
          if (/menu/i.test(t)) { x.fillStyle = 'rgb(64,64,64)'; x.fillRect(0, 0, 640, 480); x.fillStyle = '#fff'; x.fillRect(40, 40, 200, 12); x.fillRect(40, 80, 160, 12); }
          else { for (let i = 0; i < 700; i++) { x.fillStyle = 'rgb(' + (i * 37) % 256 + ',' + (i * 91) % 256 + ',' + (i * 53) % 256 + ')'; x.fillRect((i * 13) % 640, (i * 29) % 480, 40, 30); } }
        </script></body>`, 'text/html');
      }
      if (/^\/api\/roms\/\d+\/play\//.test(u.pathname) || /\/saves/.test(u.pathname)) return send(200, 'x', 'application/octet-stream');
      send(404, { error: 'nope' });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, flips, url: `http://127.0.0.1:${srv.address().port}` })));
}
const G = (id, title, extra = {}) => ({ id, slug: 'mame', title, filename: `${id}.zip`, release_year: 1990 + id, playable: true, play_override: null, ...extra });
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let browserOk = null;
async function haveBrowser() {
  if (browserOk !== null) return browserOk;
  try { const { chromium } = await import('playwright'); const b = await chromium.launch(); await b.close(); browserOk = true; } catch { browserOk = false; }
  return browserOk;
}

test('options are cleaned up and defaulted', () => {
  const o = normaliseOptions({ platforms: 'mame, fba', concurrency: 99, seconds: 1, cutoff: true, sample: 'x' });
  assert.deepEqual(o.platforms, ['mame', 'fba']);
  assert.equal(o.concurrency, 6);
  assert.equal(o.seconds, 4);
  assert.equal(o.candidates, true, 'a cut-off search always includes games not offered yet');
  assert.equal(o.sample, 20);
  assert.equal(normaliseOptions({ all: true }).sample, 0);
});

test('saved results: a torn last line is skipped; pending changes follow the verdicts', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
  const rec = (id, verdict, extra = {}) => JSON.stringify({ id, verdict, platform: 'mame', title: 't' + id, offered: true, was_on: false, ...extra });
  fs.writeFileSync(path.join(dir, 'results.jsonl'), [rec(1, 'runs'), rec(2, 'retroarch-menu'), rec(3, 'blank'), rec(4, 'runs', { was_on: true }), rec(5, 'core-error', { offered: false, was_on: false }), '{"id":6,"verd'].join('\n'));
  const done = loadResults(dir);
  assert.equal(done.size, 5);
  const { toOn, toOff } = pendingChanges([...done.values()]);
  assert.deepEqual(toOn.map((r) => r.id), [1], 'ON for games that ran and are not on yet');
  assert.deepEqual(toOff.map((r) => r.id), [2], 'OFF for failures that are offered; blank is never switched off; a failure that was never offered needs no change');
});

test('sign-in: wrong password, non-admin and unreachable server each say what is wrong', async () => {
  const { srv, url } = await fakeServer([G(1, 'A')]);
  try {
    await assert.rejects(connect(url, 'admin', 'nope'), /Sign-in failed: Wrong username or password/);
    await assert.rejects(connect(url, 'viewer', 'secret'), /needs an admin account/);
    await assert.rejects(connect('192.168.1.5:8765', 'admin', 'secret'), /must start with http/);
    await assert.rejects(connect('http://127.0.0.1:1', 'admin', 'secret'), /Cannot reach/);
    const c = await connect(url + '/', 'admin', 'secret');
    assert.equal(c.server, url);
    assert.equal((await offeredGames(c, ['mame'], 'a')).length, 1);
  } finally { srv.close(); }
});

test('a run judges each game from the picture, applies as it goes, and a stopped run carries on with resume', async (t) => {
  if (!(await haveBrowser())) return t.skip('test browser not installed');
  const games = [G(1, 'Alpha Good'), G(2, 'Beta Menu'), G(3, 'Gamma Good'), G(4, 'Delta Menu', { playable: false })];
  const { srv, flips, url } = await fakeServer(games);
  const dir = path.join(tmp, 'run1');
  try {
    const conn = await connect(url, 'admin', 'secret');
    const base = { platforms: ['mame'], all: true, seconds: 4, candidates: true, apply: true, outDir: dir };

    // run 1: stop as soon as one game is judged
    const ac = new AbortController();
    const r1 = await runCheck(conn, { ...base, concurrency: 1 }, { signal: ac.signal, emit: (type) => { if (type === 'game') ac.abort(); } });
    assert.equal(r1.aborted, true);
    const afterStop = loadResults(dir);
    assert.ok(afterStop.size >= 1 && afterStop.size < 4, `a stopped run keeps what it judged (${afterStop.size})`);

    // run 2: resume tests only what is left, and nothing is tested twice
    const seen = [];
    const r2 = await runCheck(conn, { ...base, concurrency: 2, resume: true }, { emit: (type, d) => { if (type === 'game') seen.push(d.rec.id); } });
    assert.equal(r2.aborted, false);
    for (const id of afterStop.keys()) assert.ok(!seen.includes(id), 'a game judged before the stop is not tested again');
    const all = loadResults(dir);
    assert.equal(all.size, 4);
    assert.equal(all.get(1).verdict, 'runs');
    assert.equal(all.get(2).verdict, 'retroarch-menu');
    assert.equal(all.get(3).verdict, 'runs');
    assert.equal(all.get(4).verdict, 'retroarch-menu');
    assert.ok(fs.existsSync(path.join(dir, 'shots', '2.png')), 'a failure keeps its picture');
    assert.ok(fs.existsSync(path.join(dir, 'report.html')));
    assert.deepEqual([...new Set(flips.filter(([, v]) => v === true).map(([id]) => id))].sort(), [1, 3], 'games that ran are switched on');
    assert.deepEqual([...new Set(flips.filter(([, v]) => v === false).map(([id]) => id))], [2], 'an offered failure is switched off; one never offered is left alone');

    // a fresh run keeps the old results beside the new file
    const r3 = await runCheck(conn, { ...base, recheck: true, apply: false, only: 'alpha', concurrency: 1 });
    assert.equal(r3.all.length, 1);
    assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('.jsonl.bak')), 'the earlier results are backed up, not lost');
  } finally { srv.close(); }
});

test('the window: private key required, sign-in, switching from saved results, whole-platform off', async (t) => {
  const games = [G(1, 'Alpha Good'), G(2, 'Beta Menu'), G(3, 'Gamma Good', { play_override: 1 })];
  const { srv, flips, url } = await fakeServer(games);
  const dir = path.join(tmp, 'gui');
  fs.mkdirSync(dir, { recursive: true });
  const rec = (id, title, verdict, extra = {}) => JSON.stringify({ id, title, verdict, platform: 'mame', year: 1990 + id, offered: true, was_on: false, at: '2026-01-01T00:00:00Z', ...extra });
  fs.writeFileSync(path.join(dir, 'results.jsonl'), [rec(1, 'Alpha Good', 'runs'), rec(2, 'Beta Menu', 'retroarch-menu')].join('\n') + '\n');
  const port = await freePort();
  const child = spawn(process.execPath, ['scripts/check-play-gui.mjs', '--port', String(port), '--out', dir, '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  try {
    const key = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the window did not start: ' + out)), 8000);
      const tick = setInterval(() => { const m = out.match(/\?k=([0-9a-f]{32})/); if (m) { clearInterval(tick); clearTimeout(timer); resolve(m[1]); } }, 50);
    });
    const base = `http://127.0.0.1:${port}`;
    const call = async (p, body, headers = { 'x-check-key': key }) => {
      const r = await fetch(base + '/api/' + p, body === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    };

    assert.match(await (await fetch(base + '/')).text(), /Play check/, 'the page is served');
    assert.equal((await call('state', undefined, {})).status, 401, 'no key, no access');
    assert.equal((await call('state', undefined, { 'x-check-key': 'wrong' })).status, 401);
    const rebind = await new Promise((resolve) => { const q = http.request({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example', 'x-check-key': key } }, (r) => { r.resume(); resolve(r.statusCode); }); q.end(); });
    assert.equal(rebind, 403, 'a request that arrives under another website name is refused');

    let s = await call('state');
    assert.equal(s.json.connected, false);
    assert.equal(s.json.previous.count, 2, 'results from an earlier run are offered for resume');
    assert.equal(s.json.previous.toOn, 1); assert.equal(s.json.previous.toOff, 1);
    assert.equal((await call('start', { options: { platforms: ['mame'] } })).status, 400, 'cannot start before signing in');
    const bad = await call('connect', { server: url, user: 'admin', password: 'nope' });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /Sign-in failed/);

    s = await call('connect', { server: url, user: 'admin', password: 'secret' });
    assert.equal(s.status, 200); assert.equal(s.json.connected, true);
    assert.deepEqual(s.json.platforms.map((p) => p.slug), ['mame', 'fba']);
    assert.ok(!JSON.stringify(fs.readFileSync(path.join(dir, 'gui-settings.json'), 'utf8')).includes('secret'), 'the password is never written to disk');

    assert.equal((await call('start', { options: { platforms: [] } })).status, 400, 'a run needs at least one platform');

    const ap = await call('apply', { mode: 'both' });
    assert.equal(ap.status, 200);
    assert.equal(ap.json.switchedOn, 1); assert.equal(ap.json.switchedOff, 1);
    assert.deepEqual(flips.sort((a, b) => a[0] - b[0]), [[1, true], [2, false]]);

    assert.equal((await call('off-preview', { platforms: [] })).status, 400, 'it will not switch off everything');
    const pre = await call('off-preview', { platforms: ['mame'] });
    assert.equal(pre.json.count, 2, 'games 1 and 3 are offered after the switches above; game 2 was switched off');
    const off = await call('off', { platforms: ['mame'] });
    assert.equal(off.json.n, 2);
    assert.ok(games.every((g) => g.playable === false), 'nothing is offered any more');

    if (await haveBrowser()) {
      const st = await call('start', { options: { platforms: ['mame'], all: true, seconds: 4, recheck: true, candidates: true, only: 'alpha' }, resume: false });
      assert.equal(st.status, 200); assert.equal(st.json.running, true);
      assert.equal((await call('start', { options: { platforms: ['mame'] } })).status, 409, 'one run at a time');
      assert.equal((await call('apply', { mode: 'on' })).status, 409, 'no switching while a run is going');
      const deadline = Date.now() + 40000;
      let end = null;
      while (!end && Date.now() < deadline) {
        const ev = await fetch(base + '/api/events?k=' + key); const reader = ev.body.getReader(); let text = '';
        const part = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), 500))]); if (part?.value) text += Buffer.from(part.value).toString();
        await reader.cancel().catch(() => {});
        if (text.includes('event: run-end')) end = text;
        else await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(end, 'the run reports that it finished');
      assert.match(end, /"status":"finished"/);
      assert.equal((await call('results')).json.items.length, 1, 'a fresh run replaced the earlier results (the old file is kept as a backup)');
    } else t.diagnostic('test browser not installed: the live-run part of this test was skipped');
  } finally { child.kill(); srv.close(); }
});
