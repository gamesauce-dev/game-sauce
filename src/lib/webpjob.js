// Convert the stored pictures themselves to WebP (Settings > Maintenance > Pictures), on a schedule the admin sets.
//
// This is the step that REPLACES files, so it is careful:
//   - only pictures inside the storage folder (never a file in a person's own folder), only PNG and JPEG, never an animation;
//   - a picture is converted only when the WebP is at least 10% smaller and decodes to the same size; otherwise it is left alone;
//   - every conversion is written down (image_conversions) and the ORIGINAL is moved to <storage>/image-originals, not deleted;
//     it stays there for the number of days the admin chose, and until then "Put the originals back" undoes everything;
//   - the database is updated in one transaction per picture, for every place that points at it (a cover can be shared by several games).
// It runs inside the admin's time window (like the fingerprints), one picture at a time, and stops the moment the window closes.
import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { rootDir } from './storage.js';
import { getSharp, imageSettings, clearImageCache, MIN_QUALITY } from './webp.js';
import { inWindow } from './hashjob.js';
import { noteConverted } from './artmoderation.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MIN_SAVING = 0.10;
export const MIN_KEEP_DAYS = 1, MAX_KEEP_DAYS = 90, DEFAULT_KEEP_DAYS = 14;
const KEYS = { mode: 'images.convert_mode', start: 'images.convert_window_start', end: 'images.convert_window_end', keep: 'images.keep_days', forever: 'images.keep_forever' };

const getSetting = (k) => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(k)?.value;
const putSetting = (k, v, userId = null) => db.prepare(`INSERT INTO app_settings (key, value, encrypted, updated_by, updated_at) VALUES (?, ?, 0, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`).run(k, String(v), userId);

export const MODES = ['off', 'overnight'];
/** off (default), or overnight: run inside the window. Run now always works on request. */
export function convertSettings() {
  const mode = getSetting(KEYS.mode), start = getSetting(KEYS.start), end = getSetting(KEYS.end), keep = Number(getSetting(KEYS.keep));
  return {
    mode: MODES.includes(mode) ? mode : 'off',
    window_start: HHMM.test(start || '') ? start : '02:00',
    window_end: HHMM.test(end || '') ? end : '06:00',
    keep_days: Number.isInteger(keep) && keep >= MIN_KEEP_DAYS && keep <= MAX_KEEP_DAYS ? keep : DEFAULT_KEEP_DAYS,
    keep_forever: getSetting(KEYS.forever) === '1'   // the originals stay until the admin removes them by hand
  };
}
export function saveConvertSettings({ mode, window_start, window_end, keep_days, keep_forever } = {}, userId = null) {
  if (keep_forever !== undefined) putSetting(KEYS.forever, keep_forever ? '1' : '0', userId);
  if (mode !== undefined) { if (!MODES.includes(mode)) throw Object.assign(new Error('Choose off or overnight.'), { status: 400 }); putSetting(KEYS.mode, mode, userId); }
  for (const [k, v] of [[KEYS.start, window_start], [KEYS.end, window_end]]) {
    if (v === undefined) continue;
    if (!HHMM.test(String(v))) throw Object.assign(new Error('Times are written as HH:MM, for example 02:00.'), { status: 400 });
    putSetting(k, v, userId);
  }
  if (keep_days !== undefined) {
    const d = Number(keep_days);
    if (!Number.isInteger(d) || d < MIN_KEEP_DAYS || d > MAX_KEEP_DAYS) throw Object.assign(new Error(`Keep the originals for ${MIN_KEEP_DAYS} to ${MAX_KEEP_DAYS} days.`), { status: 400 });
    putSetting(KEYS.keep, d, userId);
  }
  return convertSettings();
}

/* ───────── what points at a stored picture ───────── */

// [table, column, extra WHERE]. rom_files holds more than pictures (manuals): only its picture kinds are touched.
const REFS = [
  ['roms', 'cover_path'], ['physical_games', 'cover_path'], ['physical_games', 'spine_path'], ['physical_games', 'disc_path'], ['physical_games', 'back_path'],
  ['digital_details', 'cover_path'], ['digital_user_meta', 'cover_path'], ['rom_files', 'path', "kind <> 'manual'"]
];
const IMG = /\.(png|jpe?g)$/i;
const inside = (root, file) => { const r = path.relative(root, file); return r && !r.startsWith('..') && !path.isAbsolute(r); };

/** Every distinct stored PNG/JPEG picture the database points at, inside the storage folder, that exists. */
export function candidates() {
  const root = rootDir(), seen = new Set(), out = [];
  const take = (p) => {
    if (!p || seen.has(p) || !IMG.test(p)) return;
    seen.add(p);
    const abs = path.resolve(p);
    if (!inside(root, abs) || inside(path.join(root, 'image-originals'), abs)) return;
    try { const st = fs.statSync(abs); if (st.isFile()) out.push({ path: p, abs, bytes: st.size }); } catch { /* gone */ }
  };
  for (const [t, c, w] of REFS) for (const r of db.prepare(`SELECT DISTINCT ${c} AS p FROM ${t} WHERE ${c} IS NOT NULL${w ? ` AND ${w}` : ''}`).all()) take(r.p);
  for (const r of db.prepare("SELECT provider_media FROM roms WHERE provider_media IS NOT NULL AND provider_media <> ''").all()) {
    try { for (const m of Object.values(JSON.parse(r.provider_media))) if (m && typeof m === 'object') take(m.path); } catch { /* not JSON */ }
  }
  return out;
}

/** Point every reference at a new path (the same transaction as the journal row). rom_files also keeps the picture's type, name and size. */
function repoint(from, to, { type, name, bytes } = {}) {
  let n = 0;
  for (const [t, c, w] of REFS) {
    if (t === 'rom_files') continue;
    n += db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(to, from).changes;
  }
  n += db.prepare("UPDATE rom_files SET path = ?, type = COALESCE(?, type), name = COALESCE(?, name), bytes = COALESCE(?, bytes) WHERE path = ? AND kind <> 'manual'").run(to, type || null, name || null, bytes ?? null, from).changes;
  // the paths a provider's media list keeps, as JSON text
  const esc = (s) => JSON.stringify(s).slice(1, -1);
  for (const r of db.prepare("SELECT id, provider_media FROM roms WHERE instr(provider_media, ?) > 0").all(esc(from))) {
    db.prepare('UPDATE roms SET provider_media = ? WHERE id = ?').run(r.provider_media.split(esc(from)).join(esc(to)), r.id); n++;
  }
  return n;
}

/* ───────── converting one picture ───────── */

const keptPathFor = (abs) => path.join(rootDir(), 'image-originals', path.relative(rootDir(), abs));
const moveFile = (a, b) => { fs.mkdirSync(path.dirname(b), { recursive: true }); try { fs.renameSync(a, b); } catch { fs.copyFileSync(a, b); fs.unlinkSync(a); } };

/** Encode one picture; returns { buffer } when it is worth replacing, else { reason }. Nothing is written. */
async function encode(sharp, abs, quality) {
  const meta = await sharp(abs, { failOn: 'none' }).metadata();
  if ((meta.pages || 1) > 1) return { reason: 'animated' };
  const buffer = await sharp(abs, { failOn: 'none' }).webp({ quality, effort: 5, smartSubsample: true, alphaQuality: 100 }).toBuffer();
  const back = await sharp(buffer).metadata();
  if (back.width !== meta.width || back.height !== meta.height) return { reason: 'size-mismatch' };
  const old = fs.statSync(abs).size;
  if (buffer.length > old * (1 - MIN_SAVING)) return { reason: 'no-saving' };
  return { buffer, old };
}

export async function convertOne(c, quality) {
  const sharp = await getSharp();
  if (!sharp) return { ok: false, reason: 'unavailable' };
  const newAbs = c.abs.replace(IMG, '.webp');
  if (fs.existsSync(newAbs)) return { ok: false, reason: 'exists' };
  let enc;
  try { enc = await encode(sharp, c.abs, quality); } catch { return { ok: false, reason: 'unreadable' }; }
  if (!enc.buffer) { db.prepare('INSERT OR REPLACE INTO image_skips (path, bytes, reason) VALUES (?, ?, ?)').run(c.path, c.bytes, enc.reason); return { ok: false, reason: enc.reason }; }
  const kept = keptPathFor(c.abs);
  // new file first, then the database, then the original moves away: a crash in between leaves a working library (the original is still where the database says)
  const tmp = `${newAbs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, enc.buffer); fs.renameSync(tmp, newAbs);
  const newPath = c.path.replace(IMG, '.webp');
  try {
    db.transaction(() => {
      noteConverted(c.abs, enc.buffer);   // a picture the admin has stopped stays stopped in its new form
      repoint(c.path, newPath, { type: 'image/webp', name: null, bytes: enc.buffer.length });
      db.prepare('INSERT INTO image_conversions (old_path, new_path, kept_path, old_bytes, new_bytes, quality) VALUES (?, ?, ?, ?, ?, ?)').run(c.path, newPath, kept, enc.old, enc.buffer.length, quality);
    })();
  } catch (err) { try { fs.rmSync(newAbs, { force: true }); } catch { /* gone */ } return { ok: false, reason: 'database' }; }
  try { moveFile(c.abs, kept); } catch { /* the original stays beside the copy: harmless, and "kept_path" is then missing, so it cannot be restored from there */ db.prepare('UPDATE image_conversions SET kept_path = NULL WHERE new_path = ? AND restored_at IS NULL').run(newPath); }
  return { ok: true, old: enc.old, now: enc.buffer.length };
}

/* ───────── the job ───────── */

const job = { running: false, stop: false, forced: false, limit: 0, limit_reached: false, total: 0, done: 0, converted: 0, skipped: 0, failed: 0, bytes_saved: 0, current: '', started_at: null, finished_at: null };
let paused = false;
const allowedNow = (forced) => forced || (convertSettings().mode === 'overnight' && (() => { const s = convertSettings(); return inWindow(s.window_start, s.window_end); })());

export function jobStatus() {
  const s = convertSettings();
  const j = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(old_bytes - new_bytes), 0) AS saved, COALESCE(SUM(old_bytes), 0) AS before_bytes, COALESCE(SUM(new_bytes), 0) AS after_bytes FROM image_conversions WHERE restored_at IS NULL").get();
  const keep = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(old_bytes), 0) AS bytes FROM image_conversions WHERE restored_at IS NULL AND purged_at IS NULL AND kept_path IS NOT NULL").get();
  const now = new Date();
  return {
    ...s, ...job, converted_total: j.n, saved_total: j.saved, before_total: j.before_bytes, after_total: j.after_bytes,
    originals_kept: keep.n, originals_kept_bytes: keep.bytes,
    server_time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, server_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    in_window: inWindow(s.window_start, s.window_end), paused
  };
}

/** What a run would do, without changing anything: a sample of the pictures is converted in memory and the saving extrapolated. */
export async function estimate(sample = 30) {
  const sharp = await getSharp();
  if (!sharp) throw Object.assign(new Error('The picture converter is not available on this machine'), { status: 503 });
  const all = candidates(), total = all.reduce((n, c) => n + c.bytes, 0);
  const { quality } = imageSettings();
  // a spread across the library (every n-th), biggest effect first would flatter the result
  const step = Math.max(1, Math.floor(all.length / sample)), picked = all.filter((_, i) => i % step === 0).slice(0, sample);
  let sIn = 0, sOut = 0, ok = 0;
  for (const c of picked) { try { const e = await encode(sharp, c.abs, quality); sIn += c.bytes; if (e.buffer) { sOut += e.buffer.length; ok++; } else sOut += c.bytes; } catch { sIn += c.bytes; sOut += c.bytes; } }
  const ratio = sIn ? sOut / sIn : 1;
  return { pictures: all.length, bytes: total, sampled: picked.length, would_convert_pct: picked.length ? Math.round((100 * ok) / picked.length) : 0, estimated_saving_bytes: Math.round(total * (1 - ratio)), estimated_saving_pct: Math.round(100 * (1 - ratio)), quality };
}

export function startJob({ forced = false, limit = 0 } = {}) {
  if (job.running) return jobStatus();
  if (paused) { const s = convertSettings(); if (s.mode === 'overnight' && !inWindow(s.window_start, s.window_end)) paused = false; }
  if (paused && !forced) return jobStatus();
  if (!forced && !allowedNow(false)) return jobStatus();
  if (forced) paused = false;
  const skipped = new Map(db.prepare('SELECT path, bytes FROM image_skips').all().map((r) => [r.path, r.bytes]));
  const list = candidates().filter((c) => skipped.get(c.path) !== c.bytes);   // what would not shrink last time is not tried again (until the file changes)
  if (!list.length) { Object.assign(job, { total: 0, done: 0, finished_at: new Date().toISOString() }); return jobStatus(); }
  const cap = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 0;   // a trial run: stop after this many pictures have been converted
  Object.assign(job, { running: true, stop: false, forced, limit: cap, limit_reached: false, total: list.length, done: 0, converted: 0, skipped: 0, failed: 0, bytes_saved: 0, current: '', started_at: new Date().toISOString(), finished_at: null });
  (async () => {
    try {
      for (const c of list) {
        if (job.limit && job.converted >= job.limit) { job.limit_reached = true; break; }
        if (job.stop || !allowedNow(job.forced)) break;   // stopped, or the window has closed: the rest waits for the next night
        job.current = path.basename(c.abs);
        const r = await convertOne(c, imageSettings().quality).catch(() => ({ ok: false, reason: 'error' }));
        job.done++;
        if (r.ok) { job.converted++; job.bytes_saved += r.old - r.now; }
        else if (['unreadable', 'database', 'error', 'unavailable'].includes(r.reason)) job.failed++;
        else job.skipped++;
        await new Promise((res) => setImmediate(res));   // let a page request in between pictures
      }
    } finally { job.running = false; job.current = ''; job.finished_at = new Date().toISOString(); clearImageCache(); }
  })();
  return jobStatus();
}
export function stopJob() { paused = true; job.stop = true; return jobStatus(); }
export async function jobIdle(timeoutMs = 20000) { const until = Date.now() + timeoutMs; while (job.running && Date.now() < until) await new Promise((r) => setTimeout(r, 20)); }

/** Put every converted picture back (while its original is still kept): the original returns to its place, the database points at it again, the WebP goes. */
export function restoreAll() {
  const rows = db.prepare('SELECT * FROM image_conversions WHERE restored_at IS NULL ORDER BY id DESC').all();
  const out = { restored: 0, unavailable: 0 };
  for (const r of rows) {
    const keptAbs = r.kept_path && fs.existsSync(r.kept_path) ? r.kept_path : null;
    const oldAbs = path.resolve(r.old_path);
    if (!keptAbs && !fs.existsSync(oldAbs)) { out.unavailable++; continue; }   // the original was removed (its days were up): nothing to put back
    try {
      if (keptAbs) moveFile(keptAbs, oldAbs);
      const stat = fs.statSync(oldAbs);
      const type = /\.png$/i.test(oldAbs) ? 'image/png' : 'image/jpeg';
      db.transaction(() => {
        repoint(r.new_path, r.old_path, { type, bytes: stat.size });
        db.prepare("UPDATE image_conversions SET restored_at = datetime('now') WHERE id = ?").run(r.id);
      })();
      try { fs.rmSync(path.resolve(r.new_path), { force: true }); } catch { /* gone */ }
      out.restored++;
    } catch { out.unavailable++; }
  }
  clearImageCache();
  return out;
}

/** Delete the kept originals that are older than the days the admin chose. Called once an hour or so; the WebP stays and the conversion is final. */
export function purgeOriginals(now = Date.now()) {
  const { keep_days: days, keep_forever } = convertSettings();
  if (keep_forever) return { purged: 0, kept_by_choice: true };   // the admin chose to remove them by hand
  const rows = db.prepare("SELECT id, kept_path FROM image_conversions WHERE restored_at IS NULL AND purged_at IS NULL AND kept_path IS NOT NULL AND converted_at <= datetime(?, 'unixepoch')").all(Math.floor(now / 1000) - days * 86400);
  let purged = 0;
  for (const r of rows) { try { fs.rmSync(r.kept_path, { force: true }); db.prepare("UPDATE image_conversions SET purged_at = datetime('now') WHERE id = ?").run(r.id); purged++; } catch { /* in use */ } }
  return { purged };
}

/** Remove every kept original now, whatever its age (the admin pressed the button). The WebP stays and those conversions become final. */
export function removeKeptOriginals() {
  const rows = db.prepare('SELECT id, kept_path FROM image_conversions WHERE restored_at IS NULL AND purged_at IS NULL AND kept_path IS NOT NULL').all();
  let removed = 0, bytes = 0;
  for (const r of rows) {
    try { try { bytes += fs.statSync(r.kept_path).size; } catch { /* already gone */ } fs.rmSync(r.kept_path, { force: true }); db.prepare("UPDATE image_conversions SET purged_at = datetime('now') WHERE id = ?").run(r.id); removed++; } catch { /* in use */ }
  }
  return { removed, bytes };
}

export function startConvertScheduler(everyMs = 60_000) {
  let lastPurge = 0;
  const tick = () => {
    try {
      if (convertSettings().mode === 'overnight') startJob();
      if (Date.now() - lastPurge > 3_600_000) { lastPurge = Date.now(); purgeOriginals(); }
    } catch { /* the next tick tries again */ }
  };
  setTimeout(tick, 20_000).unref();
  setInterval(tick, everyMs).unref();
}
export { MIN_QUALITY };

/* ───────── what was converted: a list the admin can look through, with the picture before and after ───────── */

/** Which game and which picture a stored file belongs to, from where the database points at it now. */
function whose(p) {
  const rom = db.prepare("SELECT r.title, pl.name AS platform FROM roms r JOIN platforms pl ON pl.id = r.platform_id WHERE r.cover_path = ? LIMIT 1").get(p);
  if (rom) return { title: rom.title, platform: rom.platform, kind: 'cover', list: 'ROM Library' };
  const rf = db.prepare("SELECT r.title, pl.name AS platform, f.kind FROM rom_files f JOIN roms r ON r.id = f.rom_id JOIN platforms pl ON pl.id = r.platform_id WHERE f.path = ? LIMIT 1").get(p);
  if (rf) return { title: rf.title, platform: rf.platform, kind: rf.kind, list: 'ROM Library' };
  for (const col of ['cover', 'spine', 'disc', 'back']) {
    const ph = db.prepare(`SELECT title, platform FROM physical_games WHERE ${col}_path = ? LIMIT 1`).get(p);
    if (ph) return { title: ph.title, platform: ph.platform, kind: col, list: 'Physical' };
  }
  for (const t of ['digital_details', 'digital_user_meta']) {
    const d = db.prepare(`SELECT g.name, g.store FROM ${t} m JOIN digital_games g ON g.store = m.store AND g.app_id = m.app_id WHERE m.cover_path = ? LIMIT 1`).get(p);
    if (d) return { title: d.name, platform: d.store, kind: 'cover', list: 'Digital' };
  }
  const esc = JSON.stringify(p).slice(1, -1);
  const pm = db.prepare("SELECT title FROM roms WHERE instr(provider_media, ?) > 0 LIMIT 1").get(esc);
  if (pm) return { title: pm.title, platform: '', kind: 'provider picture', list: 'ROM Library' };
  return { title: path.basename(p), platform: '', kind: 'picture', list: '' };
}

/** Every stored picture path that belongs to a game whose name contains q (ROM, its files, Physical, Digital), put in a temporary table the query can join. */
function pathsOfGamesNamed(q) {
  const like = String(q).toLowerCase();
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _imgq (p TEXT PRIMARY KEY)'); db.exec('DELETE FROM _imgq');
  const add = db.prepare('INSERT OR IGNORE INTO _imgq (p) VALUES (?)');
  const titled = "(instr(lower(r.title), @q) > 0 OR instr(lower(COALESCE(r.long_title, '')), @q) > 0)";
  const rows = [
    ...db.prepare(`SELECT r.cover_path AS p FROM roms r WHERE r.cover_path IS NOT NULL AND ${titled}`).all({ q: like }),
    ...db.prepare(`SELECT f.path AS p FROM rom_files f JOIN roms r ON r.id = f.rom_id WHERE ${titled}`).all({ q: like }),
    ...['cover', 'spine', 'disc', 'back'].flatMap((c) => db.prepare(`SELECT ${c}_path AS p FROM physical_games WHERE ${c}_path IS NOT NULL AND instr(lower(title), @q) > 0`).all({ q: like })),
    ...['digital_details', 'digital_user_meta'].flatMap((t) => db.prepare(`SELECT m.cover_path AS p FROM ${t} m JOIN digital_games g ON g.store = m.store AND g.app_id = m.app_id WHERE m.cover_path IS NOT NULL AND instr(lower(g.name), @q) > 0`).all({ q: like }))
  ];
  db.transaction(() => { for (const r of rows) add.run(r.p); })();
  // a provider's picture is named inside the game's media list (JSON)
  for (const r of db.prepare(`SELECT r.provider_media AS m FROM roms r WHERE r.provider_media IS NOT NULL AND r.provider_media <> '' AND ${titled}`).all({ q: like })) {
    try { for (const m of Object.values(JSON.parse(r.m))) if (m && typeof m === 'object' && m.path) add.run(m.path); } catch { /* not JSON */ }
  }
}

/** A page of the journal, newest first. q matches the game's name (or long name) or the file name; state: all | converted | restored | final (original removed). */
export function conversionLog({ offset = 0, limit = 25, q = '', state = 'all' } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 25, 1), 100), off = Math.max(Number(offset) || 0, 0);
  const where = [], args = [];
  if (q) {
    pathsOfGamesNamed(q);
    where.push('(instr(lower(old_path), lower(?)) > 0 OR old_path IN (SELECT p FROM _imgq) OR new_path IN (SELECT p FROM _imgq))'); args.push(String(q));
  }
  if (state === 'restored') where.push('restored_at IS NOT NULL');
  else if (state === 'converted') where.push('restored_at IS NULL AND purged_at IS NULL AND kept_path IS NOT NULL');   // the original is still kept
  else if (state === 'final') where.push('restored_at IS NULL AND (purged_at IS NOT NULL OR kept_path IS NULL)');
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM image_conversions ${w}`).get(...args).n;
  const items = db.prepare(`SELECT * FROM image_conversions ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, lim, off).map((r) => {
    const restored = Boolean(r.restored_at), keptNow = Boolean(r.kept_path && !r.purged_at && !restored && fs.existsSync(r.kept_path));
    return {
      id: r.id, ...whose(restored ? r.old_path : r.new_path), file: path.basename(r.old_path), old_bytes: r.old_bytes, new_bytes: r.new_bytes,
      saving_pct: r.old_bytes ? Math.round(100 - (100 * r.new_bytes) / r.old_bytes) : 0, quality: r.quality, converted_at: r.converted_at,
      state: restored ? 'restored' : keptNow ? 'converted' : 'final', can_compare: keptNow
    };
  });
  return { total, offset: off, limit: lim, items };
}

/** The picture before ('original', only while it is kept) or after ('webp') of one journal row. */
export function conversionFile(id, kind) {
  const r = db.prepare('SELECT * FROM image_conversions WHERE id = ?').get(Number(id));
  if (!r) return null;
  const file = kind === 'original' ? (r.restored_at ? r.old_path : r.kept_path) : (r.restored_at ? null : r.new_path);
  return file && fs.existsSync(file) ? path.resolve(file) : null;
}
