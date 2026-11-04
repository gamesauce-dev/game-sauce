import express from 'express';
import db from '../db.js';
import { getDetails, describeAccount, saveAccount, removeAccount, syncSteam, listGames, countGames, setMark, parseSteamId, looksLikeKey } from '../lib/steam.js';

const router = express.Router();
const me = (req) => Number(req.user?.id ?? -1);

// Everything here is the signed-in person's own: nobody (admins included) sees another member's key or list.
router.get('/', (req, res) => {
  const stores = db.prepare("SELECT store, COUNT(*) AS count FROM digital_games WHERE user_id = ? GROUP BY store ORDER BY store").all(me(req));
  res.json({ steam: describeAccount(me(req)), stores, counts: countGames(me(req)) });
});

router.get('/games', (req, res) => {
  const store = ['steam'].includes(String(req.query.store || '')) ? String(req.query.store) : '';
  const sort = ['name', 'hours', 'recent'].includes(String(req.query.sort || '')) ? String(req.query.sort) : 'name';
  const hidden = ['show', 'only'].includes(String(req.query.hidden || '')) ? String(req.query.hidden) : '';
  const base = { store, q: String(req.query.q || '').trim().slice(0, 100), sort, favourites: req.query.favourites === '1', hidden };
  const all = listGames(me(req), base);
  // How many games sit under each letter (# for names that start with a digit or symbol), of the list as filtered so far.
  const bucket = (n) => { const c = String(n).trim().charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; };
  const letters = {}; for (const g of all) letters[bucket(g.name)] = (letters[bucket(g.name)] || 0) + 1;
  const letter = String(req.query.letter || '').toUpperCase();
  const items = /^[A-Z#]$/.test(letter) ? all.filter((g) => bucket(g.name) === letter) : all;
  res.json({ items, total: items.length, total_hours: Math.round(items.reduce((s, g) => s + g.minutes, 0) / 6) / 10, letters });
});

// One mark on one game: { field: 'favourite' | 'hidden' | 'play', value: true | false }. Private to the person; a refresh keeps them.
router.put('/games/:store/:appId/mark', (req, res) => {
  const store = String(req.params.store);
  if (store !== 'steam') return res.status(400).json({ error: 'Unknown store' });
  try { res.json(setMark(me(req), store, req.params.appId, String(req.body?.field || ''), req.body?.value === true)); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; }
});

// One game's own entry (hours, marks) plus Steam's public store details (cached; may be null when Steam has no page for it).
router.get('/games/:store/:appId', async (req, res, next) => {
  if (req.params.store !== 'steam') return res.status(400).json({ error: 'Unknown store' });
  const game = listGames(me(req), { store: 'steam', hidden: 'show' }).find((g) => g.app_id === String(req.params.appId));
  if (!game) return res.status(404).json({ error: 'That game is not in your list' });
  try { res.json({ game, details: await getDetails(game.app_id) }); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message, game }); next(err); }
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
