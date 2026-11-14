// Importing pictures and manuals from folders on the server (see src/lib/artimport.js). The admin lists the folders; anyone can import from them into their own shelf.
import express from 'express';
import { requireAdmin } from './auth.js';
import db from '../db.js';
import { folderState, setArtFolders, previewArtImport, startArtImport, artJobStatus, scanArtFolder, getArtFolders } from '../lib/artimport.js';
import { importPlatformLogos, fetchPlatformArt } from '../lib/platformart.js';
import { cleanSplit } from '../lib/wrapcut.js';
import { artSharing, setArtSharing } from '../lib/physical.js';

const router = express.Router();

// Where the spine sits in a wrap, per platform: set once on a sample, remembered for the person.
const PREF = 'art_wrap_split';
const cleanMap = (m) => Object.fromEntries(Object.entries(m && typeof m === 'object' ? m : {}).slice(0, 60).map(([k, v]) => [String(k).slice(0, 40), cleanSplit(v)]).filter(([, v]) => v));
const savedSplit = (uid) => { try { return cleanMap(JSON.parse(db.prepare('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?').get(uid, PREF)?.value || '{}')); } catch { return {}; } };
const saveSplit = (uid, m) => db.prepare('INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value').run(uid, PREF, JSON.stringify(m));
const me = (req) => Number(req.user?.id ?? -1);
const fail = (res, err) => { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; };

router.get('/folders', (req, res) => res.json({ folders: folderState(), can_edit: req.user?.role === 'admin' }));

// The platforms the importer can be told about (when the folder names do not say).
router.get('/platforms', (req, res) => res.json({ items: db.prepare('SELECT slug, name FROM platforms ORDER BY name').all() }));

// Whether pictures one account has are copied to another account's copy of the same game (see src/lib/physical.js, reuseArt).
router.get('/sharing', (req, res) => res.json({ on: artSharing(), can_edit: req.user?.role === 'admin' }));
router.put('/sharing', requireAdmin, (req, res) => { const on = setArtSharing(req.body?.on !== false); req.auditDetail = { share_art: on }; res.json({ on }); });

router.put('/folders', requireAdmin, (req, res) => {
  try { const out = setArtFolders(req.body?.folders); req.auditDetail = { folders: out.folders.length }; res.json(out); } catch (err) { fail(res, err); }
});

// body: { target: 'physical' | 'digital', folder, replace, apply }. Without apply: what it would do. With apply: starts it in the background.
router.post('/import', async (req, res, next) => {
  const target = ['digital', 'video', 'rom'].includes(req.body?.target) ? req.body.target : 'physical';
  // The Library is shared by everyone, so only an admin changes the pictures and manuals of its games (videos are shared too, but only ever added).
  if (target === 'rom' && req.user?.role !== 'admin') return res.status(403).json({ error: 'Only an admin can import pictures and manuals for the Library.' });
  const opts = { target, folder: String(req.body?.folder || ''), replace: req.body?.replace === true, cut: String(req.body?.cut || '').slice(0, 200), kind: String(req.body?.kind || ''), platform: String(req.body?.platform || '').slice(0, 60) };
  const sent = cleanMap(req.body?.split), split = { ...savedSplit(me(req)), ...sent };
  opts.split = split;
  try {
    if (req.body?.apply === true) { if (Object.keys(sent).length) saveSplit(me(req), split); req.auditDetail = { target, apply: true }; return res.json(await startArtImport(me(req), opts)); }
    res.json(await previewArtImport(me(req), opts));
  } catch (err) { if (err.status) return fail(res, err); next(err); }
});

// One picture of a scanned folder (a wrap to show on the cut screen). Only a file the scan found, in a listed folder, by its number.
/* Platform logos for Big Screen and the platform tiles: from a listed artwork folder (a folder called Platforms with one picture per platform), or from ScreenScraper's systems. Gaps only unless replace. */
router.post('/platform-logos/import', requireAdmin, (req, res) => {
  const folder = String(req.body?.folder || '');
  if (!getArtFolders().includes(folder)) return res.status(400).json({ error: 'Choose one of the artwork folders listed under Settings > Artwork folders.' });
  const r = importPlatformLogos(folder, { replace: Boolean(req.body?.replace) });
  req.auditDetail = { folder, saved: r.saved.length, families: r.families.length, unmatched: r.unmatched.length };
  res.json(r);
});
router.post('/platform-logos/fetch', requireAdmin, async (req, res, next) => {
  try { const r = await fetchPlatformArt({ replace: Boolean(req.body?.replace) }); req.auditDetail = { got: r.got.length, none: r.none.length, failed: Object.keys(r.failed).length }; res.json(r); } catch (err) { next(err); }
});

router.get('/wrap-image', async (req, res, next) => {
  try {
    const scan = await scanArtFolder(String(req.query.folder || ''));
    const e = scan.files[Number(req.query.i)];
    if (!e || e.kind !== 'wrap') return res.status(404).json({ error: 'No such picture' });
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(e.file);
  } catch (err) { if (err.status) return fail(res, err); next(err); }
});

router.get('/import/status', (req, res) => res.json(artJobStatus(me(req))));

export default router;
