import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sniffProviderImage } from './coverzip.js';

// Resolved per call, not at import time, so tests and deployments can point the
// storage root anywhere by setting the environment before use.
export function rootDir() {
  return path.resolve(process.env.GAMESAUCE_STORAGE_DIR || 'storage');
}

export const ROOT = rootDir();
export const ROM_DIR = path.join(ROOT, 'roms');
export const COVER_DIR = path.join(ROOT, 'covers');

for (const dir of [ROM_DIR, COVER_DIR]) fs.mkdirSync(dir, { recursive: true });

export function storageDir(...parts) {
  const dir = path.join(rootDir(), ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const SAFE_EXT = /^[a-z0-9]{1,8}$/i;

export function safeExtension(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return SAFE_EXT.test(ext) ? ext : 'bin';
}

/** Store under roms/<platform>/<sha1-prefix>/<sha1>.<ext> — content-addressed, so a
 *  re-upload of the same file dedupes instead of duplicating gigabytes. */
export function romStoragePath(platformSlug, sha1, filename) {
  const dir = path.join(ROM_DIR, platformSlug, sha1.slice(0, 2));
  return path.join(dir, `${sha1}.${safeExtension(filename)}`);
}

export function ensureDirFor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/** Move an upload into its final content-addressed home. */
export function placeRom(tempPath, platformSlug, sha1, filename) {
  const dest = romStoragePath(platformSlug, sha1, filename);
  ensureDirFor(dest);
  if (!fs.existsSync(dest)) {
    try {
      fs.renameSync(tempPath, dest);
    } catch {
      fs.copyFileSync(tempPath, dest);
      fs.unlinkSync(tempPath);
    }
  } else {
    fs.unlinkSync(tempPath);
  }
  return dest;
}

export function saveCover(buffer, sha1, contentType = 'image/jpeg') {
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const dest = path.join(COVER_DIR, `${sha1}.${ext}`);
  fs.writeFileSync(dest, buffer);
  return dest;
}

export async function downloadCover(url, sha1) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
    const type = sniffProviderImage(buf);
    if (!type) return null; // not a picture (an error page, a cut-off download)
    const dest = saveCover(buf, sha1, type);
    if (!fs.existsSync(dest) || fs.statSync(dest).size !== buf.length) { try { fs.unlinkSync(dest); } catch { /* gone */ } return null; }
    return dest;
  } catch {
    return null;
  }
}

export function removeRomFile(storagePath) {
  try {
    if (storagePath && fs.existsSync(storagePath)) fs.unlinkSync(storagePath);
  } catch { /* best effort */ }
}

export function removeCoverFile(coverPath) {
  try {
    if (coverPath && fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
  } catch { /* best effort */ }
}

export function tempPath(originalName) {
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${safeExtension(originalName)}`;
  return path.join(ROM_DIR, '.incoming', name);
}

/** A cover a person uploaded for their own game is named for them (physical-<person>-..., digital-<person>-...): when their account goes, those go too. */
export function purgeCustomCovers(userId) {
  try {
    for (const f of fs.readdirSync(COVER_DIR)) if (f.startsWith(`physical-${Number(userId)}-`) || f.startsWith(`digital-${Number(userId)}-`)) fs.rmSync(path.join(COVER_DIR, f), { force: true });
  } catch { /* none */ }
}
/** Remove a stored cover only when it is one a person uploaded (never a provider's picture, which other games may share). */
export function dropCustomCover(file, prefix) {
  try { if (file && path.basename(file).startsWith(prefix) && fs.existsSync(file)) fs.rmSync(file, { force: true }); } catch { /* already gone */ }
}
