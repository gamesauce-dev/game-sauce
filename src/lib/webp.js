// WebP copies of pictures, made as they are first asked for: smaller files to send, the same picture to look at.
//
// The stored picture (a cover, spine, disc ...) is NEVER changed or replaced, so exports, the cover zip, the launcher pack and every path in
// the database stay exactly as they were. A browser that accepts WebP is sent a copy kept in <storage>/image-cache instead:
//   - a thumbnail (?w=320 or ?w=640) for the tiles of a grid: made at once (it takes about 20 ms), because a tile should not wait for a big file;
//   - the full-size picture as WebP: made in the background, so the first request gets the original and the next ones the copy.
// Turning the setting off, or changing the quality, simply stops using / rebuilds the copies. The conversion needs `sharp`; without it
// (an unusual platform) everything is sent as before.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import db from '../db.js';
import { rootDir } from './storage.js';

/** The lowest quality an admin may choose: below this, covers start to show blocks and ringing. */
export const MIN_QUALITY = 70;
export const MAX_QUALITY = 95;
export const DEFAULT_QUALITY = 85;
export const THUMB_WIDTHS = [320, 640];
const KEY_ENABLED = 'images.webp_enabled';
const KEY_QUALITY = 'images.webp_quality';
const MIN_SAVING = 0.10;           // a full-size copy must be at least this much smaller than the original, or the original is kept
const CONVERTIBLE = new Set(['.png', '.jpg', '.jpeg']);   // a GIF may be animated, a WebP is already one
const MAX_WAITING = 40;            // more thumbnails than this waiting: send the original and make the thumbnail afterwards

let cached = null;
function readSettings() {
  if (cached) return cached;
  const get = (k) => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(k)?.value;
  const q = Number(get(KEY_QUALITY));
  cached = {
    enabled: get(KEY_ENABLED) !== '0',   // on unless an admin turned it off
    quality: Number.isInteger(q) && q >= MIN_QUALITY && q <= MAX_QUALITY ? q : DEFAULT_QUALITY
  };
  return cached;
}
export const imageSettings = () => ({ ...readSettings() });

/** Save the admin's choice. A quality outside MIN_QUALITY..MAX_QUALITY is refused, never clamped silently. */
export function saveImageSettings({ enabled, quality }, userId = null) {
  const out = { ...readSettings() };
  if (quality !== undefined && quality !== null && quality !== '') {
    const q = Number(quality);
    if (!Number.isInteger(q)) throw Object.assign(new Error('Quality must be a whole number'), { status: 400 });
    if (q < MIN_QUALITY) throw Object.assign(new Error(`Quality cannot be lower than ${MIN_QUALITY}: below that covers start to show blocky edges`), { status: 400 });
    if (q > MAX_QUALITY) throw Object.assign(new Error(`Quality cannot be higher than ${MAX_QUALITY}: more only makes the files bigger`), { status: 400 });
    out.quality = q;
  }
  if (enabled !== undefined) out.enabled = Boolean(enabled);
  const put = db.prepare(`INSERT INTO app_settings (key, value, encrypted, updated_by, updated_at) VALUES (?, ?, 0, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`);
  const was = readSettings();
  put.run(KEY_ENABLED, out.enabled ? '1' : '0', userId);
  put.run(KEY_QUALITY, String(out.quality), userId);
  cached = out;
  if (was.quality !== out.quality) clearImageCache();   // copies made at the old quality are not kept
  return { ...out };
}

const cacheDir = () => path.join(rootDir(), 'image-cache');

export function clearImageCache() {
  let files = 0, bytes = 0;
  try { for (const f of fs.readdirSync(cacheDir())) { try { const p = path.join(cacheDir(), f); bytes += fs.statSync(p).size; fs.rmSync(p, { force: true }); files++; } catch { /* in use */ } } } catch { /* none yet */ }
  return { files, bytes };
}

export function imageCacheInfo() {
  let files = 0, bytes = 0;
  try { for (const f of fs.readdirSync(cacheDir())) { if (f.endsWith('.webp')) { files++; bytes += fs.statSync(path.join(cacheDir(), f)).size; } } } catch { /* none yet */ }
  return { files, bytes };
}

export const stats = { thumbnails: 0, converted: 0, kept_original: 0, failed: 0, bytes_in: 0, bytes_out: 0 };

let sharpP = null;
/** sharp, or null when it cannot be loaded here (the feature then switches itself off). */
export function getSharp() {
  sharpP ||= import('sharp').then((m) => { const s = m.default; try { s.concurrency(Math.max(1, Math.min(2, os.cpus().length))); } catch { /* default */ } return s; }).catch(() => null);
  return sharpP;
}
export const webpAvailable = async () => Boolean(await getSharp());

// A few conversions at once (never more than 4), so a bulk import never starves the pages being served.
const LIMIT = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));   // 2 on a small machine, up to 4 on a big one
let running = 0;
const waiting = [];
const inflight = new Map();
function schedule(key, job) {
  if (inflight.has(key)) return inflight.get(key);
  const p = new Promise((resolve) => {
    const start = () => { running++; job().then(resolve, () => resolve(null)).finally(() => { running--; inflight.delete(key); waiting.shift()?.(); }); };
    if (running < LIMIT) start(); else waiting.push(start);
  });
  inflight.set(key, p);
  return p;
}
export const queueLength = () => waiting.length;

function variantKey(abs, st, width, quality) {
  return crypto.createHash('sha1').update(`${abs}|${st.size}|${st.mtimeMs}|${width || 0}|${quality}`).digest('hex').slice(0, 28);
}

/** Make (or find) the copy. Returns its path, or null when the original should be used (not smaller, animated, not a picture). */
async function makeVariant(abs, width) {
  const st = fs.statSync(abs);
  const { quality } = readSettings();
  const base = path.join(cacheDir(), variantKey(abs, st, width, quality));
  const file = `${base}.webp`, skip = `${base}.skip`;
  if (fs.existsSync(file)) return file;
  if (fs.existsSync(skip)) return null;
  return schedule(base, async () => {
    const sharp = await getSharp(); if (!sharp) return null;
    fs.mkdirSync(cacheDir(), { recursive: true });
    const tmp = `${base}.${process.pid}.tmp`;
    try {
      const meta = await sharp(abs, { failOn: 'none' }).metadata();
      if ((meta.pages || 1) > 1) { fs.writeFileSync(skip, ''); return null; }   // animated: left as it is
      let img = sharp(abs, { failOn: 'none' });
      if (width) img = img.resize({ width, withoutEnlargement: true });
      await img.webp({ quality, effort: 4, smartSubsample: true, alphaQuality: 100 }).toFile(tmp);
      const out = fs.statSync(tmp).size;
      if (!width && out > st.size * (1 - MIN_SAVING)) { fs.rmSync(tmp, { force: true }); fs.writeFileSync(skip, ''); stats.kept_original++; return null; }   // no real saving: keep the original
      fs.renameSync(tmp, file);
      if (width) stats.thumbnails++; else { stats.converted++; stats.bytes_in += st.size; stats.bytes_out += out; }
      return file;
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ }
      stats.failed++;
      try { fs.writeFileSync(skip, ''); } catch { /* read-only: it will be tried again */ }
      return null;
    }
  });
}

/**
 * Send a stored picture: as a WebP copy when the setting is on and the browser accepts WebP, otherwise the file itself.
 * Never throws: any problem falls back to the original. Headers (Cache-Control) are the caller's.
 */
export async function sendImage(req, res, file) {
  const abs = path.resolve(file);
  const original = () => res.sendFile(abs);
  try {
    if (!readSettings().enabled || !CONVERTIBLE.has(path.extname(abs).toLowerCase())) return original();
    res.vary('Accept');
    if (!String(req.headers.accept || '').includes('image/webp') || !(await getSharp())) return original();
    const w = Number(req.query?.w);
    const width = THUMB_WIDTHS.includes(w) ? w : 0;
    const st = fs.statSync(abs);
    const ready = `${path.join(cacheDir(), variantKey(abs, st, width, readSettings().quality))}.webp`;
    let variant = fs.existsSync(ready) ? ready : null;
    if (!variant) {
      if (width && queueLength() < MAX_WAITING) variant = await makeVariant(abs, width);   // a thumbnail is made now (a few ms)
      else makeVariant(abs, width).catch(() => {});                                       // the full picture is made behind the request
    }
    if (!variant) return original();
    res.type('image/webp');
    return res.sendFile(variant);
  } catch {
    if (!res.headersSent) return original();
  }
}

/* ───────── the admin's preview: the same piece of a real cover, original and WebP, before a quality is chosen ───────── */

const CROP = 480;   // shown at 100%, so what the admin sees is what a pixel looks like

/** A cover from the library to judge by: the one asked for, else a random PNG or JPEG one (the kind that gets converted). */
function previewSample(romId) {
  const rows = romId
    ? db.prepare('SELECT id, title, cover_path FROM roms WHERE id = ? AND cover_path IS NOT NULL').all(Number(romId))
    : db.prepare("SELECT id, title, cover_path FROM roms WHERE cover_path IS NOT NULL AND (lower(cover_path) LIKE '%.png' OR lower(cover_path) LIKE '%.jpg' OR lower(cover_path) LIKE '%.jpeg') ORDER BY RANDOM() LIMIT 12").all();
  return rows.find((r) => r.cover_path && fs.existsSync(r.cover_path) && CONVERTIBLE.has(path.extname(r.cover_path).toLowerCase())) || null;
}

function checkedQuality(q) {
  const n = Number(q === undefined || q === '' ? readSettings().quality : q);
  if (!Number.isInteger(n) || n < MIN_QUALITY || n > MAX_QUALITY) throw Object.assign(new Error(`Quality must be a whole number from ${MIN_QUALITY} to ${MAX_QUALITY}`), { status: 400 });
  return n;
}

/** The numbers for the preview: the cover chosen, its size now, and its size as WebP at this quality. */
export async function previewInfo({ rom, quality } = {}) {
  const q = checkedQuality(quality);
  const sharp = await getSharp();
  if (!sharp) throw Object.assign(new Error('The picture converter is not available on this machine'), { status: 503 });
  const s = previewSample(rom);
  if (!s) return { sample: null, quality: q };
  const meta = await sharp(s.cover_path, { failOn: 'none' }).metadata();
  const webp = await sharp(s.cover_path, { failOn: 'none' }).webp({ quality: q, effort: 4, smartSubsample: true, alphaQuality: 100 }).toBuffer();
  const orig = fs.statSync(s.cover_path).size;
  return { sample: { id: s.id, title: s.title }, quality: q, width: meta.width, height: meta.height, format: meta.format, original_bytes: orig, webp_bytes: webp.length, saving_pct: Math.round(100 - (100 * webp.length) / orig), crop: { w: Math.min(CROP, meta.width), h: Math.min(CROP, meta.height) } };
}

/** The middle of the cover at 100%: as PNG from the original (kind 'original'), or as WebP at this quality (kind 'webp'). The same pixels either way. */
export async function previewCrop({ rom, quality, kind }) {
  const q = checkedQuality(quality);
  const sharp = await getSharp();
  if (!sharp) throw Object.assign(new Error('The picture converter is not available on this machine'), { status: 503 });
  const s = previewSample(rom);
  if (!s) throw Object.assign(new Error('No cover to preview'), { status: 404 });
  const meta = await sharp(s.cover_path, { failOn: 'none' }).metadata();
  const w = Math.min(CROP, meta.width), h = Math.min(CROP, meta.height);
  const region = { left: Math.floor((meta.width - w) / 2), top: Math.floor((meta.height - h) / 2), width: w, height: h };
  // the crop is taken from the whole picture encoded at this quality, as it would be sent (a WebP of a crop alone would not match)
  const base = kind === 'webp' ? await sharp(s.cover_path, { failOn: 'none' }).webp({ quality: q, effort: 4, smartSubsample: true, alphaQuality: 100 }).toBuffer() : s.cover_path;
  return sharp(base, { failOn: 'none' }).extract(region).png().toBuffer();
}
