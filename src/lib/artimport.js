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
import { MAX_COVER_BYTES, sniffImage } from './coverzip.js';
import { titleKey as videoTitleKey } from './emumovies.js';
import { setRomFile } from './romfiles.js';
import { saveCover } from './storage.js';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
// Videos a browser can play. Other formats (avi, mkv, flv...) are not played, so they are only counted and the person is told to convert them first.
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm']);
const OTHER_VIDEO_EXT = new Set(['.avi', '.mkv', '.flv', '.wmv', '.mov', '.mpg', '.mpeg', '.ogv', '.3gp']);
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
  manual: ['manuals', 'manual'],
  video: ['videos', 'video', 'videosnaps', 'videosnap', 'snaps', 'snap', 'movies', 'previews', 'preview', 'clips']
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
    if (kind === 'video') {
      if (!VIDEO_EXT.has(ext) && !OTHER_VIDEO_EXT.has(ext)) return null;
      // Both orders are in use: <platform>/videos/<title>.mp4 and <videos>/<platform>/<title>.mp4 (LaunchBox); the plan tries the folder above and the folder below as the platform.
      return { layout: 'simple', folder: segs[i], kind, platform: segs[i - 1], region: segs[i + 1] || '', fileRegion: (/(([^)]*))/.exec(base) || [])[1] || '', title: base.replace(/-video$/i, ''), n: 1, weak: false, unsupported: !VIDEO_EXT.has(ext) };   // RetroBat names them <rom name>-video.mp4
    }
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
  if (force.kind === 'video') {
    if (!VIDEO_EXT.has(ext) && !OTHER_VIDEO_EXT.has(ext)) return null;
    const br = /(([^)]*))/.exec(base);
    return { layout: 'picked', folder: segs[segs.length - 1] || '', kind: 'video', platform: force.platform || '', platforms: force.platform ? [] : [...segs].reverse(), region: '', fileRegion: br ? br[1] : '', title: base.replace(/-video$/i, ''), n: 1, weak: false, unsupported: !VIDEO_EXT.has(ext) };
  }
  if (force.kind === 'manual' ? ext !== '.pdf' : !IMAGE_EXT.has(ext)) return null;
  const bracket = /\(([^)]*)\)/.exec(base);
  return { layout: 'picked', folder: segs[segs.length - 1] || '', kind: force.kind, platform: force.platform || '', platforms: force.platform ? [] : [...segs].reverse(), region: '', fileRegion: bracket ? bracket[1] : '', title: base, n: 1, weak: false };
}

/**
 * The title part of a file name: everything before the first `cut` (when the person gave one), with a trailing -01 left for titleKey to ignore.
 * `cut` may list several endings separated by | ("-image|-manual|-video", for assets split over folders that each add their own word): the file is cut where
 * the earliest of them appears. An ending that is not in the name, or is at its very start, is ignored.
 */
export function cutTitle(title, cut) {
  const t = String(title || ''), low = t.toLowerCase();
  let at = -1;
  for (const c of String(cut || '').split('|')) {
    if (!c) continue;
    const i = low.indexOf(c.toLowerCase());
    if (i > 0 && (at < 0 || i < at)) at = i;
  }
  return at > 0 ? t.slice(0, at) : t;
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
/** The Library's games (shared by everyone): with the files already kept for each, so a gap is only filled where there is one. */
/**
 * A ROM's file name without its extension, as a matching key (letters and numbers only): ggx15 for ggx15.zip. Arcade sets (MAME, FBNeo, CPS, Atomiswave, Neo Geo...) are named by this
 * short name, and so are their pictures, videos and manuals (ggx15.png), while the game's title is "Guilty Gear X ver 1.5": a file that matches no title is tried against this.
 */
function romStem(filename) { return squash(path.parse(String(filename || '')).name); }
/** The first word of a file name, up to the first space, dash, underscore, dot or bracket (ggx15 for ggx15-snap or ggx15_marquee): a second try, for pictures with a word added after the ROM name. */
const firstWord = (t) => squash(String(t || '').split(/[\s\-_.(\[]/)[0]);

function romGames() {
  const rows = db.prepare('SELECT r.id, p.slug AS platform, r.title, r.region, r.cover_path, r.cover_locked, r.filename FROM roms r JOIN platforms p ON p.id = r.platform_id').all();
  const files = new Map();
  for (const f of db.prepare('SELECT rom_id, kind, path FROM rom_files').all()) { if (!files.has(f.rom_id)) files.set(f.rom_id, {}); files.get(f.rom_id)[`${f.kind}_path`] = f.path; }
  return rows.map((r) => ({ ...r, stem: romStem(r.filename), ...(files.get(r.id) || {}) }));
}
function digitalGames(userId) {
  const rows = db.prepare("SELECT g.store, g.app_id, g.name AS title, g.platform, g.country AS region, um.cover_path AS own, dd.cover_path AS shared FROM digital_games g LEFT JOIN digital_user_meta um ON um.user_id = g.user_id AND um.store = g.store AND um.app_id = g.app_id LEFT JOIN digital_details dd ON dd.store = g.store AND dd.app_id = g.app_id WHERE g.user_id = ? AND g.store != 'steam'").all(userId);
  return rows.map((r) => ({ ...r, lib: CONSOLE_PLATFORMS[r.platform]?.meta?.[0] || r.platform }));
}

/* ───────── videos: the games from every list a person can play videos in, and the plan for them ───────── */

/** Every game a video could belong to: the Library's (shared), and this person's Physical and Digital games. Keyed by Library platform and title. */
function videoGames(userId) {
  const out = db.prepare('SELECT r.title, r.region, p.slug AS platform, r.filename FROM roms r JOIN platforms p ON p.id = r.platform_id').all().map((r) => ({ ...r, stem: romStem(r.filename) }));
  for (const g of physicalGames(userId)) out.push({ title: g.title, region: g.region, platform: g.platform });
  for (const g of digitalGames(userId)) out.push({ title: g.title, region: g.region, platform: g.lib });
  return out;
}

/** What a video import would do. Videos are kept per platform and title (one per game, shared by every list), and are linked where they are, not copied. */
function planVideoImport(userId, scan, { replace = false, cut = '' } = {}) {
  const games = videoGames(userId);
  const byKey = new Map();
  for (const g of games) { const k = `${g.platform}\n${titleKey(g.title)}`; if (!byKey.has(k)) byKey.set(k, g); }
  const byStem = new Map();   // the Library's ROMs by their file name (arcade pictures and videos are named like the ROM)
  for (const g of games) if (g.stem) { const k = `${g.platform}\n${g.stem}`; if (!byStem.has(k)) byStem.set(k, g); }
  const platCache = new Map(); const platOf = (name) => { if (!name) return null; if (!platCache.has(name)) platCache.set(name, resolvePlatform(name)); return platCache.get(name); };
  const unknownPlatforms = new Map(), unmatched = []; let unmatchedTotal = 0, candidates = 0;
  const unsupported = [], unsupportedAll = { n: 0 };
  const best = new Map();   // `${slug}\n${video key}` -> { game, slug, key, entry, rank }
  for (const e of scan.files) {
    if (e.kind !== 'video') continue;
    if (e.unsupported) { unsupportedAll.n++; if (unsupported.length < 8) unsupported.push(path.basename(e.file)); continue; }
    const names = e.platforms?.length ? e.platforms : [e.platform, e.region];
    const slug = names.map(platOf).find(Boolean) || null;
    if (!slug) { const nm = names.find(Boolean) || '(no folder)'; unknownPlatforms.set(nm, (unknownPlatforms.get(nm) || 0) + 1); continue; }
    candidates++;
    const g = byKey.get(`${slug}\n${titleKey(cutTitle(e.title, cut))}`) || byStem.get(`${slug}\n${squash(cutTitle(e.title, cut))}`) || byStem.get(`${slug}\n${firstWord(cutTitle(e.title, cut))}`);
    if (!g) { unmatchedTotal++; if (unmatched.length < 10) unmatched.push({ kind: 'video', platform: slug, title: e.title }); continue; }
    const key = videoTitleKey(g.title), id = `${slug}\n${key}`, rank = regionRank(g.region, e.fileRegion) * 100 + (e.n || 1);
    const cur = best.get(id);
    if (!cur || rank < cur.rank) best.set(id, { game: g, slug, key, entry: e, rank, kind: 'video' });
  }
  const have = db.prepare('SELECT path, source FROM game_videos WHERE platform = ? AND title_key = ?');
  const items = [];
  for (const b of best.values()) {
    const row = have.get(b.slug, b.key);
    const there = Boolean(row?.path) && hasFile(row.path);
    if (!there || (replace && row.source === 'folder')) items.push(b);   // a video that was fetched from EmuMovies is never replaced by a file
  }
  const seenMap = new Map();
  for (const e of scan.files) { if (e.kind !== 'video') continue; const k = `${e.platform || '?'}\n${e.folder || ''}`; seenMap.set(k, (seenMap.get(k) || 0) + 1); }
  const seen = [...seenMap].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, files]) => { const [platform, folder] = k.split('\n'); return { platform, folder, kind: 'video', files }; });
  return {
    items, matched: { video: best.size }, will: { video: items.length }, skipped: { video: best.size - items.length },
    candidates: { video: candidates }, games: games.length,
    wraps: { files: 0, odd: 0, odd_list: [], platforms: [] },
    seen, unmatched, unmatched_total: unmatchedTotal, unknown_platforms: [...unknownPlatforms].slice(0, 20).map(([name, files]) => ({ name, files })),
    unsupported_videos: unsupportedAll.n, unsupported_list: unsupported
  };
}

/** A real mp4 / webm by its first bytes, then the video is linked where it is: nothing is copied, and the cache limit never deletes it. */
async function applyVideo(b) {
  const fh = await fsp.open(b.entry.file, 'r');
  let head;
  try { head = Buffer.alloc(16); const { bytesRead } = await fh.read(head, 0, 16, 0); head = head.subarray(0, bytesRead); } finally { await fh.close(); }
  const ok = (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') || (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3);
  if (!ok) throw new Error('not an mp4 or webm video (convert it first)');
  const st = await fsp.stat(b.entry.file);
  db.prepare("INSERT INTO game_videos (platform, title_key, path, bytes, source, fetched_at, tried_at) VALUES (?, ?, ?, ?, 'folder', datetime('now'), datetime('now')) ON CONFLICT(platform, title_key) DO UPDATE SET path = excluded.path, bytes = excluded.bytes, source = 'folder', fetched_at = datetime('now'), tried_at = datetime('now')")
    .run(b.slug, b.key, path.resolve(b.entry.file), st.size);
}

/** The best file for each (game, kind). `target`: 'physical' (cover, spine, disc, manual) or 'digital' (covers of console games). Nothing is changed. */
/**
 * What an import would do for a list (physical, digital or rom): its pictures and manuals, and the videos in the same folder (videos belong to a game wherever it is listed,
 * so they are planned the same way for every list). Nothing is changed.
 */
export function planArtImport(userId, scan, opts = {}) {
  const base = planPictures(userId, scan, opts);
  if (opts.target === 'video') return base;
  const v = planVideoImport(userId, scan, { replace: opts.replace, cut: opts.cut });
  base.items.push(...v.items);
  // The Videos row only appears when the folder has videos (so a pictures-only folder reads exactly as before).
  if (v.candidates.video || v.unsupported_videos || v.unmatched_total) for (const k of ['matched', 'will', 'skipped', 'candidates']) base[k] = { ...base[k], video: v[k].video };
  base.unmatched_total += v.unmatched_total; base.unmatched = [...base.unmatched, ...v.unmatched].slice(0, 14);
  const unk = new Map(base.unknown_platforms.map((u) => [u.name, u.files]));
  for (const u of v.unknown_platforms) unk.set(u.name, (unk.get(u.name) || 0) + u.files);
  base.unknown_platforms = [...unk].slice(0, 20).map(([name, files]) => ({ name, files }));
  base.seen = [...base.seen, ...v.seen].slice(0, 16);
  base.unsupported_videos = v.unsupported_videos; base.unsupported_list = v.unsupported_list;
  return base;
}

function planPictures(userId, scan, { target = 'physical', replace = false, cut = '', split = {} } = {}) {
  if (target === 'video') return planVideoImport(userId, scan, { replace, cut });
  const wanted = target === 'digital' ? new Set(['cover']) : target === 'rom' ? new Set(['cover', 'spine', 'disc', 'manual', 'back']) : new Set(['cover', 'spine', 'disc', 'manual', 'wrap', 'back']);
  const games = target === 'digital' ? digitalGames(userId) : target === 'rom' ? romGames() : physicalGames(userId);
  const slugOf = (g) => (target === 'digital' ? g.lib : g.platform);
  const byKey = new Map();
  for (const g of games) { const k = `${slugOf(g)}\n${titleKey(g.title)}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(g); }
  const byStem = new Map();   // Library ROMs by their file name: a picture named like the ROM (ggx15.png for ggx15.zip) belongs to it, whatever the game's title
  if (target === 'rom') for (const g of games) if (g.stem) { const k = `${g.platform}\n${g.stem}`; if (!byStem.has(k)) byStem.set(k, []); byStem.get(k).push(g); }

  const platCache = new Map(); const platOf = (name) => { if (!platCache.has(name)) platCache.set(name, resolvePlatform(name)); return platCache.get(name); };
  const unknownPlatforms = new Map(); const unmatched = [], unmatchedPer = {}; let unmatchedTotal = 0;
  const best = new Map();   // `${gameKey}|${kind}` -> { game, kind, entry, rank }
  const candidatesSeen = { cover: 0, spine: 0, disc: 0, manual: 0, back: 0, wrap: 0 };
  for (const e of scan.files) {
    if (!wanted.has(e.kind)) continue;
    const slug = e.platforms?.length ? (e.platforms.map(platOf).find(Boolean) || null) : platOf(e.platform);
    if (!slug) { const nm = e.platforms?.length ? (e.platforms[0] || '(no folder)') : e.platform; unknownPlatforms.set(nm, (unknownPlatforms.get(nm) || 0) + 1); continue; }
    if (e.kind === 'disc' && target !== 'rom' && !isDiscPlatform(slug)) continue;
    candidatesSeen[e.kind]++;
    const list = byKey.get(`${slug}\n${titleKey(cutTitle(e.title, cut))}`) || byStem.get(`${slug}\n${squash(cutTitle(e.title, cut))}`) || byStem.get(`${slug}\n${firstWord(cutTitle(e.title, cut))}`);
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
    if (target === 'rom') gap = b.kind === 'cover' ? (!hasFile(g.cover_path) || (replace && !g.cover_locked)) : (!hasFile(g[`${b.kind}_path`]) || replace);   // a cover that was uploaded or imported is kept; a file brought in earlier is replaced only when asked
    else if (target === 'digital') gap = !hasFile(g.own) && (replace || !hasFile(g.shared));   // a cover of their own is never replaced; an automatic one only when asked
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
  unmatched: p.unmatched, unmatched_total: p.unmatched_total, unknown_platforms: p.unknown_platforms, wraps: p.wraps, seen: p.seen, ignored: scan.ignored || [], links: scan.links || [], unsupported_videos: p.unsupported_videos || 0, unsupported_list: p.unsupported_list || []
});

/** What an import would do (nothing is saved). */
const forceOf = (kind, platform) => (['cover', 'spine', 'disc', 'manual', 'wrap', 'back', 'video'].includes(kind) ? { kind, platform: String(platform || '') } : null);
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
/** One picture or manual for a Library game. The cover is kept like an uploaded one (it is not replaced by a later automatic lookup); the rest go in roms' own files. */
async function applyRomArt(b) {
  const st = await fsp.stat(b.entry.file);
  if (b.kind === 'manual') {
    if (st.size > MAX_MANUAL_BYTES) throw new Error('over 50 MB');
    setRomFile(b.game.id, 'manual', await fsp.readFile(b.entry.file), path.basename(b.entry.file));
    return;
  }
  if (st.size > MAX_COVER_BYTES) throw new Error('over 8 MB');
  const buf = await fsp.readFile(b.entry.file);
  if (b.kind !== 'cover') { setRomFile(b.game.id, b.kind, buf); return; }
  const type = sniffImage(buf);
  if (!type) throw new Error('not a JPEG, PNG or WebP picture');
  const file = saveCover(buf, `custom-${b.game.id}-${Date.now()}`, type);
  db.prepare("UPDATE roms SET cover_path = ?, cover_locked = 1, updated_at = datetime('now') WHERE id = ?").run(file, b.game.id);
}

async function applyOne(userId, target, b) {
  if (b.kind === 'video') return applyVideo(b);
  if (target === 'rom') return applyRomArt(b);
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
        try { await applyOne(userId, target, b); job.applied[b.kind] = (job.applied[b.kind] || 0) + 1; }
        catch (err) { job.failed++; if (job.failures.length < 10) job.failures.push({ title: b.game.title, kind: b.kind, reason: String(err.message || err).slice(0, 120) }); }
        job.done++;
      }
    } catch (err) { job.error = String(err.message || err).slice(0, 200); }
    finally { job.running = false; job.finished_at = new Date().toISOString(); }
  })();
  return artJobStatus(userId);
}
