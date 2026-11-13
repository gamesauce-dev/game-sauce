#!/usr/bin/env node
// game-sauce launcher: runs on the PC you play on (not on the server).
//
// The "Play locally" button in game-sauce opens a link like
//     gamesauce://launch?server=http://host:3000&token=...&platform=snes&ext=.sfc&title=Some+Game
// and the operating system hands that link to this program (see install-windows.bat / install-linux.sh).
// It then:
//   1. checks the server is one YOU listed in your config (a stray link cannot make it fetch from anywhere),
//   2. downloads the ROM with the one-time token into a fresh temporary folder,
//   3. starts the emulator YOU configured for that platform, with the ROM path,
//   4. waits for the emulator to close, then deletes the temporary copy.
//
// No dependencies: Node 18 or newer. The emulator is only ever started from your own config file, never from anything
// in the link, and never through a shell.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { wantsUnpack, unpackArchive, listFiles, pickLaunchFile, UnpackError } from './unpack.mjs';
import { wantsCache, cacheDirFor, entryDirFor, findFresh, readMeta, writeMeta, removeEntry, lockEntry, unlockEntry, listTree, treeBytes, prune, limitBytes } from './cache.mjs';

export const TEMP_PREFIX = 'gamesauce-launch-';
const STALE_MS = 24 * 60 * 60 * 1000;

const homeDir = () => path.join(os.homedir(), '.gamesauce');
export const configPath = () => process.env.GAMESAUCE_LAUNCHER_CONFIG || path.join(homeDir(), 'launcher.json');
const logPath = () => process.env.GAMESAUCE_LAUNCHER_LOG || path.join(homeDir(), 'launcher.log');
const tempParent = () => process.env.GAMESAUCE_LAUNCHER_TMP || os.tmpdir();
const rescueParent = () => process.env.GAMESAUCE_LAUNCHER_RESCUE || path.join(homeDir(), 'rescued');

/* ───────────────────────────── logging / messages ───────────────────────────── */

function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  try { process.stderr.write(text + '\n'); } catch { /* no console when started by the OS */ }
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    // Keep the log small: when it passes 200 KB, start again.
    try { if (fs.statSync(logPath()).size > 200 * 1024) fs.writeFileSync(logPath(), ''); } catch { /* not there yet */ }
    fs.appendFileSync(logPath(), text + '\n');
  } catch { /* logging must never stop a launch */ }
}

/** Tell the person something went wrong. The OS starts this program without a window, so a silent failure looks like
 *  "nothing happened". Best effort: any failure here is ignored. */
function notify(message) {
  if (process.env.GAMESAUCE_LAUNCHER_QUIET === '1') return;
  const text = String(message).replace(/['"`$\r\n]+/g, ' ').slice(0, 300);
  try {
    let cmd, args;
    if (process.platform === 'win32') {
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        `Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show('${text}', 'game-sauce launcher')`];
    } else if (process.platform === 'darwin') {
      cmd = 'osascript';
      args = ['-e', `display notification "${text}" with title "game-sauce launcher"`];
    } else {
      cmd = 'notify-send';
      args = ['game-sauce launcher', text];
    }
    const c = spawn(cmd, args, { stdio: 'ignore', detached: true });
    c.on('error', () => {});
    c.unref();
  } catch { /* ignore */ }
}

class LaunchError extends Error {}

/* ───────────────────────────── the link ───────────────────────────── */

export function normalizeOrigin(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin.toLowerCase();
  } catch { return null; }
}

/** Read and validate a gamesauce:// link. Throws LaunchError on anything unexpected. */
export function parseLaunchUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new LaunchError('That is not a valid gamesauce:// link.'); }
  if (u.protocol !== 'gamesauce:' || u.hostname !== 'launch') throw new LaunchError('That is not a game-sauce launch link.');
  const q = u.searchParams;
  const server = normalizeOrigin(q.get('server'));
  const token = String(q.get('token') || '');
  const platform = String(q.get('platform') || '').toLowerCase();
  let ext = String(q.get('ext') || '').toLowerCase();
  const title = String(q.get('title') || 'game');
  if (!server) throw new LaunchError('The link has no valid server address.');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new LaunchError('The link has no valid launch token.');
  if (!/^[a-z0-9_-]{1,40}$/.test(platform)) throw new LaunchError('The link has no valid platform.');
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) ext = '';
  // Optional, for quick launch: which game it is, and a fingerprint of the file (its size and date) to tell a kept copy is still the server's.
  const rom = /^\d{1,12}$/.test(String(q.get('rom') || '')) ? String(q.get('rom')) : '';
  const fp = /^[A-Za-z0-9._-]{1,60}$/.test(String(q.get('fp') || '')) ? String(q.get('fp')) : '';
  return { server, token, platform, ext, title, rom, fp };
}

/** Read a gamesauce://sync link ("Check my PC"): the server address and a one-time token. */
export function parseSyncUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new LaunchError('That is not a valid gamesauce:// link.'); }
  if (u.protocol !== 'gamesauce:' || u.hostname !== 'sync') throw new LaunchError('That is not a game-sauce sync link.');
  const server = normalizeOrigin(u.searchParams.get('server')), token = String(u.searchParams.get('token') || '');
  if (!server) throw new LaunchError('The link has no valid server address.');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new LaunchError('The link has no valid token.');
  return { server, token };
}

/** Read a gamesauce://configure link (the setup page): optionally the server to add, and a one-time token so Save can tell game-sauce. */
export function parseConfigureUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new LaunchError('That is not a valid gamesauce:// link.'); }
  if (u.protocol !== 'gamesauce:' || u.hostname !== 'configure') throw new LaunchError('That is not a game-sauce setup link.');
  const server = u.searchParams.get('server') ? normalizeOrigin(u.searchParams.get('server')) : null, token = String(u.searchParams.get('token') || '');
  if (u.searchParams.get('server') && !server) throw new LaunchError('The link has no valid server address.');
  if (token && (!server || !/^[A-Za-z0-9_-]{20,100}$/.test(token))) throw new LaunchError('The link has no valid token.');
  return { server, token: token || null };
}

/** A safe file name for the temporary copy: the game's title (some emulators guess the system from the name) plus extension. */
export function safeFileName(title, ext) {
  const base = String(title || 'game').replace(/[^\w .()\-\[\]]+/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80) || 'game';
  return base + (ext || '');
}

/* ───────────────────────────── config ───────────────────────────── */

const TEMPLATE = {
  _help: 'servers: the game-sauce addresses this launcher may download from. emulators: one entry per platform slug (e.g. nes, snes, gba, genesis, ps1). command = full path to the emulator program; args = its arguments, where {rom} is replaced by the ROM path (added at the end if you leave it out). Set "deleteOnExit": false for an emulator that hands over to another process and returns straight away. A zipped game (.zip, .7z, .rar) is unpacked first for Xbox 360 and PS3 (Xenia and RPCS3 cannot open archives); set "unpack": true for another platform, or false to hand the archive over as it is. "launchFile" (optional, for example "**/default.xex") says which unpacked file starts the game; "sevenZip" (top level) is the full path of 7z if it is not found. "quickLaunch": true keeps a game on this PC after the emulator closes (no download or unpacking next time); "cacheDir" (top level, or on a platform) is where, and "cacheLimitGb" (top level, default 100, 0 = no limit) how much to keep.',
  servers: [],
  emulators: {
    snes: { command: 'C:\\Emulators\\Snes9x\\snes9x-x64.exe', args: ['{rom}'] },
    gba: { command: '/usr/bin/mgba-qt', args: ['{rom}'] },
    nes: { command: 'C:\\Emulators\\RetroArch\\retroarch.exe', args: ['-L', 'C:\\Emulators\\RetroArch\\cores\\fceumm_libretro.dll', '{rom}'], deleteOnExit: true }
  }
};

export function writeTemplate(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(TEMPLATE, null, 2) + '\n', { flag: 'wx' });
}

export function loadConfig(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new LaunchError(`Cannot read ${file}: ${e.message}`);
  }
  let cfg;
  try { cfg = JSON.parse(text); } catch (e) { throw new LaunchError(`${file} is not valid JSON (${e.message}). Common causes: a missing or doubled quote, or a single backslash in a Windows path (write \\\\ or use / instead).`); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new LaunchError(`${file} must be a JSON object.`);
  const servers = (Array.isArray(cfg.servers) ? cfg.servers : []).map(normalizeOrigin).filter(Boolean);
  const emulators = cfg.emulators && typeof cfg.emulators === 'object' ? cfg.emulators : {};
  return {
    servers, emulators,
    sevenZip: typeof cfg.sevenZip === 'string' && cfg.sevenZip.trim() ? cfg.sevenZip.trim() : undefined,
    cacheDir: typeof cfg.cacheDir === 'string' && cfg.cacheDir.trim() ? cfg.cacheDir.trim() : undefined,   // quick launch: the folder games are kept in (each platform may have its own)
    cacheLimitGb: typeof cfg.cacheLimitGb === 'number' ? cfg.cacheLimitGb : undefined
  };
}

/** The platforms this PC can start: every emulator in the config with a command. A command written as a full path must exist; one written as just
 *  a program name (found through the PATH) is taken as it is. A wrong setting inside the file cannot be told from here. */
export function configuredPlatforms(cfg, exists = (p) => fs.existsSync(p)) {
  const out = [];
  for (const [slug, entry] of Object.entries(cfg?.emulators || {})) {
    if (!/^[a-z0-9_-]{1,40}$/.test(slug) || !entry || typeof entry.command !== 'string' || !entry.command.trim()) continue;
    const cmd = entry.command.trim();
    if ((path.isAbsolute(cmd) || /^[A-Za-z]:[\\/]/.test(cmd)) && !exists(cmd)) continue;
    out.push(slug);
  }
  return out.sort();
}

/** The command line for a ROM: the configured command, its args with {rom} / {romdir} filled in. No shell is involved. */
export function buildCommand(entry, romPath) {
  if (!entry || typeof entry.command !== 'string' || !entry.command.trim()) throw new LaunchError('This platform has no "command" in the config.');
  const rawArgs = entry.args === undefined ? ['{rom}'] : entry.args;
  if (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== 'string')) throw new LaunchError('"args" must be a list of strings.');
  const sub = (a) => a.replaceAll('{rom}', romPath).replaceAll('{romdir}', path.dirname(romPath));
  const args = rawArgs.map(sub);
  if (!rawArgs.some((a) => a.includes('{rom}'))) args.push(romPath);
  return { command: entry.command, args };
}

/* ───────────────────────────── download, run, clean up ───────────────────────────── */

function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); return true; } catch (e) {
    log(`Could not delete ${dir}: ${e.message}`);
    return false;
  }
}

/** Some emulators write saves and save states next to the ROM they were given, which here is the temporary copy. Anything in
 *  the temporary folder besides the ROM itself is copied to ~/.gamesauce/rescued/<title>-<time>/ before the folder is deleted,
 *  so it is not lost. Returns { dest, count } or null when there was nothing. Throws if the copy fails. */
export function rescueExtras(dir, romPath, title, skipDir = null) {
  const extras = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (skipDir && p === skipDir) continue;   // the unpacked game itself is not a save
      if (e.isDirectory()) walk(p);
      else if (p !== romPath) extras.push(p);
    }
  };
  walk(dir);
  if (!extras.length) return null;
  const dest = path.join(rescueParent(), `${safeFileName(title, '')}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  for (const p of extras) {
    const to = path.join(dest, path.relative(dir, p));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(p, to);
  }
  return { dest, count: extras.length };
}

/** Remove temporary folders an earlier run left behind (a crash, a power cut). Only ours, only old ones. */
export function sweepStale(parent = tempParent(), now = Date.now()) {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const dir = path.join(parent, name);
    try {
      if (now - fs.statSync(dir).mtimeMs > STALE_MS && removeDir(dir)) removed++;
    } catch { /* gone already */ }
  }
  return removed;
}

async function download(server, token, destFile) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000); // time to get a response; the body itself may take as long as it needs
  let res;
  try {
    res = await fetch(`${server}/api/launch/${encodeURIComponent(token)}`, { signal: ctl.signal });
  } catch (e) {
    throw new LaunchError(`Could not reach ${server}: ${e.cause?.code || e.message}`);
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    let why = `HTTP ${res.status}`;
    try { why = (await res.json()).error || why; } catch { /* not JSON */ }
    throw new LaunchError(why);
  }
  if (!res.body) throw new LaunchError('The server sent an empty answer.');
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destFile));
  if (fs.statSync(destFile).size === 0) throw new LaunchError('The downloaded ROM is empty.');
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

/** Do one launch from a gamesauce:// link. Resolves to a short result object; throws LaunchError for problems to show the person. */
export async function launch(rawUrl, { configFile = configPath() } = {}) {
  const link = parseLaunchUrl(rawUrl);

  const cfg = loadConfig(configFile);
  if (!cfg) {
    try { writeTemplate(configFile); } catch { /* ignore */ }
    throw new LaunchError(`No config yet. I created ${configFile}. Add "${link.server}" to "servers" and set your emulators, then click Play locally again.`);
  }
  if (!cfg.servers.includes(link.server)) {
    throw new LaunchError(`${link.server} is not listed under "servers" in ${configFile}. Add it there if you trust it.`);
  }
  const entry = cfg.emulators[link.platform];
  if (!entry) throw new LaunchError(`No emulator is set for "${link.platform}" in ${configFile}.`);

  sweepStale();

  // Quick launch: this platform keeps its games in the cache folder (launcher/cache.mjs). A game kept there that is still the one the server has starts at once.
  const cached = wantsCache(entry) && Boolean(link.rom) && Boolean(link.fp);
  const cacheDir = cached ? cacheDirFor(entry, cfg) : null;
  const dir = cached ? entryDirFor(cacheDir, link.platform, link.rom) : fs.mkdtempSync(path.join(tempParent(), TEMP_PREFIX));
  let fresh = null;
  if (cached) {
    fresh = findFresh(dir, link.fp);
    if (!fresh && fs.existsSync(dir)) {   // an old version of the game, or a half-made one: cleared (saves the emulator wrote there are copied out first)
      if (readMeta(dir)) {
        const r = removeEntry(dir, { rescueParent: rescueParent(), log });
        if (!r.removed) throw new LaunchError(`"${link.title}" is kept in the quick launch cache and could not be refreshed (is it still open in the emulator?). Close it and try again.`);
      } else removeDir(dir);
    }
    fs.mkdirSync(dir, { recursive: true });
  }
  // An Xbox Live Arcade package (".xbla" in the library) is handed over with no extension: Xenia takes a file without one for an STFS package.
  const romPath = path.join(dir, safeFileName(link.title, link.ext === '.xbla' ? '' : link.ext));
  let child = null, unpacked = null, prepared = Boolean(fresh);
  const onSignal = (sig) => {
    try { child?.kill(); } catch { /* already gone */ }
    if (cached) { unlockEntry(dir); if (!prepared) removeDir(dir); } else removeDir(dir);
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    let startPath;
    if (fresh) {
      startPath = path.join(dir, ...fresh.start.split('/'));
      log(`Quick launch: "${link.title}" (${link.platform}) is already on this PC, starting it without downloading`);
    } else {
      log(`Downloading "${link.title}" (${link.platform}) from ${link.server}`);
      await download(link.server, link.token, romPath);

      // A zipped game for an emulator that cannot open one: unpack it next to the download, drop the archive, and start the file that boots the game.
      startPath = romPath;
      if (wantsUnpack(entry, link.platform, link.ext)) {
        unpacked = path.join(dir, 'game');
        log(`Unpacking "${link.title}" (this can take a while for a big game)`);
        let how;
        try { how = await unpackArchive(romPath, unpacked, { sevenZip: typeof cfg.sevenZip === 'string' ? cfg.sevenZip : undefined }); } catch (e) { throw new LaunchError(e instanceof UnpackError ? e.message : `Could not unpack the game: ${e.message}`); }
        try { fs.rmSync(romPath, { force: true }); } catch { /* the copy is deleted at the end anyway */ }
        const pick = pickLaunchFile(listFiles(unpacked), link.platform, entry);
        if (!pick) throw new LaunchError('The game was unpacked, but there is nothing in it to start. Set "launchFile" for this platform in launcher.json (for example "**/default.xex").');
        startPath = path.join(unpacked, pick);
        log(`Unpacked with ${how}; starting ${pick}`);
      }
      if (cached) {   // what is kept, and how to tell later that it is still the server's file
        const manifest = listTree(dir);
        writeMeta(dir, { title: link.title, platform: link.platform, rom: link.rom, fp: link.fp, start: path.relative(dir, startPath).split(path.sep).join('/'), manifest: manifest.map((f) => f.path), bytes: manifest.reduce((n, f) => n + f.size, 0), lastPlayed: new Date().toISOString() });
        prepared = true;
      }
    }
    if (cached) lockEntry(dir);

    const { command, args } = buildCommand(entry, startPath);
    log(`Starting ${command}`);
    child = spawn(command, args, {
      stdio: 'ignore',
      cwd: path.isAbsolute(command) && fs.existsSync(path.dirname(command)) ? path.dirname(command) : undefined
    });
    const r = await waitForExit(child);
    if (r.error) throw new LaunchError(`Could not start ${command}: ${r.error.code === 'ENOENT' ? 'file not found' : r.error.message}`);
    log(`Emulator closed (${r.signal ? `signal ${r.signal}` : `exit code ${r.code}`})`);
    return { ok: true, code: r.code, signal: r.signal };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (cached) {
      unlockEntry(dir);
      if (!prepared) removeDir(dir);   // a download or unpack that did not finish is not kept
      else {
        const m = readMeta(dir);
        if (m) { try { writeMeta(dir, { ...m, lastPlayed: new Date().toISOString(), bytes: treeBytes(dir) }); } catch { /* the old tag stays */ } }
        log(`Kept "${link.title}" in the quick launch cache (${dir})`);
        try { prune(cacheDir, limitBytes(cfg), { keep: dir, rescueParent: rescueParent(), log }); } catch (e) { log(`Could not tidy the cache: ${e.message}`); }
      }
    } else if (entry.deleteOnExit === false) log(`Kept ${dir} ("deleteOnExit" is false for ${link.platform})`);
    else {
      let keep = false;
      try {
        const r = rescueExtras(dir, romPath, link.title, unpacked);
        if (r) log(`The emulator wrote ${r.count} file(s) next to the ROM (saves?). Copied them to ${r.dest}`);
      } catch (e) {
        keep = true; // never delete something we could not copy out
        log(`Could not copy out files the emulator wrote (${e.message}). Kept ${dir}`);
      }
      if (!keep && removeDir(dir)) log('Deleted the temporary ROM copy');
    }
  }
}

/** "Check my PC": tell the server which platforms have an emulator here (names only: no paths, no commands). */
export async function syncPlatforms(rawUrl, { configFile = configPath(), fetchImpl = fetch, exists } = {}) {
  const link = parseSyncUrl(rawUrl);
  const cfg = loadConfig(configFile);
  if (!cfg) {
    try { writeTemplate(configFile); } catch { /* ignore */ }
    throw new LaunchError(`No config yet. I created ${configFile}. Add "${link.server}" to "servers" and set your emulators, then press Check my PC again.`);
  }
  if (!cfg.servers.includes(link.server)) throw new LaunchError(`${link.server} is not listed under "servers" in ${configFile}. Add it there if you trust it.`);
  const platforms = configuredPlatforms(cfg, exists);
  let res;
  try {
    res = await fetchImpl(`${link.server}/api/launcher/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link.token, platforms }) });
  } catch (e) { throw new LaunchError(`Could not reach ${link.server}: ${e.message}`); }
  if (!res.ok) { let m = ''; try { m = (await res.json()).error; } catch { /* no body */ } throw new LaunchError(m || `The server answered ${res.status}.`); }
  log(`Told ${link.server} about ${platforms.length} platform(s): ${platforms.join(', ') || 'none'}`);
  return { ok: true, platforms };
}

/* ───────────────────────────── entry point ───────────────────────────── */

async function main() {
  const arg = process.argv[2];
  if (arg === '--configure' || /^gamesauce:\/\/configure([?/]|$)/i.test(arg || '')) {
    try {
      const link = arg === '--configure' ? {} : parseConfigureUrl(arg);
      const { startConfigServer } = await import('./configure.mjs');
      const s = await startConfigServer({ addServer: link.server || null, syncToken: link.token ? { server: link.server, token: link.token } : null });
      log(`Setup page open at ${s.url.replace(/k=.*/, 'k=…')}`);
      if (arg === '--configure') console.log(`If your browser did not open, go to: ${s.url}`);
      await s.closed;
      return;
    } catch (e) { log(`FAILED: ${e.message}`); notify(e.message); process.exit(1); }
  }
  if (!arg) {
    console.error('Usage: gamesauce-launcher <gamesauce://launch?...>\nRegister it with install-windows.bat or install-linux.sh so the "Play locally" button can call it.');
    process.exit(2);
  }
  try {
    if (/^gamesauce:\/\/sync[?/]/i.test(arg)) {
      const r = await syncPlatforms(arg);
      notify(r.platforms.length ? `game-sauce now knows this PC can play: ${r.platforms.join(', ')}` : 'No emulators are set up in launcher.json yet, so game-sauce will only offer games that play in the browser.');
      return;
    }
    await launch(arg);
  } catch (e) {
    const msg = e instanceof LaunchError ? e.message : `Unexpected problem: ${e.stack || e.message}`;
    log(`FAILED: ${msg}`);
    notify(msg);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
