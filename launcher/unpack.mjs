// Unpack a zipped game before the emulator is started (some emulators, Xenia and RPCS3 for example, cannot open a .zip or .7z).
//
// The launcher downloads the game's one file into a temporary folder. When that file is an archive and the platform asks for it (the setup page,
// or "unpack": true in launcher.json; Xbox 360 and PS3 do it unless "unpack" is false), it is unpacked into a folder next to it, the archive is
// deleted to save room, and the emulator is given the file that starts the game (an .iso, default.xex, EBOOT.BIN...). Everything is deleted
// again when the emulator closes, like the downloaded copy always was.
//
// No dependencies. The unpacking itself is done by a program already on the PC: 7-Zip (best; it opens .7z, .zip and .rar), else the system's
// tar (Windows 10 and later, macOS: .zip and usually .7z) or unzip (Linux: .zip).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const ARCHIVE_EXT = new Set(['.zip', '.7z', '.rar']);
/** Platforms that unpack unless the config says "unpack": false (their emulators cannot open an archive). */
export const AUTO_UNPACK = new Set(['xbox360', 'ps3']);

export const isArchive = (ext) => ARCHIVE_EXT.has(String(ext || '').toLowerCase());

/** Should this launch unpack? entry.unpack: true / false decides; otherwise the platforms in AUTO_UNPACK do. Only ever for an archive. */
export function wantsUnpack(entry, platform, ext) {
  if (!isArchive(ext)) return false;
  if (entry?.unpack === true) return true;
  if (entry?.unpack === false) return false;
  return AUTO_UNPACK.has(platform);
}

/* ───────────────────────────── which file starts the game ───────────────────────────── */

const norm = (p) => String(p).replace(/\\/g, '/');
const depth = (p) => norm(p).split('/').length;
/** A glob (* any run of letters, ** any run including folders, ? one letter) as a case-blind test on a path with forward slashes. */
export function globTest(pattern) {
  const src = norm(pattern).replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?');
  const re = new RegExp('^(?:.*/)?' + src + '$', 'i');   // matched anywhere in the tree unless the pattern names the folders
  return (p) => re.test(norm(p));
}

/* What to start, best first, per platform. A rule is a test on the path (lower case, forward slashes) and the picks are the shallowest, then the biggest. */
const ISO = (p) => p.endsWith('.iso');
const RULES = {
  xbox360: [ISO, (p) => p.endsWith('/default.xex') || p === 'default.xex', (p) => p.endsWith('.xex'), (p) => /(^|\/)000d0000\/[^/.]+$/.test(p)],   // the last: an Xbox Live Arcade package
  xbox: [ISO, (p) => p.endsWith('/default.xbe') || p === 'default.xbe', (p) => p.endsWith('.xbe')],
  ps3: [ISO, (p) => /(^|\/)ps3_game\/usrdir\/eboot\.bin$/.test(p), (p) => /(^|\/)eboot\.bin$/.test(p)],
  wiiu: [(p) => p.endsWith('.wua'), (p) => p.endsWith('.wud') || p.endsWith('.wux'), (p) => /(^|\/)code\/[^/]+\.rpx$/.test(p)],
  default: [(p) => p.endsWith('.cue'), (p) => p.endsWith('.gdi'), (p) => p.endsWith('.m3u'), ISO, (p) => p.endsWith('.chd')]
};
const JUNK = /(^|\/)(__macosx|\.ds_store|thumbs\.db|desktop\.ini)(\/|$)|\.(txt|nfo|jpg|jpeg|png|url|diz|md5|sfv|sha1)$/i;

/**
 * Choose the file to give the emulator from what was unpacked. `files`: [{ path (relative to the unpacked folder), size }].
 * `entry.launchFile`: your own pattern(s) ("**\/default.xex") that win over the rules. Returns the chosen relative path or null.
 */
export function pickLaunchFile(files, platform, entry = {}) {
  const list = (files || []).filter((f) => f && f.path && !JUNK.test(norm(f.path)));
  if (!list.length) return null;
  const best = (cands) => [...cands].sort((a, b) => depth(a.path) - depth(b.path) || b.size - a.size || norm(a.path).localeCompare(norm(b.path)))[0] || null;
  const mine = [].concat(entry.launchFile || []).filter((s) => typeof s === 'string' && s.trim());
  for (const pat of mine) { const t = globTest(pat), hit = best(list.filter((f) => t(f.path))); if (hit) return hit.path; }
  for (const rule of RULES[platform] || RULES.default) {
    const hit = best(list.filter((f) => rule(norm(f.path).toLowerCase())));
    if (hit) return hit.path;
  }
  return [...list].sort((a, b) => b.size - a.size)[0].path;   // nothing matched a rule: the biggest file
}

/** Every file under a folder: [{ path (relative, forward slashes), size }]. */
export function listFiles(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { let size = 0; try { size = fs.statSync(p).size; } catch { /* gone */ } out.push({ path: norm(path.relative(root, p)), size }); }
    }
  };
  walk(root);
  return out;
}

/* ───────────────────────────── the unpacking program ───────────────────────────── */

/** Where 7-Zip usually is, after any path in the config ("sevenZip") or the environment (GAMESAUCE_7Z). */
export function sevenZipCandidates(cfgPath, env = process.env, platform = process.platform) {
  const list = [cfgPath, env.GAMESAUCE_7Z].filter((s) => typeof s === 'string' && s.trim());
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files']) if (base) list.push(path.join(base, '7-Zip', '7z.exe'));
    list.push('7z.exe', '7z');
  } else if (platform === 'darwin') list.push('7zz', '7z', '7za', '/opt/homebrew/bin/7zz', '/usr/local/bin/7zz', '/opt/homebrew/bin/7z');
  else list.push('7zz', '7z', '7za', '7zr');
  return [...new Set(list)];
}

/** The commands to try, best first, to unpack `archive` into `dest`. */
export function unpackCommands(archive, dest, { ext = path.extname(archive).toLowerCase(), sevenZip, platform = process.platform, env = process.env } = {}) {
  const out = sevenZipCandidates(sevenZip, env, platform).map((command) => ({ command, args: ['x', '-y', `-o${dest}`, archive], what: '7-Zip' }));
  if (platform === 'linux') { if (ext === '.zip') out.push({ command: 'unzip', args: ['-q', '-o', archive, '-d', dest], what: 'unzip' }); }
  else out.push({ command: platform === 'win32' ? 'tar.exe' : 'tar', args: ['-xf', archive, '-C', dest], what: 'tar' });
  if (platform === 'linux') out.push({ command: 'bsdtar', args: ['-xf', archive, '-C', dest], what: 'bsdtar' });
  return out;
}

function run(command, args) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, { stdio: 'ignore', windowsHide: true }); } catch (error) { return resolve({ error }); }
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code) => resolve({ code }));
  });
}

export class UnpackError extends Error {}

/**
 * Unpack `archive` into `dest` (made if needed), trying each program in turn. Returns the name of the program that worked.
 * Throws UnpackError saying what to install when none could do it. `runImpl` is for tests.
 */
export async function unpackArchive(archive, dest, { sevenZip, runImpl = run, platform, env } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  const tried = [];
  for (const c of unpackCommands(archive, dest, { sevenZip, platform, env })) {
    const r = await runImpl(c.command, c.args);
    if (r.error) { if (r.error.code !== 'ENOENT') tried.push(`${c.what}: ${r.error.message}`); continue; }
    if (r.code === 0) return c.what;
    tried.push(`${c.what} stopped with code ${r.code}`);
  }
  throw new UnpackError(tried.length
    ? `The game could not be unpacked (${[...new Set(tried)].join('; ')}). The file may be damaged, or the disk may be full.`
    : 'The game is zipped, and nothing on this PC can unpack it. Install 7-Zip (7-zip.org), or set "sevenZip" in launcher.json to the full path of 7z.');
}
