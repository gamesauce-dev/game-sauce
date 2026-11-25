import express from 'express';
import multer from 'multer';
import { uploadLimits } from '../lib/uploads.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import db from '../db.js';
import { requireAdmin } from './auth.js';
import { EMULATORS, emulatorFor } from '../lib/emulators.js';
import { storageDir } from '../lib/storage.js';

const router = express.Router();

const emuDir = () => storageDir('emulators');

/* ── curated guide (public to any signed-in user) ── */

router.get('/guide', (req, res) => {
  res.json({ items: EMULATORS });
});

router.get('/guide/:platform', (req, res) => {
  const entry = emulatorFor(req.params.platform);
  if (!entry) return res.status(404).json({ error: 'No recommendation for that platform yet' });
  res.json(entry);
});

/* ── GitHub latest-release check (live network call, short cache) ── */

const releaseCache = new Map(); // repo -> { at, payload }
const failedChecks = new Map(); // repo -> { at, why }: the last check that got no answer at all
const FRESH_MS = 24 * 60 * 60 * 1000;     // an answer is good for a day: new releases only need looking for once a day
const RETRY_MS = 12 * 60 * 60 * 1000;     // after a check that failed, wait half a day (so never more than two tries a day by itself)
const MANUAL_MIN_MS = 10 * 60 * 1000;     // "Check latest releases" may re-ask once an answer is ten minutes old
const NO_RELEASE = 'no published latest release (nightly/rolling builds only)';
let limitedUntil = 0;                     // GitHub told us to stop until this time (ms)

/* Answers survive a restart (a stored copy in metadata_cache) so a reboot does not spend the hourly budget again. */
function storedRelease(repo) {
  try {
    const row = db.prepare("SELECT payload, strftime('%s', fetched_at) AS t FROM metadata_cache WHERE key = ?").get('ghrel:' + repo);
    return row ? { at: Number(row.t) * 1000, payload: JSON.parse(row.payload) } : null;
  } catch { return null; }
}
function keepRelease(repo, payload) {
  releaseCache.set(repo, { at: Date.now(), payload });
  try {
    db.prepare("INSERT INTO metadata_cache (key, provider, payload, fetched_at) VALUES (?, 'github', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
      .run('ghrel:' + repo, JSON.stringify(payload));
  } catch { /* the in-memory copy still works */ }
}
const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);

/**
 * Single source of truth for "what's the latest release of this repo".
 * ALWAYS returns the full payload including assets. Returns { payload, stale? } or { missing: reason } and never throws.
 *
 * GitHub allows an anonymous server only 60 requests an hour. So: each project is looked at once a day. Every answer is kept that long
 * (and across restarts), "there is no release" included. A check that fails falls back to the last good answer instead of showing nothing,
 * and is not tried again by itself for twelve hours. Once GitHub says "slow down" (403/429) nothing more is sent until the time it names.
 * An optional GITHUB_TOKEN raises the limit to 5,000 an hour.
 * Pass { manual: true } for a person pressing the button: it accepts an answer (or a failure) older than ten minutes as out of date.
 */
export async function fetchLatestRelease(repo, { manual = false } = {}) {
  const hit = releaseCache.get(repo) || storedRelease(repo);
  if (hit && !releaseCache.has(repo)) releaseCache.set(repo, hit);
  const kept = (extra) => (hit.payload.none ? { missing: NO_RELEASE } : { payload: hit.payload, cached: true, ...extra });
  if (hit && Date.now() - hit.at < (manual ? MANUAL_MIN_MS : FRESH_MS)) return kept();
  const fallback = (why) => (hit ? kept({ stale: why }) : { missing: why });
  if (Date.now() < limitedUntil) return fallback(`GitHub is limiting requests until about ${clock(limitedUntil)}`);
  const failed = failedChecks.get(repo);
  if (failed && Date.now() - failed.at < (manual ? MANUAL_MIN_MS : RETRY_MS)) return fallback(failed.why);
  const gaveNothing = (why) => { failedChecks.set(repo, { at: Date.now(), why }); return fallback(why); };
  try {
    const token = String(process.env.GITHUB_TOKEN || process.env.GAMESAUCE_GITHUB_TOKEN || '').trim();
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'game-sauce/0.2', Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    });
    // 404 = repo publishes rolling/nightly tags with no "latest" release.
    if (r.status === 404) { failedChecks.delete(repo); keepRelease(repo, { none: true }); return { missing: NO_RELEASE }; }
    if (r.status === 403 || r.status === 429) {
      const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000, wait = Number(r.headers.get('retry-after')) * 1000;
      limitedUntil = Math.max(Date.now() + 60 * 1000, Number.isFinite(reset) && reset > Date.now() ? reset : 0, Number.isFinite(wait) ? Date.now() + wait : 0);
      return fallback(`GitHub is limiting requests until about ${clock(limitedUntil)}`);
    }
    if (!r.ok) return gaveNothing(`GitHub answered ${r.status}`);
    const j = await r.json();
    const payload = {
      tag: j.tag_name,
      name: j.name,
      published_at: j.published_at,
      url: j.html_url,
      assets: (j.assets || []).map((a) => ({
        name: a.name, size: a.size, downloads: a.download_count, url: a.browser_download_url
      }))
    };
    failedChecks.delete(repo);
    keepRelease(repo, payload);
    return { payload };
  } catch (err) {
    return gaveNothing(`GitHub unreachable: ${err.message}`);
  }
}
/** For tests. */
export function _resetReleaseCache() { releaseCache.clear(); failedChecks.clear(); limitedUntil = 0; }

router.get('/latest/:platform', async (req, res) => {
  const entry = emulatorFor(req.params.platform);
  if (!entry) return res.status(404).json({ error: 'No recommendation for that platform yet' });
  if (!entry.github) return res.json({ entry, latest: null, reason: 'no GitHub repo tracked for this pick' });

  const out = await fetchLatestRelease(entry.github, { manual: req.query.refresh === '1' });
  if (out.missing) return res.json({ entry, latest: null, reason: out.missing });
  res.json({ entry, latest: out.payload, cached: Boolean(out.cached), stale: out.stale || null });
});

/* ── vault: your own emulator installers (admin writes, anyone reads) ── */

// Newer-than-vault check: compare every vault entry against the live GitHub
// latest tag and report (a) which tracked emulators have something newer than
// anything in the vault, and (b) which have nothing vaulted at all. Tags are
// free-form ("v1.2", "2506", "nightly-…"), so comparison is "does the vault
// hold exactly this tag" rather than semver. Errors never fail the endpoint —
// an unreachable GitHub just yields `updates: []` + `checked: 0`.
router.get('/updates', async (req, res) => {
  const { EMULATORS } = await import('../lib/emulators.js');
  const tracked = EMULATORS.filter((e) => e.github);
  const vaulted = db.prepare('SELECT name, version, platform_slug FROM emulators').all();
  const vaultTags = new Set(vaulted.map((v) => `${v.name}@@${v.version || ''}`));
  const vaultNames = new Set(vaulted.map((v) => v.name));
  const vaultPlatforms = new Set(vaulted.map((v) => v.platform_slug).filter(Boolean));

  // Sequential: same 60/hr anonymous budget as /latest, and both share the
  // full-payload cache (assets included) via fetchLatestRelease.
  const updates = [];
  let checked = 0;
  for (const e of tracked) {
    const out = await fetchLatestRelease(e.github);
    if (out.missing) continue;
    checked++;
    const tag = out.payload?.tag || out.payload?.name || null;
    if (!tag) continue;
    const inVault = vaultTags.has(`${e.name}@@${tag}`);
    const anyVaulted = vaultNames.has(e.name) || e.platforms.some((s) => vaultPlatforms.has(s));
    // A new build counts when the exact tag is absent. Deliberately silent
    // about *which* build in the compact badge — the Emulators view lists them.
    if (!inVault) {
      updates.push({
        name: e.name,
        platform_label: e.platform_label,
        latest_tag: tag,
        vaulted_any: anyVaulted,
        kind: anyVaulted ? 'newer' : 'missing'
      });
    }
  }
  res.json({ updates, checked, tracked: tracked.length });
});

// 1 GB cap — emulator installers are small; this is not a second ROM library.
const MAX_EMU_BYTES = Number(process.env.GAMESAUCE_MAX_EMULATOR || 1024 * 1024 * 1024);

// The file goes straight to a temporary file on disk, never into memory: an installer can be large.
const vaultUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `gs-emu-${crypto.randomBytes(8).toString('hex')}`)
  }),
  limits: uploadLimits(MAX_EMU_BYTES),
  defParamCharset: 'utf8'   // a file name with accents arrives as written
}).single('file');
const takeVaultFile = (req, res, next) => vaultUpload(req, res, (err) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Emulator file too large (cap 1 GB)' });
  next(err);
});

function sha1Of(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(filePath);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function vaultRow(e) {
  if (!e) return null;
  const { storage_path, ...rest } = e;   // where the file is kept is no part of the answer
  return { ...rest, download_url: e.id ? `/api/emulators/vault/${e.id}/download` : null };
}

/**
 * Move a temp file into the vault. rename() is fast but fails with EXDEV
 * ("cross-device link not permitted") when the temp dir and storage live on
 * different filesystems — exactly the Docker case (tmpfs /tmp vs the
 * gs-storage volume) and common on Windows (C: temp vs D: library). Fall back
 * to copy + unlink, same as placeRom() already does for ROM imports.
 */
function moveIntoPlace(tmp, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(tmp, dest);
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
    fs.copyFileSync(tmp, dest);
    fs.unlinkSync(tmp);
  }
}

function insertVault({ platform_slug, name, version, os, arch, source, source_url, filename, storage_path, size_bytes, sha1, notes }) {
  const info = db.prepare(`
    INSERT INTO emulators (platform_slug, name, version, os, arch, source, source_url, filename, storage_path, size_bytes, sha1, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    platform_slug || null, name, version || null, os || null, arch || null,
    source || 'upload', source_url || null, filename, storage_path, size_bytes, sha1 || null, notes || null
  );
  return db.prepare('SELECT * FROM emulators WHERE id = ?').get(info.lastInsertRowid);
}

router.get('/vault', (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM emulators ORDER BY platform_slug, name').all().map(vaultRow) });
});

router.get('/vault/:id/download', (req, res) => {
  const e = db.prepare('SELECT * FROM emulators WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'No such vault entry' });
  if (!fs.existsSync(e.storage_path)) return res.status(410).json({ error: 'File missing from storage' });
  res.download(e.storage_path, e.filename);
});

/** Manual upload (admin). Fields: file + name, platform_slug (required), version?, os?, arch?, notes? */
router.post('/vault/upload', requireAdmin, takeVaultFile, async (req, res, next) => {   // checked before the file is received
  const tmp = req.file?.path;
  try {
    if (!tmp) return res.status(400).json({ error: 'Send multipart/form-data with a "file" field' });
    const fields = req.body || {};
    const file = { filename: path.basename(req.file.originalname) };
    const platform = String(fields.platform_slug || '').trim();
    if (!platform) {
      return res.status(400).json({ error: 'Platform is required: pick the platform this installer is for' });
    }
    const name = String(fields.name || file.filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')).trim() || 'Emulator';
    const sha1 = await sha1Of(tmp);
    const dupe = db.prepare('SELECT id FROM emulators WHERE sha1 = ?').get(sha1);
    if (dupe) {
      return res.status(200).json(vaultRow(db.prepare('SELECT * FROM emulators WHERE id = ?').get(dupe.id)));
    }
    const dest = path.join(emuDir(), `${sha1.slice(0, 2)}`, `${sha1}-${file.filename}`);
    moveIntoPlace(tmp, dest);
    const row = insertVault({
      platform_slug: fields.platform_slug || null,
      name,
      version: fields.version || null,
      os: fields.os || null,
      arch: fields.arch || null,
      source: 'upload',
      filename: file.filename,
      storage_path: dest,
      size_bytes: req.file.size,
      sha1,
      notes: fields.notes || null
    });
    res.status(201).json(vaultRow(row));
  } catch (err) { next(err); }
  finally { if (tmp) fs.rmSync(tmp, { force: true }); }   // gone already when it was moved into the vault
});

/**
 * Save the official release to the vault (admin). Body: { platform, asset? }.
 * Downloads the GitHub release asset server-side into storage/emulators.
 * Opt-in per click — game-sauce never fetches binaries on its own.
 */
router.post('/vault/from-release', requireAdmin, async (req, res, next) => {
  try {
    const entry = emulatorFor(req.body?.platform);
    if (!entry) return res.status(404).json({ error: 'No recommendation for that platform yet' });
    if (!entry.github) return res.status(400).json({ error: 'No GitHub repo tracked for this pick' });

    // The same remembered answer the page is showing (kept a day, and the last good one while GitHub is refusing): asking afresh here
    // spent one of GitHub's rationed requests on every save, without the token or the wait it asked for.
    const known = await fetchLatestRelease(entry.github);
    if (known.missing) return res.status(502).json({ error: known.missing });
    const release = known.payload;
    const assets = release.assets || [];
    if (!assets.length) return res.status(400).json({ error: 'Release has no downloadable assets' });
    const want = String(req.body?.asset || '');
    const picked = want
      ? assets.find((a) => a.name === want || a.url === want)
      : assets.find((a) => /(^|[^a-z])win(dows|32|64)?([^a-z]|$)/i.test(a.name)) || assets.find((a) => /\.zip$/i.test(a.name)) || assets[0];
    if (!picked) return res.status(400).json({ error: 'No matching asset in the latest release' });

    // Prefer a Windows asset when the caller doesn't choose; Linux/macOS users
    // pick the matching asset from the dropdown. Size cap enforced on stream.
    const dl = await fetch(picked.url, {
      signal: AbortSignal.timeout(120000),
      headers: { 'User-Agent': 'game-sauce/0.2' }
    });
    if (!dl.ok || !dl.body) return res.status(502).json({ error: `Download failed (${dl.status})` });
    const tmp = path.join(os.tmpdir(), `gs-emu-${crypto.randomBytes(8).toString('hex')}`);
    const out = fs.createWriteStream(tmp);
    let bytes = 0;
    try {
      for await (const chunk of dl.body) {
        bytes += chunk.length;
        if (bytes > MAX_EMU_BYTES) throw Object.assign(new Error('Emulator file too large (cap 1 GB)'), { status: 413 });
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
    } catch (err) {
      try { out.destroy(); } catch { /* ignore */ }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
    const sha1 = await sha1Of(tmp);
    const dupe = db.prepare('SELECT id FROM emulators WHERE sha1 = ?').get(sha1);
    if (dupe) {
      fs.unlinkSync(tmp);
      return res.status(200).json(vaultRow(db.prepare('SELECT * FROM emulators WHERE id = ?').get(dupe.id)));
    }
    const dest = path.join(emuDir(), `${sha1.slice(0, 2)}`, `${sha1}-${picked.name}`);
    moveIntoPlace(tmp, dest);
    const row = insertVault({
      platform_slug: (entry.platforms || [])[0] || null,
      name: entry.name,
      version: release.tag || null,
      source: 'github-release',
      source_url: picked.url,
      filename: picked.name,
      storage_path: dest,
      size_bytes: bytes,
      sha1,
      notes: `Official ${entry.name} ${release.tag || ''} from GitHub`.trim()
    });
    res.status(201).json(vaultRow(row));
  } catch (err) { next(err); }
});

router.delete('/vault/:id', requireAdmin, (req, res) => {
  const e = db.prepare('SELECT * FROM emulators WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'No such vault entry' });
  db.prepare('DELETE FROM emulators WHERE id = ?').run(e.id);
  try { if (e.storage_path && fs.existsSync(e.storage_path)) fs.unlinkSync(e.storage_path); } catch { /* best effort */ }
  res.json({ deleted: Number(e.id) });
});

export default router;
