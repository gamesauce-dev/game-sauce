// Steam, per person: a member's own Web API key + SteamID64 are kept encrypted, and the owned-games list (with hours played)
// is fetched from Steam's public Web API when they ask. Nothing here touches ROMs, and nothing is shared between members.
import path from 'node:path';
import db from '../db.js';
import { encryptSecret, decryptSecret } from '../settings.js';
import { sortTitle } from './metadata.js';

/** The name as it files in a list: "The Darkness II" sits under D, like the Library. Digits and symbols fall under #. */
export const fileKey = (name) => sortTitle(String(name || '')) || String(name || '').toLowerCase();
export const bucketOf = (name) => { const c = fileKey(name).charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; };

const STEAM = (process.env.GAMESAUCE_STEAM_API_BASE || 'https://api.steampowered.com').replace(/\/+$/, '');
const STORE = (process.env.GAMESAUCE_STEAM_STORE_BASE || 'https://store.steampowered.com').replace(/\/+$/, '');

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
export function listGames(userId, { store = '', q = '', sort = 'name', favourites = false, installed = false, hidden = '' } = {}) {
  const where = ['g.user_id = ?']; const args = [userId];
  if (store) { where.push('g.store = ?'); args.push(store); }
  if (q) {
    // The words match the name, and also the genres and developer Steam gave (from the cached store details; a game whose details have not been
    // fetched yet matches by name only). "action" finds Action games; "valve" finds Valve's.
    const like = '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where.push("(g.name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM digital_details d WHERE d.store = g.store AND d.app_id = g.app_id AND d.found = 1 AND (d.json LIKE ? ESCAPE '\\')))");
    args.push(like, '%"' + String(q).replace(/[\\%_"]/g, (c) => c === '"' ? '' : '\\' + c) + '%');
  }
  if (favourites) where.push('COALESCE(m.favourite, 0) = 1');
  if (installed) where.push('COALESCE(m.play, 0) = 1');   // "installed" = the play button was switched on for it
  if (hidden === 'only') where.push('COALESCE(m.hidden, 0) = 1');
  else if (hidden !== 'show') where.push('COALESCE(m.hidden, 0) = 0');
  const order = sort === 'hours' ? 'g.minutes DESC, g.name COLLATE NOCASE' : sort === 'recent' ? 'COALESCE(g.last_played, 0) DESC, g.name COLLATE NOCASE' : 'g.name COLLATE NOCASE';
  // Console games (PlayStation, Xbox) carry the country of the store they came from, and their cover is the picture downloaded for them.
  const rows = db.prepare(`SELECT g.store, g.app_id, g.name, g.minutes, g.last_played, g.country, dd.cover_path,
      COALESCE(m.favourite, 0) AS favourite, COALESCE(m.hidden, 0) AS hidden, COALESCE(m.play, 0) AS play
    FROM digital_games g LEFT JOIN digital_marks m ON m.user_id = g.user_id AND m.store = g.store AND m.app_id = g.app_id
      LEFT JOIN digital_details dd ON dd.store = g.store AND dd.app_id = g.app_id AND g.store != 'steam'
    WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...args);
  if (sort === 'name') rows.sort((a, b) => fileKey(a.name).localeCompare(fileKey(b.name), 'en', { numeric: true }) || String(a.name).localeCompare(String(b.name)));
  else if (sort === 'hours' || sort === 'recent') { /* ties break by filing key below */ }
  return rows.map(({ cover_path: coverPath, ...r }) => ({
    ...r,
    hours: Math.round((r.minutes / 60) * 10) / 10,
    cover_url: r.store === 'steam' ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${r.app_id}/library_600x900.jpg`
      : coverPath ? `/api/digital/cover/${encodeURIComponent(r.store)}/${encodeURIComponent(r.app_id)}?v=${encodeURIComponent(path.basename(coverPath))}` : null,
    cover_fallback_url: r.store === 'steam' ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${r.app_id}/header.jpg` : null,
    // The launch link is only offered where the person switched "play" on for that game (not every game is installed).
    launch_url: r.store === 'steam' && r.play ? `steam://rungameid/${r.app_id}` : null
  }));
}

/** Counts for the chips: everything visible, favourites, and hidden. */
export function countGames(userId) {
  const r = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(m.hidden, 0) = 0 THEN 1 ELSE 0 END) AS visible,
      SUM(CASE WHEN COALESCE(m.favourite, 0) = 1 AND COALESCE(m.hidden, 0) = 0 THEN 1 ELSE 0 END) AS favourites,
      SUM(CASE WHEN COALESCE(m.play, 0) = 1 AND COALESCE(m.hidden, 0) = 0 THEN 1 ELSE 0 END) AS installed,
      SUM(CASE WHEN COALESCE(m.hidden, 0) = 1 THEN 1 ELSE 0 END) AS hidden
    FROM digital_games g LEFT JOIN digital_marks m ON m.user_id = g.user_id AND m.store = g.store AND m.app_id = g.app_id
    WHERE g.user_id = ?`).get(userId);
  return { total: r.total || 0, visible: r.visible || 0, favourites: r.favourites || 0, installed: r.installed || 0, hidden: r.hidden || 0 };
}

/* ───────── store details (public; no key needed) ───────── */

const strip = (html) => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+\n/g, '\n').trim();

/** Steam's appdetails answer, reduced to what the panel shows. Returns null when Steam has no store page for the app (delisted, DLC...). */
export function mapDetails(json, appId) {
  const e = json?.[String(appId)];
  if (!e || e.success !== true || !e.data) return null;
  const d = e.data;
  return {
    name: d.name || null,
    description: strip(d.short_description || d.about_the_game || '').slice(0, 1500),
    developers: (d.developers || []).slice(0, 4),
    publishers: (d.publishers || []).slice(0, 4),
    release: d.release_date?.date || null,
    genres: (d.genres || []).map((g) => g.description).slice(0, 8),
    categories: (d.categories || []).map((g) => g.description).slice(0, 8),
    metacritic: d.metacritic?.score || null,
    price: d.is_free ? 'Free' : (d.price_overview?.final_formatted || null),
    header: d.header_image || null,
    background: d.background_raw || d.background || null,
    screenshots: (d.screenshots || []).slice(0, 8).map((x) => x.path_thumbnail || x.path_full).filter(Boolean),
    platforms: Object.entries(d.platforms || {}).filter(([, v]) => v).map(([k]) => k),
    website: d.website || null
  };
}

/** Cached details for an app: fresh for 30 days (a game Steam has no page for is retried after a day). Fetched once, then shared. */
export async function getDetails(appId, fetchImpl = fetch) {
  const id = String(appId);
  if (!/^\d{1,10}$/.test(id)) throw Object.assign(new Error('Bad app id'), { status: 400 });
  const row = db.prepare("SELECT json, found, fetched_at, (julianday('now') - julianday(fetched_at)) AS age FROM digital_details WHERE store = 'steam' AND app_id = ?").get(id);
  if (row && row.age < (row.found ? 30 : 1)) return row.found ? JSON.parse(row.json) : null;
  let res;
  try { res = await fetchImpl(`${STORE}/api/appdetails?appids=${id}&l=english`, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'game-sauce/0.2' } }); }
  catch { if (row?.found) return JSON.parse(row.json); throw Object.assign(new Error('The Steam store could not be reached. Try again in a moment.'), { status: 502 }); }
  if (res.status === 429) { if (row?.found) return JSON.parse(row.json); throw Object.assign(new Error('Steam asked us to slow down. Try again in a minute.'), { status: 429 }); }
  if (!res.ok) { if (row?.found) return JSON.parse(row.json); throw Object.assign(new Error(`The Steam store answered with an error (${res.status}).`), { status: 502 }); }
  let json; try { json = await res.json(); } catch { throw Object.assign(new Error('The Steam store sent something unreadable.'), { status: 502 }); }
  const d = mapDetails(json, id);
  db.prepare("INSERT INTO digital_details (store, app_id, json, fetched_at, found) VALUES ('steam', ?, ?, datetime('now'), ?) ON CONFLICT(store, app_id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at, found = excluded.found")
    .run(id, d ? JSON.stringify(d) : null, d ? 1 : 0);
  return d;
}
