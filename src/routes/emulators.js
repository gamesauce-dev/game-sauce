import express from 'express';
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

/**
 * Single source of truth for "what's the latest release of this repo".
 * ALWAYS returns the full payload including assets — the /updates endpoint
 * used to cache a tag-only shape, which then starved the Emulators view of
 * its asset dropdown (the "download option disappeared" regression). Both
 * callers go through here so the cache can never hold a partial payload.
 * Returns { payload } or { missing: reason } — never throws.
 */
async function fetchLatestRelease(repo) {
  const hit = releaseCache.get(repo);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return { payload: hit.payload, cached: true };
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'game-sauce/0.2', Accept: 'application/vnd.github+json' }
    });
    // 404 = repo publishes rolling/nightly tags with no "latest" release.
    if (r.status === 404) return { missing: 'no published latest release (nightly/rolling builds only)' };
    if (!r.ok) return { missing: `GitHub answered ${r.status}` };
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
    releaseCache.set(repo, { at: Date.now(), payload });
    return { payload };
  } catch (err) {
    return { missing: `GitHub unreachable: ${err.message}` };
  }
}

router.get('/latest/:platform', async (req, res) => {
  const entry = emulatorFor(req.params.platform);
  if (!entry) return res.status(404).json({ error: 'No recommendation for that platform yet' });
  if (!entry.github) return res.json({ entry, latest: null, reason: 'no GitHub repo tracked for this pick' });

  const out = await fetchLatestRelease(entry.github);
  if (out.missing) return res.json({ entry, latest: null, reason: out.missing });
  res.json({ entry, latest: out.payload, cached: Boolean(out.cached) });
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

/**
 * Minimal multipart parser (single file + text fields) so the vault upload
 * needs no new dependency. Streams the file to temp; fields stay in memory.
 */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const ctype = req.headers['content-type'] || '';
    const m = ctype.match(/boundary=(.+)$/);
    if (!m) return reject(Object.assign(new Error('Send multipart/form-data with a "file" field'), { status: 400 }));
    const boundary = Buffer.from('--' + m[1].trim().replace(/"/g, ''));
    const chunks = [];
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_EMU_BYTES + 1024 * 1024) {
        reject(Object.assign(new Error('Emulator file too large (cap 1 GB)'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const parts = [];
        let start = 0;
        for (;;) {
          const i = body.indexOf(boundary, start);
          if (i < 0) break;
          parts.push(body.subarray(start, i));
          start = i + boundary.length;
        }
        const fields = {};
        let file = null;
        for (const part of parts) {
          const headEnd = part.indexOf(Buffer.from('\r\n\r\n'));
          if (headEnd < 0) continue;
          const head = part.subarray(0, headEnd).toString('latin1');
          let data = part.subarray(headEnd + 4);
          if (data.subarray(-2).toString() === '\r\n') data = data.subarray(0, -2);
          const nameM = head.match(/name="([^"]+)"/);
          const fileM = head.match(/filename="([^"]*)"/);
          if (!nameM) continue;
          if (fileM && fileM[1]) {
            file = { filename: path.basename(fileM[1]), data };
          } else {
            fields[nameM[1]] = data.toString('utf8');
          }
        }
        if (!file) return reject(Object.assign(new Error('Multipart body needs a "file" field'), { status: 400 }));
        resolve({ fields, file });
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

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
  return { ...e, download_url: e.id ? `/api/emulators/vault/${e.id}/download` : null };
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
router.post('/vault/upload', requireAdmin, async (req, res, next) => {
  try {
    const { fields, file } = await parseMultipart(req);
    const platform = String(fields.platform_slug || '').trim();
    if (!platform) {
      return res.status(400).json({ error: 'Platform is required: pick the platform this installer is for' });
    }
    const name = String(fields.name || file.filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')).trim() || 'Emulator';
    const tmp = path.join(os.tmpdir(), `gs-emu-${crypto.randomBytes(8).toString('hex')}`);
    fs.writeFileSync(tmp, file.data);
    const sha1 = await sha1Of(tmp);
    const dupe = db.prepare('SELECT id FROM emulators WHERE sha1 = ?').get(sha1);
    if (dupe) {
      fs.unlinkSync(tmp);
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
      size_bytes: file.data.length,
      sha1,
      notes: fields.notes || null
    });
    res.status(201).json(vaultRow(row));
  } catch (err) { next(err); }
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

    const rel = await fetch(`https://api.github.com/repos/${entry.github}/releases/latest`, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'game-sauce/0.2', Accept: 'application/vnd.github+json' }
    });
    if (!rel.ok) return res.status(502).json({ error: `GitHub answered ${rel.status}` });
    const j = await rel.json();
    const assets = j.assets || [];
    if (!assets.length) return res.status(400).json({ error: 'Release has no downloadable assets' });
    const want = String(req.body?.asset || '');
    const picked = want
      ? assets.find((a) => a.name === want || a.browser_download_url === want)
      : assets.find((a) => /win|windows|\.zip$/i.test(a.name)) || assets[0];
    if (!picked) return res.status(400).json({ error: 'No matching asset in the latest release' });

    // Prefer a Windows asset when the caller doesn't choose; Linux/macOS users
    // pick the matching asset from the dropdown. Size cap enforced on stream.
    const dl = await fetch(picked.browser_download_url, {
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
      version: j.tag_name || null,
      source: 'github-release',
      source_url: picked.browser_download_url,
      filename: picked.name,
      storage_path: dest,
      size_bytes: bytes,
      sha1,
      notes: `Official ${entry.name} ${j.tag_name || ''} from GitHub`.trim()
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
