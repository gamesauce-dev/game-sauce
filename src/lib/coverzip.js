// Import cover pictures from a zip (the one Settings > Game names > Export covers writes, or any zip of pictures named after games).
// A picture is matched to a game by file name: "snes/Super Mario World (USA).png" belongs to the SNES game whose file is
// "Super Mario World (USA).sfc" (or .zip, .7z ...). Without a folder, the platform picked on the page is used.
//
// The zip is read straight from disk, one picture at a time (nothing but the picture being saved is in memory), with no dependency:
// stored and deflated entries are supported (what every zip tool writes); zip64 (over 4 GB) is refused with a clear message.
import fs from 'node:fs';
import zlib from 'node:zlib';
import db from '../db.js';
import { saveCover, removeCoverFile } from './storage.js';

export const MAX_COVER_BYTES = 8 * 1024 * 1024;   // the same cap as a single uploaded cover
const MAX_ENTRIES = 60000;

/** JPEG / PNG / WebP only: GIF and SVG are never accepted (an SVG can carry scripts). Same rule as a single uploaded cover. */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** The entries of a zip: [{ name, method, csize, size, off }]. Throws a plain-language error for anything it cannot read. */
export function listZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = fs.fstatSync(fd).size;
    if (len < 22) throw new Error('That file is not a zip');
    const tailLen = Math.min(len, 66000), tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, len - tailLen);
    let e = tailLen - 22; while (e >= 0 && tail.readUInt32LE(e) !== 0x06054b50) e--;
    if (e < 0) throw new Error('That file is not a zip');
    const n = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (n === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new Error('This zip is over 4 GB (zip64): split it into smaller zips');
    if (n > MAX_ENTRIES) throw new Error(`This zip holds ${n} files; the limit is ${MAX_ENTRIES} at a time`);
    const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
    const out = []; let p = 0;
    for (let i = 0; i < n; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('This zip is damaged');
      const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
      out.push({ name: cd.toString('utf8', p + 46, p + 46 + nl), flags: cd.readUInt16LE(p + 8), method: cd.readUInt16LE(p + 10),
        csize: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24), off: cd.readUInt32LE(p + 42) });
      p += 46 + nl + el + cl;
    }
    return out;
  } finally { fs.closeSync(fd); }
}

/** One picture's bytes, or null when it cannot be read safely (encrypted, too big, an unknown packing, damaged). */
export function readEntry(file, ent) {
  if (ent.flags & 1) return null;                                  // password-protected
  if (ent.size > MAX_COVER_BYTES || ent.csize > MAX_COVER_BYTES) return null;
  const fd = fs.openSync(file, 'r');
  try {
    const lh = Buffer.alloc(30); fs.readSync(fd, lh, 0, 30, ent.off);
    if (lh.readUInt32LE(0) !== 0x04034b50) return null;
    const start = ent.off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const raw = Buffer.alloc(ent.csize); fs.readSync(fd, raw, 0, ent.csize, start);
    if (ent.method === 0) return raw;
    if (ent.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_COVER_BYTES });
    return null;
  } catch { return null; } finally { fs.closeSync(fd); }
}

const baseKey = (name) => String(name || '').replace(/\.[A-Za-z0-9]{1,6}$/, '').trim().toLowerCase();

/**
 * Match the zip's pictures to games. Returns { matches: [{ entry, rom }], counts }.
 * options: { platform }: with one chosen, ONLY that platform's pictures are used (a picture in another platform's folder is skipped, a picture
 * with no folder is taken to be for it). With none chosen, the folder name in the zip says which platform each picture is for.
 * replace = also replace covers games already have.
 */
export function planCovers(entries, { platform = '', replace = false } = {}) {
  const roms = db.prepare('SELECT r.id, r.filename, r.cover_path, r.cover_locked, p.slug FROM roms r JOIN platforms p ON p.id = r.platform_id').all();
  const byKey = new Map();
  for (const r of roms) { const k = `${r.slug}/${baseKey(r.filename)}`; (byKey.get(k) || byKey.set(k, []).get(k)).push(r); }
  const counts = { pictures: 0, matched: 0, will_set: 0, already_have: 0, unmatched: 0, not_image: 0, skipped: 0, other_platform: 0 };
  const matches = [], unmatchedNames = [];
  for (const ent of entries) {
    if (ent.name.endsWith('/') || /(^|\/)(\.|__MACOSX)/.test(ent.name)) continue;
    if (/\.(gif|svg)$/i.test(ent.name)) { counts.pictures++; counts.not_image++; continue; }   // never accepted (an SVG can carry scripts): said so in the preview
    if (!/\.(jpe?g|png|webp)$/i.test(ent.name)) { counts.skipped++; continue; }
    counts.pictures++;
    const parts = ent.name.split('/'); const file = parts.pop(); const own = (parts.pop() || '').toLowerCase();
    const folder = own || String(platform || '').toLowerCase();
    if (platform && own && own !== String(platform).toLowerCase()) { counts.other_platform++; continue; }   // a different platform's picture
    const hit = byKey.get(`${folder}/${baseKey(file)}`);
    if (!hit) { counts.unmatched++; if (unmatchedNames.length < 6) unmatchedNames.push(ent.name); continue; }
    counts.matched++;
    for (const rom of hit) {
      const has = Boolean(rom.cover_path);
      if (has && !replace) { counts.already_have++; continue; }
      matches.push({ entry: ent, rom }); counts.will_set++;
    }
  }
  return { matches, counts, unmatchedNames };
}

/** Save the planned pictures. A picture that is not a real JPEG/PNG/WebP is counted and skipped. Returns the final counts. */
export function applyCovers(file, plan) {
  const stats = { set: 0, not_image: 0, unreadable: 0 };
  const still = db.prepare('SELECT 1 FROM roms WHERE cover_path = ? AND id != ? LIMIT 1');
  const upd = db.prepare("UPDATE roms SET cover_path = ?, cover_locked = 1, updated_at = datetime('now') WHERE id = ?");
  for (const m of plan.matches) {
    const buf = readEntry(file, m.entry);
    if (!buf) { stats.unreadable++; continue; }
    const type = sniffImage(buf);
    if (!type) { stats.not_image++; continue; }
    const dest = saveCover(buf, `custom-${m.rom.id}-${Date.now()}`, type);
    // Remove the old file only when no other game points at it (provider covers can be shared).
    const old = m.rom.cover_path;
    upd.run(dest, m.rom.id);
    if (old && old !== dest && !still.get(old, m.rom.id)) removeCoverFile(old);
    stats.set++;
  }
  return stats;
}
