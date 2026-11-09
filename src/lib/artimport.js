// Bring in pictures and manuals you already have on disk (a LaunchBox "Images" folder, a RetroBat "roms" folder) for the games on your Physical shelf, and covers for your
// Digital console games. The server reads them from folders an admin has listed (Settings > Artwork folders): nothing outside those folders can ever be read.
//
// What is recognised (by where a file sits and what it is called; nothing is read until it is used):
//   LaunchBox   <platform>/box - front/[region/]<title>-01.png    -> cover      (also "box - front - reconstructed", used only when there is no plain front)
//               <platform>/box - spine/[region/]<title>-01.png    -> spine
//               <platform>/disc/[region/]<title>-01.png           -> disc       (disc games only)
//   RetroBat    <system>/images/<rom name>-thumb.png              -> cover      (-image, -marquee ... are not box art and are left alone)
//               <system>/manuals/<rom name>-manual.pdf            -> manual     (Physical only)
// A file is matched to a game by its platform (the folder name) and its title (letters and numbers only: "Marvel_ Ultimate Alliance 2" finds "Marvel: Ultimate Alliance 2";
// anything in (brackets) or [square brackets] is ignored, and so is a trailing -01). Where one game has pictures for several regions, the game's own region decides.
// Only gaps are filled by default; a picture the person uploaded themselves is never replaced.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import db from '../db.js';
import { resolvePlatform, setPhysicalArt, setManualFile, isDiscPlatform } from './physical.js';
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
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    let p = String(raw || '').trim();
    if (p.length > 3) p = p.replace(/[\\/]+$/, '');   // D:\Art\ and D:\Art are the same; D:\ stays as it is
    if (!p) continue;
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

const LB_KIND = { 'box - front': 'cover', 'box - front - reconstructed': 'cover', 'box - spine': 'spine', disc: 'disc' };
const REGION_GROUP = {
  eu: ['europe', 'united kingdom', 'australia', 'france', 'germany', 'spain', 'italy', 'netherlands', 'scandinavia', 'new zealand', 'russia'],
  na: ['north america', 'united states', 'canada'],
  jp: ['japan', 'asia', 'korea', 'china', 'hong kong', 'taiwan'],
  world: ['world']
};
const folderGroup = (name) => Object.keys(REGION_GROUP).find((g) => REGION_GROUP[g].includes(String(name || '').toLowerCase())) || null;
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
    return { layout: 'launchbox', kind: LB_KIND[segs[t]], platform: segs[t - 1], region: segs[t + 1] || '', title: base.replace(/-\d{1,3}$/, ''), n: num ? Number(num[1]) : 1, weak: segs[t] === 'box - front - reconstructed' };
  }
  const img = segs.lastIndexOf('images');
  if (img >= 1 && IMAGE_EXT.has(ext) && /-thumb$/i.test(base)) return { layout: 'retrobat', kind: 'cover', platform: segs[img - 1], region: '', title: base.replace(/-thumb$/i, ''), n: 1, weak: false };
  const man = segs.lastIndexOf('manuals');
  if (man >= 1 && ext === '.pdf') return { layout: 'retrobat', kind: 'manual', platform: segs[man - 1], region: '', title: base.replace(/-manual$/i, ''), n: 1, weak: false };
  return null;
}

/* ───────── scanning a folder ───────── */

const scanCache = new Map();   // folder -> { at, result }
const CACHE_MS = 5 * 60 * 1000;

async function walk(root) {
  const files = []; let scanned = 0;
  const go = async (dir, depth, segs) => {
    if (depth > MAX_DEPTH || scanned > MAX_FILES) return;
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name.startsWith('.')) continue;
      if (it.isSymbolicLink()) continue;   // never follow a link out of the folder
      if (it.isDirectory()) await go(path.join(dir, it.name), depth + 1, [...segs, it.name.toLowerCase()]);
      else if (it.isFile()) { scanned++; const c = classify(segs, it.name); if (c) files.push({ ...c, file: path.join(dir, it.name) }); }
    }
  };
  await go(root, 0, [path.basename(root).toLowerCase()]);   // the chosen folder's own name counts too (so a platform folder can be chosen on its own)
  return { files, scanned };
}

/** Everything useful under one of the listed folders. Remembered for a few minutes so a preview and the import that follows do not scan twice. */
export async function scanArtFolder(folder, { fresh = false } = {}) {
  const listed = getArtFolders().find((f) => f === folder);
  if (!listed) throw Object.assign(new Error('Choose one of the artwork folders the admin has listed.'), { status: 400 });
  const hit = scanCache.get(listed);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  let ok = false; try { ok = (await fsp.stat(listed)).isDirectory(); } catch { /* missing */ }
  if (!ok) throw Object.assign(new Error('That folder is not available on the server right now.'), { status: 400 });
  const { files, scanned } = await walk(listed);
  const result = { files, scanned };
  scanCache.set(listed, { at: Date.now(), result });
  return result;
}

/* ───────── matching to a person's games ───────── */

const hasFile = (p) => { try { return Boolean(p) && fs.existsSync(p); } catch { return false; } };

function physicalGames(userId) {
  return db.prepare('SELECT id, platform, title, region, cover_path, cover_locked, spine_path, spine_locked, disc_path, disc_locked, manual_path, manual_link FROM physical_games WHERE user_id = ?').all(userId);
}
function digitalGames(userId) {
  const rows = db.prepare("SELECT g.store, g.app_id, g.name AS title, g.platform, g.country AS region, um.cover_path AS own, dd.cover_path AS shared FROM digital_games g LEFT JOIN digital_user_meta um ON um.user_id = g.user_id AND um.store = g.store AND um.app_id = g.app_id LEFT JOIN digital_details dd ON dd.store = g.store AND dd.app_id = g.app_id WHERE g.user_id = ? AND g.store != 'steam'").all(userId);
  return rows.map((r) => ({ ...r, lib: CONSOLE_PLATFORMS[r.platform]?.meta?.[0] || r.platform }));
}

/** The best file for each (game, kind). `target`: 'physical' (cover, spine, disc, manual) or 'digital' (covers of console games). Nothing is changed. */
export function planArtImport(userId, scan, { target = 'physical', replace = false } = {}) {
  const wanted = target === 'digital' ? new Set(['cover']) : new Set(['cover', 'spine', 'disc', 'manual']);
  const games = target === 'digital' ? digitalGames(userId) : physicalGames(userId);
  const slugOf = (g) => (target === 'digital' ? g.lib : g.platform);
  const byKey = new Map();
  for (const g of games) { const k = `${slugOf(g)}\n${titleKey(g.title)}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(g); }

  const platCache = new Map(); const platOf = (name) => { if (!platCache.has(name)) platCache.set(name, resolvePlatform(name)); return platCache.get(name); };
  const unknownPlatforms = new Map(); const unmatched = []; let unmatchedTotal = 0;
  const best = new Map();   // `${gameKey}|${kind}` -> { game, kind, entry, rank }
  const candidatesSeen = { cover: 0, spine: 0, disc: 0, manual: 0 };
  for (const e of scan.files) {
    if (!wanted.has(e.kind)) continue;
    const slug = platOf(e.platform);
    if (!slug) { unknownPlatforms.set(e.platform, (unknownPlatforms.get(e.platform) || 0) + 1); continue; }
    if (e.kind === 'disc' && !isDiscPlatform(slug)) continue;
    candidatesSeen[e.kind]++;
    const list = byKey.get(`${slug}\n${titleKey(e.title)}`);
    if (!list) { unmatchedTotal++; if (unmatched.length < 25) unmatched.push({ kind: e.kind, platform: slug, title: e.title }); continue; }
    for (const g of list) {
      const id = target === 'digital' ? `${g.store}/${g.app_id}` : g.id;
      const key = `${id}|${e.kind}`;
      const rank = (e.weak ? 20 : 0) + regionRank(g.region, e.region) * 100 + (e.n || 1);
      const cur = best.get(key);
      if (!cur || rank < cur.rank) best.set(key, { game: g, id, kind: e.kind, entry: e, rank });
    }
  }

  const matched = { cover: 0, spine: 0, disc: 0, manual: 0 }, will = { cover: 0, spine: 0, disc: 0, manual: 0 }, items = [];
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
    unmatched, unmatched_total: unmatchedTotal,
    unknown_platforms: [...unknownPlatforms].slice(0, 20).map(([name, files]) => ({ name, files }))
  };
}

const publicPlan = (p, scan, folder) => ({
  folder, scanned: scan.scanned, files: scan.files.length, games: p.games,
  candidates: p.candidates, matched: p.matched, will: p.will, skipped: p.skipped,
  unmatched: p.unmatched, unmatched_total: p.unmatched_total, unknown_platforms: p.unknown_platforms
});

/** What an import would do (nothing is saved). */
export async function previewArtImport(userId, { target, folder, replace = false }) {
  const scan = await scanArtFolder(folder, { fresh: true });
  return publicPlan(planArtImport(userId, scan, { target, replace }), scan, folder);
}

/* ───────── the import itself, in the background ───────── */

const jobs = new Map();   // userId -> state
const blank = () => ({ running: false, target: null, total: 0, done: 0, applied: { cover: 0, spine: 0, disc: 0, manual: 0 }, failed: 0, failures: [], started_at: null, finished_at: null, error: null });
export const artJobStatus = (userId) => ({ ...(jobs.get(userId) || blank()), applied: { ...(jobs.get(userId)?.applied || blank().applied) }, failures: [...(jobs.get(userId)?.failures || [])] });
export const artJobIdle = async (userId) => { while (jobs.get(userId)?.running) await new Promise((r) => setTimeout(r, 25)); };

async function applyOne(userId, target, b) {
  const st = await fsp.stat(b.entry.file);
  if (b.kind === 'manual') {
    if (st.size > MAX_MANUAL_BYTES) throw new Error('over 50 MB');
    setManualFile(userId, b.game.id, await fsp.readFile(b.entry.file), path.basename(b.entry.file));
  } else {
    if (st.size > MAX_COVER_BYTES) throw new Error('over 8 MB');
    const buf = await fsp.readFile(b.entry.file);
    if (target === 'digital') setConsoleCover(userId, b.game.store, b.game.app_id, buf);
    else setPhysicalArt(userId, b.game.id, b.kind, buf);
  }
}

/** Start importing (returns at once; ask artJobStatus for progress). One run per person at a time. */
export async function startArtImport(userId, { target, folder, replace = false }) {
  const cur = jobs.get(userId);
  if (cur?.running) return artJobStatus(userId);
  const scan = await scanArtFolder(folder);
  const plan = planArtImport(userId, scan, { target, replace });
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
