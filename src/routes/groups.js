// Age restrictions, the admin's side: the groups accounts are put in, and which games are blocked for whom. A person's own groups and age limit
// are set with their account (src/routes/auth.js). The records are kept by src/lib/restrictions.js; src/lib/visibility.js applies them.
import express from 'express';
import db from '../db.js';
import { requireAdmin } from './auth.js';
import { SYSTEMS } from '../lib/ratingscale.js';
import { ratingSystem, ratingCounts } from '../lib/ratings.js';
import { listGroups, createGroup, updateGroup, deleteGroup, blocksOf, setBlocks, flushRecords, MAX_LIMIT } from '../lib/restrictions.js';
import { isRomId } from '../lib/visibility.js';

const router = express.Router();
router.use(requireAdmin);

const send = (res, work) => { try { res.json(work()); } catch (err) { res.status(err.status || 500).json({ error: err.message }); } };

/** The age limits there are to choose from, in the labels of the classification setting: "up to" each rating, all but the strictest. */
const limits = () => SYSTEMS[ratingSystem()].labels.slice(0, MAX_LIMIT).map((label, i) => ({ level: i + 1, label }));

const summary = () => {
  flushRecords();
  return { items: listGroups(), limits: limits(), unrated: ratingCounts().unrated };   // unrated games are not held back by any limit
};

/** The people a game can be blocked for: everyone but the admins. */
const people = () => db.prepare("SELECT id, username FROM users WHERE role <> 'admin' ORDER BY username").all();

router.get('/', (req, res) => send(res, summary));

router.post('/', (req, res) => send(res, () => {
  const group = createGroup(req.body || {});
  req.auditDetail = { group: group.name, age_limit: group.age_limit, can_edit: group.can_edit };
  return summary();
}));

router.patch('/:id', (req, res) => send(res, () => {
  const group = updateGroup(Number(req.params.id), req.body || {});
  req.auditDetail = { group: group.name, age_limit: group.age_limit, can_edit: group.can_edit };
  return summary();
}));

router.delete('/:id', (req, res) => send(res, () => {
  req.auditDetail = { group: deleteGroup(Number(req.params.id)).name };
  return summary();
}));

const notFound = () => Object.assign(new Error('ROM not found'), { status: 404 });
const answer = (blocks) => ({ blocked: blocks, groups: listGroups().map(({ id, name }) => ({ id, name })), users: people() });

router.get('/blocks/:id', (req, res) => send(res, () => {
  if (!isRomId(req.params.id) || !db.prepare('SELECT 1 FROM roms WHERE id = ?').get(Number(req.params.id))) throw notFound();
  return answer(blocksOf(Number(req.params.id)));
}));

/** { users: [ids], groups: [ids] }: who this game, with its other versions on this platform, is blocked for. The lists replace what was there. */
router.put('/blocks/:id', (req, res) => send(res, () => {
  if (!Array.isArray(req.body?.users) || !Array.isArray(req.body?.groups)) throw Object.assign(new Error('users and groups must be lists'), { status: 400 });
  const blocked = isRomId(req.params.id) ? setBlocks(Number(req.params.id), req.body) : null;
  if (!blocked) throw notFound();
  req.auditDetail = { rom_id: Number(req.params.id), blocked };
  return answer(blocked);
}));

export default router;
