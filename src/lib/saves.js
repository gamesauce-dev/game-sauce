// Per-user save states + battery saves for browser play.
// Files: storage/saves/<userId>/<romId>/<random>.{state,sav,png}
// Everything is scoped by user_id — callers pass the signed-in user's id and
// there is no code path that reads another user's row.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db from '../db.js';
import { rootDir } from './storage.js';

export const MAX_STATES = Math.max(1, Number(process.env.GAMESAUCE_MAX_STATES) || 10);
export const MAX_BYTES = 32 * 1024 * 1024;
const MAX_SHOT = 2 * 1024 * 1024;

function dirFor(userId, romId) {
  const d = path.join(rootDir(), 'saves', String(Number(userId)), String(Number(romId)));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const rm = (p) => { try { if (p) fs.unlinkSync(p); } catch { /* already gone */ } };
const publicRow = (r) => ({
  id: r.id, rom_id: r.rom_id, kind: r.kind, core: r.core, size_bytes: r.size_bytes,
  has_screenshot: !!r.shot_path, created_at: r.created_at, updated_at: r.updated_at
});

export function listSaves(userId, romId) {
  return db.prepare('SELECT * FROM save_states WHERE user_id = ? AND rom_id = ? ORDER BY updated_at DESC, id DESC')
    .all(userId, romId).map(publicRow);
}

export function getSave(userId, romId, id) {
  return db.prepare('SELECT * FROM save_states WHERE id = ? AND user_id = ? AND rom_id = ?').get(id, userId, romId);
}

export function putSave(userId, romId, kind, core, bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw Object.assign(new Error('Empty save data'), { status: 400 });
  if (bytes.length > MAX_BYTES) throw Object.assign(new Error('Save too large'), { status: 413 });
  const file = path.join(dirFor(userId, romId), `${crypto.randomBytes(8).toString('hex')}.${kind === 'battery' ? 'sav' : 'state'}`);
  fs.writeFileSync(file, bytes);

  let id;
  db.transaction(() => {
    if (kind === 'battery') {
      const old = db.prepare("SELECT * FROM save_states WHERE user_id = ? AND rom_id = ? AND kind = 'battery'").get(userId, romId);
      if (old) { rm(old.file_path); rm(old.shot_path); db.prepare('DELETE FROM save_states WHERE id = ?').run(old.id); }
    }
    id = db.prepare('INSERT INTO save_states (user_id, rom_id, kind, core, size_bytes, file_path) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, romId, kind, core || null, bytes.length, file).lastInsertRowid;
    if (kind === 'state') {
      const extra = db.prepare("SELECT * FROM save_states WHERE user_id = ? AND rom_id = ? AND kind = 'state' ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?")
        .all(userId, romId, MAX_STATES);
      for (const e of extra) { rm(e.file_path); rm(e.shot_path); db.prepare('DELETE FROM save_states WHERE id = ?').run(e.id); }
    }
  })();
  return Number(id);
}

export function putScreenshot(userId, romId, id, bytes) {
  const row = getSave(userId, romId, id);
  if (!row) throw Object.assign(new Error('Save not found'), { status: 404 });
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_SHOT) throw Object.assign(new Error('Bad screenshot'), { status: 400 });
  rm(row.shot_path);
  const shot = row.file_path.replace(/\.[a-z]+$/, '.png');
  fs.writeFileSync(shot, bytes);
  db.prepare('UPDATE save_states SET shot_path = ? WHERE id = ?').run(shot, id);
}

export function deleteSave(userId, romId, id) {
  const row = getSave(userId, romId, id);
  if (!row) return 0;
  rm(row.file_path); rm(row.shot_path);
  return db.prepare('DELETE FROM save_states WHERE id = ?').run(id).changes;
}

/** Remove files for every save of a ROM / user. Call BEFORE deleting the row
 *  (the DB rows themselves cascade). */
export function purgeSaveFiles({ romId, userId }) {
  const rows = romId != null
    ? db.prepare('SELECT file_path, shot_path FROM save_states WHERE rom_id = ?').all(romId)
    : db.prepare('SELECT file_path, shot_path FROM save_states WHERE user_id = ?').all(userId);
  for (const r of rows) { rm(r.file_path); rm(r.shot_path); }
}
