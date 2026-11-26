// ROM Library age ratings: the classification setting, the totals, setting ratings and the Fetch ratings job. All of it is the admin's:
// everyone else only sees a game's rating on the game itself.
import express from 'express';
import { requireAdmin } from './auth.js';
import { SYSTEMS, BOARDS } from '../lib/ratingscale.js';
import { ratingSystem, setRatingSystem, setAdminRating, ratingCounts, flushRatings } from '../lib/ratings.js';
import { ratingSources, ratingJob, startRatingJob, stopRatingJob } from '../lib/ratingfetch.js';

const router = express.Router();
router.use(requireAdmin);

const summary = () => ({
  system: ratingSystem(),
  systems: BOARDS.map((id) => ({ id, name: SYSTEMS[id].name, ratings: SYSTEMS[id].labels.map((label, i) => ({ level: i + 1, label })) })),
  counts: ratingCounts(),
  sources: ratingSources(),
  job: ratingJob()
});
const send = (res, work) => { try { res.json(work()); } catch (err) { res.status(err.status || 500).json({ error: err.message }); } };

router.get('/', (req, res) => send(res, summary));

router.put('/system', (req, res) => send(res, () => {
  setRatingSystem(String(req.body?.system || ''));
  req.auditDetail = { system: ratingSystem() };
  return summary();
}));

/** Rate one game or many: { ids, level: 1-6, or null to take the rating away }. */
router.post('/set', (req, res) => send(res, () => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) throw Object.assign(new Error('No ids supplied'), { status: 400 });
  const level = req.body?.level === null ? null : Number(req.body?.level);
  flushRatings();
  const changed = setAdminRating(ids, level);
  const system = SYSTEMS[ratingSystem()];
  req.auditDetail = { count: changed, rating: level === null ? null : `${system.board} ${system.labels[level - 1]}` };
  return { changed, level };
}));

router.get('/fetch', (req, res) => res.json(ratingJob()));
router.post('/fetch', (req, res) => send(res, () => {
  const platform = String(req.body?.platform || '').trim();
  return startRatingJob({ platform: platform === 'all' ? '' : platform, recheck: req.body?.recheck === true });
}));
router.delete('/fetch', (req, res) => res.json(stopRatingJob()));

export default router;
