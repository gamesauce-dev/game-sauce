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

/** The person's own list for the page: store chips and tiles. Steam's cover art is a fixed public address per app id. */
export function listGames(userId, { store = '', q = '', sort = 'name' } = {}) {
  const where = ['user_id = ?']; const args = [userId];
  if (store) { where.push('store = ?'); args.push(store); }
  if (q) { where.push('name LIKE ?'); args.push('%' + String(q).replace(/[%_]/g, (c) => '\\' + c) + '%'); }
  where[where.length - 1] += q ? " ESCAPE '\\'" : '';
  const order = sort === 'hours' ? 'minutes DESC, name COLLATE NOCASE' : sort === 'recent' ? 'COALESCE(last_played, 0) DESC, name COLLATE NOCASE' : 'name COLLATE NOCASE';
  const rows = db.prepare(`SELECT store, app_id, name, minutes, last_played FROM digital_games WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...args);
  return rows.map((r) => ({
    ...r,
    hours: Math.round((r.minutes / 60) * 10) / 10,
    cover_url: r.store === 'steam' ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${r.app_id}/library_600x900.jpg` : null,
    launch_url: r.store === 'steam' ? `steam://rungameid/${r.app_id}` : null
  }));
}
