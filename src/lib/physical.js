// Physical: the games on a person's shelf (boxed discs and cartridges) that have no ROM file behind them, so the Library cannot hold them.
// Each person has their own list. A game is filed under a Library platform (so the same platform chips work), and its details and cover come
// from the same providers the Library uses: found automatically in the background, or picked by hand in the details window.
import fs from 'node:fs';
import db from '../db.js';
import { enrich, cacheMedia, launchbox } from './providers.js';
import { parseCsv } from './namecsv.js';
import { decodeEntities, sortTitle } from './metadata.js';
import { platformFor, CONSOLE_PLATFORMS, appIdFor } from './consoles.js';

/** width / height of a JPEG, PNG or WebP file, read from its header (null when it cannot be read). */
export function imageAspect(file) {
  let b;
  try { const fd = fs.openSync(file, 'r'); try { b = Buffer.alloc(262144); b = b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)); } finally { fs.closeSync(fd); } } catch { return null; }
  let w = 0, h = 0;
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) { w = b.readUInt32BE(16); h = b.readUInt32BE(20); }
  else if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break; }
      i += 2 + b.readUInt16BE(i + 2);
    }
  } else if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const t = b.toString('ascii', 12, 16);
    if (t === 'VP8 ') { w = b.readUInt16LE(26) & 0x3fff; h = b.readUInt16LE(28) & 0x3fff; }
    else if (t === 'VP8L') { const v = b.readUInt32LE(21); w = (v & 0x3fff) + 1; h = ((v >> 14) & 0x3fff) + 1; }
    else if (t === 'VP8X') { w = 1 + b.readUIntLE(24, 3); h = 1 + b.readUIntLE(27, 3); }
  }
  return w > 0 && h > 0 ? Math.round((w / h) * 10000) / 10000 : null;
}

const squash = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

/* Names people type that are not a Library platform's own name, short name or slug. */
const PLATFORM_ALIASES = {
  megadrive: 'genesis', segagenesis: 'genesis', segamegadrive: 'genesis', md: 'genesis', mdrive: 'genesis', genesismegadrive: 'genesis',
  supernintendo: 'snes', superfamicom: 'snes', sfc: 'snes', supernes: 'snes',
  famicom: 'nes', nintendoentertainmentsystem: 'nes', nintendo64: 'n64', gc: 'gamecube', ngc: 'gamecube', gcn: 'gamecube',
  gameboy: 'gb', gameboycolor: 'gbc', gameboyadvance: 'gba', nintendods: 'nds', ds: 'nds', nintendo3ds: '3ds',
  psx: 'ps1', psone: 'ps1', playstation: 'ps1', playstation1: 'ps1', sonyplaystation: 'ps1', playstation2: 'ps2', playstation3: 'ps3', playstation4: 'ps4', playstation5: 'ps5',
  playstationportable: 'psp', vita: 'psvita', psv: 'psvita', playstationvita: 'psvita',
  originalxbox: 'xbox', xbox360: 'xbox360', x360: 'xbox360', xboxone: 'xboxone', xone: 'xboxone', xb1: 'xboxone', xboxseriesx: 'xboxseries', xsx: 'xboxseries', xboxseriesxs: 'xboxseries',
  mastersystem: 'mastersystem', sms: 'mastersystem', gamegear: 'gamegear', gg: 'gamegear', megacd: 'segacd', sega32x: 'sega32x', sega32: 'sega32x', saturn: 'saturn', segasaturn: 'saturn', dc: 'dreamcast', segadreamcast: 'dreamcast'
};

let platformIndex = null, platformIndexAt = 0;
/** squashed name → slug, over every Library platform's slug, name and short name (rebuilt when the table may have changed). */
function platformLookup() {
  if (platformIndex && Date.now() - platformIndexAt < 5000) return platformIndex;
  const m = new Map();
  const rows = db.prepare('SELECT slug, name, short_name FROM platforms').all();
  for (const p of rows) for (const k of [p.slug, p.name, p.short_name]) { const s = squash(k); if (s && !m.has(s)) m.set(s, p.slug); }
  const known = new Set(rows.map((p) => p.slug));
  for (const [k, slug] of Object.entries(PLATFORM_ALIASES)) if (known.has(slug) && !m.has(k)) m.set(k, slug);
  platformIndex = m; platformIndexAt = Date.now();
  return m;
}

/** What a platform name in a CSV means: a Library platform slug (or null). Slugs, names, short names and common spellings all work. */
export function resolvePlatform(input) {
  const s = squash(input);
  if (!s) return null;
  const idx = platformLookup();
  if (idx.has(s)) return idx.get(s);
  const noMaker = s.replace(/^(sony|nintendo|microsoft|sega)/, '');
  if (noMaker && idx.has(noMaker)) return idx.get(noMaker);
  // PS5 Pro, Switch OLED, Xbox Series X|S ...: the console CSV's reading of the name, taken to the Library platform it is looked up as.
  const pf = platformFor(input);
  const slug = pf && CONSOLE_PLATFORMS[pf.platform]?.meta?.[0];
  return slug && [...idx.values()].includes(slug) ? slug : null;
}

const HEADER = {
  platform: ['platform', 'platformname', 'console', 'system'],
  title: ['game', 'gametitle', 'title', 'gamename', 'name'],
  region: ['region', 'country', 'countryofsourcestore', 'territory'],
  notes: ['notes', 'note', 'condition', 'comment', 'comments', 'edition'],
  year: ['year', 'releaseyear', 'released']
};

const dedupeKey = (title, region) => `${appIdFor(title)}|${squash(region)}`;
const clean = (v, n = 200) => decodeEntities(String(v ?? '').trim()).slice(0, n);

/**
 * Read a Physical CSV (columns: Platform, Game, and optionally Region, Notes, Year; the header row is required, the order is not).
 * With apply: false nothing is saved and the answer says what would happen. With replace: true, games already on the shelf for a platform
 * that appears in the file are removed when the file no longer lists them; other platforms are left alone.
 */
export function importPhysicalCsv(userId, csvText, { apply = false, replace = false } = {}) {
  const rows = parseCsv(String(csvText || ''));
  if (!rows.length) throw Object.assign(new Error('The file is empty.'), { status: 400 });
  const head = rows[0].map(squash);
  const col = Object.fromEntries(Object.entries(HEADER).map(([k, names]) => [k, names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1]));
  if (col.platform < 0 || col.title < 0) throw Object.assign(new Error('The first row must name the columns: Platform, Game (Region, Notes and Year are optional).'), { status: 400 });

  const seen = new Map(); const problems = []; let skipped = 0, duplicates = 0;
  const problem = (line, reason) => { skipped++; if (problems.length < 10) problems.push({ line, reason }); };
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const title = clean(r[col.title]);
    const pname = String(r[col.platform] || '').trim();
    if (!title) return problem(line, 'No game title');
    const slug = resolvePlatform(pname);
    if (!slug) return problem(line, pname ? `Unknown platform "${pname.slice(0, 40)}" (use a name from the Library's platform list, such as SNES, Mega Drive, PS2 or Game Boy)` : 'No platform');
    if (!appIdFor(title)) return problem(line, `The title "${title.slice(0, 40)}" has no letters or digits`);
    const region = col.region >= 0 ? clean(r[col.region], 40) : '';
    const key = slug + '\n' + dedupeKey(title, region);
    if (seen.has(key)) { duplicates++; return; }
    const y = col.year >= 0 ? Math.round(Number(r[col.year])) : NaN;
    seen.set(key, { platform: slug, title, region: region || null, notes: col.notes >= 0 ? clean(r[col.notes], 300) || null : null, year: y >= 1950 && y <= 2100 ? y : null, key: dedupeKey(title, region) });
  });

  const games = [...seen.values()];
  const platforms = [...new Set(games.map((g) => g.platform))];
  const existing = new Map(db.prepare('SELECT id, platform, dedupe_key, title, notes, region FROM physical_games WHERE user_id = ?').all(userId).map((g) => [g.platform + '\n' + g.dedupe_key, g]));
  let added = 0, updated = 0, unchanged = 0;
  for (const g of games) {
    const had = existing.get(g.platform + '\n' + g.key);
    if (!had) added++;
    else if ((g.notes && g.notes !== had.notes) || had.title !== g.title) updated++;
    else unchanged++;
  }
  const inFile = new Set(games.map((g) => g.platform + '\n' + g.key));
  const removing = replace ? [...existing.values()].filter((g) => platforms.includes(g.platform) && !inFile.has(g.platform + '\n' + g.dedupe_key)) : [];
  const byPlatform = {}; for (const g of games) byPlatform[g.platform] = (byPlatform[g.platform] || 0) + 1;

  if (apply) {
    const ins = db.prepare('INSERT INTO physical_games (user_id, platform, title, sort_title, dedupe_key, region, notes, release_year) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    // A filled cell updates the game; an empty one never wipes what is there (the year only fills a blank, so a matched year is not overwritten).
    const upd = db.prepare(`UPDATE physical_games SET title = ?, sort_title = ?, notes = COALESCE(?, notes), release_year = COALESCE(release_year, ?), updated_at = datetime('now') WHERE id = ?`);
    const del = db.prepare('DELETE FROM physical_games WHERE id = ? AND user_id = ?');
    db.transaction(() => {
      for (const g of games) {
        const had = existing.get(g.platform + '\n' + g.key);
        if (had) upd.run(g.title, sortTitle(g.title), g.notes, g.year, had.id);
        else ins.run(userId, g.platform, g.title, sortTitle(g.title), g.key, g.region, g.notes, g.year);
      }
      for (const g of removing) del.run(g.id, userId);
    })();
    startMatchJob();
  }
  return {
    applied: Boolean(apply), csv_rows: rows.length - 1, games: games.length, by_platform: byPlatform,
    added, updated, unchanged, removed: removing.length, duplicates, skipped, problems,
    sample: games.slice(0, 5).map((g) => ({ platform: g.platform, title: g.title, region: g.region }))
  };
}

/* ───────── the list ───────── */

const toGame = (r) => ({
  id: r.id, platform: r.platform, title: r.title, region: r.region, notes: r.notes, release_year: r.release_year, developer: r.developer, publisher: r.publisher,
  genre: r.genre, players: r.players, rating: r.rating, description: r.description, favourite: Boolean(r.favourite), matched: Boolean(r.meta_source), meta_source: r.meta_source,
  cover_url: r.cover_path ? `/api/physical/cover/${r.id}?v=${encodeURIComponent(r.updated_at || '')}` : null, has_cover: Boolean(r.cover_path), created_at: r.created_at,
  cover_ar: r.cover_ar || null, spine_ar: r.spine_ar || null,
  spine_url: r.spine_path ? `/api/physical/spine/${r.id}?v=${encodeURIComponent(r.updated_at || '')}` : null, has_spine: Boolean(r.spine_path)
});

const bucketOf = (t) => { const c = String(t || '').replace(/^(the|a|an)\s+/i, '').trim().charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; };

/** Pictures saved before their shapes were recorded: read the shape once and keep it. */
function backfillShapes(rows) {
  const setAr = db.prepare('UPDATE physical_games SET cover_ar = COALESCE(?, cover_ar), spine_ar = COALESCE(?, spine_ar) WHERE id = ?');
  for (const r of rows) {
    const c = r.cover_path && !r.cover_ar ? imageAspect(r.cover_path) : null, sp = r.spine_path && !r.spine_ar ? imageAspect(r.spine_path) : null;
    if (c || sp) { setAr.run(c, sp, r.id); if (c) r.cover_ar = c; if (sp) r.spine_ar = sp; }
  }
}

/** The person's games, filtered and sorted. platforms: [] = all. */
export function listPhysical(userId, { platforms = [], q = '', sort = 'title', favourites = false, nocover = false, unmatched = false, spine = false, letter = '' } = {}) {
  let rows = db.prepare('SELECT * FROM physical_games WHERE user_id = ?').all(userId);
  backfillShapes(rows);
  if (platforms.length) { const ps = new Set(platforms); rows = rows.filter((r) => ps.has(r.platform)); }
  if (favourites) rows = rows.filter((r) => r.favourite);
  if (nocover) rows = rows.filter((r) => !r.cover_path);
  if (unmatched) rows = rows.filter((r) => !r.meta_source);
  if (spine) rows = rows.filter((r) => r.spine_path);
  const terms = squash(q) ? String(q).toLowerCase().split(/\s+/).filter(Boolean) : [];
  if (terms.length) rows = rows.filter((r) => { const hay = [r.title, r.developer, r.publisher, r.genre, r.region, r.notes, r.platform].join(' ').toLowerCase(); return terms.every((t) => hay.includes(t)); });
  const letters = {}; for (const r of rows) { const b = bucketOf(r.title); letters[b] = (letters[b] || 0) + 1; }
  if (/^[A-Z#]$/.test(letter)) rows = rows.filter((r) => bucketOf(r.title) === letter);
  const cmp = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
  const by = {
    title: (a, b) => cmp(a.sort_title, b.sort_title),
    '-title': (a, b) => cmp(b.sort_title, a.sort_title),
    added: (a, b) => b.id - a.id,
    year: (a, b) => (a.release_year || 9999) - (b.release_year || 9999) || cmp(a.sort_title, b.sort_title),
    platform: (a, b) => cmp(a.platform, b.platform) || cmp(a.sort_title, b.sort_title)
  }[sort] || ((a, b) => cmp(a.sort_title, b.sort_title));
  rows.sort(by);
  return { items: rows.map(toGame), letters };
}

/** Per platform counts for the chips, with what the Library's platform table says about each (name, family, colour). */
export function physicalPlatforms(userId) {
  // Every spine picture's shape, by platform: the shelf sizes a kind of case from the whole shelf, so a game's size never depends on what is filtered.
  backfillShapes(db.prepare('SELECT id, cover_path, cover_ar, spine_path, spine_ar FROM physical_games WHERE user_id = ? AND ((cover_path IS NOT NULL AND cover_ar IS NULL) OR (spine_path IS NOT NULL AND spine_ar IS NULL))').all(userId));
  const ars = {};
  for (const r of db.prepare('SELECT platform, spine_ar FROM physical_games WHERE user_id = ? AND spine_ar IS NOT NULL').all(userId)) (ars[r.platform] ||= []).push(r.spine_ar);
  return db.prepare(`SELECT g.platform AS slug, COUNT(*) AS count, p.name, p.short_name, p.family, p.accent FROM physical_games g
    LEFT JOIN platforms p ON p.slug = g.platform WHERE g.user_id = ? GROUP BY g.platform`).all(userId)
    .map((r) => ({ ...r, name: r.name || r.slug, short_name: r.short_name || r.slug, spine_ars: ars[r.slug] || [] }));
}

export function physicalCounts(userId) {
  const r = db.prepare('SELECT COUNT(*) AS total, SUM(favourite) AS favourites, SUM(CASE WHEN cover_path IS NULL THEN 1 ELSE 0 END) AS nocover, SUM(CASE WHEN meta_source IS NULL THEN 1 ELSE 0 END) AS unmatched, SUM(CASE WHEN spine_path IS NULL THEN 0 ELSE 1 END) AS spines FROM physical_games WHERE user_id = ?').get(userId);
  return { total: r.total || 0, favourites: r.favourites || 0, nocover: r.nocover || 0, unmatched: r.unmatched || 0, spines: r.spines || 0 };
}

const own = (userId, id) => db.prepare('SELECT * FROM physical_games WHERE id = ? AND user_id = ?').get(Number(id), userId);
export function getPhysical(userId, id) {
  const r = own(userId, id);
  if (!r) throw Object.assign(new Error('That game is not on your shelf'), { status: 404 });
  const p = db.prepare('SELECT name, family, accent, short_name FROM platforms WHERE slug = ?').get(r.platform);
  return { ...toGame(r), platform_name: p?.name || r.platform, platform_short: p?.short_name || r.platform, platform_family: p?.family || null, platform_accent: p?.accent || null };
}

export function addPhysical(userId, { platform, title, region = '', notes = '', year = null }) {
  const slug = resolvePlatform(platform);
  if (!slug) throw Object.assign(new Error('Choose a platform from the list.'), { status: 400 });
  const t = clean(title);
  if (!appIdFor(t)) throw Object.assign(new Error('Type the game\'s title.'), { status: 400 });
  const key = dedupeKey(t, region);
  if (db.prepare('SELECT 1 FROM physical_games WHERE user_id = ? AND platform = ? AND dedupe_key = ?').get(userId, slug, key)) throw Object.assign(new Error('That game is already on your shelf for this platform (add a region or note to keep a second copy).'), { status: 409 });
  const y = Math.round(Number(year));
  const info = db.prepare('INSERT INTO physical_games (user_id, platform, title, sort_title, dedupe_key, region, notes, release_year) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, slug, t, sortTitle(t), key, clean(region, 40) || null, clean(notes, 300) || null, y >= 1950 && y <= 2100 ? y : null);
  startMatchJob();
  return getPhysical(userId, info.lastInsertRowid);
}

const EDITABLE = { title: 200, region: 40, notes: 300, developer: 200, publisher: 200, genre: 200, description: 4000 };
/** Edit what a person can change by hand: the fields above, the year, players, rating, favourite. A match from a provider fills the same fields. */
export function updatePhysical(userId, id, body = {}) {
  const r = own(userId, id);
  if (!r) throw Object.assign(new Error('That game is not on your shelf'), { status: 404 });
  const sets = [], vals = [];
  for (const [f, max] of Object.entries(EDITABLE)) {
    if (body[f] === undefined) continue;
    const v = clean(body[f], max) || null;
    if (f === 'title') { if (!v || !appIdFor(v)) throw Object.assign(new Error('The title cannot be empty.'), { status: 400 }); sets.push('title = ?', 'sort_title = ?'); vals.push(v, sortTitle(v)); }
    else { sets.push(`${f} = ?`); vals.push(v); }
  }
  const num = (f, lo, hi, round) => { if (body[f] === undefined) return; const n = body[f] === null || body[f] === '' ? null : Number(body[f]); if (n !== null && !(Number.isFinite(n) && n >= lo && n <= hi)) throw Object.assign(new Error(`${f.replace('_', ' ')} is out of range`), { status: 400 }); sets.push(`${f} = ?`); vals.push(n === null ? null : round ? Math.round(n) : n); };
  num('release_year', 1950, 2100, true); num('players', 1, 16, true); num('rating', 0, 5, false);
  if (body.favourite !== undefined) { sets.push('favourite = ?'); vals.push(body.favourite ? 1 : 0); }
  if (body.platform !== undefined) { const slug = resolvePlatform(body.platform); if (!slug) throw Object.assign(new Error('Choose a platform from the list.'), { status: 400 }); sets.push('platform = ?'); vals.push(slug); }
  if (sets.length) {
    // The duplicate key follows the title and region, so editing them cannot make two copies of one game look different.
    const next = { title: body.title !== undefined ? clean(body.title) : r.title, region: body.region !== undefined ? clean(body.region, 40) : r.region };
    sets.push('dedupe_key = ?'); vals.push(dedupeKey(next.title, next.region));
    sets.push("updated_at = datetime('now')");
    try { db.prepare(`UPDATE physical_games SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals, r.id, userId); }
    catch (err) { if (/UNIQUE/.test(err.message)) throw Object.assign(new Error('Another game on your shelf already has that title, region and platform.'), { status: 409 }); throw err; }
  }
  return getPhysical(userId, id);
}

export function removePhysical(userId, id) {
  const r = db.prepare('DELETE FROM physical_games WHERE id = ? AND user_id = ?').run(Number(id), userId);
  if (!r.changes) throw Object.assign(new Error('That game is not on your shelf'), { status: 404 });
  return { removed: true };   // the cached picture is shared by URL with anyone matched to the same game, so it stays on disk
}

export function physicalSpinePath(userId, id) {
  const f = own(userId, id)?.spine_path;
  return f && fs.existsSync(f) ? f : null;
}

export function physicalCoverPath(userId, id) {
  const f = own(userId, id)?.cover_path;
  return f && fs.existsSync(f) ? f : null;
}

/* ───────── details and covers ───────── */

/** Put a chosen provider record (the candidate the identify search returns, or what enrich() found) on a game. Blank fields keep what is there. */
export async function applyMatch(userId, id, cand, { cacheImpl = cacheMedia } = {}) {
  const r = own(userId, id);
  if (!r) throw Object.assign(new Error('That game is not on your shelf'), { status: 404 });
  const c = cand || {};
  const text = (v) => (typeof v === 'string' ? decodeEntities(v).trim() : v) || null;
  const url = c.cover_url || c.media?.box2d || null;
  let coverPath = null;
  if (url) { try { coverPath = await cacheImpl(url, 'box2d'); } catch { coverPath = null; } }
  const spineUrl = c.media?.spine || c.spine_url || null;
  let spinePath = null;
  if (spineUrl) { try { spinePath = await cacheImpl(spineUrl, 'spine'); } catch { spinePath = null; } }
  const yr = Math.round(Number(c.release_year)), pl = Math.round(Number(c.players)), rt = Number(c.rating);
  db.prepare(`UPDATE physical_games SET
      developer = COALESCE(?, developer), publisher = COALESCE(?, publisher), genre = COALESCE(?, genre), description = COALESCE(?, description),
      release_year = COALESCE(?, release_year), players = COALESCE(?, players), rating = COALESCE(?, rating),
      cover_url = COALESCE(?, cover_url), cover_path = COALESCE(?, cover_path), spine_url = COALESCE(?, spine_url), spine_path = COALESCE(?, spine_path),
      cover_ar = COALESCE(?, cover_ar), spine_ar = COALESCE(?, spine_ar),
      meta_source = ?, meta_synced_at = datetime('now'), meta_tried_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`)
    .run(text(c.developer), text(c.publisher), text(c.genre), text(c.description)?.slice(0, 4000) || null,
      yr >= 1950 && yr <= 2100 ? yr : null, pl >= 1 && pl <= 16 ? pl : null, Number.isFinite(rt) && c.rating !== null && c.rating !== '' && rt >= 0 && rt <= 5 ? rt : null,
      url, coverPath, spineUrl, spinePath, coverPath ? imageAspect(coverPath) : null, spinePath ? imageAspect(spinePath) : null, String(c.source || c.meta_source || 'manual').slice(0, 40), r.id, userId);
  return getPhysical(userId, id);
}

/** Forget a game's match (wrong cover or details) so it can be matched again. Title, platform, region and notes stay. */
export function clearMatch(userId, id) {
  const r = own(userId, id);
  if (!r) throw Object.assign(new Error('That game is not on your shelf'), { status: 404 });
  db.prepare(`UPDATE physical_games SET developer = NULL, publisher = NULL, genre = NULL, description = NULL, players = NULL, rating = NULL, cover_url = NULL, cover_path = NULL, spine_url = NULL, spine_path = NULL, spine_tried_at = NULL, cover_ar = NULL, spine_ar = NULL,
    meta_source = NULL, meta_synced_at = NULL, meta_tried_at = NULL, updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(r.id, userId);
  return getPhysical(userId, id);
}

const platformRow = (slug) => db.prepare('SELECT slug, name, family, screenscraper_id, tgdb_id FROM platforms WHERE slug = ?').get(slug) || { slug, name: slug };

/** The spine picture link for a game, from the local LaunchBox database (null when it is not downloaded, or the game has none). */
async function lookupSpineDefault(r) {
  if (!launchbox.enabled) return null;
  const lb = await launchbox.lookup({ title: r.title, platform: platformRow(r.platform), hashes: {}, filename: r.title, year: r.release_year || null });
  return lb?.media?.spine || null;
}

/** Look one game up with the Library's providers and keep the answer. A game nothing is found for is stamped as tried, so it is not asked again every run. */
export async function matchOne(userId, id, { enrichImpl = enrich, cacheImpl = cacheMedia, spineImpl = lookupSpineDefault } = {}) {
  const r = own(userId, id);
  if (!r) throw Object.assign(new Error('That game is not on your shelf'), { status: 404 });
  const meta = await enrichImpl({ title: r.title, platform: platformRow(r.platform), hashes: {}, filename: r.title, titleTrusted: true, year: r.release_year || null });
  if (!meta || meta.error) { db.prepare("UPDATE physical_games SET meta_tried_at = datetime('now') WHERE id = ?").run(r.id); return null; }
  // The provider that won may not be LaunchBox: ask it for the spine on its own.
  let spine = meta.media?.spine || null;
  if (!spine) { try { spine = await spineImpl(r); } catch { spine = null; } }
  const game = await applyMatch(userId, id, { ...meta, media: { ...(meta.media || {}), ...(spine ? { spine } : {}) }, source: meta.source || 'provider' }, { cacheImpl });
  if (launchbox.enabled || spine) db.prepare("UPDATE physical_games SET spine_tried_at = datetime('now') WHERE id = ?").run(r.id);
  return game;
}

/** Only the spine, for a game that is already matched: its details (which may have been edited by hand) are left exactly as they are. */
export async function fetchSpine(userId, id, { cacheImpl = cacheMedia, spineImpl = lookupSpineDefault } = {}) {
  const r = own(userId, id);
  if (!r) throw Object.assign(new Error('That game is not on your shelf'), { status: 404 });
  let url = null; try { url = await spineImpl(r); } catch { url = null; }
  let file = null; if (url) { try { file = await cacheImpl(url, 'spine'); } catch { file = null; } }
  db.prepare("UPDATE physical_games SET spine_url = COALESCE(?, spine_url), spine_path = COALESCE(?, spine_path), spine_ar = COALESCE(?, spine_ar), spine_tried_at = datetime('now'), updated_at = CASE WHEN ? IS NULL THEN updated_at ELSE datetime('now') END WHERE id = ?").run(url, file, file ? imageAspect(file) : null, file, r.id);
  return Boolean(file);
}

/* One background run at a time looks up every game (anyone's) that has no match yet. With retry: true, games tried before are asked again too
   (for example after adding a provider key). */
const job = { running: false, total: 0, done: 0, found: 0, again: false, retry: false };
export const matchJobStatus = () => ({ running: job.running, total: job.total, done: job.done, found: job.found });
// Games with no match yet, and (when the LaunchBox database is there) matched games that have no spine picture yet.
const pending = (retry) => db.prepare(`SELECT id, user_id, meta_source IS NOT NULL AS matched FROM physical_games
  WHERE (meta_source IS NULL${retry ? '' : ' AND meta_tried_at IS NULL'}) OR (? = 1 AND spine_path IS NULL${retry ? '' : ' AND spine_tried_at IS NULL'}) ORDER BY id`).all(launchbox.enabled ? 1 : 0);

export function startMatchJob({ retry = false, enrichImpl, cacheImpl, spineImpl } = {}) {
  if (job.running) { job.again = true; job.retry = job.retry || retry; return matchJobStatus(); }
  const todo = pending(retry);
  if (!todo.length) return matchJobStatus();
  Object.assign(job, { running: true, total: todo.length, done: 0, found: 0, again: false, retry: false });
  (async () => {
    try {
      let list = todo;
      while (list.length) {
        for (const g of list) {
          try {
            if (g.matched) { if (await fetchSpine(g.user_id, g.id, { cacheImpl, spineImpl })) job.found++; }
            else if (await matchOne(g.user_id, g.id, { enrichImpl, cacheImpl, spineImpl })) job.found++;
          } catch { /* one game must not stop the run */ }
          job.done++;
        }
        list = job.again ? pending(job.retry) : [];
        job.total += list.length; job.again = false; job.retry = false;
      }
    } finally { job.running = false; }
  })();
  return matchJobStatus();
}

/** For tests: wait for the background run to finish. */
export async function matchJobIdle(timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (job.running && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
}
