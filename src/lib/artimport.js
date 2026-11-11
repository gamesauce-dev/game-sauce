// Bring in pictures and manuals you already have on disk (a LaunchBox "Images" folder, a RetroBat "roms" folder) for the games on your Physical shelf, and covers for your
// Digital console games. The server reads them from folders an admin has listed (Settings > Artwork folders): nothing outside those folders can ever be read.
//
// What is recognised (by where a file sits and what it is called; nothing is read until it is used):
//   LaunchBox   <platform>/box - front/[region/]<title>-01.png    -> cover      (also "box - front - reconstructed", used only when there is no plain front)
//               <platform>/box - spine/[region/]<title>-01.png    -> spine
//               <platform>/disc/[region/]<title>-01.png           -> disc       (disc games only)
//   RetroBat    <system>/images/<rom name>-thumb.png              -> cover      (-image, -marquee ... are not box art and are left alone)
//               <system>/manuals/<rom name>-manual.pdf            -> manual     (Physical only)
//   Full wrap   a picture with the back, the spine and the front side by side (a folder called wrap, fullcover, full box...): cut into a cover and a spine at the fractions the person
//               sets once per platform on a sample (src/lib/wrapcut.js). A real cover or spine picture always beats one cut from a wrap, and a wrap whose shape differs from the
//               platform's usual one is not cut but listed to check.
//   Picked      the person says what the folder holds (covers, spines, discs or manuals) and, if they like, which platform: then every picture in it is that kind,
//               whatever the folders are called (the platform is otherwise the nearest folder name that is one).
//   Simple      <platform>/<kind folder>/[region/]<title ...>.png     the layout of most media packs (EmuMovies and others): the folder with the platform's name, a folder for
//               each kind of picture (images, covers, box, front = cover; spines, spine = spine; discs, disc, cd = disc; manuals = manual), and optionally a region folder.
//               Anything after the title in the file name ("(USA, Europe) (En,Fr)") is dropped; or the person says where the title ends ("cut at": a piece of text such as " (" or " - ").
// A file is matched to a game by its platform (the folder name) and its title (letters and numbers only: "Marvel_ Ultimate Alliance 2" finds "Marvel: Ultimate Alliance 2";
// anything in (brackets) or [square brackets] is ignored, and so is a trailing -01). Where one game has pictures for several regions, the game's own region decides.
// Only gaps are filled by default; a picture the person uploaded themselves is never replaced.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import db from '../db.js';
import { resolvePlatform, setPhysicalArt, setManualFile, isDiscPlatform, imageAspect } from './physical.js';
import { splitWrap, splitFor } from './wrapcut.js';
import { setConsoleCover, CONSOLE_PLATFORMS } from './consoles.js';
import { MAX_MANUAL_BYTES } from './manuals.js';
import { MAX_COVER_BYTES } from './coverzip.js';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_DEPTH = 6, MAX_FILES = 400000;

/* ───────── the folders the importer may read ───────── */

const metaGet = (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null;
export function getArtFolders() {
  try { const v = JSON.parse(metaGet('art_folders') || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
export const folderState = () => getArtFolders().map((p) => { let ok = false; try { ok = fs.statSync(p).isDirectory(); } catch { /* not there */ } return { path: p, exists: ok }; });

/** Save the list (admin). Each must be an absolute path to a folder that exists on the server. Returns { folders } or throws a 400 naming the first bad one. */
export function setArtFolders(list) {
  const out = [], saved = new Set(getArtFolders());
  for (const raw of Array.isArray(list) ? list : []) {
    let p = String(raw || '').trim();
    if (p.length > 3) p = p.replace(/[\\/]+$/, '');   // D:\Art\ and D:\Art are the same; D:\ stays as it is
    if (!p) continue;
    // A folder already on the list stays as it is, even when it cannot be reached right now (a drive that is off, a path from another computer): only a newly added one is checked.
    // Otherwise one stale entry would stop every other folder from being added or removed.
    if (saved.has(p)) { if (!out.includes(p)) out.push(p); continue; }
    if (!path.isAbsolute(p)) throw Object.assign(new Error(`"${p.slice(0, 80)}" is not a full path (it must start with / or a drive letter such as D:\\).`), { status: 400 });
    let ok = false; try { ok = fs.statSync(p).isDirectory(); } catch { /* missing */ }
    if (!ok) throw Object.assign(new Error(`"${p.slice(0, 80)}" is not a folder this server can see.`), { status: 400 });
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > 10) throw Object.assign(new Error('Ten folders at most.'), { status: 400 });
  db.prepare("INSERT INTO meta (key, value) VALUES ('art_folders', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(out));
  scanCache.clear();
  return { folders: folderState() };
}

/* ───────── reading names ───────── */

const squash = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
/** The key a title is matched on: letters and numbers only, with anything in brackets left out. */
export const titleKey = (t) => squash(String(t || '').replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' '));

/** Folder names (letters and numbers only, lower case) that say what kind of picture is inside. */
const SIMPLE_KIND = {
  wrap: ['wrap', 'wraps', 'fullwrap', 'fullcover', 'fullcovers', 'fullbox', 'fullboxart', 'fullcoverart', 'coversfull', 'coverfull', 'boxfull', 'full'],
  cover: ['images', 'image', 'covers', 'cover', 'box', 'boxes', 'boxart', 'boxfront', 'front', 'frontcover', '2dbox', '2dboxart', 'thumbs', 'thumbnails'],
  spine: ['spines', 'spine', 'boxspine', 'boxspines', 'sides'],
  back: ['backs', 'back', 'backcover', 'backcovers', 'boxback', 'boxbacks', 'rear'],
  disc: ['discs', 'disc', 'cds', 'cd', 'media', 'discart', 'cdart', 'cartridges', 'cartridge', 'carts', 'cart', 'cartfront'],
  manual: ['manuals', 'manual']
};
const SIMPLE_LOOKUP = new Map(Object.entries(SIMPLE_KIND).flatMap(([kind, names]) => names.map((n) => [n, kind])));
/** Not box art: the extra pictures a RetroBat or media pack puts next to the cover. */
const NOT_COVER = /-(image|marquee|video|fanart|screenshot|titleshot|logo|wheel|map|mix|bezel|thumb)$/i;

const LB_KIND = { 'box - front': 'cover', 'box - front - reconstructed': 'cover', 'box - back': 'back', 'box - spine': 'spine', disc: 'disc', 'cart - front': 'disc' };
const REGION_GROUP = {
  eu: ['europe', 'united kingdom', 'australia', 'france', 'germany', 'spain', 'italy', 'netherlands', 'scandinavia', 'new zealand', 'russia'],
  na: ['north america', 'united states', 'canada'],
  jp: ['japan', 'asia', 'korea', 'china', 'hong kong', 'taiwan'],
  world: ['world']
};
const folderGroup = (name) => {
  const n = String(name || '').toLowerCase();
  return Object.keys(REGION_GROUP).find((g) => REGION_GROUP[g].includes(n)) || (/ntsc-?u|\busa\b|north america|canada/.test(n) ? 'na' : /ntsc-?j|japan|asia|korea/.test(n) ? 'jp' : /\bpal\b|europe|\buk\b|australia/.test(n) ? 'eu' : /world/.test(n) ? 'world' : null);
};
const gameGroup = (region) => {
  const r = String(region || '').toLowerCase();
  if (/ntsc-?u|\bus\b|usa|north america|canada/.test(r)) return 'na';
  if (/ntsc-?j|\bjp\b|japan|asia|korea/.test(r)) return 'jp';
  if (/pal|\beu\b|\buk\b|europe|aus|\bau\b/.test(r)) return 'eu';
  return null;
};
/** Lower is better: the game's own region, then World, then a file with no region, then the usual order. */
export function regionRank(game, folderRegion) {
  const fg = folderGroup(folderRegion), gg = gameGroup(game);
  if (fg && gg && fg === gg) return 0;
  if (fg === 'world') return 1;
  if (!folderRegion || !fg) return 2;
  return { na: 3, eu: 4, jp: 5 }[fg] ?? 6;
}

/** Work out what a file is from where it sits (segments are the folder names under the chosen folder, lower case). null when it is nothing we use. */
export function classify(segs, fileName) {
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '', base = dot >= 0 ? fileName.slice(0, dot) : fileName;
  const t = segs.findIndex((s) => s in LB_KIND);
  if (t >= 1 && IMAGE_EXT.has(ext)) {
    const num = /-(\d{1,3})$/.exec(base);
    return { layout: 'launchbox', folder: segs[t], kind: LB_KIND[segs[t]], platform: segs[t - 1], region: segs[t + 1] || '', title: base.replace(/-\d{1,3}$/, ''), n: num ? Number(num[1]) : 1, weak: segs[t] === 'box - front - reconstructed' };
  }
  const img = segs.lastIndexOf('images');
  if (img >= 1 && IMAGE_EXT.has(ext) && /-thumb$/i.test(base)) return { layout: 'retrobat', folder: 'images', kind: 'cover', platform: segs[img - 1], region: '', title: base.replace(/-thumb$/i, ''), n: 1, weak: false };
  const man = segs.lastIndexOf('manuals');
  if (man >= 1 && ext === '.pdf') return { layout: 'retrobat', folder: 'manuals', kind: 'manual', platform: segs[man - 1], region: '', title: base.replace(/-manual$/i, ''), n: 1, weak: false };
  // The simple layout: the folder under the platform's says the kind of picture; a folder under that, if any, is the region.
  for (let i = segs.length - 1; i >= 1; i--) {
    const kind = SIMPLE_LOOKUP.get(squash(segs[i]));
    if (!kind) continue;
    if (kind === 'manual' ? ext !== '.pdf' : !IMAGE_EXT.has(ext)) return null;
    if (kind !== 'manual' && NOT_COVER.test(base)) return null;
    const bracket = /\(([^)]*)\)/.exec(base);
    return { layout: 'simple', folder: segs[i], kind, platform: segs[i - 1], region: segs[i + 1] || '', fileRegion: bracket ? bracket[1] : '', title: base, n: 1, weak: false };
  }
  return null;
}

/** The person said what the folder holds (and maybe which platform): every picture (or PDF, for manuals) in it is that kind, whatever the folders are called. `platforms`: the folder names, nearest first, tried until one is a platform. */
function forcedEntry(segs, fileName, force) {
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '', base = dot >= 0 ? fileName.slice(0, dot) : fileName;
  if (force.kind === 'manual' ? ext !== '.pdf' : !IMAGE_EXT.has(ext)) return null;
  const bracket = /\(([^)]*)\)/.exec(base);
  return { layout: 'picked', folder: segs[segs.length - 1] || '', kind: force.kind, platform: force.platform || '', platforms: force.platform ? [] : [...segs].reverse(), region: '', fileRegion: bracket ? bracket[1] : '', title: base, n: 1, weak: false };
}

/** The title part of a file name: everything before the first `cut` (when the person gave one), with a trailing -01 left for titleKey to ignore. */
export function cutTitle(title, cut) {
  const t = String(title || ''), c = String(cut || '');
  if (!c) return t;
  const i = t.toLowerCase().indexOf(c.toLowerCase());
  return i > 0 ? t.slice(0, i) : t;
}

/* ───────── scanning a folder ───────── */

const scanCache = new Map();   // folder -> { at, result }
const CACHE_MS = 5 * 60 * 1000;

async function walk(root, force = null) {
  const files = []; let scanned = 0;
  const ignored = new Map(), links = [];   // folders with pictures nobody could place, and links that were not followed
  const go = async (dir, depth, segs) => {
    if (depth > MAX_DEPTH || scanned > MAX_FILES) return;
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name.startsWith('.')) continue;
      if (it.isSymbolicLink()) { if (links.length < 20) links.push(segs.slice(1).concat(it.name).join(' / ')); continue; }   // never follow a link out of the folder
      if (it.isDirectory()) await go(path.join(dir, it.name), depth + 1, [...segs, it.name.toLowerCase()]);
      else if (it.isFile()) { scanned++; const c = force?.kind ? forcedEntry(segs, it.name, force) : classify(segs, it.name); if (c) files.push({ ...c, file: path.join(dir, it.name) }); else { const x = path.extname(it.name).toLowerCase(); if (IMAGE_EXT.has(x) || x === '.pdf') { const k = segs.slice(-2).join(' / '); ignored.set(k, (ignored.get(k) || 0) + 1); } } }
    }
  };
  await go(root, 0, [path.basename(root).toLowerCase()]);   // the chosen folder's own name counts too (so a platform folder can be chosen on its own)
  return { files, scanned, ignored: [...ignored].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([folder, count]) => ({ folder, count })), links };
}

/** Everything useful under one of the listed folders. Remembered for a few minutes so a preview and the import that follows do not scan twice. */
export async function scanArtFolder(folder, { fresh = false, force = null } = {}) {
  const listed = getArtFolders().find((f) => f === folder);
  if (!listed) throw Object.assign(new Error('Choose one of the artwork folders the admin has listed.'), { status: 400 });
  const ckey = `${listed}\n${force?.kind || ''}\n${force?.platform || ''}`;
  const hit = scanCache.get(ckey);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  let ok = false; try { ok = (await fsp.stat(listed)).isDirectory(); } catch { /* missing */ }
  if (!ok) throw Object.assign(new Error('That folder is not available on the server right now.'), { status: 400 });
  const { files, scanned, ignored, links } = await walk(listed, force);
  const result = { files, scanned, ignored, links };
  scanCache.set(ckey, { at: Date.now(), result });
  return result;
}

/* ───────── matching to a person's games ───────── */

const hasFile = (p) => { try { return Boolean(p) && fs.existsSync(p); } catch { return false; } };

function physicalGames(userId) {
  return db.prepare('SELECT id, platform, title, region, cover_path, cover_locked, spine_path, spine_locked, disc_path, disc_locked, manual_path, manual_link, back_path, back_locked FROM physical_games WHERE user_id = ?').all(userId);
}
function digitalGames(userId) {
  const rows = db.prepare("SELECT g.store, g.app_id, g.name AS title, g.platform, g.country AS region, um.cover_path AS own, dd.cover_path AS shared FROM digital_games g LEFT JOIN digital_user_meta um ON um.user_id = g.user_id AND um.store = g.store AND um.app_id = g.app_id LEFT JOIN digital_details dd ON dd.store = g.store AND dd.app_id = g.app_id WHERE g.user_id = ? AND g.store != 'steam'").all(userId);
  return rows.map((r) => ({ ...r, lib: CONSOLE_PLATFORMS[r.platform]?.meta?.[0] || r.platform }));
}

/** The best file for each (game, kind). `target`: 'physical' (cover, spine, disc, manual) or 'digital' (covers of console games). Nothing is changed. */
export function planArtImport(userId, scan, { target = 'physical', replace = false, cut = '', split = {} } = {}) {
  const wanted = target === 'digital' ? new Set(['cover']) : new Set(['cover', 'spine', 'disc', 'manual', 'wrap', 'back']);
  const games = target === 'digital' ? digitalGames(userId) : physicalGames(userId);
  const slugOf = (g) => (target === 'digital' ? g.lib : g.platform);
  const byKey = new Map();
  for (const g of games) { const k = `${slugOf(g)}\n${titleKey(g.title)}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(g); }

  const platCache = new Map(); const platOf = (name) => { if (!platCache.has(name)) platCache.set(name, resolvePlatform(name)); return platCache.get(name); };
  const unknownPlatforms = new Map(); const unmatched = [], unmatchedPer = {}; let unmatchedTotal = 0;
  const best = new Map();   // `${gameKey}|${kind}` -> { game, kind, entry, rank }
  const candidatesSeen = { cover: 0, spine: 0, disc: 0, manual: 0, back: 0, wrap: 0 };
  for (const e of scan.files) {
    if (!wanted.has(e.kind)) continue;
    const slug = e.platforms?.length ? (e.platforms.map(platOf).find(Boolean) || null) : platOf(e.platform);
    if (!slug) { const nm = e.platforms?.length ? (e.platforms[0] || '(no folder)') : e.platform; unknownPlatforms.set(nm, (unknownPlatforms.get(nm) || 0) + 1); continue; }
    if (e.kind === 'disc' && !isDiscPlatform(slug)) continue;
    candidatesSeen[e.kind]++;
    const list = byKey.get(`${slug}\n${titleKey(cutTitle(e.title, cut))}`);
    if (!list) { unmatchedTotal++; unmatchedPer[e.kind] = (unmatchedPer[e.kind] || 0) + 1; if (unmatchedPer[e.kind] <= 6) unmatched.push({ kind: e.kind, platform: slug, title: e.title }); continue; }   // a few of each kind, so every kind shows
    for (const g of list) for (const k of e.kind === 'wrap' ? ['cover', 'spine', 'back'] : [e.kind]) {   // a wrap gives all three
      const id = target === 'digital' ? `${g.store}/${g.app_id}` : g.id;
      const key = `${id}|${k}`;
      const rank = (e.kind === 'wrap' ? 1000 : 0) + (e.weak ? 20 : 0) + regionRank(g.region, e.region || e.fileRegion) * 100 + (e.n || 1);   // a real cover or spine beats one cut from a wrap
      const cur = best.get(key);
      if (!cur || rank < cur.rank) best.set(key, { game: g, id, kind: k, entry: e, rank, slug, fromWrap: e.kind === 'wrap' });
    }
  }

  // Wraps: a platform's pack uses one template, so a wrap whose shape is far from the rest of its platform is left alone and listed (it needs its own look).
  const perSlug = new Map();
  for (const b of best.values()) if (b.fromWrap) { if (!perSlug.has(b.slug)) perSlug.set(b.slug, new Map()); if (!perSlug.get(b.slug).has(b.entry)) perSlug.get(b.slug).set(b.entry, imageAspect(b.entry.file) || 0); }
  const median = (a) => { const s = [...a].filter(Boolean).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const oddEntries = new Map(), wrapPlatforms = [];
  for (const [slug, m] of perSlug) {
    const med = median(m.values()); let sample = null, count = 0;
    for (const [entry, ar] of m) { if (med && ar && Math.abs(ar / med - 1) > 0.05) oddEntries.set(entry, { title: entry.title, platform: slug, ratio: Math.round(ar * 100) / 100 }); else { count++; if (!sample) sample = entry; } }
    wrapPlatforms.push({ slug, count, ratio: Math.round(med * 100) / 100, sample: sample ? scan.files.indexOf(sample) : null, split: splitFor(slug, split) });
  }
  for (const [key, b] of [...best]) if (b.fromWrap) { if (oddEntries.has(b.entry)) best.delete(key); else b.split = splitFor(b.slug, split); }
  // What the folder holds as the importer read it: each (platform folder, kind folder) with its kind and how many files.
  const seenMap = new Map();
  for (const e of scan.files) { if (!wanted.has(e.kind)) continue; const k = `${e.platform || '?'}\n${e.folder || ''}\n${e.kind}`; seenMap.set(k, (seenMap.get(k) || 0) + 1); }
  const seen = [...seenMap].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, files]) => { const [platform, folder, kind] = k.split('\n'); return { platform, folder, kind, files }; });
  const matched = { cover: 0, spine: 0, disc: 0, manual: 0, back: 0 }, will = { cover: 0, spine: 0, disc: 0, manual: 0, back: 0 }, items = [];
  for (const b of best.values()) {
    matched[b.kind]++;
    const g = b.game; let gap;
    if (target === 'digital') gap = !hasFile(g.own) && (replace || !hasFile(g.shared));   // a cover of their own is never replaced; an automatic one only when asked
    else if (b.kind === 'manual') gap = !g.manual_link && !hasFile(g.manual_path);       // there is no automatic manual: only gaps are filled
    else { const path_ = g[`${b.kind}_path`], locked = g[`${b.kind}_locked`]; gap = !hasFile(path_) || (replace && !locked); }
    if (gap) { will[b.kind]++; items.push(b); }
  }
  return {
    items, matched, will,
    skipped: Object.fromEntries(Object.keys(matched).map((k) => [k, matched[k] - will[k]])),
    candidates: candidatesSeen, games: games.length,
    wraps: { files: perSlug.size ? [...perSlug.values()].reduce((t, m) => t + m.size, 0) : 0, odd: oddEntries.size, odd_list: [...oddEntries.values()].slice(0, 25), platforms: wrapPlatforms },
    seen, unmatched, unmatched_total: unmatchedTotal,
    unknown_platforms: [...unknownPlatforms].slice(0, 20).map(([name, files]) => ({ name, files }))
  };
}

const publicPlan = (p, scan, folder) => ({
  folder, scanned: scan.scanned, files: scan.files.length, games: p.games,
  candidates: p.candidates, matched: p.matched, will: p.will, skipped: p.skipped,
  unmatched: p.unmatched, unmatched_total: p.unmatched_total, unknown_platforms: p.unknown_platforms, wraps: p.wraps, seen: p.seen, ignored: scan.ignored || [], links: scan.links || []
});

/** What an import would do (nothing is saved). */
const forceOf = (kind, platform) => (['cover', 'spine', 'disc', 'manual', 'wrap', 'back'].includes(kind) ? { kind, platform: String(platform || '') } : null);
export async function previewArtImport(userId, { target, folder, replace = false, cut = '', kind = '', platform = '', split = {} }) {
  const scan = await scanArtFolder(folder, { fresh: true, force: forceOf(kind, platform) });
  return publicPlan(planArtImport(userId, scan, { target, replace, cut, split }), scan, folder);
}

/* ───────── the import itself, in the background ───────── */

const jobs = new Map();   // userId -> state
const blank = () => ({ running: false, target: null, total: 0, done: 0, applied: { cover: 0, spine: 0, disc: 0, manual: 0, back: 0 }, failed: 0, failures: [], started_at: null, finished_at: null, error: null });
export const artJobStatus = (userId) => ({ ...(jobs.get(userId) || blank()), applied: { ...(jobs.get(userId)?.applied || blank().applied) }, failures: [...(jobs.get(userId)?.failures || [])] });
export const artJobIdle = async (userId) => { while (jobs.get(userId)?.running) await new Promise((r) => setTimeout(r, 25)); };

let lastWrap = { key: '', parts: null };   // the wrap just cut: its cover and its spine come one after the other
async function applyOne(userId, target, b) {
  const st = await fsp.stat(b.entry.file);
  if (b.kind === 'manual') {
    if (st.size > MAX_MANUAL_BYTES) throw new Error('over 50 MB');
    setManualFile(userId, b.game.id, await fsp.readFile(b.entry.file), path.basename(b.entry.file));
  } else {
    if (st.size > (b.fromWrap ? 40 * 1024 * 1024 : MAX_COVER_BYTES)) throw new Error(b.fromWrap ? 'over 40 MB' : 'over 8 MB');
    let buf = await fsp.readFile(b.entry.file);
    if (b.fromWrap) {
      const key = `${b.entry.file}|${b.split.from}|${b.split.to}`;
      if (lastWrap.key !== key) lastWrap = { key, parts: splitWrap(buf, b.split) };
      buf = lastWrap.parts[b.kind];
    }
    if (target === 'digital') setConsoleCover(userId, b.game.store, b.game.app_id, buf);
    else setPhysicalArt(userId, b.game.id, b.kind, buf);
  }
}

/** Start importing (returns at once; ask artJobStatus for progress). One run per person at a time. */
export async function startArtImport(userId, { target, folder, replace = false, cut = '', kind = '', platform = '', split = {} }) {
  const cur = jobs.get(userId);
  if (cur?.running) return artJobStatus(userId);
  const scan = await scanArtFolder(folder, { force: forceOf(kind, platform) });
  const plan = planArtImport(userId, scan, { target, replace, cut, split });
  const job = { ...blank(), running: true, target, total: plan.items.length, started_at: new Date().toISOString() };
  jobs.set(userId, job);
  (async () => {
    try {
      for (const b of plan.items) {
        try { await applyOne(userId, target, b); job.applied[b.kind]++; }
        catch (err) { job.failed++; if (job.failures.length < 10) job.failures.push({ title: b.game.title, kind: b.kind, reason: String(err.message || err).slice(0, 120) }); }
        job.done++;
      }
    } catch (err) { job.error = String(err.message || err).slice(0, 200); }
    finally { job.running = false; job.finished_at = new Date().toISOString(); }
  })();
  return artJobStatus(userId);
}
