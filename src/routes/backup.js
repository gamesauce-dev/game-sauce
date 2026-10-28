import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { stageRestore, applyRestore, cancelPending, pendingRestore, lastRestore, appSchemaVersion, restartSupported, clearStaging, MAX_RESTORE_BYTES } from '../lib/restore.js';
import { audit } from '../auth.js';
import { pipeline } from 'node:stream/promises';
import {
  backupPath, backupRunning, createBackupStream, deleteBackup, getBackupSettings,
  INTERVAL_CHOICES, listBackups, runBackupToDir, saveBackupSettings
} from '../lib/backup.js';

// Mounted behind requireAdmin in app.js: backups contain the encryption key and password hashes.
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ settings: getBackupSettings(), items: listBackups(), running: backupRunning(), intervals: INTERVAL_CHOICES });
});

router.put('/settings', (req, res, next) => {
  try { res.json({ settings: saveBackupSettings(req.body || {}) }); } catch (err) { next(err); }
});

// Back up now, into the configured server folder (applies the keep-N rule).
router.post('/run', async (req, res, next) => {
  try { res.status(201).json(await runBackupToDir()); } catch (err) { next(err); }
});

// Download a fresh backup straight to the browser (nothing is kept on the server).
router.get('/download', async (req, res, next) => {
  let handle;
  try {
    handle = await createBackupStream();
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${handle.name}"`);
    res.setHeader('Cache-Control', 'no-store');
    await pipeline(handle.stream, res);
  } catch (err) {
    handle?.cleanup();
    if (!res.headersSent) next(err); else res.destroy(err);
  }
});

// Download / delete a backup kept on the server. The name is validated, never used as a path.
router.get('/files/:name', (req, res) => {
  const file = backupPath(req.params.name);
  if (!file) return res.status(404).json({ error: 'Backup not found' });
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
});

router.delete('/files/:name', (req, res, next) => {
  try { res.json({ removed: deleteBackup(req.params.name) }); } catch (err) { next(err); }
});

/* ───────────────────────────── restore ───────────────────────────── */

// Uploads land in the data folder (not the OS temp dir, which may be a small tmpfs).
const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.resolve(process.env.GAMESAUCE_DATA_DIR || 'data', 'restore-upload');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `upload-${Date.now()}.tar.gz`)
  }),
  limits: { fileSize: MAX_RESTORE_BYTES }
});

router.get('/restore/status', (req, res) => {
  res.json({ restart_supported: restartSupported(), schema_version: appSchemaVersion(), pending: pendingRestore(), last: lastRestore() });
});

// Step 1: upload and CHECK a backup. Changes nothing; returns what is inside it.
// Same check, for a backup already in the server's backup folder (no download/upload round trip).
// The name is validated and resolved inside the backup folder only.
router.post('/restore/inspect-server', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '');
    const file = backupPath(name);
    if (!file) return res.status(404).json({ error: 'Backup not found in the server folder' });
    res.json({ ...(await stageRestore(file)), source_name: name });
  } catch (err) { next(err); }
});

router.post('/restore/inspect', restoreUpload.single('backup'), async (req, res, next) => {
  const file = req.file?.path;
  try {
    if (!file) return res.status(400).json({ error: 'Choose a backup file to upload' });
    res.json(await stageRestore(file));
  } catch (err) { next(err); }
  finally { if (file) { try { fs.unlinkSync(file); } catch { /* already removed */ } } }
});

// Step 2: apply the staged backup. A safety backup of the current state is taken first.
router.post('/restore/apply', async (req, res, next) => {
  try {
    if (req.body?.confirm !== 'RESTORE') return res.status(400).json({ error: 'Type RESTORE to confirm' });
    const out = await applyRestore(req.body?.token);
    audit(req.user, 'backup.restore', { detail: { safety_backup: out.safety_backup, restarting: out.restarting } });
    res.json(out);
  } catch (err) { next(err); }
});

router.post('/restore/cancel', (req, res) => { cancelPending(); res.json({ ok: true }); });

export default router;
