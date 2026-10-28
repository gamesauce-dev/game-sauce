// Backups: one .tar.gz holding a consistent database snapshot, the encryption key and
// every user's saves. Imported ROMs, covers and media are deliberately NOT included
// (they can be many GB; covers can be re-fetched).
//
//   gamesauce.db     SQLite online-backup copy — safe while the app is running
//   secret.key       encrypts provider credentials (only when it lives in a file)
//   saves/...        per-user save states + battery saves
//   manifest.json    app/schema version, date, counts, what is and is not inside
//
// The tar is written by hand (ustar) and streamed through gzip, so a backup never has to
// fit in memory and the app needs no extra dependency. Restore lives in lib/restore.js.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import db from '../db.js';
import { rootDir } from './storage.js';
import { tarHeader, tarPad as pad } from './tar.js';

const dataDir = () => process.env.GAMESAUCE_DATA_DIR || path.resolve('data');
export const defaultBackupDir = () => process.env.GAMESAUCE_BACKUP_DIR || path.join(dataDir(), 'backups');
const NAME_RE = /^game-sauce-backup-\d{8}-\d{6}(?:-\d+)?\.tar\.gz$/;
export const isBackupName = (n) => NAME_RE.test(String(n || ''));

const appVersion = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; }
  catch { return 'unknown'; }
})();

/* ───────────────────────────── settings ───────────────────────────── */

const getMeta = (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null;
const setMeta = (k, v) => {
  if (v === null || v === undefined) db.prepare('DELETE FROM meta WHERE key = ?').run(k);
  else db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
};

export const INTERVAL_CHOICES = [0, 6, 12, 24, 168]; // hours; 0 = off

export function getBackupSettings() {
  return {
    interval_hours: Number(getMeta('backup_interval_hours') || 0),
    keep: Number(getMeta('backup_keep') || 7),
    dir: getMeta('backup_dir') || '',
    effective_dir: getMeta('backup_dir') || defaultBackupDir(),
    default_dir: defaultBackupDir(),
    last_at: getMeta('backup_last_at'),
    last_error: getMeta('backup_last_error'),
    key_in_env: Boolean(process.env.GAMESAUCE_SECRET_KEY)
  };
}

export function saveBackupSettings({ interval_hours, keep, dir }) {
  const hours = Number(interval_hours);
  if (!INTERVAL_CHOICES.includes(hours)) throw Object.assign(new Error('Choose off, 6, 12, 24 or 168 hours'), { status: 400 });
  const k = Math.floor(Number(keep));
  if (!Number.isFinite(k) || k < 1 || k > 365) throw Object.assign(new Error('Keep must be between 1 and 365'), { status: 400 });

  let chosen = String(dir || '').trim();
  if (chosen) {
    if (!path.isAbsolute(chosen)) throw Object.assign(new Error('The backup folder must be an absolute path'), { status: 400 });
    chosen = path.resolve(chosen);
    try {
      fs.mkdirSync(chosen, { recursive: true });
      const probe = path.join(chosen, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
    } catch (err) {
      throw Object.assign(new Error(`Cannot write to that folder: ${err.code || err.message}`), { status: 400 });
    }
  }
  setMeta('backup_interval_hours', hours);
  setMeta('backup_keep', k);
  setMeta('backup_dir', chosen || null);
  return getBackupSettings();
}

async function* fileEntries(root, rel = '') {
  let list;
  try { list = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of list) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* fileEntries(root, r);
    else if (e.isFile()) yield r;
  }
}

async function* tarChunks({ dbCopy, manifest, keyFile, savesRoot }) {
  const now = Math.floor(Date.now() / 1000);
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
  yield tarHeader('manifest.json', manifestBuf.length, now);
  yield manifestBuf;
  if (pad(manifestBuf.length)) yield pad(manifestBuf.length);

  const dbSize = fs.statSync(dbCopy).size;
  yield tarHeader('gamesauce.db', dbSize, now);
  let sent = 0;
  for await (const chunk of fs.createReadStream(dbCopy)) { sent += chunk.length; yield chunk; }
  if (sent !== dbSize) throw new Error('Database snapshot changed while it was being read');
  if (pad(dbSize)) yield pad(dbSize);

  if (keyFile && fs.existsSync(keyFile)) {
    const buf = fs.readFileSync(keyFile);
    yield tarHeader('secret.key', buf.length, now);
    yield buf;
    if (pad(buf.length)) yield pad(buf.length);
  }

  if (savesRoot && fs.existsSync(savesRoot)) {
    for await (const rel of fileEntries(savesRoot)) {
      let buf;
      try { buf = fs.readFileSync(path.join(savesRoot, rel)); } catch { continue; } // deleted mid-backup
      yield tarHeader(`saves/${rel}`, buf.length, now);
      yield buf;
      if (pad(buf.length)) yield pad(buf.length);
    }
  }
  yield Buffer.alloc(1024); // end-of-archive marker
}

/* ───────────────────────────── create ───────────────────────────── */

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

function countOf(sql) { try { return db.prepare(sql).get().n; } catch { return null; } }

/**
 * Take a snapshot and return a gzip stream of the archive plus a cleanup function that
 * removes the temporary database copy (call it when the stream ends or errors).
 */
export async function createBackupStream() {
  const tmpDir = dataDir();
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbCopy = path.join(tmpDir, `.backup-tmp-${process.pid}-${Date.now()}.db`);
  await db.backup(dbCopy); // consistent even with writers active (WAL)

  const keyFile = process.env.GAMESAUCE_SECRET_KEY ? null : path.join(dataDir(), 'secret.key');
  const savesRoot = path.join(rootDir(), 'saves');
  const manifest = {
    app: 'game-sauce',
    app_version: appVersion,
    schema_version: Number(getMeta('schema_version') || 0),
    created_at: new Date().toISOString(),
    counts: {
      roms: countOf('SELECT COUNT(*) AS n FROM roms'),
      users: countOf('SELECT COUNT(*) AS n FROM users'),
      collections: countOf('SELECT COUNT(*) AS n FROM collections'),
      save_files: countOf('SELECT COUNT(*) AS n FROM save_states')
    },
    includes: {
      database: true,
      secret_key: Boolean(keyFile && fs.existsSync(keyFile)),
      saves: true,
      imported_roms: false,
      covers_and_media: false
    },
    note: process.env.GAMESAUCE_SECRET_KEY
      ? 'The encryption key is supplied by GAMESAUCE_SECRET_KEY and is NOT in this archive; keep it safe or stored provider credentials cannot be decrypted after a restore.'
      : 'Contains secret.key and password hashes: store this archive as carefully as the server itself.'
  };

  const cleanup = () => { try { fs.unlinkSync(dbCopy); } catch { /* already gone */ } };
  const stream = Readable.from(tarChunks({ dbCopy, manifest, keyFile, savesRoot })).pipe(zlib.createGzip({ level: 6 }));
  stream.on('close', cleanup);
  stream.on('error', cleanup);
  return { stream, cleanup, manifest, name: `game-sauce-backup-${stamp()}.tar.gz` };
}

/* ───────────────────────── backups kept on the server ───────────────────────── */

export function listBackups(dir = getBackupSettings().effective_dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(isBackupName).map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return { name, size: st.size, created_at: st.mtime.toISOString() };
  // Names embed the timestamp, so a plain (not locale-aware) comparison is chronological and
  // survives the files being copied around (which changes their modified time).
  }).sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

let running = false;
export const backupRunning = () => running;

export async function runBackupToDir() {
  if (running) throw Object.assign(new Error('A backup is already running'), { status: 409 });
  running = true;
  const s = getBackupSettings();
  const dir = s.effective_dir;
  let partial = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const { stream, manifest, name } = await createBackupStream();
    // Millisecond suffix: names stay unique (and sortable) even when old ones are pruned.
    const ms = String(new Date().getMilliseconds()).padStart(3, '0');
    let final = name.replace(/\.tar\.gz$/, `-${ms}.tar.gz`), n = 0;
    while (fs.existsSync(path.join(dir, final))) final = name.replace(/\.tar\.gz$/, `-${ms}${++n}.tar.gz`);
    partial = path.join(dir, `.partial-${process.pid}-${Date.now()}`);
    await pipeline(stream, fs.createWriteStream(partial));
    fs.renameSync(partial, path.join(dir, final)); // only a finished file ever gets a real name
    partial = null;
    setMeta('backup_last_at', new Date().toISOString());
    setMeta('backup_last_error', null);
    const st = fs.statSync(path.join(dir, final));
    const removed = pruneBackups(dir, s.keep, final); // the file just written is never pruned
    return { name: final, size: st.size, created_at: st.mtime.toISOString(), manifest, pruned: removed };
  } catch (err) {
    if (partial) { try { fs.unlinkSync(partial); } catch { /* nothing to clean */ } }
    setMeta('backup_last_error', `${new Date().toISOString()} — ${err.code || ''} ${err.message}`.trim());
    throw err;
  } finally {
    running = false;
  }
}

/** Keep the newest `keep` backups. Only touches files this feature created. */
export function pruneBackups(dir, keep, protect = null) {
  const all = listBackups(dir);
  const doomed = all.slice(Math.max(1, keep)).filter((b) => b.name !== protect);
  for (const b of doomed) { try { fs.unlinkSync(path.join(dir, b.name)); } catch { /* best effort */ } }
  return doomed.map((b) => b.name);
}

export function deleteBackup(name) {
  if (!isBackupName(name)) throw Object.assign(new Error('Not a backup file'), { status: 400 });
  const file = path.join(getBackupSettings().effective_dir, name);
  if (!fs.existsSync(file)) return 0;
  fs.unlinkSync(file);
  return 1;
}

export function backupPath(name) {
  if (!isBackupName(name)) return null;
  const file = path.join(getBackupSettings().effective_dir, name);
  return fs.existsSync(file) ? file : null;
}

/* ───────────────────────────── scheduler ───────────────────────────── */

let timer = null;
export function startBackupScheduler({ checkEveryMs = 5 * 60 * 1000 } = {}) {
  if (timer) return;
  const tick = async () => {
    try {
      const s = getBackupSettings();
      if (!s.interval_hours) return;
      const last = s.last_at ? Date.parse(s.last_at) : 0;
      if (Date.now() - last < s.interval_hours * 3600 * 1000) return;
      await runBackupToDir();
      console.log('game-sauce: scheduled backup written');
    } catch (err) {
      console.error('game-sauce: scheduled backup failed:', err.message);
    }
  };
  timer = setInterval(tick, checkEveryMs);
  timer.unref?.();
  setTimeout(tick, 30_000).unref?.(); // catch up soon after a restart if one is due
}
