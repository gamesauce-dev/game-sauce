// Console games in Digital: PlayStation 4, PlayStation 5 and Xbox. There is no store login to read them from, so a person brings their
// list in from a CSV (platform, game title, country of the store it was bought from). The details and cover art are then looked up
// with the same providers the Library uses for ROMs, in the background, and cached like Steam's store details (shared by everyone,
// keyed by store + game). Nothing here can launch a game: consoles have no play button.
import fs from 'node:fs';
import db from '../db.js';
import { enrich, cacheMedia } from './providers.js';
import { parseCsv } from './namecsv.js';
import { decodeEntities } from './metadata.js';

/** The console stores. `meta` lists the Library platforms to search, in order (a PS5 game not found as PS5 is tried as PS4, and so on). */
export const CONSOLE_STORES = {
  ps4: { label: 'PlayStation 4', short: 'PS4', meta: ['ps4', 'ps5'] },
  ps5: { label: 'PlayStation 5', short: 'PS5', meta: ['ps5', 'ps4'] },
  xbox: { label: 'Xbox', short: 'XBOX', meta: ['xboxseries', 'xboxone'] }
};
export const isConsoleStore = (s) => Object.prototype.hasOwnProperty.call(CONSOLE_STORES, String(s || ''));
const CONSOLE_LIST = Object.keys(CONSOLE_STORES);

const squash = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

/** "PS4", "PlayStation 4", "Sony PlayStation 4" → ps4; "PS5" → ps5; "Xbox", "Xbox One", "Xbox Series X|S", "XSX" → xbox. Anything else → null. */
export function storeFor(platformName) {
  const s = squash(platformName).replace(/^sony/, '').replace(/^microsoft/, '');
  if (!s) return null;
  if (['ps4', 'playstation4', 'ps4pro', 'psn4'].includes(s)) return 'ps4';
  if (['ps5', 'playstation5', 'ps5pro'].includes(s)) return 'ps5';
  if (s.startsWith('xbox') || ['xb1', 'xbone', 'xsx', 'xss', 'xsxs', 'xbs'].includes(s)) return 'xbox';
  return null;
}

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
  if (store === 'ps4' || store === 'ps5') return `https://store.playstation.com/${loc}/search/${q}`;
  if (store === 'xbox') {
    const [lang, ...rest] = loc.split('-');
    return `https://www.xbox.com/${lang}-${rest.join('-').toUpperCase()}/search/results/games?q=${q}`;
  }
  return null;
}

/* ───────── CSV import ───────── */

const HEADER = {
  platform: ['platformname', 'platform', 'console', 'system'],
  title: ['gametitle', 'title', 'game', 'gamename', 'name'],
  country: ['countryofsourcestore', 'countryofstore', 'storecountry', 'sourcestorecountry', 'country', 'region', 'store']
};

/**
 * Read a console CSV (columns: Platform Name, Game Title, Country of Source Store; the header row is required, the order is not).
 * With apply: false nothing is saved and the answer says what would happen. With replace: true, games already in the person's list
 * for a platform that appears in the file are removed when the file no longer lists them; platforms not in the file are left alone.
 */
export function importConsoleCsv(userId, csvText, { apply = false, replace = false } = {}) {
  const rows = parseCsv(String(csvText || ''));
  if (!rows.length) throw Object.assign(new Error('The file is empty.'), { status: 400 });
  const head = rows[0].map(squash);
  const col = Object.fromEntries(Object.entries(HEADER).map(([k, names]) => [k, names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1]));
  if (col.platform < 0 || col.title < 0) {
    throw Object.assign(new Error('The first row must name the columns: Platform Name, Game Title, Country of Source Store (the country is optional).'), { status: 400 });
  }
  const seen = new Map();   // "store\napp_id" → row
  const problems = []; let skipped = 0, duplicates = 0;
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const title = decodeEntities(String(r[col.title] || '').trim()).slice(0, 200);
    const platform = String(r[col.platform] || '').trim();
    const store = storeFor(platform);
    if (!title) { skipped++; if (problems.length < 10) problems.push({ line, reason: 'No game title' }); return; }
    if (!store) { skipped++; if (problems.length < 10) problems.push({ line, reason: platform ? `Unknown platform "${platform.slice(0, 40)}" (use PS4, PS5 or Xbox)` : 'No platform' }); return; }
    const appId = appIdFor(title);
    if (!appId) { skipped++; if (problems.length < 10) problems.push({ line, reason: `The title "${title.slice(0, 40)}" has no letters or digits` }); return; }
    const key = store + '\n' + appId;
    if (seen.has(key)) { duplicates++; return; }
    const c = col.country >= 0 ? countryFor(r[col.country]) : null;
    seen.set(key, { store, app_id: appId, name: title, country: c ? (c.code || c.name) : null });
  });

  const games = [...seen.values()];
  const stores = [...new Set(games.map((g) => g.store))];
  const existing = new Map(db.prepare(`SELECT store, app_id, name, country FROM digital_games WHERE user_id = ? AND store IN (${CONSOLE_LIST.map(() => '?').join(',')})`)
    .all(userId, ...CONSOLE_LIST).map((g) => [g.store + '\n' + g.app_id, g]));
  let added = 0, updated = 0, unchanged = 0;
  for (const g of games) {
    const had = existing.get(g.store + '\n' + g.app_id);
    if (!had) added++;
    else if (had.name !== g.name || (had.country || null) !== (g.country || null)) updated++;
    else unchanged++;
  }
  const removing = replace ? [...existing.values()].filter((g) => stores.includes(g.store) && !seen.has(g.store + '\n' + g.app_id)) : [];
  const byStore = Object.fromEntries(CONSOLE_LIST.map((s) => [s, games.filter((g) => g.store === s).length]).filter(([, n]) => n));

  if (apply) {
    const ins = db.prepare(`INSERT INTO digital_games (user_id, store, app_id, name, country) VALUES (?, ?, ?, ?, ?)`);
    const upd = db.prepare('UPDATE digital_games SET name = ?, country = ? WHERE user_id = ? AND store = ? AND app_id = ?');
    const delGame = db.prepare('DELETE FROM digital_games WHERE user_id = ? AND store = ? AND app_id = ?');
    const delMark = db.prepare('DELETE FROM digital_marks WHERE user_id = ? AND store = ? AND app_id = ?');
    db.transaction(() => {
      for (const g of games) {
        if (existing.has(g.store + '\n' + g.app_id)) upd.run(g.name, g.country, userId, g.store, g.app_id);
        else ins.run(userId, g.store, g.app_id, g.name, g.country);
      }
      for (const g of removing) { delGame.run(userId, g.store, g.app_id); delMark.run(userId, g.store, g.app_id); }
    })();
    startDetailsJob();
  }
  return {
    applied: Boolean(apply), csv_rows: rows.length - 1, games: games.length, by_store: byStore,
    added, updated, unchanged, removed: removing.length, duplicates, skipped, problems,
    sample: games.slice(0, 5).map((g) => ({ store: g.store, name: g.name, country: g.country }))
  };
}

/** Remove one console game from a person's list (its marks go too; the shared cached details stay for anyone else who owns it). */
export function removeConsoleGame(userId, store, appId) {
  if (!isConsoleStore(store)) throw Object.assign(new Error('Only PlayStation and Xbox games can be removed here.'), { status: 400 });
  const r = db.prepare('DELETE FROM digital_games WHERE user_id = ? AND store = ? AND app_id = ?').run(userId, store, String(appId));
  db.prepare('DELETE FROM digital_marks WHERE user_id = ? AND store = ? AND app_id = ?').run(userId, store, String(appId));
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
export async function lookupConsoleGame(store, name, enrichImpl = enrich) {
  let best = null, lastError = null;
  for (const slug of CONSOLE_STORES[store]?.meta || []) {
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
export async function refreshConsoleDetails(store, appId, name, { enrichImpl = enrich, cacheImpl = cacheMedia } = {}) {
  const { details, error } = await lookupConsoleGame(store, name, enrichImpl);
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

export function consoleCoverPath(store, appId) {
  const row = db.prepare('SELECT cover_path FROM digital_details WHERE store = ? AND app_id = ?').get(store, String(appId));
  return row?.cover_path && fs.existsSync(row.cover_path) ? row.cover_path : null;
}

/* One background run at a time looks up every console game (anyone's) that has no details yet. With retry: true, games nothing was
   found for are tried again too (for example after adding a provider key). */
const job = { running: false, total: 0, done: 0, found: 0, again: false, retry: false };
export const detailsJobStatus = () => ({ running: job.running, total: job.total, done: job.done, found: job.found });

const pendingSql = (retry) => `SELECT g.store, g.app_id, MIN(g.name) AS name FROM digital_games g
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
          try { if (await refreshConsoleDetails(g.store, g.app_id, g.name, { enrichImpl, cacheImpl })) job.found++; } catch { /* one game must not stop the run */ }
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
