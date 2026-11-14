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

const emuKey = (title) => String(title || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();   // the same key the videos are filed under (src/lib/emumovies.js titleKey)

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

const IMG_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' };
const KINDS = ['spine', 'disc', 'back', 'manual', 'logo', 'marquee', 'fanart'];

/** An unused file that belongs to a game which exists but has lost its record of it: a game's own file (rom-files/<id>/<kind>-<time>.<ext>) with no record of that kind, or a video the game's title names with no video on record. */
function belongsTo(group, rel, name, ctx) {
  if (group === 'rom-files') {
    const m = /^rom-files\/(\d+)\/([a-z]+)-(\d+)\.([a-z0-9]+)$/i.exec(rel);
    if (!m || !KINDS.includes(m[2]) || !IMG_TYPE[m[4].toLowerCase()]) return null;
    const id = Number(m[1]);
    if (!db.prepare('SELECT 1 FROM roms WHERE id = ?').get(id) || db.prepare('SELECT 1 FROM rom_files WHERE rom_id = ? AND kind = ?').get(id, m[2])) return null;
    return { type: 'file', slot: `f${id}/${m[2]}`, id, kind: m[2], ext: m[4].toLowerCase(), stamp: Number(m[3]) };
  }
  if (group === 'videos') {
    const m = /^videos\/([^/]+)\/([^/]+?)\.[a-z0-9]+$/i.exec(rel);
    if (!m || /\.part$/i.test(name)) return null;
    const slug = m[1], stem = m[2].toLowerCase();
    if (!ctx.keys.has(slug)) ctx.keys.set(slug, new Map(db.prepare('SELECT r.title FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE p.slug = ?').all(slug).map((r) => { const k = emuKey(r.title); return [k.replace(/ /g, '-').slice(0, 120), k]; })));
    const key = ctx.keys.get(slug).get(stem);
    if (!key || db.prepare('SELECT 1 FROM game_videos WHERE platform = ? AND title_key = ? AND path IS NOT NULL').get(slug, key)) return null;
    return { type: 'video', slot: `v${slug}/${key}`, slug, key };
  }
  return null;
}

/** Look at the storage folder. Returns { groups: [{ key, label, files, bytes, sample }], total_files, total_bytes, relink: { files, bytes, sample } } and, for the actions, the files themselves. */
export function scanStorage() {
  const { tails, hashes } = references();
  const root = rootDir(), now = Date.now(), ctx = { keys: new Map() };
  const rel = (f) => path.relative(root, f).replace(/\\/g, '/');
  const groups = [], unused = [], cands = new Map();
  for (const g of GROUPS) {
    const dir = path.join(root, g.dir);
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
      const entry = { file: f, bytes: st.size, group: g.key, mtime: st.mtimeMs };
      const link = belongsTo(g.key, rel(f), name, ctx);
      if (link) { entry.link = link; if (!cands.has(link.slot)) cands.set(link.slot, []); cands.get(link.slot).push(entry); } else unused.push(entry);
    }
  }
  const relink = [];
  for (const list of cands.values()) { list.sort((a, b) => (b.link.stamp ?? 0) - (a.link.stamp ?? 0) || b.mtime - a.mtime); relink.push(list[0]); unused.push(...list.slice(1).map((e) => ({ ...e, link: null }))); }   // the newest file of a kind is the one to take back
  const label = (e) => {
    let r = rel(e.file);
    const m = e.group === 'rom-files' ? /^rom-files\/(\d+)\//.exec(r) : null;   // the folder is the game's id: say which game it is
    if (m) { const g = db.prepare('SELECT title FROM roms WHERE id = ?').get(Number(m[1])); r += g ? `  (${g.title})` : '  (that game no longer exists)'; }
    return r;
  };
  for (const g of GROUPS) {
    const mine = unused.filter((u) => u.group === g.key);
    groups.push({ key: g.key, label: g.label, files: mine.length, bytes: mine.reduce((t, u) => t + u.bytes, 0), sample: mine.slice(0, 12).map(label) });
  }
  return {
    groups, total_files: unused.length, total_bytes: unused.reduce((t, u) => t + u.bytes, 0),
    relink: { files: relink.length, bytes: relink.reduce((t, u) => t + u.bytes, 0), sample: relink.slice(0, 12).map(label) },
    _unused: unused, _relink: relink
  };
}

export const publicScan = ({ _unused, _relink, ...rest }) => rest;

/** Take back files whose game exists but has lost its record: the record is written again, the file is not touched. */
export function reattach() {
  const scan = scanStorage();
  let done = 0, skipped = 0;
  const addFile = db.prepare('INSERT INTO rom_files (rom_id, kind, path, name, type, bytes) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(rom_id, kind) DO NOTHING');
  const addVideo = db.prepare("INSERT INTO game_videos (platform, title_key, path, bytes, source, fetched_at, tried_at) VALUES (?, ?, ?, ?, 'emumovies', datetime('now'), datetime('now')) ON CONFLICT(platform, title_key) DO UPDATE SET path = excluded.path, bytes = excluded.bytes WHERE game_videos.path IS NULL");
  for (const e of scan._relink) {
    const l = e.link;
    const r = l.type === 'file'
      ? addFile.run(l.id, l.kind, e.file, l.kind === 'manual' ? `Manual.${l.ext}` : `${l.kind}.${l.ext}`, IMG_TYPE[l.ext], e.bytes)
      : addVideo.run(l.slug, l.key, e.file, e.bytes);
    if (r.changes) done++; else skipped++;
  }
  return { reattached: done, skipped };
}

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
