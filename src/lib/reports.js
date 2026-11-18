// Admin Reports: the whole collection (ROM Library, Physical shelves and Digital lists) counted together. Read-only, straight from the database.
// A game on a shelf or in a Digital list that several accounts have is counted once. Nothing here is secret: it is all counts and names.
import db from '../db.js';
import { platformLabel, CONSOLE_PLATFORMS } from './consoles.js';

const thisYear = () => new Date().getFullYear();
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const yearOf = (v) => { const y = Number(/\b(19[5-9]\d|20\d\d)\b/.exec(String(v ?? ''))?.[1]); return y && y <= thisYear() + 1 ? y : null; };
const splitGenres = (s) => clean(s).split(/[,;|]/).map(clean).filter(Boolean).slice(0, 4);
const has = (v) => clean(v).length > 0;

/** Every game of every library as one list of { kind, platform, slug, genres, year, cover, desc }. */
function gather() {
  const plats = db.prepare('SELECT slug, name, generation FROM platforms').all();
  const bySlug = new Map(plats.map((p) => [p.name, p.slug])), genOf = new Map(plats.map((p) => [p.slug, p.generation || null]));
  const out = [];
  for (const r of db.prepare(`SELECT p.name AS platform, p.generation AS gen, r.title, r.genre, r.release_year AS year, r.cover_path, r.description
      FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.is_system = 0 AND r.hidden_all = 0`).all()) {
    out.push({ kind: 'roms', title: r.title, gen: r.gen || null, platform: r.platform, slug: bySlug.get(r.platform) || null, genres: splitGenres(r.genre), year: yearOf(r.year), cover: has(r.cover_path), desc: has(r.description) });
  }
  for (const r of db.prepare(`SELECT COALESCE(p.name, g.platform) AS platform, g.platform AS slug, g.title, g.genre, g.release_year AS year, g.cover_path, g.description
      FROM physical_games g LEFT JOIN platforms p ON p.slug = g.platform WHERE g.hidden = 0 GROUP BY g.platform, g.dedupe_key`).all()) {
    out.push({ kind: 'physical', title: r.title, gen: genOf.get(r.slug) || null, platform: r.platform, slug: r.slug, genres: splitGenres(r.genre), year: yearOf(r.year), cover: has(r.cover_path), desc: has(r.description) });
  }
  for (const r of db.prepare(`SELECT g.store, g.platform, g.name, dd.json, dd.cover_path FROM digital_games g
      LEFT JOIN digital_details dd ON dd.store = g.store AND dd.app_id = g.app_id GROUP BY g.store, g.app_id`).all()) {
    let d = {}; try { d = JSON.parse(r.json || '{}') || {}; } catch { d = {}; }
    const steam = r.store === 'steam';
    const cp = CONSOLE_PLATFORMS[r.platform], slug = cp && cp.store === r.store ? cp.meta?.[0] : (r.store === 'xbox' ? 'xbox' : null);
    out.push({ kind: 'digital', title: r.name, gen: steam ? null : (genOf.get(slug) || null), platform: steam ? 'Steam (PC)' : platformLabel(r.store, r.platform), slug: null, genres: (Array.isArray(d.genres) ? d.genres : []).map(clean).filter(Boolean).slice(0, 4),
      year: yearOf(d.release), cover: steam || has(r.cover_path), desc: steam || has(d.description) });
  }
  return out;
}

/** The same game under different names of one title: lower case, no (region) or [tag] text, no accents, no "the", only letters and digits. */
export function titleKey(title) {
  return clean(title).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[([][^)\]]*[)\]]/g, ' ').replace(/&/g, ' and ')
    .replace(/\b(the|a|an)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/ +/g, ' ');
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
    const p = e.plats.get(g.platform) || new Set(); p.add(g.kind); e.plats.set(g.platform, p);
    groups.set(key, e);
  }
  const list = [];
  for (const e of groups.values()) {
    if (e.plats.size < 2) continue;
    const title = [...e.names].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
    list.push({ title: clean(title), gen: e.gen, platforms: [...e.plats].map(([name, kinds]) => ({ name, kinds: [...kinds].sort() })).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  list.sort((a, b) => a.gen - b.gen || b.platforms.length - a.platforms.length || a.title.localeCompare(b.title));
  const byGen = new Map();
  for (const x of list) byGen.set(x.gen, (byGen.get(x.gen) || 0) + 1);
  return { total: list.length, by_generation: [...byGen].map(([gen, count]) => ({ gen, count })).sort((a, b) => a.gen - b.gen), groups: list.slice(0, 1000) };
}

const ranked = (map, limit = 60) => [...map].map(([label, v]) => ({ label, ...(typeof v === 'number' ? { count: v } : v) })).sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label))).slice(0, limit);

export function collectReports() {
  const games = gather();
  const split = { roms: 0, physical: 0, digital: 0 };
  const plat = new Map(), genre = new Map(), year = new Map(), comp = new Map();
  for (const g of games) {
    split[g.kind]++;
    const p = plat.get(g.platform) || { count: 0, slug: g.slug, roms: 0, physical: 0, digital: 0 };
    p.count++; p[g.kind]++; if (!p.slug && g.slug) p.slug = g.slug; plat.set(g.platform, p);
    for (const x of g.genres) genre.set(x, (genre.get(x) || 0) + 1);
    if (g.year) year.set(String(g.year), (year.get(String(g.year)) || 0) + 1);
    const c = comp.get(g.platform) || { count: 0, complete: 0, no_cover: 0, no_desc: 0, neither: 0 };
    c.count++;
    if (g.cover && g.desc) c.complete++; else if (!g.cover && g.desc) c.no_cover++; else if (g.cover && !g.desc) c.no_desc++; else c.neither++;
    comp.set(g.platform, c);
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
