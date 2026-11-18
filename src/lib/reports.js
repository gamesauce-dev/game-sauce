// Admin Reports: the whole collection (ROM Library, Physical shelves and Digital lists) counted together. Read-only, straight from the database.
// A game on a shelf or in a Digital list that several accounts have is counted once. Nothing here is secret: it is all counts and names.
import db from '../db.js';
import { platformLabel, CONSOLE_PLATFORMS } from './consoles.js';

const thisYear = () => new Date().getFullYear();
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const yearOf = (v) => { const y = Number(/\b(19[5-9]\d|20\d\d)\b/.exec(String(v ?? ''))?.[1]); return y && y <= thisYear() + 1 ? y : null; };
const splitGenres = (s) => clean(s).split(/[,;|]/).map(clean).filter(Boolean).slice(0, 4);
const has = (v) => clean(v).length > 0;

const normName = (n) => clean(n).toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Every game of every library as one list of { kind, title, platform, pkey, slug, gen, genres, year, cover, desc }.
 *  A platform is one thing whichever library it comes from: Digital's "Xbox 360" and the Library's "XBOX 360" share a pkey (the squashed name),
 *  and a Digital console is shown under the Library platform's own name. */
function gather() {
  const plats = db.prepare('SELECT slug, name, generation FROM platforms').all();
  const nameOf = new Map(plats.map((p) => [p.slug, p.name])), genOf = new Map(plats.map((p) => [p.slug, p.generation || null]));
  const out = [];
  const add = (kind, title, slug, label, gen, r) => out.push({ kind, title, slug, platform: label, pkey: normName(label) || slug || 'unknown', gen: gen || null,
    genres: r.genres, year: r.year, cover: r.cover, desc: r.desc });
  for (const r of db.prepare(`SELECT p.slug, p.name AS platform, r.title, r.genre, r.release_year AS year, r.cover_path, r.description
      FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.is_system = 0 AND r.hidden_all = 0`).all()) {
    add('roms', r.title, r.slug, r.platform, genOf.get(r.slug), { genres: splitGenres(r.genre), year: yearOf(r.year), cover: has(r.cover_path), desc: has(r.description) });
  }
  for (const r of db.prepare(`SELECT g.platform AS slug, g.title, g.genre, g.release_year AS year, g.cover_path, g.description
      FROM physical_games g WHERE g.hidden = 0 GROUP BY g.platform, g.dedupe_key`).all()) {
    add('physical', r.title, r.slug, nameOf.get(r.slug) || r.slug, genOf.get(r.slug), { genres: splitGenres(r.genre), year: yearOf(r.year), cover: has(r.cover_path), desc: has(r.description) });
  }
  for (const r of db.prepare(`SELECT g.store, g.platform, g.name, dd.json, dd.cover_path FROM digital_games g
      LEFT JOIN digital_details dd ON dd.store = g.store AND dd.app_id = g.app_id GROUP BY g.store, g.app_id`).all()) {
    let d = {}; try { d = JSON.parse(r.json || '{}') || {}; } catch { d = {}; }
    const rest = { genres: (Array.isArray(d.genres) ? d.genres : []).map(clean).filter(Boolean).slice(0, 4), year: yearOf(d.release) };
    if (r.store === 'steam') { add('digital', r.name, null, 'Steam (PC)', null, { ...rest, cover: true, desc: true }); continue; }
    const cp = CONSOLE_PLATFORMS[r.platform], slug = cp && cp.store === r.store ? cp.meta?.[0] : (r.store === 'xbox' ? 'xbox' : null);
    add('digital', r.name, slug, (slug && nameOf.get(slug)) || platformLabel(r.store, r.platform), genOf.get(slug), { ...rest, cover: has(r.cover_path), desc: has(d.description) });
  }
  return out;
}

/** The same game under different names of one title: lower case, no (region) or [tag] text, no accents, no "the", only letters and digits. */
export function titleKey(title) {
  return clean(title).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[([][^)\]]*[)\]]/g, ' ').replace(/&/g, ' and ')
    .replace(/\b(standard|deluxe|gold|ultimate|premium|special|digital|complete|anniversary|launch|day one|game of the year|goty)( edition)?\b/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/ +/g, ' ');
}

/** Games that appear on more than one platform of the same console generation (Prince of Persia on GameCube, PS2 and Xbox). Information only. */
function crossPlatform(games) {
  const groups = new Map();
  for (const g of games) {
    if (!g.gen || !g.title) continue;
    const key = g.gen + '|' + titleKey(g.title);
    if (key.endsWith('|')) continue;
    const e = groups.get(key) || { gen: g.gen, names: new Map(), plats: new Map() };
    e.names.set(g.title, (e.names.get(g.title) || 0) + 1);
    const p = e.plats.get(g.pkey) || { name: g.platform, kinds: new Set() }; p.kinds.add(g.kind); e.plats.set(g.pkey, p);
    groups.set(key, e);
  }
  const list = [];
  for (const e of groups.values()) {
    if (e.plats.size < 2) continue;
    const title = [...e.names].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
    list.push({ title: clean(title), gen: e.gen, platforms: [...e.plats.values()].map((p) => ({ name: p.name, kinds: [...p.kinds].sort() })).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  list.sort((a, b) => a.gen - b.gen || b.platforms.length - a.platforms.length || a.title.localeCompare(b.title));
  const byGen = new Map();
  for (const x of list) byGen.set(x.gen, (byGen.get(x.gen) || 0) + 1);
  return { total: list.length, by_generation: [...byGen].map(([gen, count]) => ({ gen, count })).sort((a, b) => a.gen - b.gen), groups: list.slice(0, 20000) };
}

/** "Why is this game not in the list?": every game whose title contains the words, with its platform, console generation, which library it is in, and
 *  how many other platforms of that generation hold the same game. */
export function findTitle(q) {
  const needle = titleKey(q);
  if (needle.length < 2) return [];
  const games = gather(), seen = new Map();
  for (const g of games) { if (!g.gen) continue; const k = g.gen + '|' + titleKey(g.title); (seen.get(k) || seen.set(k, new Set()).get(k)).add(g.pkey); }
  return games.filter((g) => titleKey(g.title).includes(needle)).slice(0, 80).map((g) => ({
    title: clean(g.title), kind: g.kind, platform: g.platform, gen: g.gen,
    same_generation: g.gen ? Math.max(0, (seen.get(g.gen + '|' + titleKey(g.title))?.size || 1) - 1) : null
  })).sort((a, b) => a.title.localeCompare(b.title) || a.platform.localeCompare(b.platform));
}

const ranked = (map, limit = 60) => [...map].map(([label, v]) => ({ label, ...(typeof v === 'number' ? { count: v } : v) })).sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label))).slice(0, limit);

export function collectReports() {
  const games = gather();
  const split = { roms: 0, physical: 0, digital: 0 };
  const plat = new Map(), genre = new Map(), year = new Map(), comp = new Map();
  for (const g of games) {
    split[g.kind]++;
    const p = plat.get(g.pkey) || { label: g.platform, count: 0, slug: g.slug, roms: 0, physical: 0, digital: 0 };
    p.count++; p[g.kind]++; if (!p.slug && g.slug) p.slug = g.slug; plat.set(g.pkey, p);
    for (const x of g.genres) genre.set(x, (genre.get(x) || 0) + 1);
    if (g.year) year.set(String(g.year), (year.get(String(g.year)) || 0) + 1);
    const c = comp.get(g.pkey) || { label: g.platform, count: 0, complete: 0, no_cover: 0, no_desc: 0, neither: 0 };
    c.count++;
    if (g.cover && g.desc) c.complete++; else if (!g.cover && g.desc) c.no_cover++; else if (g.cover && !g.desc) c.no_desc++; else c.neither++;
    comp.set(g.pkey, c);
  }
  const total = games.length;
  const withCover = games.filter((g) => g.cover).length, complete = games.filter((g) => g.cover && g.desc).length;
  const years = ranked(year, 200);
  return {
    generated: new Date().toISOString(),
    totals: { all: total, ...split, with_cover: withCover, complete, platforms: plat.size },
    platforms: ranked(plat),
    genres: ranked(genre),
    years,
    completeness: ranked(comp, 14),
    cross_platform: crossPlatform(games)
  };
}

/** One row per day with the headline counts, so trends can be drawn from the day this started. At most one write a day (the first request or the daily tick). */
export function recordSnapshot(rep = null) {
  const day = new Date().toISOString().slice(0, 10);
  if (db.prepare('SELECT 1 FROM report_snapshots WHERE day = ?').get(day)) return false;
  const t = (rep || collectReports()).totals;
  db.prepare('INSERT OR IGNORE INTO report_snapshots (day, json) VALUES (?, ?)').run(day, JSON.stringify(t));
  return true;
}

export function listSnapshots(days = 365) {
  return db.prepare('SELECT day, json FROM report_snapshots ORDER BY day DESC LIMIT ?').all(days).reverse().map((r) => { let t = {}; try { t = JSON.parse(r.json); } catch { /* skip */ } return { day: r.day, ...t }; });
}

export function startSnapshotTimer(everyMs = 6 * 3600 * 1000) {
  const go = () => { try { recordSnapshot(); } catch { /* the next tick tries again */ } };
  setTimeout(go, 60_000).unref();
  setInterval(go, everyMs).unref();
}
