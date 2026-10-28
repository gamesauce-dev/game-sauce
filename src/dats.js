import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';
import { describeDat, looksLikeDat, parseDat } from './lib/dat.js';
import { PLATFORM_BY_SLUG, PLATFORMS, seedPlatforms } from './lib/platforms.js';
import { parseFilename, sortTitle } from './lib/metadata.js';

/* ─────────────────────────── schema ─────────────────────────── */

// NOTE: datfiles / dat_entries live in migrations.js, not here. Every fresh
// database must have them even when nothing imports the DAT helpers first,
// and migrations.js runs on every boot via app.js.

const romCols = new Set(db.prepare('PRAGMA table_info(roms)').all().map((c) => c.name));
for (const [name, ddl] of [
  // verified | bad | variant | not-in-dat | (null = never checked)
  ['dat_status', 'TEXT'],
  ['dat_entry_id', 'INTEGER'],
  ['dat_title', 'TEXT'],
  ['dat_checked_at', 'TEXT']
]) {
  if (!romCols.has(name)) db.exec(`ALTER TABLE roms ADD COLUMN ${name} ${ddl}`);
}

/* ─────────────────────────── import ─────────────────────────── */

/**
 * Work out which platform a DAT belongs to from its header text, falling back to
 * an explicit choice from the user. Returns a platform slug or null.
 */
export function guessPlatform({ systemName = '', fileName = '' }, explicit = null) {
  if (explicit && PLATFORM_BY_SLUG.has(explicit)) return explicit;

  const hay = `${systemName} ${fileName}`.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!hay) return null;

  // 1. Exact-ish system names win outright. Matching these first stops
  //    "Super Nintendo" from being caught by the "entertainment system" rule and
  //    landing in NES.
  const EXACT = [
    ['snes', ['nintendo - super nintendo entertainment system', 'super nintendo entertainment system', 'super nintendo', 'snes']],
    ['nes', ['nintendo - entertainment system', 'nintendo entertainment system', 'famicom', 'nes']],
    ['n64', ['nintendo - nintendo 64', 'nintendo 64', 'n64']],
    ['gamecube', ['nintendo - gamecube', 'gamecube']],
    ['wiiu', ['nintendo - wii u', 'wii u']],
    ['wii', ['nintendo - wii', 'wii']],
    ['switch2', ['nintendo - switch 2', 'switch 2']],
    ['switch', ['nintendo - switch', 'switch']],
    ['gba', ['nintendo - game boy advance', 'game boy advance', 'gba']],
    ['gbc', ['nintendo - game boy color', 'game boy color', 'gbc']],
    ['gb', ['nintendo - game boy', 'game boy', 'gb']],
    ['nds', ['nintendo - nintendo ds', 'nintendo ds', 'nds']],
    ['3ds', ['nintendo - nintendo 3ds', 'nintendo 3ds', '3ds']],
    ['virtualboy', ['nintendo - virtual boy', 'virtual boy']],
    ['ps5', ['sony - playstation 5', 'playstation 5', 'ps5']],
    ['ps4', ['sony - playstation 4', 'playstation 4', 'ps4']],
    ['ps3', ['sony - playstation 3', 'playstation 3', 'ps3']],
    ['ps2', ['sony - playstation 2', 'playstation 2', 'ps2']],
    ['psp', ['sony - playstation portable', 'playstation portable', 'psp']],
    ['psvita', ['sony - playstation vita', 'playstation vita', 'vita']],
    ['ps1', ['sony - playstation', 'playstation', 'psx']],
    ['xboxseries', ['microsoft - xbox series', 'xbox series']],
    ['xboxone', ['microsoft - xbox one', 'xbox one']],
    ['xbox360', ['microsoft - xbox 360', 'xbox 360']],
    ['xbox', ['microsoft - xbox', 'xbox']],
    ['genesis', ['sega - mega drive', 'sega - genesis', 'mega drive', 'genesis']],
    ['mastersystem', ['sega - master system', 'master system']],
    ['gamegear', ['sega - game gear', 'game gear']],
    ['segacd', ['sega - mega-cd', 'sega cd', 'mega-cd']],
    ['sega32x', ['sega - 32x', '32x']],
    ['saturn', ['sega - saturn', 'saturn']],
    ['dreamcast', ['sega - dreamcast', 'dreamcast']],
    ['atari2600', ['atari - 2600', 'atari 2600']],
    ['atari5200', ['atari - 5200', 'atari 5200']],
    ['atari7800', ['atari - 7800', 'atari 7800']],
    ['lynx', ['atari - lynx', 'lynx']],
    ['jaguar', ['atari - jaguar', 'jaguar']],
    ['turbografx16', ['nec - pc engine', 'turbografx', 'pc engine']],
    ['neogeo', ['snk - neo geo', 'neo geo']],
    ['neogeopocket', ['neo geo pocket']],
    ['wonderswan', ['wonderswan']],
    ['arcade', ['mame', 'arcade']]
  ];

  // Collect every candidate and take the LONGEST match, so
  // "Sega - Mega Drive - Genesis" resolves to Genesis rather than NES.
  let best = null;
  let bestLen = 0;
  for (const [slug, keys] of EXACT) {
    for (const key of keys) {
      if (!hay.includes(key)) continue;
      if (key.length > bestLen) { best = slug; bestLen = key.length; }
    }
  }
  return best;
}

/** Import a DAT file into the database. Returns a summary. */
export async function importDat({ filePath, platform = null, name = null, userId = null }) {
  // The platform catalogue must exist before a DAT can point at one.
  seedPlatforms(db);
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error(`DAT file not found: ${filePath}`), { status: 400 });
  }
  if (!looksLikeDat(filePath)) {
    throw Object.assign(new Error('That file does not look like a DAT (expected <datafile> XML)'), { status: 400 });
  }

  const header = {};
  const started = Date.now();

  // Create the datfile row first so entries can reference it, then update the
  // counts once the stream has been consumed. imported_by is only set when that
  // user actually exists, so an import from a script or test cannot fail the FK.
  const importer = userId && db.prepare('SELECT id FROM users WHERE id = ?').get(userId) ? userId : null;
  const info = db.prepare(`
    INSERT INTO datfiles (name, filename, imported_by) VALUES (?, ?, ?)
  `).run(name || path.basename(filePath), path.basename(filePath), importer);

  const datfileId = Number(info.lastInsertRowid);

  // A hash already present in another DAT is not inserted twice — the entry is
  // the same dump, and duplicate rows would only slow matching down.
  const existing = db.prepare(`
    SELECT id FROM dat_entries
    WHERE (sha1 IS NOT NULL AND sha1 = @sha1)
       OR (crc32 IS NOT NULL AND crc32 = @crc32 AND size = @size)
    LIMIT 1
  `);

  const insert = db.prepare(`
    INSERT INTO dat_entries
      (datfile_id, platform_slug, title, rom_name, size, crc32, md5, sha1, status, cloneof)
    VALUES (@datfile_id, @platform_slug, @title, @rom_name, @size, @crc32, @md5, @sha1, @status, @cloneof)
  `);

  let inserted = 0;
  let skipped = 0;
  let resolvedSlug = platform;

  const writeBatch = db.transaction((rows) => {
    for (const row of rows) {
      const slug = resolvedSlug || guessPlatform({ systemName: header.name || '', fileName: path.basename(filePath) }) || 'other';
      if (existing.get({ sha1: row.sha1 || null, crc32: row.crc32 || null, size: row.size ?? null })) {
        skipped++;
        continue;
      }
      insert.run({ ...row, platform_slug: slug, datfile_id: datfileId });
      inserted++;
    }
  });

  let parsed;
  try {
    parsed = await parseDat(filePath, {
      header,
      onBatch: (batch) => {
        // Resolve the platform from the header as soon as we have it, so every
        // batch lands under the right slug.
        if (!resolvedSlug) {
          resolvedSlug = guessPlatform({ systemName: header.name || '', fileName: path.basename(filePath) }, platform);
        }
        writeBatch(batch);
      }
    });
  } catch (err) {
    db.prepare('DELETE FROM datfiles WHERE id = ?').run(datfileId);
    throw Object.assign(new Error(`Could not parse DAT: ${err.message}`), { status: 400 });
  }

  const meta = describeDat(parsed.header);
  const finalSlug = resolvedSlug || 'other';

  db.prepare(`
    UPDATE datfiles SET name = ?, source = ?, version = ?, system_name = ?,
      platform_slug = ?, entries = ? WHERE id = ?
  `).run(
    name || meta.system || path.basename(filePath),
    meta.source, meta.version, meta.system || parsed.header.name || null,
    finalSlug, inserted, datfileId
  );

  return {
    id: datfileId,
    name: name || meta.system || path.basename(filePath),
    platform: finalSlug,
    platform_name: PLATFORM_BY_SLUG.get(finalSlug)?.name || finalSlug,
    source: meta.source,
    version: meta.version,
    games: parsed.games,
    entries: inserted,
    duplicates: skipped,
    elapsed_ms: Date.now() - started
  };
}

/* ─────────────────────────── matching ─────────────────────────── */

/**
 * Look a ROM up in the imported DATs.
 *
 * SHA1 first (unambiguous), then CRC32 + size (CRC32 alone collides across a big
 * enough library). Returns the best entry or null.
 */
export function lookupDat({ sha1, crc32, size, platform }) {
  if (sha1) {
    const row = db.prepare(`
      SELECT * FROM dat_entries WHERE sha1 = ?
      ORDER BY (platform_slug = ?) DESC, id LIMIT 1
    `).get(sha1, platform || '');
    if (row) return row;
  }
  if (crc32 && size != null) {
    const row = db.prepare(`
      SELECT * FROM dat_entries WHERE crc32 = ? AND size = ?
      ORDER BY (platform_slug = ?) DESC, id LIMIT 1
    `).get(crc32, size, platform || '');
    if (row) return row;
  }
  if (crc32) {
    // Last resort: CRC32 only, and only if every candidate agrees.
    const rows = db.prepare('SELECT * FROM dat_entries WHERE crc32 = ? LIMIT 5').all(crc32);
    if (rows.length === 1) return rows[0];
  }
  return null;
}

/**
 * Apply a DAT match to one ROM row.
 *
 * A provider or hand-edited title always wins: the DAT supplies the canonical
 * name only when the current title was itself derived from a filename.
 */
export function applyDatMatch(rom, { force = false } = {}) {
  // The caller may pass a slim row (the scanner does); fill in the rest.
  if (rom.meta_source === undefined || rom.size_bytes === undefined) {
    const full = db.prepare(`
      SELECT r.title, r.sha1, r.crc32, r.size_bytes, r.meta_source, r.dat_status, p.slug AS platform
      FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?
    `).get(rom.id);
    if (full) rom = { ...full, id: rom.id };
  }

  const entry = lookupDat({
    sha1: rom.sha1, crc32: rom.crc32, size: rom.size_bytes, platform: rom.platform
  });

  if (!entry) {
    db.prepare(`
      UPDATE roms SET dat_status = 'not-in-dat', dat_entry_id = NULL, dat_title = NULL,
        dat_checked_at = datetime('now') WHERE id = ?
    `).run(rom.id);
    return { id: rom.id, matched: false };
  }

  const parsed = parseFilename(entry.rom_name || entry.title);
  // Once a DAT has supplied a title we treat it as confirmed. Renaming again on a
  // later rematch would silently undo a title the user edited by hand.
  const titleFromFilename = ['filename', 'seed', null, undefined].includes(rom.meta_source);
  const rename = force || (titleFromFilename && !rom.dat_status);

  db.prepare(`
    UPDATE roms SET
      dat_status = ?, dat_entry_id = ?, dat_title = ?, dat_checked_at = datetime('now'),
      title = CASE WHEN ? THEN ? ELSE title END,
      sort_title = CASE WHEN ? THEN ? ELSE sort_title END,
      meta_source = CASE WHEN ? THEN 'dat' ELSE meta_source END,
      region = COALESCE(region, ?),
      revision = COALESCE(revision, ?),
      release_year = COALESCE(release_year, ?),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    entry.status, entry.id, entry.title,
    rename ? 1 : 0, entry.title,
    rename ? 1 : 0, sortTitle(entry.title),
    rename ? 1 : 0,
    parsed.region, parsed.revision, parsed.year,
    rom.id
  );

  return { id: rom.id, matched: true, status: entry.status, dat_title: entry.title, renamed: Boolean(rename) };
}

/** Re-match a whole library (or one platform). */
export function rematchAll({ platform = null, force = false } = {}) {
  const rows = db.prepare(`
    SELECT r.id, r.title, r.sha1, r.crc32, r.size_bytes, r.meta_source, r.dat_status,
           p.slug AS platform
    FROM roms r JOIN platforms p ON p.id = r.platform_id
    ${platform ? 'WHERE p.slug = ?' : ''}
  `).all(...(platform ? [platform] : []));

  const stats = { checked: 0, matched: 0, not_in_dat: 0, renamed: 0, bad: 0, variant: 0 };
  db.transaction(() => {
    for (const rom of rows) {
      const res = applyDatMatch(rom, { force });
      stats.checked++;
      if (res.matched) {
        stats.matched++;
        if (res.renamed) stats.renamed++;
        if (res.status === 'bad') stats.bad++;
        if (res.status === 'variant') stats.variant++;
      } else {
        stats.not_in_dat++;
      }
    }
  })();

  return stats;
}

/* ─────────────────────────── queries ─────────────────────────── */

export function listDatfiles() {
  return db.prepare(`
    SELECT d.*, p.name AS platform_name, p.short_name AS platform_short,
           (SELECT COUNT(*) FROM roms r WHERE r.dat_entry_id IN
              (SELECT id FROM dat_entries WHERE datfile_id = d.id)) AS roms_matched,
           (SELECT COUNT(*) FROM dat_entries e
              WHERE e.datfile_id = d.id
              AND NOT EXISTS (SELECT 1 FROM roms r WHERE r.dat_entry_id = e.id)) AS missing_count
    FROM datfiles d LEFT JOIN platforms p ON p.slug = d.platform_slug
    ORDER BY d.imported_at DESC, d.id DESC
  `).all();
}

export function datCoverage() {
  const rows = db.prepare(`
    SELECT COALESCE(dat_status, 'unchecked') AS status, COUNT(*) AS count
    FROM roms GROUP BY dat_status
  `).all();
  const byPlatform = db.prepare(`
    SELECT p.slug, p.short_name, p.accent,
           COUNT(*) AS roms,
           SUM(CASE WHEN r.dat_status IN ('verified','bad','variant') THEN 1 ELSE 0 END) AS matched
    FROM roms r JOIN platforms p ON p.id = r.platform_id
    GROUP BY p.id HAVING roms > 0 ORDER BY roms DESC
  `).all();

  const total = rows.reduce((n, r) => n + r.count, 0);
  const status = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  return { total, status, byPlatform };
}

export function deleteDatfile(id) {
  const datfile = db.prepare('SELECT id FROM datfiles WHERE id = ?').get(id);
  if (!datfile) throw Object.assign(new Error('DAT not found'), { status: 404 });

  db.transaction(() => {
    // Clear the verification this DAT gave before removing the entries it owns,
    // so no ROM is left pointing at a row that no longer exists.
    db.prepare(`
      UPDATE roms SET dat_status = NULL, dat_entry_id = NULL, dat_title = NULL, dat_checked_at = NULL
      WHERE dat_entry_id IN (SELECT id FROM dat_entries WHERE datfile_id = ?)
    `).run(id);
    db.prepare('DELETE FROM dat_entries WHERE datfile_id = ?').run(id);
    db.prepare('DELETE FROM datfiles WHERE id = ?').run(id);
  })();

  return { deleted: Number(id) };
}

export const SUPPORTED_DAT_PLATFORMS = PLATFORMS.map((p) => ({ slug: p.slug, name: p.name, family: p.family }));
