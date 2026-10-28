// Restore from a backup made by lib/backup.js. Two steps, so nothing is changed by accident:
//   1. stageRestore(file)  unpack into <data>/restore-staging/<token>, validate, return a summary
//   2. applyRestore(token) take a safety backup, write restore-pending.json, restart the process
// The actual file swap happens in lib/restore-boot.js before the database is opened, because a
// live SQLite file cannot be replaced safely underneath a running server.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import Database from 'better-sqlite3';
import db from '../db.js';
import { extractTar } from './tar.js';
import { runBackupToDir } from './backup.js';

const dataDir = () => path.resolve(process.env.GAMESAUCE_DATA_DIR || 'data');
const stagingRoot = () => path.join(dataDir(), 'restore-staging');
const markerFile = () => path.join(dataDir(), 'restore-pending.json');
export const MAX_RESTORE_BYTES = Number(process.env.GAMESAUCE_MAX_RESTORE || 2 * 1024 * 1024 * 1024);

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** The schema version this build of the app understands = what the live database is at. */
export const appSchemaVersion = () => Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0);

/** Can the process bring itself back after exiting? (systemd, Docker, or an explicit opt-in) */
export function restartSupported() {
  if (process.env.GAMESAUCE_RESTART === 'manual') return false;
  if (process.env.GAMESAUCE_RESTART === 'exit') return true;
  if (process.env.INVOCATION_ID) return true;                 // running under systemd
  try { if (fs.existsSync('/.dockerenv')) return true; } catch { /* not linux */ }
  return false;
}

// Only these entries are ever written out of an archive, and only inside the staging folder.
function destFor(staging, name) {
  const clean = path.posix.normalize(String(name).replace(/\\/g, '/'));
  if (clean.startsWith('/') || clean.startsWith('../') || clean === '..' || clean.includes('/../')) {
    throw fail(`Unsafe path in backup: ${name}`);
  }
  if (clean === 'manifest.json' || clean === 'gamesauce.db' || clean === 'secret.key') return path.join(staging, clean);
  if (clean.startsWith('saves/') && clean.length > 6) return path.join(staging, ...clean.split('/'));
  return null; // anything else in the archive is ignored
}

export function clearStaging() {
  try { fs.rmSync(stagingRoot(), { recursive: true, force: true }); } catch { /* best effort */ }
}

export async function stageRestore(uploadedFile) {
  clearStaging();
  const token = crypto.randomBytes(16).toString('hex');
  const staging = path.join(stagingRoot(), token);
  fs.mkdirSync(staging, { recursive: true });
  try {
    let written;
    try {
      const gz = zlib.createGunzip();
      // pipeline() (not .pipe) so a bad file tears both streams down instead of the file
      // reader writing into a destroyed gunzip stream.
      pipeline(fs.createReadStream(uploadedFile), gz, () => {});
      let bytes = 0;
      gz.on('data', (c) => { bytes += c.length; if (bytes > MAX_RESTORE_BYTES) gz.destroy(fail('Backup is larger than the allowed size')); });
      written = await extractTar(gz, (name) => destFor(staging, name));
    } catch (err) {
      if (err.status) throw err;
      if (/incorrect header check|unexpected end|invalid|not a valid|incomplete|corrupt|unsupported/i.test(err.message)) {
        throw fail(`That is not a usable game-sauce backup: ${err.message}`);
      }
      throw err;
    }

    const has = (n) => written.some((w) => w.name === n);
    if (!has('manifest.json') || !has('gamesauce.db')) throw fail('That is not a game-sauce backup (manifest.json or gamesauce.db is missing)');

    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8')); } catch { throw fail('The backup manifest is unreadable'); }
    if (manifest?.app !== 'game-sauce') throw fail('That file was not made by game-sauce');

    const warnings = [];
    const staged = new Database(path.join(staging, 'gamesauce.db'), { readonly: true, fileMustExist: true });
    let counts, schema, admins;
    try {
      if (staged.pragma('integrity_check', { simple: true }) !== 'ok') throw fail('The database inside this backup is damaged (integrity check failed)');
      schema = Number(staged.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0);
      const n = (sql) => { try { return staged.prepare(sql).get().n; } catch { return null; } };
      counts = {
        roms: n('SELECT COUNT(*) n FROM roms'), users: n('SELECT COUNT(*) n FROM users'),
        collections: n('SELECT COUNT(*) n FROM collections'), saves: n('SELECT COUNT(*) n FROM save_states')
      };
      admins = n("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND disabled = 0");
    } finally { staged.close(); }

    const current = appSchemaVersion();
    if (schema > current) throw fail(`This backup is from a newer game-sauce (database version ${schema}; this server understands up to ${current}). Update game-sauce first, then restore.`);
    if (!admins) throw fail('This backup has no active admin account, so nobody could sign in after restoring it');

    if (schema < current) warnings.push(`This backup is from an older version (database v${schema}); it will be upgraded automatically on restart.`);
    const keyInArchive = has('secret.key');
    if (process.env.GAMESAUCE_SECRET_KEY) {
      warnings.push('This server gets its encryption key from GAMESAUCE_SECRET_KEY. If the backup was made with a different key, stored provider credentials will not decrypt and must be re-entered.');
    } else if (!keyInArchive) {
      warnings.push('The backup has no secret.key, so stored provider credentials may not decrypt after restoring and would need re-entering.');
    }

    fs.writeFileSync(path.join(staging, 'summary.json'), JSON.stringify({ token }));
    return {
      token,
      manifest: { app_version: manifest.app_version, created_at: manifest.created_at, schema_version: schema },
      counts, current_counts: {
        roms: db.prepare('SELECT COUNT(*) n FROM roms').get().n,
        users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
        collections: db.prepare('SELECT COUNT(*) n FROM collections').get().n,
        saves: db.prepare('SELECT COUNT(*) n FROM save_states').get().n
      },
      key_in_backup: keyInArchive, warnings, restart_supported: restartSupported()
    };
  } catch (err) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }
}

export async function applyRestore(token, { restart = true } = {}) {
  if (!/^[a-f0-9]{32}$/.test(String(token || ''))) throw fail('Missing or invalid restore token');
  const staging = path.join(stagingRoot(), token);
  if (!fs.existsSync(path.join(staging, 'gamesauce.db'))) throw fail('That restore is no longer staged. Upload the backup again.', 404);

  // Safety net first: the current state, as an ordinary backup, in the backup folder.
  const safety = await runBackupToDir();
  fs.writeFileSync(markerFile(), JSON.stringify({
    token, requested_at: new Date().toISOString(), safety_backup: safety.name,
    backup_created_at: (() => { try { return JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8')).created_at; } catch { return null; } })()
  }));

  const canRestart = restartSupported();
  if (restart && canRestart) {
    // Let the HTTP response go out, then exit; the supervisor starts us again and
    // restore-boot.js performs the swap before the database is opened.
    setTimeout(() => process.exit(75), 800).unref?.();
  }
  return { ok: true, safety_backup: safety.name, restarting: Boolean(restart && canRestart), restart_supported: canRestart };
}

export function pendingRestore() {
  try { return JSON.parse(fs.readFileSync(markerFile(), 'utf8')); } catch { return null; }
}
export function lastRestore() {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), 'restore-last.json'), 'utf8')); } catch { return null; }
}
export function cancelPending() {
  try { fs.unlinkSync(markerFile()); } catch { /* none */ }
  clearStaging();
}
