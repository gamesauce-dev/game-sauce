import express from 'express';
import path from 'node:path';
import multer from 'multer';
import db from '../db.js';
import { listPhysical, physicalPlatforms, physicalCounts, getPhysical, addPhysical, updatePhysical, removePhysical, setDigitalCounterpart, linkAllDigital, physicalCoverPath, physicalSpinePath, physicalDiscPath, physicalBackPath, physicalManualPath, setPhysicalArt, removePhysicalArt, setManualLink, setManualFile, removeManual, applyMatch, clearMatch, matchOne, importPhysicalCsv, startMatchJob, matchJobStatus } from '../lib/physical.js';

import { MAX_MANUAL_BYTES, manualType } from '../lib/manuals.js';

const router = express.Router();
const manualUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MANUAL_BYTES } });
const coverUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const me = (req) => Number(req.user?.id ?? -1);
const fail = (res, err) => { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; };

// Everything here is the signed-in person's own shelf: nobody (admins included) sees another member's list.
router.get('/', (req, res) => {
  res.json({ platforms: physicalPlatforms(me(req)), counts: physicalCounts(me(req)), match_job: matchJobStatus() });
});

router.get('/games', (req, res) => {
  const platforms = String(req.query.platforms || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 80);
  const sort = ['title', '-title', 'added', 'year', 'platform'].includes(String(req.query.sort)) ? String(req.query.sort) : 'title';
  const out = listPhysical(me(req), {
    platforms, q: String(req.query.q || '').trim().slice(0, 100), sort, favourites: req.query.favourites === '1', nocover: req.query.nocover === '1',
    unmatched: req.query.unmatched === '1', spine: req.query.spine === '1', letter: String(req.query.letter || '').toUpperCase()
  });
  res.json({ ...out, total: out.items.length });
});

// One game, added by hand.
router.post('/games', (req, res) => {
  try { const g = addPhysical(me(req), req.body || {}); res.status(201).json(g); }
  catch (err) { fail(res, err); }
});

router.get('/games/:id', (req, res) => {
  try { res.json(getPhysical(me(req), req.params.id)); } catch (err) { fail(res, err); }
});

router.patch('/games/:id', (req, res) => {
  try { res.json(updatePhysical(me(req), req.params.id, req.body || {})); } catch (err) { fail(res, err); }
});

router.delete('/games/:id', (req, res) => {
  try { res.json(removePhysical(me(req), req.params.id)); } catch (err) { fail(res, err); }
});

// Every Xbox One / Series disc that is not switched off gets its Digital counterpart.
router.post('/digital/all', (req, res) => { res.json(linkAllDigital(me(req))); });

// An Xbox One / Series disc's counterpart in Digital: { on: true | false }. Taking the disc off the shelf removes a counterpart this created.
router.put('/games/:id/digital', (req, res) => {
  try { res.json(setDigitalCounterpart(me(req), req.params.id, req.body?.on === true)); } catch (err) { fail(res, err); }
});

// Take a candidate picked in the identify search (the same shape POST /metadata/search returns) and put it on this game.
router.post('/games/:id/match', async (req, res, next) => {
  try {
    const cand = req.body?.candidate;
    if (!cand || typeof cand !== 'object') return res.status(400).json({ error: 'candidate object is required' });
    res.json(await applyMatch(me(req), req.params.id, { ...cand, source: cand.source || 'thegamesdb' }, { explicit: true }));   // picked by hand: it replaces an uploaded cover
  } catch (err) { if (err.status) return fail(res, err); next(err); }
});

// Ask the providers to find this one game by its title and platform.
router.post('/games/:id/auto-match', async (req, res, next) => {
  try {
    const g = await matchOne(me(req), req.params.id);
    res.json({ matched: Boolean(g), game: g || getPhysical(me(req), req.params.id) });
  } catch (err) { if (err.status) return fail(res, err); next(err); }
});

router.delete('/games/:id/match', (req, res) => {
  try { res.json(clearMatch(me(req), req.params.id)); } catch (err) { fail(res, err); }
});

// Look up details and covers again for games that have none (retry: also the ones nothing was found for last time).
router.post('/match', (req, res) => { res.json(startMatchJob({ retry: req.body?.retry === true })); });

router.get('/cover/:id', (req, res) => {
  const file = physicalCoverPath(me(req), req.params.id);
  if (!file) return res.status(404).json({ error: 'No cover' });
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.resolve(file));
});

router.get('/back/:id', (req, res) => {
  const file = physicalBackPath(me(req), req.params.id);
  if (!file) return res.status(404).json({ error: 'No back' });
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.resolve(file));
});

router.get('/disc/:id', (req, res) => {
  const file = physicalDiscPath(me(req), req.params.id);
  if (!file) return res.status(404).json({ error: 'No disc' });
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.resolve(file));
});

// The person's own picture for a game: its cover, spine or disc (kind). Uploaded (POST, a JPEG, PNG or WebP up to 8 MB, checked) or put back to the automatic one (DELETE).
router.post('/games/:id/art/:kind', (req, res) => {
  coverUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That image is over 8 MB.' : err.message });
    try { res.json(setPhysicalArt(me(req), req.params.id, req.params.kind, req.file?.buffer)); } catch (e) { fail(res, e); }
  });
});
router.delete('/games/:id/art/:kind', (req, res) => {
  try { res.json(removePhysicalArt(me(req), req.params.id, req.params.kind)); } catch (err) { fail(res, err); }
});

// A game's manual: a web link (PUT), or a file the person uploads (POST, a PDF or pictures), or neither (DELETE). Private to the person; nobody else can read the file.
router.put('/games/:id/manual', (req, res) => {
  try { res.json(setManualLink(me(req), req.params.id, req.body?.link)); } catch (err) { fail(res, err); }
});
router.post('/games/:id/manual', (req, res) => {
  manualUpload.single('manual')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is over 50 MB.' : err.message });
    try { res.json(setManualFile(me(req), req.params.id, req.file?.buffer, req.file?.originalname)); } catch (e) { fail(res, e); }
  });
});
router.delete('/games/:id/manual', (req, res) => {
  try { res.json(removeManual(me(req), req.params.id)); } catch (err) { fail(res, err); }
});
router.get('/manual/:id', (req, res) => {
  const m = physicalManualPath(me(req), req.params.id);
  if (!m) return res.status(404).json({ error: 'No manual' });
  res.setHeader('Content-Type', manualType(m.file));
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(m.name)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");   // a file is shown, never run
  res.sendFile(path.resolve(m.file));
});

router.get('/spine/:id', (req, res) => {
  const file = physicalSpinePath(me(req), req.params.id);
  if (!file) return res.status(404).json({ error: 'No spine' });
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.resolve(file));
});

// Games from a CSV (Platform, Game, Region, Notes, Year) onto the signed-in person's own shelf. Without apply nothing is saved: the answer is the preview.
router.post('/import', (req, res) => {
  try {
    const r = importPhysicalCsv(me(req), req.body?.csv, { apply: req.body?.apply === true, replace: req.body?.replace === true, digital: req.body?.digital !== false });
    if (r.applied) req.auditDetail = { added: r.added, updated: r.updated, removed: r.removed };
    res.json({ ...r, match_job: matchJobStatus() });
  } catch (err) { fail(res, err); }
});

export default router;
