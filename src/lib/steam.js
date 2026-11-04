// Steam, per person: a member's own Web API key + SteamID64 are kept encrypted, and the owned-games list (with hours played)
// is fetched from Steam's public Web API when they ask. Nothing here touches ROMs, and nothing is shared between members.
import db from '../db.js';
import { encryptSecret, decryptSecret } from '../settings.js';

const STEAM = (process.env.GAMESAUCE_STEAM_API_BASE || 'https://api.steampowered.com').replace(/\/+$/, '');

export const looksLikeKey = (k) => /^[A-Fa-f0-9]{32}$/.test(String(k || '').trim());
export const looksLikeSteamId = (s) => /^7656119\d{10}$/.test(String(s || '').trim());

/** Pull the 17-digit SteamID64 out of what a person pastes: the number itself, or a steamcommunity.com/profiles/<id> link. */
export function parseSteamId(input) {
  const t = String(input || '').trim();
  if (looksLikeSteamId(t)) return t;
  const m = t.match(/steamcommunity\.com\/profiles\/(7656119\d{10})/i);
  return m ? m[1] : null;
}

export function getAccount(userId) {
  const r = db.prepare('SELECT steam_id, key_enc, last_sync, last_error FROM digital_accounts WHERE user_id = ? AND store = ?').get(userId, 'steam');
  return r || null;
}

/** What the page may see: that a key is saved, never the key itself. */
export function describeAccount(userId) {
  const a = getAccount(userId);
  const count = db.prepare("SELECT COUNT(*) AS n FROM digital_games WHERE user_id = ? AND store = 'steam'").get(userId).n;
  return { connected: Boolean(a), steam_id: a?.steam_id || null, last_sync: a?.last_sync || null, last_error: a?.last_error || null, games: count };
}

export function saveAccount(userId, steamId, key) {
  db.prepare(`INSERT INTO digital_accounts (user_id, store, steam_id, key_enc) VALUES (?, 'steam', ?, ?)
    ON CONFLICT(user_id, store) DO UPDATE SET steam_id = excluded.steam_id, key_enc = excluded.key_enc, last_error = NULL`).run(userId, steamId, encryptSecret(key));
}

export function removeAccount(userId) {
  db.prepare("DELETE FROM digital_marks WHERE user_id = ? AND store = 'steam'").run(userId);
  db.prepare("DELETE FROM digital_games WHERE user_id = ? AND store = 'steam'").run(userId);
  db.prepare("DELETE FROM digital_accounts WHERE user_id = ? AND store = 'steam'").run(userId);
}

/** Turn Steam's answer into plain rows. Playtime arrives in minutes. */
export function mapOwned(json) {
  const games = json?.response?.games;
  if (!Array.isArray(games)) return null;   // an empty response means a private profile, not zero games
  return games.filter((g) => Number.isFinite(Number(g.appid))).map((g) => ({
    appid: Number(g.appid),
    name: String(g.name || `App ${g.appid}`).slice(0, 200),
    minutes: Math.max(0, Number(g.playtime_forever) || 0),
    last_played: g.rtime_last_played ? Number(g.rtime_last_played) : null,
    img_icon: g.img_icon_url || null
  }));
}

/** Ask Steam, and store the result for this person. Returns { count } or throws an error whose message says what to do. */
export async function syncSteam(userId, fetchImpl = fetch) {
  const a = getAccount(userId);
  if (!a) throw Object.assign(new Error('Add your Steam key and Steam ID first (My account → Steam).'), { status: 400 });
  const key = decryptSecret(a.key_enc);
  if (!key) throw Object.assign(new Error('The saved key could not be read. Save it again.'), { status: 400 });
  const url = `${STEAM}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(a.steam_id)}&include_appinfo=1&include_played_free_games=1&format=json`;
  let res;
  try { res = await fetchImpl(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'game-sauce/0.2' } }); }
  catch { return fail(userId, 'Steam could not be reached. Try again in a moment.'); }
  if (res.status === 401 || res.status === 403) return fail(userId, 'Steam refused the key. Check it was copied in full (32 letters and numbers).');
  if (!res.ok) return fail(userId, `Steam answered with an error (${res.status}). Try again later.`);
  let json; try { json = await res.json(); } catch { return fail(userId, 'Steam sent something unreadable. Try again later.'); }
  const rows = mapOwned(json);
  if (!rows) return fail(userId, 'Steam returned no games. In Steam: Profile → Edit profile → Privacy settings, set "Game details" to Public, then try again.');
  const del = db.prepare("DELETE FROM digital_games WHERE user_id = ? AND store = 'steam'");
  const ins = db.prepare("INSERT INTO digital_games (user_id, store, app_id, name, minutes, last_played, img_icon) VALUES (?, 'steam', ?, ?, ?, ?, ?)");
  db.transaction(() => { del.run(userId); for (const g of rows) ins.run(userId, String(g.appid), g.name, g.minutes, g.last_played, g.img_icon); })();
  db.prepare("UPDATE digital_accounts SET last_sync = datetime('now'), last_error = NULL WHERE user_id = ? AND store = 'steam'").run(userId);
  return { count: rows.length };
}

function fail(userId, message) {
  db.prepare("UPDATE digital_accounts SET last_error = ? WHERE user_id = ? AND store = 'steam'").run(message, userId);
  throw Object.assign(new Error(message), { status: 502 });
}

/** Set one mark on one game: field is 'favourite' | 'hidden' | 'play'. The game must be in this person's list. */
export function setMark(userId, store, appId, field, value) {
  if (!['favourite', 'hidden', 'play'].includes(field)) throw Object.assign(new Error('Unknown mark'), { status: 400 });
  const own = db.prepare('SELECT 1 FROM digital_games WHERE user_id = ? AND store = ? AND app_id = ?').get(userId, store, String(appId));
  if (!own) throw Object.assign(new Error('That game is not in your list'), { status: 404 });
  db.prepare(`INSERT INTO digital_marks (user_id, store, app_id, ${field}) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, store, app_id) DO UPDATE SET ${field} = excluded.${field}`).run(userId, store, String(appId), value ? 1 : 0);
  return db.prepare('SELECT favourite, hidden, play FROM digital_marks WHERE user_id = ? AND store = ? AND app_id = ?').get(userId, store, String(appId));
}

/** The person's own list for the page: store chips and tiles. Steam's cover art is a fixed public address per app id.
 *  Hidden games stay out unless asked for (hidden: 'show' adds them, 'only' lists only them); favourites: true lists only favourites. */
export function listGames(userId, { store = '', q = '', sort = 'name', favourites = false, hidden = '' } = {}) {
  const where = ['g.user_id = ?']; const args = [userId];
  if (store) { where.push('g.store = ?'); args.push(store); }
  if (q) { where.push("g.name LIKE ? ESCAPE '\\'"); args.push('%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%'); }
  if (favourites) where.push('COALESCE(m.favourite, 0) = 1');
  if (hidden === 'only') where.push('COALESCE(m.hidden, 0) = 1');
  else if (hidden !== 'show') where.push('COALESCE(m.hidden, 0) = 0');
  const order = sort === 'hours' ? 'g.minutes DESC, g.name COLLATE NOCASE' : sort === 'recent' ? 'COALESCE(g.last_played, 0) DESC, g.name COLLATE NOCASE' : 'g.name COLLATE NOCASE';
  const rows = db.prepare(`SELECT g.store, g.app_id, g.name, g.minutes, g.last_played,
      COALESCE(m.favourite, 0) AS favourite, COALESCE(m.hidden, 0) AS hidden, COALESCE(m.play, 0) AS play
    FROM digital_games g LEFT JOIN digital_marks m ON m.user_id = g.user_id AND m.store = g.store AND m.app_id = g.app_id
    WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...args);
  return rows.map((r) => ({
    ...r,
    hours: Math.round((r.minutes / 60) * 10) / 10,
    cover_url: r.store === 'steam' ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${r.app_id}/library_600x900.jpg` : null,
    // The launch link is only offered where the person switched "play" on for that game (not every game is installed).
    launch_url: r.store === 'steam' && r.play ? `steam://rungameid/${r.app_id}` : null
  }));
}

/** Counts for the chips: everything visible, favourites, and hidden. */
export function countGames(userId) {
  const r = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(m.hidden, 0) = 0 THEN 1 ELSE 0 END) AS visible,
      SUM(CASE WHEN COALESCE(m.favourite, 0) = 1 AND COALESCE(m.hidden, 0) = 0 THEN 1 ELSE 0 END) AS favourites,
      SUM(CASE WHEN COALESCE(m.hidden, 0) = 1 THEN 1 ELSE 0 END) AS hidden
    FROM digital_games g LEFT JOIN digital_marks m ON m.user_id = g.user_id AND m.store = g.store AND m.app_id = g.app_id
    WHERE g.user_id = ?`).get(userId);
  return { total: r.total || 0, visible: r.visible || 0, favourites: r.favourites || 0, hidden: r.hidden || 0 };
}
