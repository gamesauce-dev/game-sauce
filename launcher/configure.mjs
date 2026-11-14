// The launcher's setup page: a small web page served from THIS PC only (127.0.0.1, a random port, a secret key in the address)
// that edits launcher.json, so nobody has to write JSON by hand. Opened by gamesauce://configure?... (the "Set up emulators"
// button in game-sauce) or by running:  node gamesauce-launcher.mjs --configure
//
// Safe by construction: it listens on 127.0.0.1 only, every request must carry the secret key (which only the page that was opened
// knows), the Host header must be this machine's (so a web page cannot reach it through a DNS trick), and it closes by itself.
// It can only do what editing launcher.json by hand can do.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configPath, normalizeOrigin, loadConfig, syncPlatforms } from './gamesauce-launcher.mjs';
import { cacheDirFor, defaultCacheDir, listEntries, empty as emptyCache, ENTRY_NAME, DEFAULT_LIMIT_GB } from './cache.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SLUG = /^[a-z0-9_-]{1,40}$/;
const IDLE_MS = 20 * 60 * 1000;

export const platformList = () => JSON.parse(fs.readFileSync(path.join(here, 'platforms.json'), 'utf8'));

/**
 * The platforms to choose an emulator for: the ones this launcher shipped with, plus any the server has that it does not (a platform added in Settings > Platforms, or one added in
 * a version of game-sauce newer than this launcher). The server is asked only when the page was opened from game-sauce (it carries the server's address and a token).
 */
export async function platformsWithServer(syncToken, fetchImpl = fetch) {
  const bundled = platformList();
  if (!syncToken?.server || !syncToken?.token) return bundled;
  try {
    const res = await fetchImpl(`${syncToken.server}/api/launcher/platforms?token=${encodeURIComponent(syncToken.token)}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return bundled;
    const extra = (await res.json())?.platforms;
    if (!Array.isArray(extra)) return bundled;
    const have = new Set(bundled.map((p) => p.slug));
    return [...bundled, ...extra.filter((p) => p && /^[a-z0-9_-]{1,40}$/.test(String(p.slug)) && !have.has(p.slug)).map((p) => ({ slug: p.slug, name: String(p.name || p.slug).slice(0, 80), family: String(p.family || 'Others').slice(0, 40) }))];
  } catch { return bundled; }   // the server cannot be reached: the shipped list is still right for everything it knew
}

/** Is this program there? A full path must exist; a bare name is looked for in the PATH. */
export function programExists(cmd, { env = process.env, platform = process.platform } = {}) {
  const c = String(cmd || '').trim();
  if (!c) return false;
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  if (path.isAbsolute(c) || /[\\/]/.test(c)) return isFile(c);
  const exts = platform === 'win32' ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : [''];
  for (const dir of String(env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) for (const x of exts) if (isFile(path.join(dir, c + x))) return true;
  return false;
}

/** Check what the page sent, and say what is wrong in words. Returns the cleaned { servers, emulators } or throws Error. */
export function cleanSettings(body) {
  const servers = [];
  for (const raw of Array.isArray(body?.servers) ? body.servers : []) {
    const s = String(raw || '').trim(); if (!s) continue;
    const o = normalizeOrigin(s);
    if (!o) throw new Error(`"${s.slice(0, 80)}" is not a server address. Write it like http://192.168.1.50:8765`);
    if (!servers.includes(o)) servers.push(o);
  }
  const emulators = {};
  for (const e of Array.isArray(body?.emulators) ? body.emulators : []) {
    const slug = String(e?.slug || '').trim().toLowerCase(), command = String(e?.command || '').trim();
    if (!slug && !command) continue;
    if (!SLUG.test(slug)) throw new Error('Choose a platform for every emulator line.');
    if (!command) throw new Error(`Choose the emulator program for ${slug}.`);
    if (emulators[slug]) throw new Error(`${slug} appears twice: keep one line for it.`);
    const entry = { command };
    if (Array.isArray(e.args)) {
      if (e.args.length > 40 || e.args.some((a) => typeof a !== 'string' || a.length > 500)) throw new Error(`The arguments for ${slug} are too long.`);
      entry.args = e.args;
    }
    if (e.deleteOnExit === false) entry.deleteOnExit = false;
    if (e.unpack === true || e.unpack === false) entry.unpack = e.unpack;   // unset: Xbox 360 and PS3 unpack a zipped game, the others do not
    if (e.quickLaunch === true) entry.quickLaunch = true;   // keep the game on this PC after the emulator closes
    const own = cleanDir(e.cacheDir, `the quick launch folder for ${slug}`);
    if (own) entry.cacheDir = own;
    emulators[slug] = entry;
  }
  const cacheDir = cleanDir(body?.cacheDir, 'the quick launch folder');
  let cacheLimitGb;
  if (body?.cacheLimitGb !== undefined && body?.cacheLimitGb !== null && String(body.cacheLimitGb).trim() !== '') {
    cacheLimitGb = Number(body.cacheLimitGb);
    if (!Number.isFinite(cacheLimitGb) || cacheLimitGb < 0 || cacheLimitGb > 100000) throw new Error('The quick launch size limit is a number of GB (0 for no limit).');
  }
  return { servers, emulators, cacheDir, cacheLimitGb };
}

/** A folder the person typed or chose: empty (nothing), or a full path. */
function cleanDir(v, what) {
  const t = String(v ?? '').trim();
  if (!t) return undefined;
  if (t.length > 500) throw new Error(`The path for ${what} is too long.`);
  if (!path.isAbsolute(t) && !/^[A-Za-z]:[\\/]/.test(t)) throw new Error(`Write the full path of ${what} (for example D:\\GameCache), or choose it with Browse.`);
  return t;
}

/** The window that chooses a file on this computer. Resolves to the path, or '' when cancelled; rejects when this system has no way to show one. */
export function pickFile() {
  return new Promise((resolve, reject) => {
    let cmd, args;
    if (process.platform === 'win32') {
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-STA', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = 'Choose the emulator program'; $d.Filter = 'Programs|*.exe;*.bat;*.cmd;*.lnk|All files|*.*'; if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.FileName) }"];
    } else if (process.platform === 'darwin') {
      cmd = 'osascript'; args = ['-e', 'POSIX path of (choose file with prompt "Choose the emulator program")'];
    } else { cmd = 'zenity'; args = ['--file-selection', '--title=Choose the emulator program']; }
    let out = '', done = false;
    const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
    let c;
    try { c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return reject(new Error('No file window is available here: type the path instead.')); }
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', () => finish(reject, new Error('No file window is available here: type the path instead.')));
    c.on('close', () => finish(resolve, out.trim().replace(/\r?\n.*/s, '')));
    setTimeout(() => { try { c.kill(); } catch { /* gone */ } finish(resolve, ''); }, 5 * 60 * 1000).unref();
  });
}

/** The window that chooses a folder on this computer (same rules as pickFile). */
export function pickFolder() {
  return new Promise((resolve, reject) => {
    let cmd, args;
    if (process.platform === 'win32') {
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-STA', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose the quick launch folder'; if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"];
    } else if (process.platform === 'darwin') {
      cmd = 'osascript'; args = ['-e', 'POSIX path of (choose folder with prompt "Choose the quick launch folder")'];
    } else { cmd = 'zenity'; args = ['--file-selection', '--directory', '--title=Choose the quick launch folder']; }
    let out = '', done = false;
    const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
    let c;
    try { c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return reject(new Error('No folder window is available here: type the path instead.')); }
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', () => finish(reject, new Error('No folder window is available here: type the path instead.')));
    c.on('close', () => finish(resolve, out.trim().replace(/\r?\n.*/s, '')));
    setTimeout(() => { try { c.kill(); } catch { /* gone */ } finish(resolve, ''); }, 5 * 60 * 1000).unref();
  });
}

/** The AppImage's own library settings stop the computer's browser from starting: hand it a clean environment. */
function cleanEnv() {
  const e = { ...process.env };
  for (const k of ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'GTK_PATH', 'GIO_EXTRA_MODULES', 'GDK_PIXBUF_MODULE_FILE', 'GSETTINGS_SCHEMA_DIR', 'PYTHONHOME', 'PERLLIB', 'QT_PLUGIN_PATH']) delete e[k];
  return e;
}

function openInBrowser(url) {
  try {
    const c = process.platform === 'win32' ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true, env: cleanEnv() });
    c.on('error', () => { if (process.platform === 'linux') for (const alt of ['gio', 'sensible-browser', 'x-www-browser']) { try { const d = spawn(alt, alt === 'gio' ? ['open', url] : [url], { stdio: 'ignore', detached: true, env: cleanEnv() }); d.on('error', () => {}); d.unref(); break; } catch { /* next */ } } }); c.unref();
  } catch { /* the address is printed too */ }
}

/** Start the setup page. Options: configFile; addServer (a server to offer to add); syncToken + syncServer (so Save can tell game-sauce); open (open the browser); pick (for tests). */
export async function startConfigServer({ configFile = configPath(), addServer = null, syncToken = null, open = true, pick = pickFile, pickDir = pickFolder, idleMs = IDLE_MS } = {}) {
  const key = crypto.randomBytes(24).toString('base64url');
  let closeResolve; const closed = new Promise((r) => { closeResolve = r; });
  let idle;
  const server = http.createServer(async (req, res) => {
    try {
      clearTimeout(idle); idle = setTimeout(() => close(), idleMs); idle.unref?.();
      const port = server.address().port, host = String(req.headers.host || '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { res.writeHead(403).end('Wrong host'); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && url.pathname === '/') {
        if (url.searchParams.get('k') !== key) { res.writeHead(403).end('This page needs the link the launcher opened.'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'", 'X-Frame-Options': 'DENY' });
        res.end(fs.readFileSync(path.join(here, 'configure-ui.html'))); return;
      }
      if (!url.pathname.startsWith('/api/') || req.headers['x-key'] !== key) { send(403, { error: 'Not allowed' }); return; }
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) { send(400, { error: 'Expected JSON' }); return; }
      let body = {};
      if (req.method === 'POST') {
        let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 200000) { send(413, { error: 'Too large' }); return; } }
        try { body = text ? JSON.parse(text) : {}; } catch { send(400, { error: 'Not JSON' }); return; }
      }
      const describe = (emulators) => Object.entries(emulators || {}).filter(([, e]) => e && typeof e.command === 'string')
        .map(([slug, e]) => ({ slug, command: e.command, args: Array.isArray(e.args) ? e.args : undefined, deleteOnExit: e.deleteOnExit === false ? false : undefined, unpack: typeof e.unpack === 'boolean' ? e.unpack : undefined, quickLaunch: e.quickLaunch === true ? true : undefined, cacheDir: typeof e.cacheDir === 'string' && e.cacheDir.trim() ? e.cacheDir : undefined, found: programExists(e.command) }));
      const rescueDir = () => process.env.GAMESAUCE_LAUNCHER_RESCUE || path.join(os.homedir(), '.gamesauce', 'rescued');
      // The cache folders in use: the shared (or default) one, and any platform's own. Only these may be listed or emptied from this page.
      const cacheFolders = (cfg) => {
        const dirs = new Map([[cacheDirFor({}, cfg), 'all other platforms']]);
        for (const [slug, e] of Object.entries(cfg?.emulators || {})) if (e?.quickLaunch === true && typeof e.cacheDir === 'string' && e.cacheDir.trim()) { const d = e.cacheDir.trim(); dirs.set(d, (dirs.has(d) ? dirs.get(d) + ', ' : '') + slug); }
        return dirs;
      };

      if (url.pathname === '/api/config') {
        let cfg = null, warning = '';
        try { cfg = loadConfig(configFile); } catch (e) { warning = `${e.message} Saving here will replace it (the old file is kept as a .bak copy).`; }
        return send(200, { file: configFile, servers: cfg?.servers || [], emulators: describe(cfg?.emulators), platforms: await platformsWithServer(syncToken), can_sync: Boolean(syncToken), add_server: addServer, warning, cache: { dir: cfg?.cacheDir || '', limit_gb: cfg?.cacheLimitGb ?? null, default_dir: defaultCacheDir(), default_limit_gb: DEFAULT_LIMIT_GB } });
      }
      if (url.pathname === '/api/test') return send(200, { found: programExists(body.command) });
      if (url.pathname === '/api/pickdir') { try { return send(200, { path: await pickDir() }); } catch (e) { return send(400, { error: e.message }); } }
      if (url.pathname === '/api/cache') {   // what quick launch keeps, per folder
        let cfg = null; try { cfg = loadConfig(configFile); } catch { /* shown by /api/config */ }
        const folders = [...cacheFolders(cfg).entries()].map(([dir, used]) => { const entries = listEntries(dir); return { dir, used_by: used, exists: fs.existsSync(dir), games: entries.map((e) => ({ name: e.name, title: e.title, platform: e.platform, bytes: e.bytes, last_played: e.lastPlayed, in_use: e.inUse })), bytes: entries.reduce((n, e) => n + e.bytes, 0) }; });
        return send(200, { folders });
      }
      if (url.pathname === '/api/cache/empty') {
        let cfg = null; try { cfg = loadConfig(configFile); } catch { /* none */ }
        const dir = String(body.dir || ''), name = body.name == null ? null : String(body.name);
        if (!cacheFolders(cfg).has(dir)) return send(400, { error: 'That is not one of the quick launch folders in the saved settings. Save first, then empty it.' });
        if (name !== null && !ENTRY_NAME.test(name)) return send(400, { error: 'That is not a game kept by quick launch.' });
        const r = emptyCache(dir, { name, rescueParent: rescueDir() });
        return send(200, r);
      }
      if (url.pathname === '/api/pick') { try { return send(200, { path: await pick() }); } catch (e) { return send(400, { error: e.message }); } }
      if (url.pathname === '/api/save') {
        let clean; try { clean = cleanSettings(body); } catch (e) { return send(400, { error: e.message }); }
        let old = {}; try { old = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { /* new or broken */ }
        if (fs.existsSync(configFile)) { try { fs.copyFileSync(configFile, `${configFile}.bak`); } catch { /* not fatal */ } }
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        // A "launchFile" written into the file by hand is not on this page: keep it.
        for (const [slug, e] of Object.entries(clean.emulators)) { const was = old?.emulators?.[slug]?.launchFile; if (was !== undefined) e.launchFile = was; }
        const out = { ...(old && typeof old === 'object' && !Array.isArray(old) ? old : {}), servers: clean.servers, emulators: clean.emulators };
        for (const [k, v] of [['cacheDir', clean.cacheDir], ['cacheLimitGb', clean.cacheLimitGb]]) { if (v === undefined) delete out[k]; else out[k] = v; }
        delete out._help;
        fs.writeFileSync(configFile, JSON.stringify(out, null, 2) + '\n');
        return send(200, { file: configFile, servers: clean.servers, emulators: describe(clean.emulators) });
      }
      if (url.pathname === '/api/sync') {
        if (!syncToken) return send(400, { error: 'This page was not opened from game-sauce: use Check my PC there.' });
        try {
          const r = await syncPlatforms('gamesauce://sync?' + new URLSearchParams({ server: syncToken.server, token: syncToken.token }).toString(), { configFile });
          syncToken = null; return send(200, { platforms: r.platforms });
        } catch (e) { return send(400, { error: e.message }); }
      }
      if (url.pathname === '/api/done') { send(200, { ok: true }); setTimeout(() => close(), 150); return; }
      send(404, { error: 'Not found' });
    } catch (e) { try { res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Something went wrong' })); } catch { /* sent */ } }
  });
  function close() { clearTimeout(idle); server.close(); server.closeAllConnections?.(); closeResolve(); }
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, url = `http://127.0.0.1:${port}/?k=${key}`;
  idle = setTimeout(() => close(), idleMs); idle.unref?.();
  if (open) openInBrowser(url);
  return { url, port, key, close, closed };
}
