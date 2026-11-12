// "Find assets": for one game, look up what ScreenScraper keeps (cover, spine, disc, back, manual, video) and keep whatever the game is missing. Only gaps are filled: a picture
// or manual that is already there, and anything the person uploaded themselves, is never touched. It runs when the person presses the button for one game, never in bulk, and
// every file goes through ScreenScraper's own request queue (src/lib/providers.js). The video also comes from EmuMovies when ScreenScraper has none (src/lib/emumovies.js).
import fs from 'node:fs';
import db from '../db.js';
import { screenscraper } from './providers.js';
import { ensureVideo, videoFile } from './emumovies.js';
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
    return {
      title: r.title, platform: r.platform, region: r.region || '',
      has: { cover: hasFile(r.cover_path), spine: files.has('spine'), disc: files.has('disc'), back: files.has('back'), manual: files.has('manual') },
      kinds: ['cover', 'spine', 'disc', 'back', 'manual'],
      put(k, buf, name) {
        if (k === 'cover') {
          const type = sniffImage(buf); if (!type) throw new Error('that file is not a JPEG, PNG or WebP picture');
          const file = saveCover(buf, `custom-${r.id}-${Date.now()}`, type);
          db.prepare("UPDATE roms SET cover_path = ?, cover_locked = 0, updated_at = datetime('now') WHERE id = ?").run(file, r.id);   // an automatic cover: a later lookup may replace it
        } else setRomFile(r.id, k, buf, name);
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
 * Fill what the game is missing. Returns { results: { video, cover, ... }, why? } where each result is 'had' (already there), 'got' (just added), 'none' (the sources have none)
 * or 'failed' (found, but it could not be kept), plus `errors` for the ones that failed. Throws a 404 for a game that is not theirs.
 */
export async function fetchAssets({ kind, id, store = '', userId, force = false }) {
  const g = resolve({ kind, id, store, userId });
  const results = {}, errors = {};
  const missing = g.kinds.filter((k) => !g.has[k]);
  for (const k of g.kinds) if (g.has[k]) results[k] = 'had';
  const haveVideo = Boolean(videoFile({ title: g.title, platform: g.platform }));
  results.video = haveVideo ? 'had' : 'pending';

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
