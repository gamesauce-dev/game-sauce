// A problem picture that sharing has spread between accounts (see reuseArt in physical.js), dealt with by the admin without being shown anyone's library.
//
// What the admin is shown: only pictures that have travelled, that is, the same uploaded file held by two or more accounts, or a picture sharing is
// known to have copied. Never whose it is, never anything else about the game, and never a picture only one account has.
// "Remove and stop sharing" takes it off every shelf that has it and remembers it, so sharing does not copy it again. A picture is known by the exact
// content of its file: a re-saved or resized version counts as another picture. (Converting stored pictures to WebP is followed: see noteConverted.)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { dropCustomCover } from './storage.js';

const KINDS = ['cover', 'spine', 'disc', 'back'];
const SHAPES = ['cover', 'spine'];   // the kinds whose width to height is stored with them
const TRIED = ['spine', 'disc', 'back'];   // the kinds that remember when they were last looked for

const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// Reading a whole shelf of pictures each time would be slow: a file's fingerprint is kept until its size or date changes.
const seen = new Map();
function fileHash(file, st) {
  try {
    const s = st || fs.statSync(file), hit = seen.get(file);
    if (hit && hit.size === s.size && hit.mtime === s.mtimeMs) return hit.hash;
    const hash = digest(fs.readFileSync(file));
    seen.set(file, { size: s.size, mtime: s.mtimeMs, hash });
    return hash;
  } catch { return null; }
}

const isBlocked = (hash) => Boolean(hash && db.prepare('SELECT 1 FROM art_blocked WHERE hash = ?').get(hash));
export const isBlockedFile = (file) => isBlocked(fileHash(file));

/** Sharing is about to give an account a copy of this picture: remember that it has travelled. */
export function noteShared(file, { title, platform, kind }) {
  try {
    const st = fs.statSync(file), hash = fileHash(file, st);
    if (hash) db.prepare('INSERT OR IGNORE INTO art_shared (hash, bytes, title, platform, kind) VALUES (?, ?, ?, ?, ?)').run(hash, st.size, String(title).slice(0, 200), platform, kind);
  } catch { /* the record is not worth failing a copy over */ }
}

/** A stored picture is being rewritten (to WebP): what was known about the old content is true of the new. oldFile still holds the old content. */
export function noteConverted(oldFile, newBuffer) {
  const from = fileHash(oldFile);
  if (!from) return;
  const to = digest(newBuffer);
  db.prepare('INSERT OR IGNORE INTO art_shared (hash, bytes, title, platform, kind) SELECT ?, ?, title, platform, kind FROM art_shared WHERE hash = ?').run(to, newBuffer.length, from);
  db.prepare('INSERT OR IGNORE INTO art_blocked (hash, block_id, title, platform, kind) SELECT ?, block_id, title, platform, kind FROM art_blocked WHERE hash = ?').run(to, from);
}

/** Every picture on every shelf: where it is, whose row, and which of the four it is. For this file's use only: none of it leaves it. */
function holdings() {
  const out = [];
  const sizes = new Map();
  for (const g of db.prepare('SELECT id, user_id, title, platform, cover_path, spine_path, disc_path, back_path FROM physical_games').all()) {
    for (const kind of KINDS) {
      const file = g[`${kind}_path`];
      if (!file) continue;
      if (!sizes.has(file)) { try { sizes.set(file, fs.statSync(file)); } catch { sizes.set(file, null); } }
      const st = sizes.get(file);
      if (st) out.push({ row: g.id, user: g.user_id, title: g.title, platform: g.platform, kind, file, st, uploaded: path.basename(file).startsWith('physical-') });
    }
  }
  return out;
}

/** The pictures that have travelled, each with the shelves that hold it. */
function travelled() {
  const all = holdings();
  const record = new Set(db.prepare('SELECT bytes FROM art_shared').all().map((r) => r.bytes));
  // Only files that could possibly qualify are read: of a size sharing has recorded, or of a size that two accounts have uploads of.
  const bySize = new Map();
  for (const h of all) if (h.uploaded) { if (!bySize.has(h.st.size)) bySize.set(h.st.size, new Set()); bySize.get(h.st.size).add(h.user); }
  const groups = new Map();
  for (const h of all) {
    if (!record.has(h.st.size) && !(bySize.get(h.st.size)?.size > 1)) continue;
    const hash = fileHash(h.file, h.st);
    if (!hash) continue;
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash).push(h);
  }
  const known = db.prepare('SELECT 1 FROM art_shared WHERE hash = ?');
  for (const [hash, holders] of groups) {
    const uploaders = new Set(holders.filter((h) => h.uploaded).map((h) => h.user));
    if (uploaders.size < 2 && !known.get(hash)) groups.delete(hash);
  }
  return groups;
}

/** For the admin's list: which picture, of which game, and on how many accounts. Nothing about who. */
export function sharedPictures() {
  return [...travelled()]
    .map(([id, holders]) => ({ id, kind: holders[0].kind, title: holders[0].title, platform: holders[0].platform, accounts: new Set(holders.map((h) => h.user)).size }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.kind.localeCompare(b.kind));
}

/** The file of a listed picture, or null: a picture that is not on the list cannot be looked at. */
export const sharedPictureFile = (id) => travelled().get(String(id))?.[0].file || null;

/** What has been stopped, newest first (no picture: it is gone from the shelves). */
export const blockedPictures = () => db.prepare('SELECT block_id AS id, title, platform, kind, MIN(blocked_at) AS blocked_at FROM art_blocked GROUP BY block_id ORDER BY blocked_at DESC, title').all();

/** Take a listed picture off every shelf that has it and stop it being shared. Returns how many pictures were removed, or null when it is not listed. */
export function removeAndBlock(id) {
  const holders = travelled().get(String(id));
  if (!holders) return null;
  const { title, platform, kind } = holders[0];
  // If it is a converted copy and its original was kept aside, the original is the same picture: block that too.
  const hashes = new Set([String(id)]);
  for (const h of holders) {
    for (const c of db.prepare('SELECT kept_path FROM image_conversions WHERE new_path = ? AND kept_path IS NOT NULL').all(h.file)) {
      const original = fileHash(c.kept_path);
      if (original) hashes.add(original);
    }
  }
  const block = db.prepare('INSERT OR REPLACE INTO art_blocked (hash, block_id, title, platform, kind) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (const hash of hashes) block.run(hash, String(id), title, platform, kind);
    for (const h of holders) {
      const extra = [
        ...(SHAPES.includes(h.kind) ? [`${h.kind}_ar = NULL`] : []),
        // not looked for again by itself: that could bring the same one back
        TRIED.includes(h.kind) ? `${h.kind}_tried_at = datetime('now')` : "meta_tried_at = COALESCE(meta_tried_at, datetime('now'))"
      ];
      db.prepare(`UPDATE physical_games SET ${h.kind}_path = NULL, ${h.kind}_url = NULL, ${h.kind}_locked = 0, ${extra.map((x) => `${x}, `).join('')}updated_at = datetime('now') WHERE id = ?`).run(h.row);
    }
  })();
  // Each account's own copy of an upload goes. A provider's picture is a shared download that other things may point at, so its file stays.
  for (const h of holders) if (h.uploaded && !db.prepare(`SELECT 1 FROM physical_games WHERE ${KINDS.map((k) => `${k}_path = ?`).join(' OR ')}`).get(h.file, h.file, h.file, h.file)) dropCustomCover(h.file, 'physical-');
  return { removed: holders.length, title, platform, kind };
}

/** Let a stopped picture be shared again. False when there is no such block. (It does not bring removed pictures back.) */
export const allowAgain = (id) => db.prepare('DELETE FROM art_blocked WHERE block_id = ?').run(String(id)).changes > 0;
