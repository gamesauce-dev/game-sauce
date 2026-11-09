import express from 'express';
import path from 'node:path';
import db from '../db.js';
import { listPhysical, physicalPlatforms, physicalCounts, getPhysical, addPhysical, updatePhysical, removePhysical, physicalCoverPath, physicalSpinePath, physicalDiscPath, applyMatch, clearMatch, matchOne, importPhysicalCsv, startMatchJob, matchJobStatus } from '../lib/physical.js';

const router = express.Router();
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

// Take a candidate picked in the identify search (the same shape POST /metadata/search returns) and put it on this game.
router.post('/games/:id/match', async (req, res, next) => {
  try {
    const cand = req.body?.candidate;
    if (!cand || typeof cand !== 'object') return res.status(400).json({ error: 'candidate object is required' });
    res.json(await applyMatch(me(req), req.params.id, { ...cand, source: cand.source || 'thegamesdb' }));
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

router.get('/disc/:id', (req, res) => {
  const file = physicalDiscPath(me(req), req.params.id);
  if (!file) return res.status(404).json({ error: 'No disc' });
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.resolve(file));
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
    const r = importPhysicalCsv(me(req), req.body?.csv, { apply: req.body?.apply === true, replace: req.body?.replace === true });
    if (r.applied) req.auditDetail = { added: r.added, updated: r.updated, removed: r.removed };
    res.json({ ...r, match_job: matchJobStatus() });
  } catch (err) { fail(res, err); }
});

export default router;
