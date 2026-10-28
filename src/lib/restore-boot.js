// Applies a staged restore BEFORE the database is opened. Imported first thing in server.js
// (ES modules evaluate in import order, and this file deliberately never imports db.js).
//
// Flow: Settings -> Backups -> Restore validates a backup into <data>/restore-staging/<token>,
// takes a safety backup, writes <data>/restore-pending.json and restarts the process. On the
// way back up this module swaps the files in. Nothing is deleted: the data being replaced is
// moved to <data>/pre-restore-<timestamp>/ so a restore can always be undone by hand.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const stampNow = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

function move(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(src, dst); }
  catch (err) {
    if (err.code !== 'EXDEV') throw err; // different volume (Docker): copy then remove
    fs.copyFileSync(src, dst);
    fs.unlinkSync(src);
  }
}
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

export function defaultPaths() {
  const dataDir = path.resolve(process.env.GAMESAUCE_DATA_DIR || 'data');
  return {
    dataDir,
    dbFile: process.env.GAMESAUCE_DB_FILE || path.join(dataDir, 'gamesauce.db'),
    keyFile: path.join(dataDir, 'secret.key'),
    storageDir: path.resolve(process.env.GAMESAUCE_STORAGE_DIR || 'storage'),
    keyFromEnv: Boolean(process.env.GAMESAUCE_SECRET_KEY)
  };
}

export function applyPendingRestore(paths = defaultPaths(), log = console) {
  const { dataDir, dbFile, keyFile, storageDir, keyFromEnv } = paths;
  const markerFile = path.join(dataDir, 'restore-pending.json');
  if (!exists(markerFile)) return { applied: false };

  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch { marker = null; }
  const done = () => { try { fs.unlinkSync(markerFile); } catch { /* gone */ } };
  const token = String(marker?.token || '');
  const staging = path.join(dataDir, 'restore-staging', token);
  if (!/^[a-f0-9]{32}$/.test(token) || !exists(path.join(staging, 'gamesauce.db'))) {
    log.error('game-sauce: a restore was requested but its staged files are missing; nothing was changed');
    done();
    return { applied: false, error: 'staged files missing' };
  }

  const kept = path.join(dataDir, `pre-restore-${stampNow()}`);
  const undo = []; // [from, to] moves to reverse if something fails half-way
  try {
    // A restored database must not resurrect old logins.
    const staged = new Database(path.join(staging, 'gamesauce.db'));
    try {
      if (staged.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('staged database failed its integrity check');
      try { staged.prepare('DELETE FROM sessions').run(); } catch { /* table absent in very old backups */ }
      staged.pragma('wal_checkpoint(TRUNCATE)');
    } finally { staged.close(); }
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(path.join(staging, `gamesauce.db${ext}`)); } catch { /* none */ } }

    fs.mkdirSync(kept, { recursive: true });
    const stash = (src, name) => {
      if (!exists(src)) return;
      const dst = path.join(kept, name);
      move(src, dst); undo.push([dst, src]);
    };
    const place = (src, dst) => { move(src, dst); undo.push([dst, src]); };

    // Current state moves aside…
    stash(dbFile, 'gamesauce.db');
    stash(`${dbFile}-wal`, 'gamesauce.db-wal');
    stash(`${dbFile}-shm`, 'gamesauce.db-shm');
    const stagedKey = path.join(staging, 'secret.key');
    const replaceKey = !keyFromEnv && exists(stagedKey);
    if (replaceKey) stash(keyFile, 'secret.key');
    const savesDir = path.join(storageDir, 'saves');
    const stagedSaves = path.join(staging, 'saves');
    if (exists(stagedSaves) || exists(savesDir)) {
      if (exists(savesDir)) { fs.cpSync(savesDir, path.join(kept, 'saves'), { recursive: true }); fs.rmSync(savesDir, { recursive: true, force: true }); }
    }

    // …and the backup moves in.
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    place(path.join(staging, 'gamesauce.db'), dbFile);
    if (replaceKey) place(stagedKey, keyFile);
    if (exists(stagedSaves)) { fs.mkdirSync(storageDir, { recursive: true }); fs.cpSync(stagedSaves, savesDir, { recursive: true }); }

    fs.writeFileSync(path.join(dataDir, 'restore-last.json'), JSON.stringify({
      at: new Date().toISOString(), backup_created_at: marker.backup_created_at || null,
      safety_backup: marker.safety_backup || null, previous_data_kept_in: kept
    }, null, 2));
    fs.rmSync(path.join(dataDir, 'restore-staging'), { recursive: true, force: true });
    done();
    log.log(`game-sauce: restored from backup${marker.backup_created_at ? ` of ${marker.backup_created_at}` : ''}; previous data kept in ${kept}`);
    return { applied: true, kept };
  } catch (err) {
    log.error(`game-sauce: restore FAILED (${err.message}); putting the previous data back`);
    for (const [from, to] of undo.reverse()) { try { move(from, to); } catch { /* best effort */ } }
    done();
    return { applied: false, error: err.message };
  }
}

try { applyPendingRestore(); } catch (err) { console.error('game-sauce: restore step crashed:', err.message); }
