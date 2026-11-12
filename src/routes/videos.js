import express from 'express';
import path from 'node:path';
import db from '../db.js';
import { emumovies, ensureVideo, videoFile, recentlyMissed } from '../lib/emumovies.js';
import { isConsoleStore } from '../lib/consoles.js';
import { listGames } from '../lib/steam.js';

// Game videos for the details window. One address shape for the three places a game can live:
//   ?kind=rom&id=12   ?kind=physical&id=7   ?kind=digital&store=xbox&id=<app id>
// Physical and Digital games are the signed-in person's own: a game that is not theirs is "not found", admins included.
const router = express.Router();
const me = (req) => Number(req.user?.id ?? -1);

/** { title, platform } for the game the request names, or null when the person has no such game. */
export function resolveGame(req) {
  const q = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const kind = String(q.kind || ''), id = String(q.id || '');
  if (kind === 'rom') {
    const r = db.prepare('SELECT r.title, p.slug AS platform FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?').get(id);
    return r || null;
  }
  if (kind === 'physical') {
    return db.prepare('SELECT title, platform FROM physical_games WHERE id = ? AND user_id = ?').get(id, me(req)) || null;
  }
  if (kind === 'digital') {
    const store = String(q.store || '');
    if (!isConsoleStore(store)) return null;   // Steam games have no video snaps on EmuMovies
    const g = listGames(me(req), { store, hidden: 'show' }).find((x) => x.app_id === id);
    return g?.platform ? { title: g.name, platform: g.platform } : null;
  }
  return null;
}

const notFound = (res) => res.status(404).json({ error: 'That game is not in your list' });

router.get('/status', (req, res) => {
  const game = resolveGame(req);
  if (!game) return notFound(res);
  const have = videoFile(game);
  res.json({ available: Boolean(have), bytes: have?.bytes || null, can_fetch: emumovies.enabled, missed: !have && recentlyMissed(game) });
});

// Ask EmuMovies for this game's video now (the person pressed the button). { force: true } asks again after a "none found".
router.post('/fetch', async (req, res, next) => {
  try {
    const game = resolveGame(req);
    if (!game) return notFound(res);
    const r = await ensureVideo({ ...game, force: req.body?.force === true });
    if (r.status === 'disabled') return res.status(400).json({ error: 'EmuMovies is not set up (an admin adds the login under Settings, Metadata providers)' });
    if (r.status === 'error') return res.status(502).json({ error: r.error });
    res.json({ available: r.status === 'ready', bytes: r.bytes || null, missed: r.status === 'none' });
  } catch (err) { next(err); }
});

router.get('/file', (req, res) => {
  const game = resolveGame(req);
  if (!game) return notFound(res);
  const have = videoFile(game);
  if (!have) return res.status(404).json({ error: 'No video for this game' });
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.type(path.extname(have.path) === '.webm' ? 'video/webm' : 'video/mp4');
  res.sendFile(path.resolve(have.path));   // Range requests are answered, so the player can seek
});

export default router;
