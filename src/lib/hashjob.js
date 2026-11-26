// Fingerprints in the background. A scan adds games at once, without reading them; this job then reads each new file in full (CRC32 + MD5 + SHA1, one pass),
// which is slow for big files on a network share. It runs right after a scan, or only inside an overnight window the admin sets, and picks up where it
// stopped (after a restart, or when the window closes): the games still waiting are simply the ones with no SHA1.
//
// When the fingerprints arrive: a game whose SHA1 already belongs to another game is a duplicate and is removed (the older one stays, as an inline scan
// always did), and a game that matches a DAT file gets its proper title. A file that cannot be read is marked and not tried again until it changes.
import fs from 'node:fs';
import db from '../db.js';
import { hashFile } from './hash.js';
import { applyDatMatch } from '../dats.js';
import { flushRatings } from './ratings.js';
import { clearDuplicateCache } from './duplicates.js';

const getMeta = (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null;
const setMeta = (k, v) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

export const MODES = ['background', 'overnight', 'inline'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** How fingerprints are made: 'background' (right after a scan, one game at a time), 'overnight' (only inside the window) or 'inline' (during the scan, as before). */
export function getHashSettings() {
  const mode = MODES.includes(process.env.GAMESAUCE_HASH_MODE) ? process.env.GAMESAUCE_HASH_MODE : getMeta('hash_mode');   // the environment wins (a fixed choice for Docker, and for tests)
  const start = getMeta('hash_window_start'), end = getMeta('hash_window_end');
  const max = Number(getMeta('hash_max_gb'));
  return { mode: MODES.includes(mode) ? mode : 'background', window_start: HHMM.test(start || '') ? start : '01:00', window_end: HHMM.test(end || '') ? end : '07:00', max_gb: Number.isFinite(max) && max > 0 ? max : 0 };
}

export function saveHashSettings({ mode, window_start, window_end, max_gb } = {}) {
  if (mode !== undefined) { if (!MODES.includes(mode)) throw Object.assign(new Error('Choose when the fingerprints are made from the list.'), { status: 400 }); setMeta('hash_mode', mode); }
  for (const [k, v] of [['hash_window_start', window_start], ['hash_window_end', window_end]]) {
    if (v === undefined) continue;
    if (!HHMM.test(String(v))) throw Object.assign(new Error('Times are written as HH:MM, for example 01:30.'), { status: 400 });
    setMeta(k, v);
  }
  if (max_gb !== undefined) {
    const g = max_gb === '' || max_gb === null ? 0 : Number(max_gb);
    if (!Number.isFinite(g) || g < 0 || g > 100000) throw Object.assign(new Error('The size limit is a number of gigabytes, or 0 for no limit.'), { status: 400 });
    setMeta('hash_max_gb', g);
    // files that were skipped for being too big, and now fit under the new limit (or there is none), wait for their fingerprints again
    db.prepare('UPDATE roms SET hash_failed = 0 WHERE hash_failed = 3 AND (? = 0 OR size_bytes <= ?)').run(g, g * 1024 ** 3);
  }
  return getHashSettings();
}

/** Is a time of day inside the window? The window may cross midnight (22:00 to 06:00); equal start and end means the whole day. */
export function inWindow(start, end, now = new Date()) {
  const mins = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const a = mins(start), b = mins(end), t = now.getHours() * 60 + now.getMinutes();
  if (a === b) return true;
  return a < b ? t >= a && t < b : t >= a || t < b;
}

const PENDING = "sha1 IS NULL AND source_id IS NOT NULL AND missing = 0 AND hash_failed = 0";
export const pendingCount = () => db.prepare(`SELECT COUNT(*) AS n FROM roms WHERE ${PENDING}`).get().n;
const countWhere = (w) => db.prepare(`SELECT COUNT(*) AS n FROM roms WHERE ${w}`).get().n;

let paused = false;   // the admin pressed Stop: nothing starts by itself until Run now (or saving the settings), so Stop is not undone a minute later
const job = { running: false, forced: false, stop: false, total: 0, done: 0, current: '', duplicates: 0, failed: 0, started_at: null, last_finished_at: null, waiting_for_window: false };

/** Whether the job may work now: always when started by hand, else the mode's own rule. */
function allowedNow(forced) {
  if (forced) return true;
  const s = getHashSettings();
  return s.mode !== 'overnight' || inWindow(s.window_start, s.window_end);
}

export function hashStatus() {
  const s = getHashSettings();
  return {
    ...s, pending: pendingCount(), unreadable: countWhere('hash_failed = 1'), kept_duplicates: countWhere('hash_failed = 2'), skipped_large: countWhere('hash_failed = 3'),
    paused, running: job.running, total: job.total, done: job.done, current: job.current, duplicates_removed: job.duplicates, failed: job.failed,
    server_time: `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`, server_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    started_at: job.started_at, last_finished_at: job.last_finished_at, in_window: inWindow(s.window_start, s.window_end),
    waiting_for_window: s.mode === 'overnight' && pendingCount() > 0 && !job.running && !inWindow(s.window_start, s.window_end)
  };
}

/** The next game to fingerprint, or null. Smallest first, so the library fills in quickly and a huge file does not hold up the rest. */
const nextRom = () => db.prepare(`SELECT id, title, meta_source, source_path, storage_path, size_bytes, scanned_size FROM roms WHERE ${PENDING} ORDER BY size_bytes, id LIMIT 1`).get();

async function one(r) {
  const file = r.source_path || r.storage_path;
  const limit = getHashSettings().max_gb;
  if (limit && r.size_bytes > limit * 1024 ** 3) { db.prepare("UPDATE roms SET hash_failed = 3 WHERE id = ?").run(r.id); return; }   // too big to be worth reading: no fingerprint, and it plays as normal
  const fail = (code) => { db.prepare("UPDATE roms SET hash_failed = ?, updated_at = datetime('now') WHERE id = ?").run(code, r.id); job.failed++; };
  let st = null; try { st = fs.statSync(file); } catch { /* unreachable or gone */ }
  if (!st || !st.isFile()) return fail(1);
  // Stop, a change to overnight outside the window, or the window closing ends the read within a moment, not after a 150 GB file: the game stays waiting.
  let h; try { h = await hashFile(file, { shouldStop: () => job.stop || !allowedNow(job.forced) }); } catch (e) { if (e.stopped) return 'stopped'; return fail(1); }
  const dupe = db.prepare('SELECT id FROM roms WHERE sha1 = ? AND id != ?').get(h.sha1, r.id);
  if (dupe) {
    // The same bytes are already in the library. Remove this entry unless it has been worked on (a title from a provider or by hand): then keep it, unhashed.
    if (r.meta_source === 'filename' || r.meta_source === null) { db.prepare('DELETE FROM roms WHERE id = ?').run(r.id); job.duplicates++; }
    else db.prepare("UPDATE roms SET hash_failed = 2, updated_at = datetime('now') WHERE id = ?").run(r.id);
    return;
  }
  db.prepare("UPDATE roms SET crc32 = ?, md5 = ?, sha1 = ?, updated_at = datetime('now') WHERE id = ?").run(h.crc32, h.md5, h.sha1, r.id);
  flushRatings();   // a rating remembered by fingerprint is given back now (a game renamed since it was rated, say)
  const row = db.prepare('SELECT r.id, r.title, r.filename, r.sha1, r.crc32, r.size_bytes, r.meta_source, p.slug AS platform FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?').get(r.id);
  try { if (row) applyDatMatch(row); } catch { /* a DAT problem must not stop the fingerprints */ }
}

/** Start working through the waiting games. forced: the admin pressed Run now (the window does not apply). Returns at once. */
export function startHashJob({ forced = false, resume = false } = {}) {
  if (forced || resume) paused = false;
  // In overnight mode Stop only holds for the rest of that window: once it is closed, the next night starts as normal.
  if (paused) { const c = getHashSettings(); if (c.mode === 'overnight' && !inWindow(c.window_start, c.window_end)) paused = false; }
  if (job.running) { job.forced = job.forced || forced; return hashStatus(); }
  if (paused || !pendingCount() || !allowedNow(forced)) return hashStatus();
  Object.assign(job, { running: true, forced, stop: false, total: pendingCount(), done: 0, current: '', duplicates: 0, failed: 0, started_at: new Date().toISOString() });
  (async () => {
    try {
      for (;;) {   // (anything unexpected, such as the database closing, ends the run; the games still waiting are picked up next time)
        if (job.stop || !allowedNow(job.forced)) break;   // stopped, or the overnight window has closed: the rest waits for the next one
        const r = nextRom(); if (!r) break;
        job.current = r.title || ''; job.total = Math.max(job.total, job.done + pendingCount());
        let outcome; try { outcome = await one(r); } catch { db.prepare("UPDATE roms SET hash_failed = 1 WHERE id = ?").run(r.id); job.failed++; }
        if (outcome === 'stopped') break;
        job.done++;
      }
    } catch { /* ends the run */ } finally { job.running = false; job.current = ''; job.last_finished_at = new Date().toISOString(); clearDuplicateCache(); }
  })();
  return hashStatus();
}

export function stopHashJob() { paused = true; job.stop = true; return hashStatus(); }

/** For tests: wait until the job has stopped. */
export async function hashJobIdle(timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (job.running && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
}

/** Once a minute: start the job when games are waiting and the mode allows it (this is what opens the overnight window). */
export function startHashScheduler(everyMs = 60_000) {
  const tick = () => { try { startHashJob(); } catch { /* the next tick tries again */ } };
  setTimeout(tick, 15_000).unref();
  setInterval(tick, everyMs).unref();
}
