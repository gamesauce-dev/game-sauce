// Unused asset files in the storage folder: pictures, manuals and videos nothing points at any more (left behind by a deleted game, a replaced picture, a redone import).
// Scan first (nothing is changed), then clear out on request. Only these folders are looked at: covers, media (ScreenScraper pictures), rom-files (a game's own spine, disc, logo...),
// manuals and videos. ROMs, saves, emulators, DATs and the artwork folders an admin listed are never touched.
// "Used" is judged generously: a file counts as used when ANY text in the database mentions its name (or, for provider pictures, the address it was fetched from),
// so a missing reference can only keep a file, never lose one that is in use. A file written in the last ten minutes is left alone (an import or fetch may be mid-way).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db from '../db.js';
import { rootDir } from './storage.js';

const FRESH_MS = 10 * 60 * 1000;
export const GROUPS = [
  { key: 'covers', label: 'Covers', dir: 'covers', by: 'name' },
  { key: 'media', label: 'ScreenScraper pictures', dir: 'media', by: 'hash' },
  { key: 'rom-files', label: 'Game files (spines, discs, logos, marquees, backgrounds, manuals)', dir: 'rom-files', by: 'path' },
  { key: 'manuals', label: 'Manuals', dir: 'manuals', by: 'path' },
  { key: 'videos', label: 'Videos', dir: 'videos', by: 'path' }
];
const norm = (p) => String(p).replace(/\\/g, '/').split('/').filter(Boolean);
const URL_RE = /https?:\/\/[^\s"'<>\\]+/g;

/** Everything the database mentions: the last one, two and three parts of every path-like text, and the hash of every address (media files are named by it). */
function references() {
  const tails = new Set(), hashes = new Set();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
  for (const t of tables) {
    let cols;
    try { cols = db.prepare(`PRAGMA table_info("${t.replace(/"/g, '')}")`).all().filter((c) => !/BLOB/i.test(c.type || '')).map((c) => c.name); } catch { continue; }
    if (!cols.length) continue;
    let it;
    try { it = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${t.replace(/"/g, '')}"`).iterate(); } catch { continue; }
    for (const row of it) {
      for (const v of Object.values(row)) {
        if (typeof v !== 'string' || !v || v.length > 200000) continue;
        if (v.length < 600 && /[\\/]/.test(v) && !/^https?:/i.test(v)) { const s = norm(v); for (let n = 1; n <= 3 && n <= s.length; n++) tails.add(s.slice(-n).join('/').toLowerCase()); }
        else if (v.length < 600 && !/\s/.test(v)) tails.add(v.toLowerCase());
        if (v.includes('http')) for (const u of v.match(URL_RE) || []) hashes.add(crypto.createHash('sha1').update(u).digest('hex'));
      }
    }
  }
  return { tails, hashes };
}

function walk(dir) {
  const out = [];
  const go = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) go(p); else if (e.isFile()) out.push(p); } };
  go(dir);
  return out;
}

/** Look at the storage folder. Returns { groups: [{ key, label, files, bytes, sample }], total_files, total_bytes } and, for clearOut, the files themselves. */
export function scanStorage() {
  const { tails, hashes } = references();
  const root = rootDir(), now = Date.now();
  const groups = [], unused = [];
  for (const g of GROUPS) {
    const dir = path.join(root, g.dir);
    let files = 0, bytes = 0; const sample = [];
    for (const f of walk(dir)) {
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (now - st.mtimeMs < FRESH_MS) continue;
      const s = norm(f);
      const name = s[s.length - 1].toLowerCase();
      let used;
      if (g.by === 'name') used = tails.has(`${g.dir}/${name}`) || tails.has(name);
      else if (g.by === 'hash') { const m = /^[a-z0-9]+-([0-9a-f]{40})\./i.exec(name); used = m ? hashes.has(m[1].toLowerCase()) : true; }   // a name we do not recognise is kept
      else used = tails.has(s.slice(-3).join('/').toLowerCase());
      if (g.key === 'videos' && /\.part$/i.test(name)) used = false;   // a download that never finished
      if (used) continue;
      files++; bytes += st.size; unused.push({ file: f, bytes: st.size, group: g.key });
      if (sample.length < 12) {
        let rel = path.relative(root, f).replace(/\\/g, '/');
        const m = g.key === 'rom-files' ? /^rom-files\/(\d+)\//.exec(rel) : null;   // the folder is the game's id: say which game it is
        if (m) { const r = db.prepare('SELECT title FROM roms WHERE id = ?').get(Number(m[1])); rel += r ? `  (${r.title})` : '  (that game no longer exists)'; }
        sample.push(rel);
      }
    }
    groups.push({ key: g.key, label: g.label, files, bytes, sample });
  }
  return { groups, total_files: unused.length, total_bytes: unused.reduce((t, u) => t + u.bytes, 0), _unused: unused };
}

export const publicScan = ({ _unused, ...rest }) => rest;

/** Delete what a fresh scan finds unused (records are never changed: the app forgets one itself when its file is missing). Only the chosen groups, all of them when none are named. */
export function clearOut(keys = null) {
  const scan = scanStorage();
  const want = keys && keys.length ? new Set(keys) : null;
  let removed = 0, bytes = 0, failed = 0;
  for (const u of scan._unused) {
    if (want && !want.has(u.group)) continue;
    try { fs.unlinkSync(u.file); removed++; bytes += u.bytes; } catch { failed++; }
  }
  // Tidy folders the clear-out emptied (rom-files/<id>, manuals/<user>, videos/<platform>); the top folders stay.
  const root = rootDir();
  for (const g of GROUPS) {
    const top = path.join(root, g.dir);
    for (const f of (() => { try { return fs.readdirSync(top, { withFileTypes: true }); } catch { return []; } })()) {
      if (f.isDirectory()) { try { if (!fs.readdirSync(path.join(top, f.name)).length) fs.rmdirSync(path.join(top, f.name)); } catch { /* in use */ } }
    }
  }
  return { removed, bytes, failed };
}
