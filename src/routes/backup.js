import express from 'express';
import fs from 'node:fs';
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

export default router;
