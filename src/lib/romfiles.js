// Extra files kept for a Library game (ROM) beyond its cover: a spine, a disc, a back and a manual, brought in by the picture importer (src/lib/artimport.js).
// They are kept in their own table, not in roms.provider_media, so refreshing a game's metadata or clearing its match never loses them.
// The ROM Library is shared, so these are shared too. Files live in storage/rom-files/<rom id>/.
import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { storageDir } from './storage.js';
import { sniffImage } from './coverzip.js';
import { sniffManual, MAX_MANUAL_BYTES, cleanFileName } from './manuals.js';

export const ROM_FILE_KINDS = ['spine', 'disc', 'back', 'manual', 'logo', 'marquee', 'fanart'];   // logo: the game's title picture (arcade games use it); marquee: the banner; fanart: a background picture
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const dirFor = (romId) => storageDir('rom-files', String(Number(romId)));

/** Keep one file for a game, replacing the one of that kind it had. Throws a 400 for anything that is not a JPEG, PNG or WebP picture (a PDF or picture for a manual). */
export function setRomFile(romId, kind, buffer, originalName = '') {
  if (!ROM_FILE_KINDS.includes(kind)) throw Object.assign(new Error('Unknown kind of file.'), { status: 400 });
  let ext, type, name;
  if (kind === 'manual') {
    if (buffer.length > MAX_MANUAL_BYTES) throw Object.assign(new Error('That file is over 50 MB.'), { status: 400 });
    const m = sniffManual(buffer);
    if (!m) throw Object.assign(new Error('A manual must be a PDF or a picture (PNG, JPEG or WebP).'), { status: 400 });
    ({ ext, type } = m); name = `${cleanFileName(originalName).replace(/\.(pdf|png|jpe?g|webp)$/i, '') || 'Manual'}.${ext}`;
  } else {
    if (buffer.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('That image is over 8 MB.'), { status: 400 });
    type = sniffImage(buffer);
    if (!type) throw Object.assign(new Error('That file is not a JPEG, PNG or WebP image.'), { status: 400 });
    ext = EXT[type]; name = `${kind}.${ext}`;
  }
  const file = path.join(dirFor(romId), `${kind}-${Date.now()}.${ext}`);
  fs.writeFileSync(file, buffer);
  const old = db.prepare('SELECT path FROM rom_files WHERE rom_id = ? AND kind = ?').get(romId, kind);
  db.prepare('INSERT INTO rom_files (rom_id, kind, path, name, type, bytes) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(rom_id, kind) DO UPDATE SET path = excluded.path, name = excluded.name, type = excluded.type, bytes = excluded.bytes')
    .run(romId, kind, file, name, type, buffer.length);
  if (old?.path && old.path !== file) try { fs.unlinkSync(old.path); } catch { /* already gone */ }
  return { kind, name, type };
}

/** What a game has: [{ kind, name, type, url }] (a row whose file has gone is forgotten). */
export function romFiles(romId) {
  const out = [];
  for (const r of db.prepare('SELECT kind, path, name, type FROM rom_files WHERE rom_id = ? ORDER BY kind').all(romId)) {
    if (!fs.existsSync(r.path)) { db.prepare('DELETE FROM rom_files WHERE rom_id = ? AND kind = ?').run(romId, r.kind); continue; }
    out.push({ kind: r.kind, name: r.name, type: r.type, url: `/api/roms/${romId}/file/${r.kind}` });
  }
  return out;
}

export function romFile(romId, kind) {
  const r = db.prepare('SELECT path, name, type FROM rom_files WHERE rom_id = ? AND kind = ?').get(romId, kind);
  return r && fs.existsSync(r.path) ? r : null;
}

/** Every file a game has goes (its rows follow the game when it is deleted; this removes the files too). */
export function dropRomFiles(romId) {
  db.prepare('DELETE FROM rom_files WHERE rom_id = ?').run(romId);
  try { fs.rmSync(path.join(storageDir('rom-files'), String(Number(romId))), { recursive: true, force: true }); } catch { /* best effort */ }
}
