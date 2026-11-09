// Console games in Digital: PlayStation (3, 4, 5), Nintendo (Switch 2, Switch, Wii, Wii U, 3DS, DS) and Xbox. There is no store login to read them from, so a person brings their
// list in from a CSV (platform, game title, country of the store it was bought from). The details and cover art are then looked up
// with the same providers the Library uses for ROMs, in the background, and cached like Steam's store details (shared by everyone,
// keyed by store + game). Nothing here can launch a game: consoles have no play button.
import fs from 'node:fs';
import db from '../db.js';
import { enrich, cacheMedia } from './providers.js';
import { parseCsv } from './namecsv.js';
import { decodeEntities } from './metadata.js';
import { saveCover, dropCustomCover } from './storage.js';
import { sniffImage, MAX_COVER_BYTES } from './coverzip.js';

/** The console stores, one chip each in Digital. `meta` is the default list of Library platforms to search when a game has no console of its own. */
export const CONSOLE_STORES = {
  playstation: { label: 'PlayStation', short: 'PS', meta: ['ps4', 'ps5', 'ps3'] },
  nintendo: { label: 'Nintendo', short: 'NINTENDO', meta: ['switch', 'switch2', 'wii', 'wiiu', '3ds', 'nds'] },
  xbox: { label: 'Xbox', short: 'XBOX', meta: ['xboxseries', 'xboxone'] }
};
export const isConsoleStore = (s) => Object.prototype.hasOwnProperty.call(CONSOLE_STORES, String(s || ''));

/**
 * Each store holds games from several consoles. A game carries the console it is for (its `platform`): that decides its badge and which Library
 * platform it is looked up as (`meta`, in order: a game not found as a PS5 game is tried as a PS4 one, and so on). The ids are unique across stores.
 */
export const CONSOLE_PLATFORMS = {
  ps2: { store: 'playstation', label: 'PlayStation 2', badge: 'PS2', meta: ['ps2'] },
  ps3: { store: 'playstation', label: 'PlayStation 3', badge: 'PS3', meta: ['ps3'] },
  ps4: { store: 'playstation', label: 'PlayStation 4', badge: 'PS4', meta: ['ps4', 'ps5'] },
  ps5: { store: 'playstation', label: 'PlayStation 5', badge: 'PS5', meta: ['ps5', 'ps4'] },
  switch2: { store: 'nintendo', label: 'Nintendo Switch 2', badge: 'SWITCH 2', meta: ['switch2', 'switch'] },
  switch: { store: 'nintendo', label: 'Nintendo Switch', badge: 'SWITCH', meta: ['switch', 'switch2'] },
  wii: { store: 'nintendo', label: 'Nintendo Wii', badge: 'WII', meta: ['wii'] },
  wiiu: { store: 'nintendo', label: 'Nintendo Wii U', badge: 'WII U', meta: ['wiiu'] },
  '3ds': { store: 'nintendo', label: 'Nintendo 3DS', badge: '3DS', meta: ['3ds'] },
  ds: { store: 'nintendo', label: 'Nintendo DS', badge: 'DS', meta: ['nds'] },
  xbox: { store: 'xbox', label: 'Xbox', badge: 'XBOX', meta: ['xbox'] },
  x360: { store: 'xbox', label: 'Xbox 360', badge: 'XBOX 360', meta: ['xbox360'] },
  xone: { store: 'xbox', label: 'Xbox One', badge: 'XBOX ONE', meta: ['xboxone', 'xboxseries'] },
  xsx: { store: 'xbox', label: 'Xbox Series X|S', badge: 'X|S', meta: ['xboxseries', 'xboxone'] }
};
const platformOf = (store, platform) => (CONSOLE_PLATFORMS[platform]?.store === store ? CONSOLE_PLATFORMS[platform] : null);
/** The name a game's platform is shown under (an Xbox game from before the consoles were told apart has none, so it is just Xbox). */
export const platformLabel = (store, platform) => platformOf(store, platform)?.label || CONSOLE_STORES[store]?.label || store;
const CONSOLE_LIST = Object.keys(CONSOLE_STORES);

const squash = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

/**
 * What a platform name in the CSV means, as { store, platform } (or null). PlayStation: "PS3", "PlayStation 4", "PS5 Pro"...; Nintendo: "Switch 2",
 * "Switch" (Lite and OLED too), "Wii", "Wii U", "3DS" (2DS and New 3DS too), "DS" (DSi and DS Lite too); Xbox: "Xbox" → xbox, "Xbox 360" → x360,
 * "Xbox One" → xone, "Xbox Series X|S" (or "X|S", "XSX") → xsx. A leading Sony, Nintendo or Microsoft is ignored.
 */
export function platformFor(platformName) {
  const s = squash(platformName).replace(/^(sony|nintendo|microsoft)/, '');
  if (!s) return null;
  const is = (platform) => ({ store: CONSOLE_PLATFORMS[platform].store, platform });
  const ps = /^(?:ps|playstation|psn)([2345])(?:pro|slim)?$/.exec(s);
  if (ps) return is('ps' + ps[1]);
  if (/^(?:switch2|ns2)/.test(s)) return is('switch2');
  if (/^(?:switch|ns)(?:lite|oled)?$/.test(s)) return is('switch');
  if (s === 'wiiu') return is('wiiu');
  if (s === 'wii') return is('wii');
  if (/^(?:new)?n?[32]ds(?:xl|ll)?$/.test(s)) return is('3ds');
  if (/^n?dsi?(?:lite|xl|ll)?$/.test(s)) return is('ds');
  if (s.includes('360') || s === 'x360') return is('x360');
  if (s.includes('series') || ['xs', 'xsx', 'xss', 'xsxs', 'xbs'].includes(s)) return is('xsx');
  if (s.includes('one') || ['xb1', 'xone'].includes(s)) return is('xone');
  if (s.startsWith('xbox')) return is('xbox');
  return null;
}
export const storeFor = (platformName) => platformFor(platformName)?.store || null;

/** A game's id inside its store: its title, lower case, with everything but letters and digits made into dashes. Stable across imports. */
export function appIdFor(title) {
  return String(title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

/* Countries people buy from, with the address each store uses for that country's site. */
const COUNTRIES = {
  AU: ['Australia', 'en-au'], NZ: ['New Zealand', 'en-nz'], US: ['United States', 'en-us'], CA: ['Canada', 'en-ca'], GB: ['United Kingdom', 'en-gb'],
  IE: ['Ireland', 'en-ie'], JP: ['Japan', 'ja-jp'], DE: ['Germany', 'de-de'], FR: ['France', 'fr-fr'], ES: ['Spain', 'es-es'], IT: ['Italy', 'it-it'],
  NL: ['Netherlands', 'nl-nl'], BE: ['Belgium', 'fr-be'], AT: ['Austria', 'de-at'], CH: ['Switzerland', 'de-ch'], PT: ['Portugal', 'pt-pt'],
  SE: ['Sweden', 'sv-se'], DK: ['Denmark', 'da-dk'], NO: ['Norway', 'no-no'], FI: ['Finland', 'fi-fi'], PL: ['Poland', 'pl-pl'],
  BR: ['Brazil', 'pt-br'], MX: ['Mexico', 'es-mx'], AR: ['Argentina', 'es-ar'], CL: ['Chile', 'es-cl'], HK: ['Hong Kong', 'en-hk'],
  SG: ['Singapore', 'en-sg'], MY: ['Malaysia', 'en-my'], IN: ['India', 'en-in'], KR: ['South Korea', 'ko-kr'], TW: ['Taiwan', 'zh-hant-tw'],
  ZA: ['South Africa', 'en-za'], AE: ['United Arab Emirates', 'en-ae'], SA: ['Saudi Arabia', 'en-sa']
};
const COUNTRY_ALIASES = {
  usa: 'US', america: 'US', unitedstatesofamerica: 'US', uk: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', britain: 'GB', greatbritain: 'GB',
  korea: 'KR', southkorea: 'KR', uae: 'AE', holland: 'NL', aus: 'AU', oz: 'AU'
};

/** "Australia", "AU", "au", "AUS" → { code: 'AU', name: 'Australia', locale: 'en-au' }. Unknown text is kept as written, with no store address. */
export function countryFor(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const s = squash(raw);
  let code = null;
  if (/^[a-z]{2}$/.test(s)) code = s.toUpperCase() === 'UK' ? 'GB' : s.toUpperCase();
  if (!COUNTRIES[code]) code = COUNTRY_ALIASES[s] || Object.keys(COUNTRIES).find((k) => squash(COUNTRIES[k][0]) === s) || null;
  if (!code) return { code: null, name: raw.slice(0, 60), locale: null };
  return { code, name: COUNTRIES[code][0], locale: COUNTRIES[code][1] };
}

/** The store's own search page for a game, on that country's site (US when the country is unknown). */
export function storeUrl(store, title, country) {
  const loc = countryFor(country)?.locale || 'en-us';
  const q = encodeURIComponent(String(title || ''));
  if (store === 'playstation') return `https://store.playstation.com/${loc}/search/${q}`;
  if (store === 'xbox') {
    const [lang, ...rest] = loc.split('-');
    return `https://www.xbox.com/${lang}-${rest.join('-').toUpperCase()}/search/results/games?q=${q}`;
  }
  return null;   // Nintendo's shops have no search address that works the same for every country
}

/* ───────── CSV import ───────── */

const HEADER = {
  platform: ['platform', 'platformname', 'console', 'system'],
  title: ['game', 'gametitle', 'title', 'gamename', 'name'],
  country: ['country', 'countryofsourcestore', 'countryofstore', 'storecountry', 'sourcestorecountry', 'region', 'store'],
  media: ['media', 'physical', 'physicalcopy', 'format', 'copy']
};
/** The fourth column: DISC or CART (also "cartridge", "physical", "yes") switches the tile's disc / cartridge icon on; "digital", "no" or "-" switches it off; empty leaves it as it is. */
function mediaFor(v) {
  const s = squash(v);
  if (!s) return null;
  if (['disc', 'disk', 'cart', 'cartridge', 'physical', 'yes', 'y', 'true', '1'].includes(s)) return true;
  if (['digital', 'none', 'no', 'n', 'false', '0'].includes(s)) return false;
  return undefined;
}

/**
 * Read a console CSV (columns: Platform, Game, Country and optionally Media (DISC or CART); the header row is required, the order is not; the older names Platform Name, Game Title and Country of Source Store still work).
 * With apply: false nothing is saved and the answer says what would happen. With replace: true, games already in the person's list
 * for a platform that appears in the file are removed when the file no longer lists them; platforms not in the file are left alone.
 */
export function importConsoleCsv(userId, csvText, { apply = false, replace = false } = {}) {
  const rows = parseCsv(String(csvText || ''));
  if (!rows.length) throw Object.assign(new Error('The file is empty.'), { status: 400 });
  const head = rows[0].map(squash);
  const col = Object.fromEntries(Object.entries(HEADER).map(([k, names]) => [k, names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1]));
  if (col.platform < 0 || col.title < 0) {
    throw Object.assign(new Error('The first row must name the columns: Platform, Game, Country (the country is optional).'), { status: 400 });
  }
  const seen = new Map();   // "store\napp_id" → row
  const problems = []; let skipped = 0, duplicates = 0;
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const title = decodeEntities(String(r[col.title] || '').trim()).slice(0, 200);
    const platform = String(r[col.platform] || '').trim();
    const pf = platformFor(platform), store = pf?.store || null;
    if (!title) { skipped++; if (problems.length < 10) problems.push({ line, reason: 'No game title' }); return; }
    if (!store) { skipped++; if (problems.length < 10) problems.push({ line, reason: platform ? `Unknown platform "${platform.slice(0, 40)}" (use PS3, PS4, PS5, Switch 2, Switch, Wii, Wii U, 3DS, DS, Xbox, Xbox 360, Xbox One or Xbox Series X|S)` : 'No platform' }); return; }
    const slug = appIdFor(title);
    if (!slug) { skipped++; if (problems.length < 10) problems.push({ line, reason: `The title "${title.slice(0, 40)}" has no letters or digits` }); return; }
    // A game is filed per console, so the same title on the PS4 and the PS5 (or the 360 and the One) is two games.
    const appId = `${slug}-${pf.platform}`;
    const key = store + '\n' + appId;
    if (seen.has(key)) { duplicates++; return; }
    const c = col.country >= 0 ? countryFor(r[col.country]) : null;
    const media = col.media >= 0 ? mediaFor(r[col.media]) : null;
    if (media === undefined && problems.length < 10) problems.push({ line, reason: `Media "${String(r[col.media]).trim().slice(0, 20)}" not understood (use DISC or CART); left as it is` });
    seen.set(key, { store, app_id: appId, slug, name: title, platform: pf.platform, country: c ? (c.code || c.name) : null, physical: typeof media === 'boolean' ? media : null });
  });

  const games = [...seen.values()];
  const stores = [...new Set(games.map((g) => g.store))];
  const existing = new Map(db.prepare(`SELECT store, app_id, name, country, platform FROM digital_games WHERE user_id = ? AND store IN (${CONSOLE_LIST.map(() => '?').join(',')})`)
    .all(userId, ...CONSOLE_LIST).map((g) => [g.store + '\n' + g.app_id, g]));
  // Games imported before the consoles were told apart (Xbox ones) have no console and a plain id: the first game of that title in the file takes
  // such a row over (keeping its id, so its marks and cover stay), instead of adding a second copy.
  const kept = new Set();
  for (const g of games) {
    if (g.platform && !existing.has(g.store + '\n' + g.app_id)) {
      const old = existing.get(g.store + '\n' + g.slug);
      if (old && !old.platform && !kept.has(g.store + '\n' + g.slug)) g.app_id = g.slug;
    }
    kept.add(g.store + '\n' + g.app_id);
  }
  let added = 0, updated = 0, unchanged = 0;
  for (const g of games) {
    const had = existing.get(g.store + '\n' + g.app_id);
    if (!had) added++;
    else if (had.name !== g.name || (had.country || null) !== (g.country || null) || (had.platform || null) !== (g.platform || null)) updated++;
    else unchanged++;
  }
  const removing = replace ? [...existing.values()].filter((g) => stores.includes(g.store) && !kept.has(g.store + '\n' + g.app_id)) : [];
  const byStore = Object.fromEntries(CONSOLE_LIST.map((s) => [s, games.filter((g) => g.store === s).length]).filter(([, n]) => n));

  if (apply) {
    const ins = db.prepare(`INSERT INTO digital_games (user_id, store, app_id, name, country, platform) VALUES (?, ?, ?, ?, ?, ?)`);
    const upd = db.prepare('UPDATE digital_games SET name = ?, country = ?, platform = ? WHERE user_id = ? AND store = ? AND app_id = ?');
    const delGame = db.prepare('DELETE FROM digital_games WHERE user_id = ? AND store = ? AND app_id = ?');
    const setPhysical = db.prepare(`INSERT INTO digital_marks (user_id, store, app_id, physical) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, store, app_id) DO UPDATE SET physical = excluded.physical`);
    const delMark = db.prepare('DELETE FROM digital_marks WHERE user_id = ? AND store = ? AND app_id = ?');
    db.transaction(() => {
      for (const g of games) {
        if (existing.has(g.store + '\n' + g.app_id)) upd.run(g.name, g.country, g.platform, userId, g.store, g.app_id);
        else ins.run(userId, g.store, g.app_id, g.name, g.country, g.platform);
      }
      for (const g of games) if (g.physical !== null) setPhysical.run(userId, g.store, g.app_id, g.physical ? 1 : 0);
      for (const g of removing) { delGame.run(userId, g.store, g.app_id); delMark.run(userId, g.store, g.app_id); }
    })();
    startDetailsJob();
  }
  return {
    applied: Boolean(apply), csv_rows: rows.length - 1, games: games.length, by_store: byStore,
    added, updated, unchanged, removed: removing.length, duplicates, skipped, problems,
    physical_on: games.filter((g) => g.physical === true).length, physical_off: games.filter((g) => g.physical === false).length,
    sample: games.slice(0, 5).map((g) => ({ store: g.store, platform: g.platform, name: g.name, country: g.country }))
  };
}

/** Add one console game by hand: a Library-style title, a console (an id such as ps5 or a name such as "PS5"), and optionally the country of the store. */
export function addConsoleGame(userId, { platform, title, country = '' } = {}) {
  const pf = CONSOLE_PLATFORMS[platform] ? { store: CONSOLE_PLATFORMS[platform].store, platform } : platformFor(platform);
  if (!pf) throw Object.assign(new Error('Choose a console from the list.'), { status: 400 });
  const name = decodeEntities(String(title || '').trim()).slice(0, 200);
  const slug = appIdFor(name);
  if (!slug) throw Object.assign(new Error('Type the game\'s title.'), { status: 400 });
  const appId = `${slug}-${pf.platform}`;
  if (db.prepare('SELECT 1 FROM digital_games WHERE user_id = ? AND store = ? AND app_id = ?').get(userId, pf.store, appId)) throw Object.assign(new Error('That game is already in your Digital list for this console.'), { status: 409 });
  const c = countryFor(country);
  db.prepare('INSERT INTO digital_games (user_id, store, app_id, name, country, platform) VALUES (?, ?, ?, ?, ?, ?)').run(userId, pf.store, appId, name, c ? (c.code || c.name) : null, pf.platform);
  startDetailsJob();
  return { store: pf.store, app_id: appId, name, platform: pf.platform };
}

/** Remove one console game from a person's list (its marks go too; the shared cached details stay for anyone else who owns it). */
export function removeConsoleGame(userId, store, appId) {
  if (!isConsoleStore(store)) throw Object.assign(new Error('Only console games can be removed here.'), { status: 400 });
  const r = db.prepare('DELETE FROM digital_games WHERE user_id = ? AND store = ? AND app_id = ?').run(userId, store, String(appId));
  db.prepare('DELETE FROM digital_marks WHERE user_id = ? AND store = ? AND app_id = ?').run(userId, store, String(appId));
  db.prepare('DELETE FROM digital_user_meta WHERE user_id = ? AND store = ? AND app_id = ?').run(userId, store, String(appId));
  if (!r.changes) throw Object.assign(new Error('That game is not in your list'), { status: 404 });
  return { removed: true };
}

/* ───────── details and covers ───────── */

const splitList = (s) => String(s || '').split(/\s*[,;/]\s*/).map((x) => x.trim()).filter(Boolean);

/** A provider's record (the shape enrich() returns for ROMs) reduced to what the details window shows, in the same shape as Steam's. */
export function mapRecord(meta, platformSlug) {
  if (!meta || meta.error) return null;
  const txt = (v) => (typeof v === 'string' ? decodeEntities(v).trim() : v) || null;
  const media = meta.media || {};
  const shots = [media.screenshot, media.fanart, ...(Array.isArray(media.screenshots) ? media.screenshots : [])].filter((u) => typeof u === 'string' && /^https?:/i.test(u));
  return {
    name: txt(meta.title),
    description: String(txt(meta.description) || '').slice(0, 1500),
    developers: splitList(txt(meta.developer)).slice(0, 4),
    publishers: splitList(txt(meta.publisher)).slice(0, 4),
    release: meta.release_year ? String(meta.release_year) : null,
    genres: splitList(txt(meta.genre)).slice(0, 8),
    rating: Number.isFinite(Number(meta.rating)) && meta.rating !== null ? Number(meta.rating) : null,
    screenshots: [...new Set(shots)].slice(0, 6),
    source: meta.cover_source && meta.source ? `${meta.source} (cover: ${meta.cover_source})` : (meta.source || null),
    matched_platform: platformSlug,
    cover_url: meta.cover_url || media.box2d || null
  };
}

/** Platform rows as the providers expect them (the ScreenScraper / TheGamesDB ids come from the Library's platform table). */
function platformRow(slug) {
  const p = db.prepare('SELECT slug, name, family, screenscraper_id, tgdb_id FROM platforms WHERE slug = ?').get(slug);
  return p || { slug, name: slug };
}

/** Look one console game up: each of its store's platforms in turn, keeping the first match that has a cover (or else the first match). */
export async function lookupConsoleGame(store, name, enrichImpl = enrich, platform = null) {
  let best = null, lastError = null;
  for (const slug of platformOf(store, platform)?.meta || CONSOLE_STORES[store]?.meta || []) {
    const meta = await enrichImpl({ title: name, platform: platformRow(slug), hashes: {}, filename: name, titleTrusted: true });
    if (meta?.error) { lastError = String(meta.error); continue; }
    const d = mapRecord(meta, slug);
    if (!d) continue;
    if (d.cover_url) return { details: d };
    if (!best) best = d;
  }
  return best ? { details: best } : { details: null, error: lastError };
}

/** Fetch and cache the details for one game; returns what the window shows (or null when no provider knows it). */
export async function refreshConsoleDetails(store, appId, name, { enrichImpl = enrich, cacheImpl = cacheMedia, platform = null } = {}) {
  const { details, error } = await lookupConsoleGame(store, name, enrichImpl, platform);
  let coverPath = null;
  if (details?.cover_url) { try { coverPath = await cacheImpl(details.cover_url, 'box2d'); } catch { coverPath = null; } }
  const json = details ? JSON.stringify({ ...details, cover_url: undefined }) : (error ? JSON.stringify({ error }) : null);
  db.prepare(`INSERT INTO digital_details (store, app_id, json, fetched_at, found, cover_path) VALUES (?, ?, ?, datetime('now'), ?, ?)
    ON CONFLICT(store, app_id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at, found = excluded.found, cover_path = excluded.cover_path`)
    .run(store, String(appId), json, details ? 1 : 0, coverPath);
  return details ? { ...details, cover_url: undefined } : null;
}

/** Cached details for the window: looked up on the spot when there are none yet, or when nothing was found more than a day ago. */
export async function getConsoleDetails(store, appId, name, opts) {
  const row = db.prepare("SELECT json, found, (julianday('now') - julianday(fetched_at)) AS age FROM digital_details WHERE store = ? AND app_id = ?").get(store, String(appId));
  if (row?.found) return JSON.parse(row.json);
  if (row && row.age < 1) return null;
  return refreshConsoleDetails(store, appId, name, opts);
}

/** Does this person have a cover of their own for the game (uploaded, or came with a match they picked)? */
export function hasOwnConsoleCover(userId, store, appId) {
  const own = db.prepare('SELECT cover_path FROM digital_user_meta WHERE user_id = ? AND store = ? AND app_id = ?').get(userId, store, String(appId));
  return Boolean(own?.cover_path && fs.existsSync(own.cover_path));
}

export function consoleCoverPath(store, appId, userId = null) {
  const own = userId == null ? null : db.prepare('SELECT cover_path FROM digital_user_meta WHERE user_id = ? AND store = ? AND app_id = ?').get(userId, store, String(appId));
  if (own?.cover_path && fs.existsSync(own.cover_path)) return own.cover_path;   // the cover a person picked by hand beats the shared one
  const row = db.prepare('SELECT cover_path FROM digital_details WHERE store = ? AND app_id = ?').get(store, String(appId));
  return row?.cover_path && fs.existsSync(row.cover_path) ? row.cover_path : null;
}

/* ───────── a person's own corrections to a console game's details ─────────
   Kept in digital_user_meta, apart from the cached details everyone shares. A field the person changed (by hand or through a match picked in the identify search)
   wins for them only; a field they never touched keeps following the shared details. */
const FIELDS = ['description', 'developers', 'publishers', 'release', 'genres', 'rating'];
const LISTS = new Set(['developers', 'publishers', 'genres']);
const userMeta = (userId, store, appId) => db.prepare('SELECT json, cover_path, source, updated_at FROM digital_user_meta WHERE user_id = ? AND store = ? AND app_id = ?').get(userId, store, String(appId));
const sharedJson = (store, appId) => { try { return JSON.parse(db.prepare('SELECT json FROM digital_details WHERE store = ? AND app_id = ? AND found = 1').get(store, String(appId))?.json || 'null'); } catch { return null; } };

/** The shared details with the person's own corrections laid over them (null when there are neither). */
export function mergeDetails(shared, own) {
  let mine = null; try { mine = own?.json ? JSON.parse(own.json) : null; } catch { mine = null; }
  if (!shared && !mine) return null;
  const out = { ...(shared || { screenshots: [], source: null }) };
  for (const f of FIELDS) if (mine && mine[f] !== undefined && mine[f] !== null) out[f] = mine[f];
  if (mine?.source || own?.source) out.source = mine?.source || own.source;
  for (const f of LISTS) if (!Array.isArray(out[f])) out[f] = [];
  return out;
}

export function consoleDetailsFor(userId, store, appId, shared) {
  const own = userMeta(userId, store, appId);
  return { details: mergeDetails(shared ?? sharedJson(store, appId), own), custom: Boolean(own) };
}

const asList = (v) => (Array.isArray(v) ? v : splitList(v)).map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Edit by hand: description, developers, publishers, genres (lists may be comma separated text), release (year or date text), rating 0-5, and the store country. */
export function editConsoleGame(userId, store, appId, body = {}) {
  const game = db.prepare('SELECT 1 FROM digital_games WHERE user_id = ? AND store = ? AND app_id = ?').get(userId, store, String(appId));
  if (!game) throw Object.assign(new Error('That game is not in your list'), { status: 404 });
  const shared = sharedJson(store, appId) || {};
  const cur = userMeta(userId, store, appId); let mine = {}; try { mine = cur?.json ? JSON.parse(cur.json) : {}; } catch { mine = {}; }
  for (const f of FIELDS) {
    if (body[f] === undefined) continue;
    let v;
    if (LISTS.has(f)) v = asList(body[f]);
    else if (f === 'rating') { const x = body[f] === null || body[f] === '' ? null : Number(body[f]); if (x !== null && !(Number.isFinite(x) && x >= 0 && x <= 5)) throw Object.assign(new Error('The rating must be between 0 and 5'), { status: 400 }); v = x; }
    else v = String(body[f] ?? '').trim().slice(0, f === 'description' ? 4000 : 40);
    // Only what differs from the shared details is a correction: a field left as it is keeps following the shared details.
    if (same(v, shared[f] ?? (LISTS.has(f) ? [] : (f === 'rating' ? null : '')))) delete mine[f]; else mine[f] = v;
  }
  if (body.country !== undefined) {
    const c = countryFor(body.country);
    db.prepare('UPDATE digital_games SET country = ? WHERE user_id = ? AND store = ? AND app_id = ?').run(c ? (c.code || c.name) : null, userId, store, String(appId));
  }
  const empty = !Object.keys(mine).length && !cur?.cover_path;
  if (empty) db.prepare('DELETE FROM digital_user_meta WHERE user_id = ? AND store = ? AND app_id = ?').run(userId, store, String(appId));
  else db.prepare(`INSERT INTO digital_user_meta (user_id, store, app_id, json, cover_path, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, store, app_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(userId, store, String(appId), JSON.stringify(mine), cur?.cover_path || null, cur?.source || null);
  return { custom: !empty };
}

/** A match picked in the identify search (the candidate POST /metadata/search returns): its details and cover become this person's own for the game. */
export async function applyConsoleMatch(userId, store, appId, cand, { cacheImpl = cacheMedia } = {}) {
  const game = db.prepare('SELECT 1 FROM digital_games WHERE user_id = ? AND store = ? AND app_id = ?').get(userId, store, String(appId));
  if (!game) throw Object.assign(new Error('That game is not in your list'), { status: 404 });
  const c = cand || {};
  const text = (v) => (typeof v === 'string' ? decodeEntities(v).trim() : '') || null;
  const rec = {
    description: text(c.description)?.slice(0, 4000) || null,
    developers: splitList(text(c.developer)).slice(0, 4), publishers: splitList(text(c.publisher)).slice(0, 4), genres: splitList(text(c.genre)).slice(0, 8),
    release: c.release_year ? String(c.release_year) : null,
    rating: Number.isFinite(Number(c.rating)) && c.rating !== null && c.rating !== '' && Number(c.rating) >= 0 && Number(c.rating) <= 5 ? Number(c.rating) : null
  };
  const json = {}; for (const f of FIELDS) { const v = rec[f]; if (v !== null && !(Array.isArray(v) && !v.length)) json[f] = v; }
  const url = c.cover_url || c.media?.box2d || null;
  let coverPath = null; if (url) { try { coverPath = await cacheImpl(url, 'box2d'); } catch { coverPath = null; } }
  const source = String(c.source || 'manual').slice(0, 40);
  db.prepare(`INSERT INTO digital_user_meta (user_id, store, app_id, json, cover_path, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, store, app_id) DO UPDATE SET json = excluded.json, cover_path = COALESCE(excluded.cover_path, digital_user_meta.cover_path), source = excluded.source, updated_at = excluded.updated_at`)
    .run(userId, store, String(appId), JSON.stringify(json), coverPath, source);
  return { custom: true };
}

/** The person's own cover for a console game (a JPEG, PNG or WebP picture, up to 8 MB): theirs alone, and it wins over the shared one. */
export function setConsoleCover(userId, store, appId, buffer) {
  const game = db.prepare('SELECT 1 FROM digital_games WHERE user_id = ? AND store = ? AND app_id = ?').get(userId, store, String(appId));
  if (!game) throw Object.assign(new Error('That game is not in your list'), { status: 404 });
  if (!buffer?.length) throw Object.assign(new Error('Choose an image first.'), { status: 400 });
  if (buffer.length > MAX_COVER_BYTES) throw Object.assign(new Error('That image is over 8 MB.'), { status: 400 });
  const type = sniffImage(buffer);
  if (!type) throw Object.assign(new Error('That file is not a JPEG, PNG or WebP image'), { status: 400 });
  const file = saveCover(buffer, `digital-${Number(userId)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type);
  dropCustomCover(userMeta(userId, store, appId)?.cover_path, 'digital-');
  db.prepare(`INSERT INTO digital_user_meta (user_id, store, app_id, json, cover_path, source, updated_at) VALUES (?, ?, ?, '{}', ?, NULL, datetime('now'))
    ON CONFLICT(user_id, store, app_id) DO UPDATE SET cover_path = excluded.cover_path, updated_at = excluded.updated_at`).run(userId, store, String(appId), file);
  return { own_cover: true };
}

/** Back to the shared cover: the person's own picture is forgotten (their edits, if any, stay). */
export function removeConsoleCover(userId, store, appId) {
  const cur = userMeta(userId, store, appId);
  if (!cur) return { own_cover: false };
  dropCustomCover(cur.cover_path, 'digital-');
  db.prepare("UPDATE digital_user_meta SET cover_path = NULL, updated_at = datetime('now') WHERE user_id = ? AND store = ? AND app_id = ?").run(userId, store, String(appId));
  let mine = {}; try { mine = cur.json ? JSON.parse(cur.json) : {}; } catch { mine = {}; }
  if (!Object.keys(mine).length && !cur.source) db.prepare('DELETE FROM digital_user_meta WHERE user_id = ? AND store = ? AND app_id = ?').run(userId, store, String(appId));
  return { own_cover: false };
}

/** Forget this person's corrections and match: the game follows the shared details and cover again. */
export function clearConsoleMatch(userId, store, appId) {
  dropCustomCover(userMeta(userId, store, appId)?.cover_path, 'digital-');
  const r = db.prepare('DELETE FROM digital_user_meta WHERE user_id = ? AND store = ? AND app_id = ?').run(userId, store, String(appId));
  return { cleared: r.changes > 0 };
}

/** Ask the providers about this one game again (the shared details are refreshed, as the Refresh button does for every game). */
export async function lookupConsoleAgain(userId, store, appId, opts) {
  const g = db.prepare('SELECT name, platform FROM digital_games WHERE user_id = ? AND store = ? AND app_id = ?').get(userId, store, String(appId));
  if (!g) throw Object.assign(new Error('That game is not in your list'), { status: 404 });
  return refreshConsoleDetails(store, appId, g.name, { ...opts, platform: g.platform });
}



/* One background run at a time looks up every console game (anyone's) that has no details yet. With retry: true, games nothing was
   found for are tried again too (for example after adding a provider key). */
const job = { running: false, total: 0, done: 0, found: 0, again: false, retry: false };
export const detailsJobStatus = () => ({ running: job.running, total: job.total, done: job.done, found: job.found });

const pendingSql = (retry) => `SELECT g.store, g.app_id, MIN(g.name) AS name, MIN(g.platform) AS platform FROM digital_games g
  LEFT JOIN digital_details d ON d.store = g.store AND d.app_id = g.app_id
  WHERE g.store IN (${CONSOLE_LIST.map(() => '?').join(',')}) AND (d.app_id IS NULL${retry ? ' OR d.found = 0' : ''})
  GROUP BY g.store, g.app_id ORDER BY MIN(g.id)`;

export function startDetailsJob({ retry = false, enrichImpl, cacheImpl } = {}) {
  if (job.running) { job.again = true; job.retry = job.retry || retry; return detailsJobStatus(); }
  const todo = db.prepare(pendingSql(retry)).all(...CONSOLE_LIST);
  if (!todo.length) return detailsJobStatus();
  Object.assign(job, { running: true, total: todo.length, done: 0, found: 0, again: false, retry: false });
  (async () => {
    try {
      let list = todo;
      while (list.length) {
        for (const g of list) {
          try { if (await refreshConsoleDetails(g.store, g.app_id, g.name, { enrichImpl, cacheImpl, platform: g.platform })) job.found++; } catch { /* one game must not stop the run */ }
          job.done++;
        }
        // Games imported while this ran are picked up before it ends.
        list = job.again ? db.prepare(pendingSql(job.retry)).all(...CONSOLE_LIST) : [];
        job.total += list.length; job.again = false; job.retry = false;
      }
    } finally { job.running = false; }
  })();
  return detailsJobStatus();
}

/** For tests: wait for the background run to finish. */
export async function detailsJobIdle(timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (job.running && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
}
