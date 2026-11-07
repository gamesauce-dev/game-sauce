#!/usr/bin/env node
// The point-and-click version of scripts/check-play.mjs. It starts a small web page on THIS computer (nothing is exposed to the
// network), opens it in your browser, and runs the same checks from there: pick platforms, press Start, watch it work, press Stop,
// and carry on later with Resume. It does exactly what the command line does, because both use scripts/lib/check-play-core.mjs.
//
//   npm ci                                    (once, in the game-sauce folder)
//   npx playwright install chromium           (once: downloads the test browser, about 150 MB)
//   node scripts/check-play-gui.mjs
//
// Then sign in with your server address and an ADMIN account. The password is kept in memory only, never written to disk.
//
// Options
//   --port N            port for the page on this computer (default 5555)
//   --out DIR           where results are kept (default ./play-check): the same folder the command line uses, so the two can
//                       carry on each other's runs
//   --server URL        pre-fill the server address
//   --user NAME         pre-fill the account name
//   --no-open           do not open the browser for you; open the link printed here instead
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect, listPlatforms, offeredGames, switchOff, runCheck, loadResults, pendingChanges, applyResults, tallyByPlatform, normaliseOptions } from './lib/check-play-core.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

if (flag('--help') || flag('-h')) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(0); }

const port = Number(opt('--port', 5555));
const outDir = path.resolve(opt('--out', './play-check'));
const pageFile = new URL('./check-play-gui/index.html', import.meta.url);
const key = crypto.randomBytes(16).toString('hex'); // every request to the API must carry this, so another web page cannot drive the tool
const settingsFile = path.join(outDir, 'gui-settings.json');
fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const settings = readJson(settingsFile, {});
if (opt('--server')) settings.server = opt('--server');
if (opt('--user')) settings.user = opt('--user');
const saveSettings = () => { try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch { /* not worth stopping for */ } };

// ---- the one run at a time, and the events it produced (replayed to a page that connects late or reconnects)
let conn = null;
let platforms = [];
let run = null; // { status: 'running' | 'stopping' | 'finished' | 'stopped' | 'error', controller, startedAt, error, summary }
let events = [];
let seq = 0;
let quitting = false;
const clients = new Set();
const KEEP = new Set(['run-start', 'plan', 'step', 'run-end', 'applied']);
const sseSend = (res, type, data, id) => res.write(`${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
function push(type, data) {
  const e = { id: ++seq, type, data };
  events.push(e);
  if (events.length > 30000) events = [...events.filter((x) => KEEP.has(x.type)), ...events.filter((x) => !KEEP.has(x.type)).slice(-15000)].sort((a, b) => a.id - b.id);
  for (const c of clients) sseSend(c, type, data, e.id);
}
const running = () => run && (run.status === 'running' || run.status === 'stopping');

function previous() {
  const all = [...loadResults(outDir).values()];
  const { toOn, toOff } = pendingChanges(all);
  const last = all.reduce((m, r) => (r.at > m ? r.at : m), '');
  return { count: all.length, byPlatform: tallyByPlatform(all), lastAt: last || null, toOn: toOn.length, toOff: toOff.length, failures: all.filter((r) => r.verdict !== 'runs').length };
}
function stateOut() {
  return {
    connected: Boolean(conn), server: conn?.server || settings.server || '', user: settings.user || '',
    platforms, running: Boolean(running()), runStatus: run?.status || 'idle', runError: run?.error || null,
    previous: previous(), lastOptions: settings.lastOptions || null, outDir,
  };
}

async function startRun(body) {
  if (!conn) throw httpError(400, 'Sign in first.');
  if (running()) throw httpError(409, 'A check is already running.');
  const o = normaliseOptions(body.options || {});
  if (!o.cutoff && !o.platforms.length) throw httpError(400, 'Pick at least one platform to check.');
  const resume = Boolean(body.resume);
  settings.lastOptions = { ...(body.options || {}), resume: undefined };
  saveSettings();
  const controller = new AbortController();
  run = { status: 'running', controller, startedAt: Date.now(), error: null, summary: null };
  events = [];
  push('reset', {});
  push('run-start', { options: o, resume, startedAt: run.startedAt });
  const mine = run;
  runCheck(conn, { ...o, resume, outDir }, { signal: controller.signal, emit: push })
    .then((r) => {
      mine.status = r.aborted ? 'stopped' : 'finished';
      mine.summary = { nothing: r.nothing, aborted: r.aborted, total: r.all.length, switchedOn: r.switchedOn, switchedOff: r.switchedOff, cutoffReport: r.cutoffReport };
      push('run-end', { status: mine.status, ...mine.summary });
      if (quitting) process.exit(0);
    })
    .catch((e) => {
      const expired = /HTTP 401/.test(e.message);
      if (expired) conn = null;
      mine.status = 'error';
      mine.error = expired ? 'Your sign-in on the server has expired. Sign in again, then press Resume to carry on.' : e.message;
      push('run-end', { status: 'error', error: mine.error });
      if (quitting) process.exit(0);
    });
}

// ---- http plumbing
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const json = (res, status, body) => { const s = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(s); };
const readBody = (req) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > 100_000) { reject(httpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(httpError(400, 'Bad request.')); } });
  req.on('error', reject);
});
const hostOk = (req) => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(String(req.headers.host || '').toLowerCase()); // blocks DNS-rebinding

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req)) return json(res, 403, { error: 'Open this tool at http://127.0.0.1:' + port });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
      return res.end(fs.readFileSync(pageFile));
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
    const given = req.headers['x-check-key'] || url.searchParams.get('k') || '';
    const a = Buffer.from(String(given)), b = Buffer.from(key);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(res, 401, { error: 'Open the link printed in the terminal where you started this tool: it carries the key that lets this page talk to it.' });

    if (req.method === 'GET') {
      if (url.pathname === '/api/state') return json(res, 200, stateOut());
      if (url.pathname === '/api/results') return json(res, 200, { items: [...loadResults(outDir).values()] });
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        sseSend(res, 'reset', {});
        for (const e of events) if (e.type !== 'reset') sseSend(res, e.type, e.data, e.id);
        clients.add(res);
        const beat = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(beat); clients.delete(res); });
        return;
      }
      const m = url.pathname.match(/^\/api\/shot\/(\d+)$/);
      if (m) {
        const f = path.join(outDir, 'shots', `${m[1]}.png`);
        if (!fs.existsSync(f)) return json(res, 404, { error: 'No picture.' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(f));
      }
      return json(res, 404, { error: 'Not found.' });
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'Not allowed.' });
    const body = await readBody(req);

    if (url.pathname === '/api/connect') {
      if (running()) throw httpError(409, 'Stop the running check before signing in again.');
      const c = await connect(body.server, body.user || 'admin', String(body.password || '')).catch((e) => { throw httpError(400, e.message); });
      conn = c;
      platforms = await listPlatforms(c);
      settings.server = c.server; settings.user = String(body.user || 'admin'); saveSettings();
      return json(res, 200, stateOut());
    }
    if (url.pathname === '/api/disconnect') {
      if (running()) throw httpError(409, 'Stop the running check first.');
      conn = null; platforms = [];
      return json(res, 200, stateOut());
    }
    if (url.pathname === '/api/start') { await startRun(body); return json(res, 200, stateOut()); }
    if (url.pathname === '/api/stop') {
      if (!running()) return json(res, 200, stateOut());
      run.status = 'stopping'; run.controller.abort(); push('stopping', {});
      return json(res, 200, stateOut());
    }
    if (url.pathname === '/api/apply') {
      if (!conn) throw httpError(400, 'Sign in first.');
      if (running()) throw httpError(409, 'Wait for the running check to finish (or stop it) first.');
      const mode = ['on', 'off', 'both'].includes(body.mode) ? body.mode : 'both';
      const r = await applyResults(conn, [...loadResults(outDir).values()], mode);
      return json(res, 200, { ...r, state: stateOut() });
    }
    if (url.pathname === '/api/off-preview' || url.pathname === '/api/off') {
      if (!conn) throw httpError(400, 'Sign in first.');
      if (running()) throw httpError(409, 'Wait for the running check to finish (or stop it) first.');
      const plats = (Array.isArray(body.platforms) ? body.platforms : []).map(String).filter((s) => platforms.some((p) => p.slug === s));
      if (!plats.length) throw httpError(400, 'Pick a platform. This will not switch off browser play everywhere.');
      const list = await offeredGames(conn, plats, body.only);
      if (url.pathname === '/api/off-preview') return json(res, 200, { count: list.length });
      const r = await switchOff(conn, list);
      return json(res, 200, { ...r, state: stateOut() });
    }
    return json(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.message || String(e) });
    else res.end();
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use (is this tool already running?). Try  --port ${port + 1}`);
  else console.error(e.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  const link = `http://127.0.0.1:${port}/?k=${key}`;
  console.log(`\nPlay check is running. Open this link in your browser:\n\n  ${link}\n\nResults are kept in ${outDir}\nPress Ctrl+C here to quit (a running check is stopped first; carry on later with Resume).\n`);
  if (!flag('--no-open')) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]] : process.platform === 'darwin' ? ['open', [link]] : ['xdg-open', [link]];
    try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* the printed link works */ }
  }
});

const quit = () => { quitting = true; if (running()) { run.controller.abort(); setTimeout(() => process.exit(0), 3000).unref(); } else process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
