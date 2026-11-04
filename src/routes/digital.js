import express from 'express';
import db from '../db.js';
import { describeAccount, saveAccount, removeAccount, syncSteam, listGames, parseSteamId, looksLikeKey } from '../lib/steam.js';

const router = express.Router();
const me = (req) => Number(req.user?.id ?? -1);

// Everything here is the signed-in person's own: nobody (admins included) sees another member's key or list.
router.get('/', (req, res) => {
  const stores = db.prepare("SELECT store, COUNT(*) AS count FROM digital_games WHERE user_id = ? GROUP BY store ORDER BY store").all(me(req));
  res.json({ steam: describeAccount(me(req)), stores });
});

router.get('/games', (req, res) => {
  const store = ['steam'].includes(String(req.query.store || '')) ? String(req.query.store) : '';
  const sort = ['name', 'hours', 'recent'].includes(String(req.query.sort || '')) ? String(req.query.sort) : 'name';
  const items = listGames(me(req), { store, q: String(req.query.q || '').trim().slice(0, 100), sort });
  res.json({ items, total: items.length, total_hours: Math.round(items.reduce((s, g) => s + g.minutes, 0) / 6) / 10 });
});

router.put('/steam', (req, res) => {
  const steamId = parseSteamId(req.body?.steam_id);
  const key = String(req.body?.key || '').trim();
  if (!steamId) return res.status(400).json({ error: 'The Steam ID should be the 17-digit number (starting 7656119…) or your steamcommunity.com/profiles/… link.' });
  const existing = describeAccount(me(req)).connected;
  if (!key && !existing) return res.status(400).json({ error: 'Paste your Steam Web API key (32 letters and numbers).' });
  if (key && !looksLikeKey(key)) return res.status(400).json({ error: 'That does not look like a Steam Web API key: it is 32 letters and numbers.' });
  if (key) saveAccount(me(req), steamId, key);
  else db.prepare("UPDATE digital_accounts SET steam_id = ?, last_error = NULL WHERE user_id = ? AND store = 'steam'").run(steamId, me(req)); // new ID, same key
  req.auditDetail = { store: 'steam' };   // never the key
  res.json(describeAccount(me(req)));
});

router.post('/steam/sync', async (req, res, next) => {
  try { const r = await syncSteam(me(req)); req.auditDetail = { store: 'steam', games: r.count }; res.json({ ...r, ...describeAccount(me(req)) }); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

router.delete('/steam', (req, res) => {
  removeAccount(me(req));
  req.auditDetail = { store: 'steam' };
  res.json(describeAccount(me(req)));
});

export default router;
