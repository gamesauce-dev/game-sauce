// Importing pictures and manuals from folders on the server (see src/lib/artimport.js). The admin lists the folders; anyone can import from them into their own shelf.
import express from 'express';
import { requireAdmin } from './auth.js';
import db from '../db.js';
import { folderState, setArtFolders, previewArtImport, startArtImport, artJobStatus } from '../lib/artimport.js';

const router = express.Router();
const me = (req) => Number(req.user?.id ?? -1);
const fail = (res, err) => { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; };

router.get('/folders', (req, res) => res.json({ folders: folderState(), can_edit: req.user?.role === 'admin' }));

// The platforms the importer can be told about (when the folder names do not say).
router.get('/platforms', (req, res) => res.json({ items: db.prepare('SELECT slug, name FROM platforms ORDER BY name').all() }));

router.put('/folders', requireAdmin, (req, res) => {
  try { const out = setArtFolders(req.body?.folders); req.auditDetail = { folders: out.folders.length }; res.json(out); } catch (err) { fail(res, err); }
});

// body: { target: 'physical' | 'digital', folder, replace, apply }. Without apply: what it would do. With apply: starts it in the background.
router.post('/import', async (req, res, next) => {
  const target = req.body?.target === 'digital' ? 'digital' : 'physical';
  const opts = { target, folder: String(req.body?.folder || ''), replace: req.body?.replace === true, cut: String(req.body?.cut || '').slice(0, 40), kind: String(req.body?.kind || ''), platform: String(req.body?.platform || '').slice(0, 60) };
  try {
    if (req.body?.apply === true) { req.auditDetail = { target, apply: true }; return res.json(await startArtImport(me(req), opts)); }
    res.json(await previewArtImport(me(req), opts));
  } catch (err) { if (err.status) return fail(res, err); next(err); }
});

router.get('/import/status', (req, res) => res.json(artJobStatus(me(req))));

export default router;
