// A person's own browser-play saves, all in one place (see src/lib/saves.js). Only ever their own, the admin included.
// The saves of one game are under /api/roms/:id/saves; these two also reach the saves of a game the person can no longer open.
import express from 'express';
import { allSaves, deleteOwnSave } from '../lib/saves.js';

const router = express.Router();
router.get('/', (req, res) => res.json(allSaves(req.user)));
router.delete('/:sid', (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.sid) || !deleteOwnSave(req.user.id, Number(req.params.sid))) return res.status(404).json({ error: 'Save not found' });
  res.json({ ok: true });
});
export default router;
