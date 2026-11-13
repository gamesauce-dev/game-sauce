// Quick launch: keep a game on this PC after the emulator closes, so the next launch needs no download and no unpacking.
//
// A platform with "quick launch" on downloads (and unpacks) the game into the cache folder instead of a temporary one, and the folder is kept. The next launch of
// the same game finds it, checks it is still the file the server has (a fingerprint of its size and date), and starts the emulator straight away.
//
//   <cache folder>/gamesauce-cache/<platform>-<game id>/        one folder per game: everything the launcher put there, plus
//       .gamesauce-cache.json     what it is: title, fingerprint, the file that starts the game, every file it brought in (the manifest), last played, size
//       .gamesauce-lock           present while an emulator is using it (holds the launcher's process id)
//
// The launcher only ever deletes folders that carry the .gamesauce-cache.json tag inside a gamesauce-cache folder, so a wrong path in the setup page cannot
// delete anything else. Anything in a game's folder that is not in its manifest (a save the emulator wrote beside the game) is copied to the rescue folder
// before the folder is removed. The cache is limited in size: the games played longest ago go first, never one that is running.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TAG = '.gamesauce-cache.json';
export const LOCK = '.gamesauce-lock';
export const CACHE_FOLDER = 'gamesauce-cache';
export const DEFAULT_LIMIT_GB = 100;
export const ENTRY_NAME = /^[a-z0-9_-]{1,40}-\d{1,12}$/;

export const defaultCacheDir = () => path.join(os.homedir(), '.gamesauce', 'cache');
const norm = (p) => String(p).replace(/\\/g, '/');

/** Where a platform keeps its games: its own folder, else the shared one, else the default. */
export function cacheDirFor(entry, cfg) {
  const own = typeof entry?.cacheDir === 'string' && entry.cacheDir.trim() ? entry.cacheDir.trim() : '';
  const shared = typeof cfg?.cacheDir === 'string' && cfg.cacheDir.trim() ? cfg.cacheDir.trim() : '';
  return own || shared || defaultCacheDir();
}
export const wantsCache = (entry) => entry?.quickLaunch === true;
/** The limit in bytes for a cache folder: 0 means no limit. */
export function limitBytes(cfg) {
  const gb = typeof cfg?.cacheLimitGb === 'number' && Number.isFinite(cfg.cacheLimitGb) && cfg.cacheLimitGb >= 0 ? cfg.cacheLimitGb : DEFAULT_LIMIT_GB;
  return Math.round(gb * 1024 * 1024 * 1024);
}
export const entryDirFor = (cacheDir, platform, romId) => path.join(cacheDir, CACHE_FOLDER, `${platform}-${romId}`);

/** Every file under a folder (relative paths, forward slashes) with its size; the tag and lock files are not counted. */
export function listTree(root) {
  const out = [];
  const walk = (d) => {
    let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of items) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && !(d === root && (e.name === TAG || e.name === LOCK))) { let size = 0; try { size = fs.statSync(p).size; } catch { /* gone */ } out.push({ path: norm(path.relative(root, p)), size }); }
    }
  };
  walk(root);
  return out;
}
export const treeBytes = (root) => listTree(root).reduce((n, f) => n + f.size, 0);

export function readMeta(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, TAG), 'utf8'));
    return m && typeof m === 'object' && m.v === 1 && typeof m.start === 'string' && Array.isArray(m.manifest) ? m : null;
  } catch { return null; }
}
export function writeMeta(dir, meta) { fs.writeFileSync(path.join(dir, TAG), JSON.stringify({ v: 1, ...meta })); }

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function isInUse(dir) {
  try {
    const pid = Number(fs.readFileSync(path.join(dir, LOCK), 'utf8'));
    return Number.isInteger(pid) && pid > 0 && alive(pid);
  } catch { return false; }
}
export const lockEntry = (dir) => { try { fs.writeFileSync(path.join(dir, LOCK), String(process.pid)); } catch { /* best effort */ } };
export const unlockEntry = (dir) => { try { fs.rmSync(path.join(dir, LOCK), { force: true }); } catch { /* gone */ } };

/** A game kept here that is still the one the server has, with the file that starts it present. Returns its meta or null. */
export function findFresh(dir, fp) {
  const m = readMeta(dir);
  if (!m || !fp || m.fp !== fp) return null;
  try { return fs.statSync(path.join(dir, m.start)).isFile() ? m : null; } catch { return null; }
}

/** Files in a game's folder that the launcher did not bring in (saves the emulator wrote beside the game). */
export function extrasOf(dir, meta) {
  const known = new Set((meta?.manifest || []).map(norm));
  return listTree(dir).filter((f) => !known.has(f.path));
}

/** Copy a game's extras to `<rescueParent>/<title>-<time>/` and return { dest, count } or null. Throws if a copy fails (the folder must then be kept). */
export function rescue(dir, meta, rescueParent, title = 'game') {
  const extras = extrasOf(dir, meta);
  if (!extras.length) return null;
  const safe = String(title || 'game').replace(/[^\w .()\-\[\]]+/g, '_').slice(0, 60) || 'game';
  const dest = path.join(rescueParent, `${safe}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  for (const f of extras) {
    const to = path.join(dest, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(dir, ...f.path.split('/')), to);
  }
  return { dest, count: extras.length };
}

/** Remove one kept game: only a folder with the tag, never one in use, saves copied out first. Returns { removed, bytes, rescued } (removed false when it was left). */
export function removeEntry(dir, { rescueParent, log = () => {} } = {}) {
  const meta = readMeta(dir);
  if (!meta && !fs.existsSync(path.join(dir, TAG))) return { removed: false, bytes: 0, rescued: null };   // not ours: left alone
  if (isInUse(dir)) return { removed: false, bytes: 0, rescued: null };
  let rescued = null;
  if (meta && rescueParent) {
    try { rescued = rescue(dir, meta, rescueParent, meta.title); if (rescued) log(`Copied ${rescued.count} file(s) the emulator wrote for "${meta.title}" to ${rescued.dest}`); }
    catch (e) { log(`Could not copy out files for "${meta?.title}" (${e.message}); kept ${dir}`); return { removed: false, bytes: 0, rescued: null }; }
  }
  const bytes = treeBytes(dir);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { log(`Could not delete ${dir}: ${e.message}`); return { removed: false, bytes: 0, rescued }; }
  return { removed: true, bytes, rescued };
}

/** The games kept in one cache folder: [{ name, dir, title, platform, rom, bytes, lastPlayed, inUse }], newest first. */
export function listEntries(cacheDir) {
  const root = path.join(cacheDir, CACHE_FOLDER), out = [];
  let names = []; try { names = fs.readdirSync(root); } catch { return out; }
  for (const name of names) {
    if (!ENTRY_NAME.test(name)) continue;
    const dir = path.join(root, name), meta = readMeta(dir);
    if (!meta) continue;
    out.push({ name, dir, title: meta.title || name, platform: meta.platform || '', rom: meta.rom || null, bytes: Number(meta.bytes) || treeBytes(dir), lastPlayed: meta.lastPlayed || '', inUse: isInUse(dir) });
  }
  return out.sort((a, b) => String(b.lastPlayed).localeCompare(String(a.lastPlayed)));
}

/** Keep one cache folder within its limit: the games played longest ago go first; `keep` (the game just played) and any in use stay. Returns the titles removed. */
export function prune(cacheDir, limit, { keep = null, rescueParent, log = () => {} } = {}) {
  if (!limit || limit <= 0) return [];
  const entries = listEntries(cacheDir).reverse();   // oldest first
  let total = entries.reduce((n, e) => n + e.bytes, 0);
  const gone = [];
  for (const e of entries) {
    if (total <= limit) break;
    if (e.inUse || (keep && path.resolve(e.dir) === path.resolve(keep))) continue;
    const r = removeEntry(e.dir, { rescueParent, log });
    if (r.removed) { total -= e.bytes; gone.push(e.title); log(`Quick launch cache over its limit: removed "${e.title}"`); }
  }
  return gone;
}

/** Empty one cache folder, or one game in it (`name`). Returns { removed, bytes, left } where left counts the ones in use or that could not be removed. */
export function empty(cacheDir, { name = null, rescueParent, log = () => {} } = {}) {
  let removed = 0, bytes = 0, left = 0;
  for (const e of listEntries(cacheDir)) {
    if (name && e.name !== name) continue;
    const r = removeEntry(e.dir, { rescueParent, log });
    if (r.removed) { removed++; bytes += r.bytes; } else left++;
  }
  return { removed, bytes, left };
}
