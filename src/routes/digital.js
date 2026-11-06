import express from 'express';
import path from 'node:path';
import db from '../db.js';
import { requireAdmin } from './auth.js';
import { CONSOLE_STORES, isConsoleStore, importConsoleCsv, removeConsoleGame, getConsoleDetails, consoleCoverPath, storeUrl, countryFor, startDetailsJob, detailsJobStatus } from '../lib/consoles.js';
import { bucketOf, getDetails, describeAccount, saveAccount, removeAccount, syncSteam, listGames, countGames, setMark, parseSteamId, looksLikeKey } from '../lib/steam.js';

const router = express.Router();
const me = (req) => Number(req.user?.id ?? -1);
const knownStore = (s) => s === 'steam' || isConsoleStore(s);
const STORE_LABELS = { steam: 'Steam', ...Object.fromEntries(Object.entries(CONSOLE_STORES).map(([k, v]) => [k, v.label])) };

// Everything here is the signed-in person's own: nobody (admins included) sees another member's key or list.
router.get('/', (req, res) => {
  const stores = db.prepare("SELECT store, COUNT(*) AS count FROM digital_games WHERE user_id = ? GROUP BY store ORDER BY store").all(me(req));
  res.json({ steam: describeAccount(me(req)), stores: stores.map((s) => ({ ...s, label: STORE_LABELS[s.store] || s.store })), counts: countGames(me(req)), details_job: detailsJobStatus() });
});

router.get('/games', (req, res) => {
  const store = knownStore(String(req.query.store || '')) ? String(req.query.store) : '';
  const sort = ['name', 'hours', 'recent'].includes(String(req.query.sort || '')) ? String(req.query.sort) : 'name';
  const hidden = ['show', 'only'].includes(String(req.query.hidden || '')) ? String(req.query.hidden) : '';
  const base = { store, q: String(req.query.q || '').trim().slice(0, 100), sort, favourites: req.query.favourites === '1', installed: req.query.installed === '1', hidden };
  const all = listGames(me(req), base);
  // How many games sit under each letter (# for names that start with a digit or symbol), of the list as filtered so far.
  const bucket = bucketOf;   // "The Darkness II" files under D
  const letters = {}; for (const g of all) letters[bucket(g.name)] = (letters[bucket(g.name)] || 0) + 1;
  const letter = String(req.query.letter || '').toUpperCase();
  const items = /^[A-Z#]$/.test(letter) ? all.filter((g) => bucket(g.name) === letter) : all;
  res.json({ items, total: items.length, total_hours: Math.round(items.reduce((s, g) => s + g.minutes, 0) / 6) / 10, letters });
});

// One mark on one game: { field: 'favourite' | 'hidden' | 'play', value: true | false }. Private to the person; a refresh keeps them.
router.put('/games/:store/:appId/mark', (req, res) => {
  const store = String(req.params.store);
  if (!knownStore(store)) return res.status(400).json({ error: 'Unknown store' });
  if (store !== 'steam' && req.body?.field === 'play') return res.status(400).json({ error: 'Console games have no play button' });
  try { res.json(setMark(me(req), store, req.params.appId, String(req.body?.field || ''), req.body?.value === true)); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; }
});

// One game's own entry (hours, marks) plus Steam's public store details (cached; may be null when Steam has no page for it).
router.get('/games/:store/:appId', async (req, res, next) => {
  const store = String(req.params.store);
  if (isConsoleStore(store)) {
    // A console game: its own entry plus the details and cover found for it (looked up now if the background run has not got to it yet).
    const game = listGames(me(req), { store, hidden: 'show' }).find((g) => g.app_id === String(req.params.appId));
    if (!game) return res.status(404).json({ error: 'That game is not in your list' });
    const c = countryFor(game.country);
    const extra = { store_label: CONSOLE_STORES[store].label, country_name: c?.name || null, store_url: storeUrl(store, game.name, game.country) };
    try {
      const details = await getConsoleDetails(store, game.app_id, game.name);
      // The cover may have arrived just now: list it again so the window gets its address.
      const fresh = details ? listGames(me(req), { store, hidden: 'show' }).find((g) => g.app_id === game.app_id) || game : game;
      return res.json({ game: { ...fresh, ...extra }, details });
    } catch (err) { return next(err); }
  }
  if (store !== 'steam') return res.status(400).json({ error: 'Unknown store' });
  const game = listGames(me(req), { store: 'steam', hidden: 'show' }).find((g) => g.app_id === String(req.params.appId));
  if (!game) return res.status(404).json({ error: 'That game is not in your list' });
  try { res.json({ game, details: await getDetails(game.app_id) }); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message, game }); next(err); }
});

// The picture found for a console game (Steam's covers come straight from Steam's own address).
router.get('/cover/:store/:appId', (req, res) => {
  if (!isConsoleStore(req.params.store)) return res.status(404).json({ error: 'No cover' });
  const own = db.prepare('SELECT 1 FROM digital_games WHERE user_id = ? AND store = ? AND app_id = ?').get(me(req), req.params.store, String(req.params.appId));
  const file = own ? consoleCoverPath(req.params.store, req.params.appId) : null;
  if (!file) return res.status(404).json({ error: 'No cover' });
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.resolve(file));
});

// Console games from a CSV (Platform Name, Game Title, Country of Source Store) into the signed-in person's own list.
// { csv: text, apply?: boolean, replace?: boolean }. Without apply nothing is saved: the answer is the preview.
router.post('/consoles/import', requireAdmin, (req, res) => {
  try {
    const r = importConsoleCsv(me(req), req.body?.csv, { apply: req.body?.apply === true, replace: req.body?.replace === true });
    if (r.applied) req.auditDetail = { added: r.added, updated: r.updated, removed: r.removed };
    res.json({ ...r, details_job: detailsJobStatus() });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; }
});

// Look up details and covers again for console games that have none (retry: also the ones nothing was found for last time).
router.post('/consoles/details', (req, res) => {
  res.json(startDetailsJob({ retry: req.body?.retry === true }));
});

router.delete('/games/:store/:appId', (req, res) => {
  try { res.json(removeConsoleGame(me(req), String(req.params.store), req.params.appId)); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; }
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
