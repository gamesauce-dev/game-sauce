import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db from '../db.js';
import { parseFilename, sortTitle } from './metadata.js';
import {
  ALL_EXTENSIONS, PLATFORM_BY_SLUG, candidatePlatforms, detectPlatform, folderNamesFor, extensionAllowed
} from './platforms.js';
import { hashFile } from './hash.js';
import { applyDatMatch } from '../dats.js';
import { applyMameNames, mameTitleTrusted } from './mamenames.js';

/** Files that are part of a disc set but are not the game itself. */
const SIDECAR_EXT = new Set(['cue', 'gdi', 'ccd', 'm3u', 'dat', 'sbi', 'sub', 'toc']);
const IGNORED_DIRS = new Set(['.git', '.svn', '__macosx', 'system volume information', '$recycle.bin', '.trash', 'node_modules']);
const IGNORED_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/**
 * Guess a platform from the folder names between the source root and the file.
 * "D:/roms/ps4/Game.pkg" -> ps4, even though .pkg is shared by PS3/4/5.
 * Returns { slug, confidence: 'hint' | 'folder' | 'extension' | 'none' }.
 */
export function resolvePlatform({ filename, relativePath, sourceHint }) {
  const ext = (filename.split('.').pop() || '').toLowerCase();

  // 1. An explicit hint on the source always wins — the user told us.
  if (sourceHint && (PLATFORM_BY_SLUG.has(sourceHint) || db.prepare('SELECT 1 FROM platforms WHERE slug = ?').get(String(sourceHint)))) {
    return { slug: sourceHint, confidence: 'hint' };
  }

  const candidates = candidatePlatforms(ext);

  // 2. A folder name that matches a platform slug/short name disambiguates
  //    shared extensions: .../PlayStation 4/..., .../PS5/..., .../switch/...
  const segments = String(relativePath || '').split(/[\\/]/).slice(0, -1);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!seg) continue;
    for (const slug of candidates) {
      if (folderNamesFor(slug).includes(seg)) return { slug, confidence: 'folder' };
    }
    // Family folders: ".../Sony/", ".../Nintendo/" — narrow by family.
    for (const slug of candidates) {
      const p = PLATFORM_BY_SLUG.get(slug);
      if (p.family && p.family.toLowerCase().replace(/[^a-z0-9]/g, '') === seg) {
        return { slug, confidence: 'folder' };
      }
    }
  }

  // 3. Unambiguous extension.
  const byExt = detectPlatform(filename);
  if (byExt) return { slug: byExt, confidence: 'extension' };

  // 4. One candidate only (after aliases) — safe enough.
  if (candidates.length === 1) return { slug: candidates[0], confidence: 'extension' };

  return { slug: 'other', confidence: 'none', candidates };
}

function matchIgnore(relPath, globs) {
  if (!globs?.length) return false;
  const name = path.basename(relPath).toLowerCase();
  return globs.some((g) => {
    const pat = g.trim().toLowerCase();
    if (!pat) return false;
    if (pat.startsWith('*.')) return name.endsWith(pat.slice(1));
    // "temp.*" — prefix glob
    if (pat.endsWith('.*')) return name.startsWith(pat.slice(0, -1));
    if (pat.includes('*')) {
      const rx = new RegExp('^' + pat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return rx.test(name);
    }
    return name === pat || relPath.toLowerCase().includes(pat);
  });
}

/**
 * Walk a source folder. Returns entries for ROM-ish files, skipping sidecars
 * whose disc image is present in the same directory.
 */
export function walkSource(source) {
  const root = path.resolve(source.path);
  const ignoreGlobs = source.ignore_globs ? String(source.ignore_globs).split(',') : [];
  const found = [];
  const seen = [];
  // Extensions of user-created platforms (the built-in list doesn't know them).
  const customExts = new Set();
  try {
    for (const r of db.prepare('SELECT extensions FROM platforms').all()) {
      for (const e of String(r.extensions || '').split(',')) if (e.trim()) customExts.add(e.trim().toLowerCase());
    }
  } catch { /* table missing in odd test setups */ }

  const visit = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      seen.push({ dir, error: err.code || err.message });
      return;
    }

    const present = new Set(entries.filter((e) => e.isFile()).map((e) => e.name.toLowerCase()));

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);

      if (entry.isDirectory()) {
        if (!source.recursive) continue;
        if (IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
        if (depth > 24) continue;
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const lower = entry.name.toLowerCase();
      if (IGNORED_FILES.has(lower)) continue;
      if (lower.startsWith('._')) continue; // macOS resource forks
      if (matchIgnore(rel, ignoreGlobs)) continue;

      const ext = lower.split('.').pop() || '';
      if (!ALL_EXTENSIONS.has(ext) && !customExts.has(ext)) continue;
      // Strict platforms (MAME = .zip only): ignore anything else in the folder.
      if (source.platform_hint && !extensionAllowed(source.platform_hint, entry.name)) continue;

      // A .cue/.gdi/.m3u next to its .bin/.iso/.chd is a descriptor, not a game.
      if (SIDECAR_EXT.has(ext)) {
        const base = entry.name.slice(0, entry.name.length - ext.length - 1).toLowerCase();
        const siblings = [...present].filter((n) => !SIDECAR_EXT.has(n.split('.').pop()));
        const hasImage = siblings.some((n) => n.startsWith(base) || base.startsWith(n.split('.')[0]));
        if (hasImage && !lower.endsWith('.m3u')) continue;
      }

      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size === 0) continue;

      found.push({
        path: full,
        relativePath: rel,
        filename: entry.name,
        ext,
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs)
      });
    }
  };

  visit(root, 0);
  return { found, errors: seen };
}

/**
 * Re-apply filename parsing to an existing row. Titles from a metadata provider
 * are never overwritten — only titles we derived from the filename ourselves.
 */
function refreshFromFilename(existing, filename, source, romId, relativePath = '') {
  const parsed = parseFilename(filename);
  const platform = resolvePlatform({
    filename,
    relativePath: relativePath || path.basename(filename),
    sourceHint: source.platform_hint
  });
  const platformRow = db.prepare('SELECT id FROM platforms WHERE slug = ?').get(platform.slug)
    || db.prepare("SELECT id FROM platforms WHERE slug = 'other'").get();

  const renameTitle = existing.title_source !== 'provider';
  db.prepare(`
    UPDATE roms SET
      title = CASE WHEN ? THEN ? ELSE title END,
      sort_title = CASE WHEN ? THEN ? ELSE sort_title END,
      region = COALESCE(?, region),
      revision = COALESCE(?, revision),
      release_year = COALESCE(?, release_year),
      platform_id = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    renameTitle ? 1 : 0, parsed.title, renameTitle ? 1 : 0, sortTitle(parsed.title),
    parsed.region, parsed.revision, parsed.year,
    platformRow.id, romId
  );
}

/** Cheap identity for a file so a rescan can skip hashing unchanged files. */
function quickKey(sourceId, relPath, size, mtimeMs) {
  return crypto.createHash('sha1')
    .update(`${sourceId}:${relPath}:${size}:${mtimeMs}`)
    .digest('hex');
}

/* ── live progress ──────────────────────────────────────────────────────────
   In-memory, per source. The scan request itself stays a single blocking POST;
   the UI polls getScanProgress() while it is in flight (and on page load, so a
   refresh mid-scan shows the bar again). Lost on restart — a rescan resumes
   cheaply because unchanged files are skipped. */
const PROGRESS = new Map();
export function getScanProgress(sourceId) {
  return PROGRESS.get(Number(sourceId)) || null;
}
export function getAllScanProgress() {
  return [...PROGRESS.values()];
}

export async function scanSource(sourceId, { hash = true, enrich = null, onProgress = null } = {}) {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
  if (!source) throw new Error('Source not found');

  // Auto-metadata: run enrichment on the newly added ROMs after the scan (the
  // UI's "scan" button also passes enrich=true). Serial per-ROM; token-bucket
  // inside enrich() keeps provider quotas safe.
  const enrichNew = async (ids) => {
    if (!ids.length || !enrich) return { updated: 0, failed: 0, skipped: 0 };
    prog.phase = 'enriching'; prog.total = ids.length; prog.done = 0;
    try {
      const { enrich: enrichImpl } = await import('./providers.js');
      const out = { updated: 0, failed: 0, skipped: 0 };
      for (const id of ids) {
        prog.done++;
        const rom = db.prepare(`
          SELECT r.*, p.slug AS platform_slug, p.screenscraper_id, p.tgdb_id
          FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?
        `).get(id);
        if (!rom) { out.skipped++; continue; }
        const meta = await enrichImpl({
          filename: rom.filename,
          titleTrusted: mameTitleTrusted(rom.platform_slug, rom.filename),
          title: rom.title,
          platform: { slug: rom.platform_slug, screenscraper_id: rom.screenscraper_id, tgdb_id: rom.tgdb_id },
          hashes: { crc32: rom.crc32, md5: rom.md5, sha1: rom.sha1 }
        }).catch(() => null);
        if (!meta || meta.error) { out.failed++; continue; }
        const { applyMetadataRecord } = await import('../routes/roms.js');
        await applyMetadataRecord(id, meta);
        out.updated++;
      }
      return out;
    } catch { return { updated: 0, failed: ids.length, skipped: 0 }; }
  };

  const started = Date.now();
  const existingRun = PROGRESS.get(Number(sourceId));
  if (existingRun && existingRun.phase !== 'done') throw Object.assign(new Error('A scan of this source is already running'), { status: 409 });
  const prog = { source_id: Number(sourceId), source: source.name, phase: 'finding', total: 0, done: 0, added: 0, skipped: 0, failed: 0, file: '', started_at: started };
  PROGRESS.set(Number(sourceId), prog);
  try {
  const log = db.prepare('INSERT INTO scan_log (source_id) VALUES (?)').run(sourceId);
  const logId = Number(log.lastInsertRowid);

  let rootExists = true;
  try {
    rootExists = fs.statSync(source.path).isDirectory();
  } catch {
    rootExists = false;
  }

  if (!rootExists) {
    db.prepare("UPDATE scan_log SET finished_at = datetime('now'), error = ? WHERE id = ?")
      .run('Source folder is not reachable', logId);
    db.prepare(`UPDATE sources SET last_scan_at = datetime('now'), last_scan_error = ? WHERE id = ?`)
      .run('Source folder is not reachable', sourceId);
    return { found: 0, added: 0, updated: 0, missing: 0, skipped: 0, error: 'Source folder is not reachable' };
  }

  const { found, errors } = walkSource(source);
  prog.phase = 'importing'; prog.total = found.length;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const known = new Map(
    db.prepare('SELECT id, source_path, scanned_size, scanned_mtime, sha1, title, meta_source AS title_source FROM roms WHERE source_id = ?')
      .all(sourceId)
      .map((r) => [r.source_path, r])
  );

  let added = 0, updated = 0, skipped = 0, failed = 0, firstFailure = null;
  const touched = new Set();
  const addedRoms = [];

  for (const file of found) {
   // One bad file (e.g. a UNIQUE clash on identical content) must never abort
   // the other hundreds: count it, remember the first message, carry on.
   try {
    prog.done++; prog.file = file.filename; prog.added = added; prog.skipped = skipped; prog.failed = failed;
    const existing = known.get(file.path);

    // Unchanged on disk: no hashing, but still re-derive the filename metadata so
    // that parser fixes reach the existing catalogue instead of only new files.
    if (existing && existing.scanned_size === file.size && existing.scanned_mtime === file.mtimeMs) {
      refreshFromFilename(existing, file.filename, source, existing.id, file.relativePath);
      // Found on disk again: clear a stale 'missing' flag (set while a drive/share was
      // offline). Without this an unchanged file stayed flagged missing forever, because
      // only the changed-file path below reset it.
      db.prepare("UPDATE roms SET missing = 0, last_seen_at = ? WHERE id = ? AND missing = 1").run(now, existing.id);
      touched.add(existing.id);
      skipped++;
      continue;
    }

    const platform = resolvePlatform({
      filename: file.filename,
      relativePath: file.relativePath,
      sourceHint: source.platform_hint
    });
    const platformRow = db.prepare('SELECT * FROM platforms WHERE slug = ?').get(platform.slug)
      || db.prepare("SELECT * FROM platforms WHERE slug = 'other'").get();

    const parsed = parseFilename(file.filename);

    let hashes = { crc32: null, md5: null, sha1: null };
    if (hash) {
      try {
        hashes = await hashFile(file.path);
      } catch {
        // Unreadable file (permissions, network drop) — still catalog it by path.
      }
    }

    if (existing) {
      // Parsing rules improve over time, so re-derive the fields that come purely
      // from the filename whenever the file itself is re-processed.
      refreshFromFilename(existing, file.filename, source, existing.id, file.relativePath);
      db.prepare(`
        UPDATE roms SET
          platform_id = ?, size_bytes = ?, scanned_size = ?, scanned_mtime = ?,
          missing = 0, last_seen_at = ?, storage_path = ?, source_path = ?,
          crc32 = COALESCE(?, crc32), md5 = COALESCE(?, md5), sha1 = COALESCE(?, sha1),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        platformRow.id, file.size, file.size, file.mtimeMs, now, file.path, file.path,
        hashes.crc32, hashes.md5, hashes.sha1, existing.id
      );
      touched.add(existing.id);
      updated++;
      continue;
    }

    // New file. Guard against the same content living in two sources: if a ROM
    // with this SHA1 exists elsewhere we keep the existing row and record the
    // extra path rather than creating a second entry the user did not ask for.
    if (hashes.sha1) {
      // Any existing row with this SHA1 (same source or another): the schema has a
      // UNIQUE index on sha1, so inserting would throw.
      const dupe = db.prepare('SELECT id, title FROM roms WHERE sha1 = ?').get(hashes.sha1);
      if (dupe) {
        skipped++;
        continue;
      }
    }

    const info = db.prepare(`
      INSERT INTO roms (
        platform_id, title, sort_title, filename, storage_path, source_path,
        source_id, in_place, size_bytes, scanned_size, scanned_mtime, last_seen_at,
        region, revision, release_year, crc32, md5, sha1, meta_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'filename')
    `).run(
      platformRow.id, parsed.title, sortTitle(parsed.title), file.filename,
      file.path, file.path, sourceId, file.size, file.size, file.mtimeMs, now,
      parsed.region, parsed.revision, parsed.year, hashes.crc32, hashes.md5, hashes.sha1
    );

    const romId = Number(info.lastInsertRowid);
    if (platformRow.slug === 'mame') applyMameNames(romId);
    added++;
    touched.add(romId);
    addedRoms.push(romId);

    // Local DAT match first: it is free, offline, and exact. A hit also gives
    // any later provider lookup a canonical title to search for.
    if (hashes.sha1 || hashes.crc32) {
      const inserted = db.prepare(`
        SELECT r.id, r.title, r.sha1, r.crc32, r.size_bytes, r.meta_source, p.slug AS platform
        FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?
      `).get(romId);
      if (inserted) applyDatMatch(inserted);
    }

    if (parsed.tags.length) {
      const insertTag = db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING');
      const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
      const link = db.prepare('INSERT OR IGNORE INTO rom_tags (rom_id, tag_id) VALUES (?, ?)');
      for (const t of parsed.tags) {
        insertTag.run(t);
        const tag = findTag.get(t);
        if (tag) link.run(romId, tag.id);
      }
    }

    onProgress?.({ added, found: found.length, file: file.filename });
   } catch (err) {
    failed++;
    if (!firstFailure) firstFailure = `${file.filename}: ${err.message}`;
   }
  }

  // Anything we knew about in this source but did not see is now missing —
  // flagged, not deleted, because a drive being unplugged is not a delete.
  const stale = db.prepare('SELECT id FROM roms WHERE source_id = ? AND missing = 0').all(sourceId)
    .map((r) => r.id)
    .filter((id) => !touched.has(id));
  const markMissing = db.prepare("UPDATE roms SET missing = 1, updated_at = datetime('now') WHERE id = ?");
  db.transaction(() => { for (const id of stale) markMissing.run(id); })();

  const elapsed = Date.now() - started;
  db.prepare(`
    UPDATE scan_log SET finished_at = datetime('now'), found = ?, added = ?, updated = ?, missing = ?, skipped = ?,
      error = ? WHERE id = ?
  `).run(found.length, added, updated, stale.length, skipped,
    [errors.length ? `${errors.length} folder(s) unreadable` : null, failed ? `${failed} file(s) failed (first: ${firstFailure})` : null].filter(Boolean).join('; ') || null, logId);

  db.prepare(`
    UPDATE sources SET last_scan_at = datetime('now'), last_scan_ms = ?, last_scan_found = ?,
      last_scan_added = ?, last_scan_error = ? WHERE id = ?
  `).run(elapsed, found.length, added, errors.length ? `${errors.length} folder(s) unreadable` : null, sourceId);

  // Auto-enrich the ROMs this scan just added (opt-in via `enrich` option).
  // Runs after the scan bookkeeping so the row is fully committed even if a
  // provider call fails; failures are counted, never fatal to the scan result.
  prog.added = added; prog.skipped = skipped; prog.failed = failed;
  const enrichOut = await enrichNew(addedRoms);
  prog.phase = 'done'; prog.done = prog.total; prog.file = '';
  setTimeout(() => { if (PROGRESS.get(Number(sourceId)) === prog) PROGRESS.delete(Number(sourceId)); }, 15000).unref?.();
  return {
    found: found.length, added, updated, missing: stale.length, skipped, failed, first_failure: firstFailure,
    errors: errors.length, elapsed_ms: elapsed, added_rom_ids: addedRoms,
    enriched: enrichOut.updated, enrich_failed: enrichOut.failed, enrich_skipped: enrichOut.skipped
  };
  } finally {
    // Error or early return (unreachable folder): never leave a stuck 'running' entry.
    if (prog.phase !== 'done' && PROGRESS.get(Number(sourceId)) === prog) PROGRESS.delete(Number(sourceId));
  }
}

export async function scanAll({ hash = true, enrich = false, onSource = null } = {}) {
  const sources = db.prepare('SELECT id, name FROM sources WHERE enabled = 1').all();
  const results = [];
  for (const s of sources) {
    // Sequential on purpose: hashing many large files in parallel thrashes disks.
    onSource?.({ id: s.id, name: s.name });
    results.push({ source_id: s.id, source: s.name, ...(await scanSource(s.id, { hash, enrich })) });
  }
  return results;
}

