// "Find assets": for one game, look up what ScreenScraper keeps (cover, spine, disc, back, manual, video) and keep whatever the game is missing. Only gaps are filled: a picture
// or manual that is already there, and anything the person uploaded themselves, is never touched. It runs when the person presses the button for one game, never in bulk, and
// every file goes through ScreenScraper's own request queue (src/lib/providers.js). The video also comes from EmuMovies when ScreenScraper has none (src/lib/emumovies.js).
import fs from 'node:fs';
import db from '../db.js';
import { screenscraper } from './providers.js';
import { ensureVideo, videoFile, videoSourcesEnabled } from './emumovies.js';
import { getPhysical, setPhysicalArt, setManualFile, isDiscPlatform } from './physical.js';
import { setConsoleCover, libSlug } from './consoles.js';
import { setRomFile, romFiles } from './romfiles.js';
import { saveCover } from './storage.js';
import { sniffImage } from './coverzip.js';
import { listGames } from './steam.js';

const MAX_PICTURE = 8 * 1024 * 1024, MAX_MANUAL = 50 * 1024 * 1024;
const hasFile = (p) => { try { return Boolean(p) && fs.existsSync(p); } catch { return false; } };
const fail = (status, message) => Object.assign(new Error(message), { status });

/** The game, what it already has, and how each kind is put on it. Throws a 404 for a game that is not the person's (or, for the Library, not there). */
function resolve({ kind, id, store, userId }) {
  if (kind === 'rom') {
    const r = db.prepare('SELECT r.id, r.title, r.region, r.cover_path, p.slug AS platform FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?').get(id);
    if (!r) throw fail(404, 'That game is not in the Library');
    const files = new Set(romFiles(r.id).map((f) => f.kind));
    let media = {}; try { media = JSON.parse(db.prepare('SELECT provider_media FROM roms WHERE id = ?').get(r.id)?.provider_media || '{}') || {}; } catch { media = {}; }
    const matched = (k) => hasFile(media?.[k]?.path);   // a ScreenScraper match keeps its own logo (wheel), marquee and fan art
    return {
      title: r.title, platform: r.platform, region: r.region || '',
      has: { cover: hasFile(r.cover_path), spine: files.has('spine'), disc: files.has('disc'), back: files.has('back'), manual: files.has('manual'), logo: files.has('logo') || matched('wheel'), marquee: files.has('marquee') || matched('marquee'), fanart: files.has('fanart') || matched('fanart') },
      kinds: ['cover', 'spine', 'disc', 'back', 'manual', 'logo', 'marquee', 'fanart'],
      put(k, buf, name) {
        if (k === 'cover') {
          const type = sniffImage(buf); if (!type) throw new Error('that file is not a JPEG, PNG or WebP picture');
          const file = saveCover(buf, `custom-${r.id}-${Date.now()}`, type);
          db.prepare("UPDATE roms SET cover_path = ?, cover_locked = 0, updated_at = datetime('now') WHERE id = ?").run(file, r.id);   // an automatic cover: a later lookup may replace it
        } else setRomFile(r.id, k, buf, name, 'screenscraper');
      }
    };
  }
  if (kind === 'physical') {
    const g = getPhysical(userId, id);   // throws a 404 for a game that is not on this person's shelf
    return {
      title: g.title, platform: g.platform, region: g.region || '',
      has: { cover: g.has_cover, spine: g.has_spine, disc: g.has_disc || !isDiscPlatform(g.platform), back: g.has_back, manual: g.has_manual },
      kinds: ['cover', 'spine', ...(isDiscPlatform(g.platform) ? ['disc'] : []), 'back', 'manual'],
      put(k, buf, name) { if (k === 'manual') setManualFile(userId, id, buf, name); else setPhysicalArt(userId, id, k, buf); }
    };
  }
  if (kind === 'digital') {
    const g = listGames(userId, { store, hidden: 'show' }).find((x) => x.app_id === String(id));
    if (!g?.platform) throw fail(404, 'That game is not in your list');
    return {
      title: g.name, platform: libSlug(g.platform), region: g.country || '',
      has: { cover: Boolean(g.cover_url) },
      kinds: ['cover'],
      put(k, buf) { setConsoleCover(userId, store, g.app_id, buf); }
    };
  }
  throw fail(404, 'That game is not in your list');
}

/**
 * After a lookup of ONE game (Refresh metadata, Look up again): fill what the game is missing too, the way Find assets does (gaps only). Best effort: a failure here never fails the
 * lookup, and nothing is asked when no source is set up. Returns { got, results } or null. Never used by the bulk lookups (they would spend a day's allowance).
 */
export async function fillAfterLookup(args) {
  try {
    if (!videoSourcesEnabled().length) return null;
    const r = await fetchAssets({ ...args, force: false });
    return { got: r.got, results: r.results };
  } catch { return null; }
}

/**
 * Fill what the game is missing. Returns { results: { video, cover, ... }, why? } where each result is 'had' (already there), 'got' (just added), 'none' (the sources have none)
 * or 'failed' (found, but it could not be kept), plus `errors` for the ones that failed. Throws a 404 for a game that is not theirs.
 */
export async function fetchAssets({ kind, id, store = '', userId, force = false, only = null, skipVideo = false }) {
  const g = resolve({ kind, id, store, userId });
  if (Array.isArray(only)) g.kinds = g.kinds.filter((k) => only.includes(k));   // the bulk run asks for a few small kinds only
  const results = {}, errors = {};
  const missing = g.kinds.filter((k) => !g.has[k]);
  for (const k of g.kinds) if (g.has[k]) results[k] = 'had';
  const haveVideo = skipVideo || Boolean(videoFile({ title: g.title, platform: g.platform }));
  results.video = skipVideo ? 'skipped' : haveVideo ? 'had' : 'pending';

  let ss = null, why = null;
  if (missing.length && !screenscraper.enabled) why = 'ScreenScraper is not set up, so pictures and manuals cannot be looked for (Settings, Metadata providers)';
  if ((missing.length || !haveVideo) && screenscraper.enabled) {
    try { ss = await screenscraper.assetsFor({ title: g.title, platform: g.platform, region: g.region, force }); } catch (err) { why = err.message; }
    if (ss && !why) why = ss.why || null;
  }
  for (const k of missing) {
    const url = ss?.urls?.[k];
    if (!url) { results[k] = 'none'; continue; }
    try {
      const buf = await screenscraper.fetchFile(url, k === 'manual' ? MAX_MANUAL : MAX_PICTURE);
      g.put(k, buf, `${g.title} manual.pdf`);
      results[k] = 'got';
    } catch (err) { results[k] = 'failed'; errors[k] = String(err.message || err).slice(0, 160); }
  }
  if (!haveVideo) {
    const v = await ensureVideo({ title: g.title, platform: g.platform, force });
    results.video = v.status === 'ready' ? 'got' : v.status === 'none' ? 'none' : v.status === 'disabled' ? 'none' : 'failed';
    if (v.status === 'error') errors.video = v.error;
    if (v.status === 'none' && v.why && !why) why = v.why;
  }
  return { results, errors, why, got: Object.keys(results).filter((k) => results[k] === 'got') };
}

/* ───────── fill the gaps: a platform's games that have no logo, marquee or background ─────────
 * One run asks ScreenScraper about up to `limit` games of one platform (a game's single lookup also tells where its logo, marquee and fan art are), keeps only those three small
 * kinds, never a cover, manual or video, and remembers every game it asked about so the next run goes on with other games. It stops by itself when ScreenScraper's allowance for the
 * day is used up, and the person can stop it. Admin only; one run at a time. */
export const FILL_KINDS = ['logo', 'marquee', 'fanart'];
const TRIED_DAYS = 14;
export const fillJob = { running: false, stop: false, platform: '', limit: 0, total: 0, done: 0, got: { logo: 0, marquee: 0, fanart: 0 }, games_filled: 0, none: 0, failed: 0, message: '', finished: false };

/** The games of a platform still missing a logo, marquee or background that were not asked about lately, in title order, at most `limit`. */
export function fillCandidates(platform, limit) {
  const rows = db.prepare(`SELECT r.id, r.provider_media FROM roms r JOIN platforms p ON p.id = r.platform_id
    WHERE p.slug = ? AND r.missing = 0 AND r.is_system = 0 AND r.id NOT IN (SELECT rom_id FROM rom_assets_tried WHERE tried_at > datetime('now', ?))
    ORDER BY r.sort_title`).all(platform, `-${TRIED_DAYS} days`);
  const own = new Map();
  for (const f of db.prepare("SELECT rom_id, kind FROM rom_files WHERE kind IN ('logo', 'marquee', 'fanart')").all()) { if (!own.has(f.rom_id)) own.set(f.rom_id, new Set()); own.get(f.rom_id).add(f.kind); }
  const out = [];
  for (const r of rows) {
    let media = {}; try { media = r.provider_media ? JSON.parse(r.provider_media) : {}; } catch { media = {}; }
    const mine = own.get(r.id) || new Set();
    const has = { logo: mine.has('logo') || hasFile(media?.wheel?.path), marquee: mine.has('marquee') || hasFile(media?.marquee?.path), fanart: mine.has('fanart') || hasFile(media?.fanart?.path) };
    if (FILL_KINDS.some((k) => !has[k])) out.push(r.id);
    if (out.length >= limit) break;
  }
  return out;
}

/** Start a run. Returns the job status. `ask` is what fetches one game (the real one by default; a test passes its own). */
export function startFill({ platform, limit = 50, userId, ask = fetchAssets }) {
  if (fillJob.running) return fillJob;
  const slug = String(platform || '').toLowerCase();
  if (!db.prepare('SELECT 1 FROM platforms WHERE slug = ?').get(slug)) throw fail(404, 'Choose a platform.');
  if (!screenscraper.enabled) throw fail(400, 'ScreenScraper is not set up (Settings, Metadata providers), so there is nothing to fetch from.');
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  const ids = fillCandidates(slug, lim);
  Object.assign(fillJob, { running: true, stop: false, platform: slug, limit: lim, total: ids.length, done: 0, got: { logo: 0, marquee: 0, fanart: 0 }, games_filled: 0, none: 0, failed: 0, message: ids.length ? 'Starting…' : 'Nothing to do: every game of this platform has them, or was asked about in the last two weeks.', finished: false });
  if (!ids.length) { fillJob.running = false; fillJob.finished = true; return fillJob; }
  (async () => {
    const mark = db.prepare("INSERT INTO rom_assets_tried (rom_id, tried_at) VALUES (?, datetime('now')) ON CONFLICT(rom_id) DO UPDATE SET tried_at = excluded.tried_at");
    try {
      for (const id of ids) {
        if (fillJob.stop) { fillJob.message = `Stopped after ${fillJob.done} of ${fillJob.total} games.`; break; }
        try {
          const r = await ask({ kind: 'rom', id, userId, only: FILL_KINDS, skipVideo: true });
          const got = (r.got || []).filter((k) => FILL_KINDS.includes(k));
          for (const k of got) fillJob.got[k]++;
          if (got.length) fillJob.games_filled++; else if (Object.values(r.errors || {}).length) fillJob.failed++; else fillJob.none++;
          if (/allowance|quota/i.test(`${r.why || ''}`)) { mark.run(id); fillJob.done++; fillJob.message = `ScreenScraper's allowance for today is used up: stopped after ${fillJob.done} games. Run it again tomorrow.`; break; }
        } catch (err) {
          fillJob.failed++;
          if (/allowance|quota/i.test(String(err.message))) { fillJob.done++; fillJob.message = `ScreenScraper's allowance for today is used up: stopped after ${fillJob.done} games. Run it again tomorrow.`; break; }
        }
        mark.run(id); fillJob.done++;
        fillJob.message = `Looked at ${fillJob.done} of ${fillJob.total} games…`;
      }
      if (!fillJob.message.startsWith('Stopped') && !/allowance/.test(fillJob.message)) fillJob.message = `Done: ${fillJob.games_filled} game${fillJob.games_filled === 1 ? '' : 's'} got something (${fillJob.got.logo} logos, ${fillJob.got.marquee} marquees, ${fillJob.got.fanart} backgrounds); ${fillJob.none} had none at ScreenScraper${fillJob.failed ? `; ${fillJob.failed} could not be fetched` : ''}.`;
    } finally { fillJob.running = false; fillJob.finished = true; }
  })();
  return fillJob;
}
export const stopFill = () => { fillJob.stop = true; return fillJob; };
