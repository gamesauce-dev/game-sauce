import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { hashFile } from '../lib/hash.js';
import { parseFilename, sortTitle } from '../lib/metadata.js';
import { detectPlatform, PLATFORM_SLUGS, extensionAllowed } from '../lib/platforms.js';
import { enrich, cacheMedia } from '../lib/providers.js';
import { requireAdmin } from './auth.js';
import { canDownload } from '../lib/policy.js';
import { applyMameNames, mameTitleTrusted } from '../lib/mamenames.js';
import { importNames } from '../lib/namecsv.js';
import { listSaves, getSave, putSave, putScreenshot, deleteSave, purgeSaveFiles, MAX_BYTES } from '../lib/saves.js';
import {
  placeRom, tempPath, romStoragePath,
  removeRomFile, removeCoverFile, saveCover
} from '../lib/storage.js';

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.dirname(tempPath('x.bin'));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, path.basename(tempPath(file.originalname)))
  }),
    limits: { fileSize: Number(process.env.GAMESAUCE_MAX_UPLOAD || 8 * 1024 * 1024 * 1024) }
});

const ROM_COLUMNS = `
  r.id, r.title, r.sort_title, r.filename, r.size_bytes, r.region, r.revision,
  r.release_year, r.developer, r.publisher, r.genre, r.players, r.rating,
  r.description, r.cover_path, r.crc32, r.md5, r.sha1,
  r.meta_source, r.meta_synced_at, r.play_count,
  CASE WHEN EXISTS (SELECT 1 FROM favorites fv WHERE fv.rom_id = r.id AND fv.user_id = @uid) THEN 1 ELSE 0 END AS favorite, r.play_override, r.cover_locked,
  r.source_id, r.source_path, r.in_place, r.missing, r.provider_media,
  r.dat_status, r.dat_title, CASE WHEN EXISTS (SELECT 1 FROM hidden_roms hr WHERE hr.rom_id = r.id AND hr.user_id = @uid) THEN 1 ELSE 0 END AS hidden, r.keep_override, r.is_system,
  r.created_at, r.updated_at,
  s.name AS source_name, s.path AS source_root,
  p.slug AS platform, p.name AS platform_name, p.short_name AS platform_short,
  p.accent AS platform_accent, p.manufacturer AS platform_manufacturer
`;

const SORTS = {
  title: 'r.sort_title ASC',
  '-title': 'r.sort_title DESC',
  added: 'r.created_at DESC',
  '-added': 'r.created_at ASC',
  year: 'r.release_year IS NULL, r.release_year ASC, r.sort_title ASC',
  '-year': 'r.release_year DESC, r.sort_title ASC',
  rating: 'r.rating IS NULL, r.rating DESC',
  size: 'r.size_bytes DESC',
  '-size': 'r.size_bytes ASC'
};

function withTags(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const tags = db.prepare(`
    SELECT rt.rom_id, t.name FROM rom_tags rt JOIN tags t ON t.id = rt.tag_id
    WHERE rt.rom_id IN (${placeholders}) ORDER BY t.name
  `).all(...ids);
  const byRom = new Map();
  for (const t of tags) {
    if (!byRom.has(t.rom_id)) byRom.set(t.rom_id, []);
    byRom.get(t.rom_id).push(t.name);
  }
  return rows.map((r) => {
    let media = null;
    if (r.provider_media) {
      try { media = JSON.parse(r.provider_media); } catch { media = null; }
    }
    return {
      ...r,
      tags: byRom.get(r.id) || [],
      media,
      // ?v= changes whenever the image file does, so a newly matched/uploaded cover shows at once
      // instead of the browser's day-long cached copy of the old one.
      cover_url: r.cover_path ? `/api/roms/${r.id}/cover?v=${encodeURIComponent(path.basename(r.cover_path))}` : r.cover_url
    };
  });
}

function setTags(romId, tagNames) {
  db.prepare('DELETE FROM rom_tags WHERE rom_id = ?').run(romId);
  if (!tagNames?.length) return;
  const insertTag = db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING');
  const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const link = db.prepare('INSERT OR IGNORE INTO rom_tags (rom_id, tag_id) VALUES (?, ?)');
  for (const name of tagNames) {
    const clean = String(name).trim();
    if (!clean) continue;
    insertTag.run(clean);
    const tag = findTag.get(clean);
    if (tag) link.run(romId, tag.id);
  }
}

/**
 * Cache every image a provider returned, and return the cover path plus the
 * JSON we store in roms.provider_media. Caching is what keeps the library
 * looking right when the provider is unreachable later.
 */
async function applyProviderMedia(meta, sha1) {
  const media = meta.media || {};
  const out = {};
  let coverPath = null;

  for (const [kind, url] of Object.entries(media)) {
    if (!url) continue;
    const file = await cacheMedia(url, kind);
    if (file) out[kind] = { path: file, url };
  }

  if (out.box2d?.path) coverPath = out.box2d.path;
  else if (meta.cover_url) {
    const file = await cacheMedia(meta.cover_url, 'box2d');
    if (file) {
      out.box2d = { path: file, url: meta.cover_url };
      coverPath = file;
    }
  }

  return { coverPath, mediaJson: Object.keys(out).length ? JSON.stringify(out) : null };
}

function romById(id, uid = null) {
  const row = db.prepare(`
    SELECT ${ROM_COLUMNS} FROM roms r
    JOIN platforms p ON p.id = r.platform_id
    LEFT JOIN sources s ON s.id = r.source_id
    WHERE r.id = @rid
  `).get({ rid: id, uid: uid ?? -1 });
  const full = row ? withTags([row])[0] : null;
  if (full) {
    full.favourite_of = db.prepare('SELECT u.username FROM favorites f JOIN users u ON u.id = f.user_id WHERE f.rom_id = ? ORDER BY u.username').all(full.id).map((x) => x.username);
    // Cheap playability flag for the detail drawer: BIOS-free core exists?
    const core = playableCore(full.platform, full.release_year, full.play_override);
    full.playable = core || null;
    full.playable_core = core;
    // For the per-game toggle: can this platform play at all, and what is the default?
    full.play_capable = !!playableCore(full.platform, null, 1);
    full.play_default = !!playableCore(full.platform, full.release_year);
  }
  return full;
}

/**
 * Apply an already-fetched metadata record to a ROM row. Shared by the bulk
 * auto-matcher and the manual "identify this game" flow, so both paths write
 * the same columns in the same way.
 */
export async function applyMetadataRecord(id, meta, uid = null) {
  const rom = db.prepare('SELECT sha1, cover_path, cover_locked FROM roms WHERE id = ?').get(id);
  if (!rom) throw Object.assign(new Error('ROM not found'), { status: 404 });

  let { coverPath, mediaJson } = await applyProviderMedia(meta, rom.sha1);
  // A cover the user uploaded themselves is never replaced by a provider's.
  if (rom.cover_locked && rom.cover_path) coverPath = rom.cover_path;
  db.prepare(`
    UPDATE roms SET
      title = COALESCE(?, title),
      sort_title = COALESCE(?, sort_title),
      developer = ?, publisher = ?, genre = ?, release_year = ?,
      players = ?, rating = ?, description = ?,
      cover_url = ?, cover_path = ?, provider_media = ?,
      meta_source = ?, meta_synced_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(
    meta.title, meta.title ? sortTitle(meta.title) : null,
    meta.developer, meta.publisher, meta.genre, meta.release_year,
    meta.players, meta.rating, meta.description,
    meta.cover_url, coverPath, mediaJson, meta.source, id
  );
  return romById(id, uid);
}

/**
 * Delete one catalogue row plus its tag links, cached media and (optionally)
 * stored file. Shared by single delete, bulk delete and orphan purge so every
 * path removes the full footprint — leaving rom_tags or files behind is what
 * produced "count went down but a shell was still there".
 *
 * @param {object} rom  full rom row
 * @param {object} opts { deleteFile?: boolean } — only ever true for imported
 *   copies (in_place = 0/NULL) or when the caller explicitly passed delete_file=1
 * @returns {{ fileDeleted: boolean }}
 */
function deleteRomRow(rom, { deleteFile = false } = {}) {
  purgeSaveFiles({ romId: rom.id });
  const stmts = [
    'DELETE FROM rom_tags WHERE rom_id = ?',
    'DELETE FROM collection_roms WHERE rom_id = ?',
    'DELETE FROM downloads WHERE rom_id = ?',
    'DELETE FROM roms WHERE id = ?'
  ];
  const txn = db.transaction(() => {
    for (const sql of stmts) db.prepare(sql).run(rom.id);
  });
  txn();

  let fileDeleted = false;
  // Never delete a scanned file from a user's own folder unless explicitly asked.
  const mayDeleteFile = deleteFile || !rom.in_place;
  if (mayDeleteFile && rom.storage_path) {
    try {
      const before = fs.existsSync(rom.storage_path);
      removeRomFile(rom.storage_path);
      fileDeleted = before && !fs.existsSync(rom.storage_path);
    } catch { fileDeleted = false; }
  }
  if (rom.cover_path) {
    try { removeCoverFile(rom.cover_path); } catch { /* best effort */ }
  }
  return { fileDeleted };
}

/*
 * Bulk operations live on their own router mounted at /bulk.
 *
 * Express matches same-method routes in registration order, and the older
 * '/:id/hide' handler sits above, so a '/bulk/hide' route registered after it is
 * never reached — "/bulk/hide" simply matches '/:id/hide' with id="bulk". Nesting
 * the literal paths in a sub-router gives them a separate, earlier match.
 */
const bulkRouter = express.Router();

bulkRouter.post('/hide', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'No ids supplied' });
  const hidden = req.body?.hidden === false ? 0 : 1;

  // Sample display labels for the audit line (cap: the summary counts the rest).
  const labelOf = db.prepare(`
    SELECT r.id, r.title, p.name AS platform_name
    FROM roms r JOIN platforms p ON p.id = r.platform_id
    WHERE r.id = ?
  `);
  const titles = [];
  for (const id of ids.slice(0, 10)) {
    try { const l = labelOf.get(id); if (l) titles.push({ title: l.title, platform: l.platform_name }); } catch { /* decorative */ }
  }
  req.auditDetail = { hidden: Boolean(hidden), titles, count: ids.length };

  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  // Personal: this only changes what YOU see.
  const add = db.prepare('INSERT OR IGNORE INTO hidden_roms (user_id, rom_id) SELECT ?, id FROM roms WHERE id = ?');
  const del = db.prepare('DELETE FROM hidden_roms WHERE user_id = ? AND rom_id = ?');
  let changed = 0;
  db.transaction(() => { for (const id of ids) changed += (hidden ? add.run(req.user.id, id) : del.run(req.user.id, id)).changes; })();
  res.json({ changed, hidden: Boolean(hidden) });
});

// Clear the metadata match: a wrong match (the wrong game's cover and details) goes back to the plain name.
// Title: the name from the loaded name list / names CSV when there is one, otherwise the name read from the file name.
// Cover, description, genre, developer and other provider details are removed, so Fetch metadata (or Identify) can start fresh.
// A cover you uploaded yourself is kept. Files on disk are never touched.
const ARCADE_SLUGS = new Set(['mame', 'neogeo', 'cps1', 'cps2', 'cps3', 'naomi', 'atomiswave', 'fba', 'arcade', 'coinop']);
function clearMatchFor(ids) {
  const get = db.prepare('SELECT r.id, r.filename, r.cover_path, r.cover_locked, p.slug AS platform_slug FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?');
  const listed = db.prepare('SELECT title, year FROM mame_names WHERE name = ?');
  const upd = db.prepare(`UPDATE roms SET title = ?, sort_title = ?, release_year = ?, developer = NULL, publisher = NULL, genre = NULL,
    players = NULL, rating = NULL, description = NULL, cover_url = NULL, provider_media = NULL, meta_source = ?, meta_synced_at = NULL,
    cover_path = CASE WHEN cover_locked = 1 THEN cover_path ELSE NULL END, updated_at = datetime('now') WHERE id = ?`);
  let cleared = 0;
  db.transaction(() => {
    for (const id of ids) {
      const r = get.get(id);
      if (!r) continue;
      const key = String(r.filename).replace(/\.(zip|7z)$/i, '').toLowerCase();
      const n = ARCADE_SLUGS.has(r.platform_slug) ? listed.get(key) : null;
      const parsed = parseFilename(r.filename);
      const title = n?.title || parsed.title;
      upd.run(title, sortTitle(title), n?.year ?? parsed.year ?? null, n ? 'mame-list' : 'filename', id);
      if (r.cover_path && !r.cover_locked) removeCoverFile(r.cover_path);
      cleared++;
    }
  })();
  return cleared;
}
bulkRouter.post('/clear-match', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'No ids supplied' });
  req.auditDetail = { count: ids.length };
  res.json({ cleared: clearMatchFor(ids) });
});

// Mark / unmark games as System entries (BIOS, devices, computers): kept and downloadable, but out of the main library.
bulkRouter.post('/system', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'No ids supplied' });
  const v = req.body?.system === false ? 0 : 1;
  const stmt = db.prepare("UPDATE roms SET is_system = ?, updated_at = datetime('now') WHERE id = ?");
  let changed = 0;
  db.transaction(() => { for (const id of ids) changed += stmt.run(v, id).changes; })();
  req.auditDetail = { system: Boolean(v), count: ids.length };
  res.json({ changed, system: Boolean(v) });
});

bulkRouter.post('/delete', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'No ids supplied' });

  const get = db.prepare('SELECT * FROM roms WHERE id = ?');
  const labelOf = db.prepare(`
    SELECT r.id, r.title, p.name AS platform_name
    FROM roms r JOIN platforms p ON p.id = r.platform_id
    WHERE r.id = ?
  `);
  const deleteFile = req.body?.delete_file === true || req.body?.delete_file === '1';
  const keepFile = req.body?.keep_file === true || req.body?.keep_file === '1';
  let deleted = 0;
  let filesDeleted = 0;
  // Keep display labels for the audit line. A bulk of 500 titles would bloat
  // the row, so cap the stored sample — the summary counts the rest.
  const sample = [];
  const favRows = db.prepare(`SELECT f.rom_id, u.username FROM favorites f JOIN users u ON u.id = f.user_id WHERE f.rom_id IN (${ids.map(() => '?').join(',') || 'NULL'})`).all(...ids);
  if (favRows.length && !(req.body?.confirm_favorites === true || req.body?.confirm_favorites === '1')) {
    const who = [...new Set(favRows.map((x) => x.username))];
    return res.status(409).json({ error: `${new Set(favRows.map((x) => x.rom_id)).size} of these are favourites of ${who.join(', ')}.`, favourite_of: who, favourite_count: new Set(favRows.map((x) => x.rom_id)).size });
  }
  let protectedCount = 0;
  for (const id of ids) {
    const rom = get.get(id);
    if (!rom) continue;
    // A copy you marked Keep in the duplicate finder is protected until you switch Keep off.
    if (rom.keep_override === 1) { protectedCount++; continue; }
    // keep_file=1 wins over delete_file: when the caller wants catalogue-only
    // removal the file must never be touched.
    if (sample.length < 10) {
      try {
        const label = labelOf.get(id);
        if (label) sample.push({ rom_id: label.id, title: label.title, platform: label.platform_name });
      } catch { /* labels are decorative; the delete still counts */ }
    }
    const { fileDeleted } = deleteRomRow(rom, { deleteFile: !keepFile && deleteFile });
    deleted++;
    if (fileDeleted) filesDeleted++;
  }
  // The generic audit middleware already wrote a bare "POST /api/roms/bulk/delete"
  // row by now? No — it fires on finish, after this handler: stash the labels so
  // it picks them up instead of an empty detail.
  req.auditDetail = { ids: ids.slice(0, 50), titles: sample, count: deleted };
  res.json({ deleted, files_deleted: filesDeleted, protected: protectedCount });
});

router.use('/bulk', bulkRouter);

/* ---------------------------------------------------------------- list */

router.get('/', (req, res) => {
  const {
    q, platform, genre, region, favorite, tag, source, family,
    sort = 'title', limit = 200, offset = 0, year_min, year_max
  } = req.query;

  const where = [];
  const params = {};

  if (q && String(q).trim()) {
    // Substring match over the fields people actually search by. instr() is used
    // rather than LIKE so that % and _ in the query are not wildcards.
    where.push(`(
      instr(lower(r.title), lower(@q)) > 0 OR
      instr(lower(COALESCE(r.developer,'')), lower(@q)) > 0 OR
      instr(lower(COALESCE(r.publisher,'')), lower(@q)) > 0 OR
      instr(lower(COALESCE(r.genre,'')), lower(@q)) > 0
    )`);
    params.q = String(q).trim();
  }
  if (platform && platform !== 'all') { where.push('p.slug = @platform'); params.platform = platform; }
  // A game can carry several genres in one field ("Shooter, Arcade"): match one of them, not the whole text.
  if (genre) { where.push("(',' || REPLACE(r.genre, ', ', ',') || ',') LIKE @genre"); params.genre = `%,${String(genre).replace(/[%_]/g, '').trim()},%`; }
  if (region) { where.push('r.region = @region'); params.region = region; }
  params.uid = req.user ? Number(req.user.id) : -1;
  if (favorite === '1' || favorite === 'true') where.push('EXISTS (SELECT 1 FROM favorites fv2 WHERE fv2.rom_id = r.id AND fv2.user_id = @uid)');
  if (source) { where.push('r.source_id = @source'); params.source = Number(source); }
  if (family) { where.push('p.family = @family'); params.family = family; }
  if (req.query.dat_status) { where.push('r.dat_status = @dat_status'); params.dat_status = req.query.dat_status; }
  // Hidden ROMs are excluded by default so they disappear from every view that
  // does not ask for them; hidden=only is the filter that finds them again.
  // System entries (BIOS, devices, computers) have their own filter: ?system=only shows just them (hidden ones too, so
  // they can be selected, hidden or unhidden there); otherwise they stay out of the library.
  if (req.query.system === 'only') where.push('r.is_system = 1');
  else {
    if (req.query.system !== 'all') where.push('r.is_system = 0');
    // Hiding is personal: only the signed-in person's own hidden games are left out (others still see them).
    const mine = 'EXISTS (SELECT 1 FROM hidden_roms hr WHERE hr.rom_id = r.id AND hr.user_id = @uid)';
    if (req.query.hidden === '1' || req.query.hidden === 'only') where.push(mine);
    else if (req.query.hidden === 'all') { /* no clause */ }
    else where.push('NOT ' + mine);
  }
  if (req.query.missing === '1') where.push('r.missing = 1');
  if (req.query.missing === '0') where.push('r.missing = 0');
  // Unmatched: never enriched from any provider or DAT — filename/seed rows and
  // anything with no meta_source at all. The "needs manual identify" worklist.
  if (req.query.unmatched === '1' || req.query.unmatched === 'only') {
    where.push(`(r.meta_source IS NULL OR r.meta_source IN ('filename','seed',''))`);
  }
  // Orphans: ROMs whose source row is gone (or was never set). These can never
  // be re-scanned — this is the "platforms with no source" the sidebar shows.
  if (req.query.orphan === '1' || req.query.orphan === 'only' || req.query.orphaned === '1') {
    where.push('(r.source_id IS NULL OR r.source_id NOT IN (SELECT id FROM sources))');
  }
  if (year_min) { where.push('r.release_year >= @year_min'); params.year_min = Number(year_min); }
  if (year_max) { where.push('r.release_year <= @year_max'); params.year_max = Number(year_max); }
  if (tag) {
    where.push(`EXISTS (
      SELECT 1 FROM rom_tags rt JOIN tags t ON t.id = rt.tag_id
      WHERE rt.rom_id = r.id AND t.name = @tag
    )`);
    params.tag = tag;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = SORTS[sort] || SORTS.title;
  const lim = Math.min(Number(limit) || 200, 500);
  const off = Math.max(Number(offset) || 0, 0);

  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM roms r JOIN platforms p ON p.id = r.platform_id ${whereSql}
  `).get(params).n;

  const rows = db.prepare(`
    SELECT ${ROM_COLUMNS}
    FROM roms r
    JOIN platforms p ON p.id = r.platform_id
    LEFT JOIN sources s ON s.id = r.source_id
    ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ${lim} OFFSET ${off}
  `).all(params);

  // Cheap playability flag for every tile: BIOS-free core exists for the ROM's
  // platform? Guards the controller badge on covers + the detail Play button.
  const out = withTags(rows).map((r) => {
    const core = playableCore(r.platform, r.release_year, r.play_override);
    return { ...r, playable: core || null, playable_core: core };
  });
  res.json({ total, limit: lim, offset: off, items: out });
});

/* ------------------------------------------------------------ facets */

router.get('/facets', (req, res) => {
  const platforms = db.prepare(`
    SELECT p.slug, p.name, p.short_name, p.accent, p.family, p.manufacturer,
           p.generation, COUNT(r.id) AS count,
           COALESCE(SUM(r.size_bytes), 0) AS bytes
    FROM platforms p LEFT JOIN roms r ON r.platform_id = p.id
    GROUP BY p.id HAVING count > 0 ORDER BY p.name
  `).all();

  const families = db.prepare(`
    SELECT COALESCE(p.family,'Other') AS name, COUNT(r.id) AS count
    FROM platforms p JOIN roms r ON r.platform_id = p.id
    GROUP BY p.family ORDER BY count DESC
  `).all();

  const sources = db.prepare(`
    SELECT s.id, s.name, s.path, COUNT(r.id) AS count,
           COALESCE(SUM(r.size_bytes),0) AS bytes,
           SUM(CASE WHEN r.missing = 1 THEN 1 ELSE 0 END) AS missing
    FROM sources s LEFT JOIN roms r ON r.source_id = s.id
    GROUP BY s.id ORDER BY s.name
  `).all();

  const genres = db.prepare(`
    SELECT genre AS name, COUNT(*) AS count FROM roms
    WHERE genre IS NOT NULL AND genre <> '' GROUP BY genre ORDER BY count DESC, genre
  `).all();

  const regions = db.prepare(`
    SELECT region AS name, COUNT(*) AS count FROM roms
    WHERE region IS NOT NULL GROUP BY region ORDER BY count DESC
  `).all();

  const tags = db.prepare(`
    SELECT t.name, COUNT(*) AS count FROM tags t JOIN rom_tags rt ON rt.tag_id = t.id
    GROUP BY t.id ORDER BY count DESC, t.name
  `).all();

  const stats = db.prepare(`
    SELECT COUNT(*) AS roms, COALESCE(SUM(size_bytes),0) AS bytes,
           COUNT(DISTINCT platform_id) AS platforms,
           (SELECT COUNT(*) FROM favorites WHERE user_id = ${req.user ? Number(req.user.id) : -1}) AS favorites,
           SUM(missing) AS missing,
           (SELECT COUNT(*) FROM hidden_roms WHERE user_id = ${req.user ? Number(req.user.id) : -1}) AS hidden,
           SUM(CASE WHEN meta_source IN ('screenscraper','thegamesdb') THEN 1 ELSE 0 END) AS enriched,
           SUM(CASE WHEN source_id IS NULL THEN 1 ELSE 0 END) AS orphaned,
           SUM(CASE WHEN missing = 1 AND source_id IS NOT NULL THEN 1 ELSE 0 END) AS missing_sourced,
           SUM(CASE WHEN meta_source IN ('filename','seed','') OR meta_source IS NULL THEN 1 ELSE 0 END) AS never_enriched,
           SUM(CASE WHEN source_id IS NULL AND in_place = 0 THEN 1 ELSE 0 END) AS imported_or_seed
    FROM roms
  `).get();

  res.json({ platforms, families, sources, genres, regions, tags, stats });
});

// Must be registered before '/:id', or "recently-played" would be read as a ROM id.
/* Games this user played in the browser most recently, one entry per game, newest first.
 * Built from the existing play log (downloads.kind = 'play'); another user's plays never show.
 * Hidden games and games that cannot be played any more are left out. */
router.get('/recently-played', (req, res) => {
  const lim = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
  const rows = db.prepare(`
    SELECT ${ROM_COLUMNS}, MAX(d.id) AS last_play_id, MAX(d.created_at) AS last_played_at, COUNT(*) AS plays
    FROM downloads d
    JOIN roms r ON r.id = d.rom_id
    JOIN platforms p ON p.id = r.platform_id
    LEFT JOIN sources s ON s.id = r.source_id
    WHERE d.kind = 'play' AND d.user_id = @uid AND NOT EXISTS (SELECT 1 FROM hidden_roms hr WHERE hr.rom_id = r.id AND hr.user_id = @uid) AND r.missing = 0
    GROUP BY r.id
    ORDER BY last_play_id DESC
    LIMIT @lim
  `).all({ uid: req.user.id, lim: lim * 3 }); // over-fetch: some may no longer be playable
  const items = withTags(rows)
    .map((r) => ({ ...r, playable: playableCore(r.platform, r.release_year, r.play_override) || null }))
    .filter((r) => r.playable)
    .slice(0, lim)
    .map((r) => ({ ...r, playable_core: r.playable }));
  res.json({ items });
});

/* ------------------------------------------------------------ detail */

// Name list (CSV): rename ROMs on one platform from a file-name -> game-name table. Preview first, then apply.
router.post('/bulk/import-names', requireAdmin, multer({ limits: { fileSize: 20 * 1024 * 1024 } }).single('csv'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a CSV file' });
    const platform = String(req.body?.platform || '').trim();
    if (!db.prepare('SELECT 1 FROM platforms WHERE slug = ?').get(platform)) return res.status(400).json({ error: 'Pick a platform' });
    res.json(importNames({ csvText: req.file.buffer.toString('utf8'), platform, romCol: req.body.rom_col || undefined, nameCol: req.body.name_col || undefined, hideSystem: req.body.hide_system === '1', flagSystem: req.body.flag_system === '1', apply: req.body.apply === '1' }));
  } catch (err) { next(err); }
});

// Registered before '/:id' so it isn't swallowed by it (job itself is defined further down).
router.get('/bulk/enrich-job', requireAdmin, (req, res) => res.json({ ...enrichJob }));

router.get('/:id', (req, res) => {
  const rom = romById(req.params.id, req.user?.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });

  const collections = db.prepare(`
    SELECT c.id, c.name FROM collections c
    JOIN collection_roms cr ON cr.collection_id = c.id WHERE cr.rom_id = ?
  `).all(rom.id);

  const siblings = db.prepare(`
    SELECT id, title, region, revision FROM roms
    WHERE platform_id = (SELECT platform_id FROM roms WHERE id = ?)
      AND id <> ? AND sort_title = ?
  `).all(rom.id, rom.id, rom.sort_title);

  res.json({ ...rom, collections, variants: siblings });
});

/* ------------------------------------------------------------ cover */

router.get('/:id/cover', (req, res) => {
  const rom = db.prepare('SELECT cover_path FROM roms WHERE id = ?').get(req.params.id);
  if (!rom?.cover_path || !fs.existsSync(rom.cover_path)) {
    return res.status(404).json({ error: 'No cover' });
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.resolve(rom.cover_path));
});

/** Any cached provider media for this ROM: ?kind=screenshot|fanart|wheel|manual|video */
router.get('/:id/media/:kind', (req, res) => {
  const rom = db.prepare('SELECT provider_media, cover_path FROM roms WHERE id = ?').get(req.params.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });

  const kind = String(req.params.kind);
  if (kind === 'box2d' && rom.cover_path && fs.existsSync(rom.cover_path)) {
    return res.sendFile(path.resolve(rom.cover_path));
  }

  let media = {};
  try { media = JSON.parse(rom.provider_media || '{}'); } catch { media = {}; }
  const file = media?.[kind]?.path;
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'No media of that kind' });

  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.resolve(file));
});

/* --------------------------------------------------------- download */

router.get('/:id/download', (req, res) => {
  // Members can play in the browser, but only download the file when an admin has allowed it.
  if (!canDownload(req.user)) {
    return res.status(403).json({ error: 'Downloads are turned off for member accounts. Ask the admin, or play it in the browser.' });
  }
  const rom = db.prepare('SELECT * FROM roms WHERE id = ?').get(req.params.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });
  if (!fs.existsSync(rom.storage_path)) {
    // In-place libraries live on drives the user can unplug. Flag it rather than
    // deleting the catalogue entry.
    if (rom.source_id) db.prepare("UPDATE roms SET missing = 1 WHERE id = ?").run(rom.id);
    return res.status(410).json({ error: 'File is not reachable — its drive may be offline' });
  }

  // TRUE manual download: the only event counted for the "most downloaded"
  // stat. Browser-play streams use /play (also logs) so "most downloaded"
  // means downloads, not fetch/stream events. To flag that separation the
  // stats query counts only rows created by this endpoint.
  db.prepare("INSERT INTO downloads (rom_id, bytes, user_id, kind) VALUES (?, ?, ?, 'download')")
    .run(rom.id, rom.size_bytes, req.user ? Number(req.user.id) : null);

  const downloadName = `${rom.title.replace(/[^\w .()\-\[\]]+/g, '_')}${path.extname(rom.filename)}`;
  res.download(rom.storage_path, downloadName, (err) => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

/* ── play: browser streaming for BIOS-free platforms (EmulatorJS) ──
 * WHAT this is: an extra way to experience a ROM that stays on your server —
 * the ROM streams to the browser and runs in a libretro core compiled to
 * WebAssembly. No vault installer, no download, no save-state sync.
 * WHAT this is NOT: a replacement for real emulators (vault/guide stay), a
 * way to play BIOS-gated systems (PS1/PS2/Saturn/Dreamcast are excluded by
 * design), or a loophole around auth (the stream needs a valid session).
 * Legal posture: the ROM stays yours on your box; the page just hands the
 * browser a temporary URL to fetch it with. Only platforms whose emulation
 * needs no BIOS/keys dump are listed — nothing the user would have to go and
 * pirate a system file for. */

// game-sauce platform slug -> EmulatorJS SYSTEM id (EJS_core). This is the
// system selector EmulatorJS expects ('nes', 'snes', 'segaMD', …) — NOT the
// libretro core filename ('fceumm', 'snes9x', …). Passing a core filename here
// is exactly the black-window bug: the button shows, the loader boots, but no
// system binds so nothing ever renders. Conservative list: every entry here
// boots with zero external files on the default core.
const PLAYABLE_CORES = {
  nes: 'nes',
  snes: 'snes',
  gb: 'gb',
  gbc: 'gbc',
  gba: 'gba',
  genesis: 'segaMD',
  mastersystem: 'segaMS',
  gamegear: 'segaGG',
  segacd: 'segaCD',
  sega32x: 'sega32x',
  turbografx16: 'pce',
  atari2600: 'atari2600',
  atari7800: 'atari7800',
  atarilynx: 'lynx',
  wonderswan: 'ws',
  virtualboy: 'vb',
  arcade: 'arcade',
  neogeo: 'arcade',
  mame: 'mame',
  fba: 'arcade'
};

/** Which platforms the in-browser player supports at all. */
/* MAME in the browser uses an old (2003-era) core: early-80s to ~1990 hardware runs,
 * later boards (Neo Geo, CPS2+, Cave, 3D) mostly do not. MAME ROMs released after
 * this year get no Play button. Unknown year = allowed (best effort). Override with
 * GAMESAUCE_MAME_PLAY_MAX_YEAR (set 9999 to disable the cutoff). */
export const MAME_PLAY_MAX_YEAR = Number(process.env.GAMESAUCE_MAME_PLAY_MAX_YEAR) || 1990;

export function playableCore(slug, year = null, override = null) {
  const s = String(slug || '').toLowerCase();
  // Per-game override wins: 0 = off, 1 = on (still needs a core for the platform).
  if (override === 0 || override === '0') return null;
  if (override === 1 || override === '1') return PLAYABLE_CORES[s] || null;
  if (s === 'mame' && Number(year) > MAME_PLAY_MAX_YEAR) return null;
  return PLAYABLE_CORES[s] || null;
}

router.get('/playable', (req, res) => {
  res.json({ cores: PLAYABLE_CORES });
});

/* --------------------------------------------------------- play stream */

/**
 * Stream a ROM for in-browser play. Same reachability rules as download
 * (missing file -> 410 + flag), but served inline with byte-range support so
 * the emulator frontend can fetch what it needs. Auth is enforced by the
 * global requireAuth middleware — no session, no bytes.
 *
 * Two routes, one handler: /:id/play and /:id/play/:filename. The filename
 * suffix is ignored server-side but ESSENTIAL for EmulatorJS, which sniffs
 * the file type from the URL extension. Without it (/play with no extension)
 * the loader boots with no system bound and renders the famous black window.
 */
function servePlay(req, res) {
  const rom = db.prepare(`
    SELECT r.*, p.slug AS platform_slug
    FROM roms r JOIN platforms p ON p.id = r.platform_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });

  // BIOS-gated systems are excluded by design: the whole point of browser
  // play is "nothing to source but the ROM". Real emulators (vault/guide)
  // remain the path for PS1/PS2/Saturn/Dreamcast and friends.
  const core = playableCore(rom.platform_slug, rom.release_year, rom.play_override);
  if (!core) return res.status(400).json({ error: 'In-browser play is not available for this platform — use a vault emulator instead' });

  if (!fs.existsSync(rom.storage_path)) {
    if (rom.source_id) db.prepare("UPDATE roms SET missing = 1 WHERE id = ?").run(rom.id);
    return res.status(410).json({ error: 'File is not reachable — its drive may be offline' });
  }

  // Play streams log too (so /play shows in stats), but the "most downloaded"
  // banner counts only kind='download' — manual downloads, not streams.
  db.prepare("INSERT INTO downloads (rom_id, bytes, user_id, kind) VALUES (?, ?, ?, 'play')")
    .run(rom.id, rom.size_bytes, req.user ? Number(req.user.id) : null);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  // Inline, not attachment: the player fetches it with XHR/fetch.
  res.setHeader('Content-Disposition', `inline; filename="${String(rom.filename).replace(/"/g, '')}"`);
  // Always octet-stream: Express maps .md to text/markdown, which makes the
  // browser decode the ROM as text and corrupt the bytes the core receives.
  res.type('application/octet-stream');
  const stream = fs.createReadStream(rom.storage_path);
  stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  stream.pipe(res);
}
router.get('/:id/play', servePlay);

/* ------------------------------------------------- per-user saves (play) */
// Every query is scoped to req.user.id: a user can only ever see, load or
// delete their own states and battery saves.
const rawBody = express.raw({ type: '*/*', limit: MAX_BYTES });
const saveErr = (res, err) => res.status(err.status || 500).json({ error: err.message });
const romExists = (id) => !!db.prepare('SELECT 1 FROM roms WHERE id = ?').get(id);

router.get('/:id/saves', (req, res) => {
  if (!romExists(req.params.id)) return res.status(404).json({ error: 'ROM not found' });
  res.json({ items: listSaves(req.user.id, Number(req.params.id)) });
});

router.post('/:id/saves', rawBody, (req, res) => {
  if (!romExists(req.params.id)) return res.status(404).json({ error: 'ROM not found' });
  const kind = req.query.kind === 'battery' ? 'battery' : 'state';
  try {
    const id = putSave(req.user.id, Number(req.params.id), kind, String(req.query.core || '').slice(0, 40), req.body);
    res.status(201).json({ id });
  } catch (err) { saveErr(res, err); }
});

router.put('/:id/saves/:sid/screenshot', rawBody, (req, res) => {
  try {
    putScreenshot(req.user.id, Number(req.params.id), Number(req.params.sid), req.body);
    res.json({ ok: true });
  } catch (err) { saveErr(res, err); }
});

function sendSave(field, type) {
  return (req, res) => {
    const row = getSave(req.user.id, Number(req.params.id), Number(req.params.sid));
    if (!row || !row[field] || !fs.existsSync(row[field])) return res.status(404).json({ error: 'Save not found' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.type(type);
    fs.createReadStream(row[field]).pipe(res);
  };
}
router.get('/:id/saves/:sid/file', sendSave('file_path', 'application/octet-stream'));
router.get('/:id/saves/:sid/screenshot', sendSave('shot_path', 'image/png'));

router.delete('/:id/saves/:sid', (req, res) => {
  res.json({ removed: deleteSave(req.user.id, Number(req.params.id), Number(req.params.sid)) });
});
router.get('/:id/play/:filename', servePlay);

/* --------------------------------------------------------- favorite */

/* Per-game browser-play switch. value: true (force on) / false (force off) /
 * null (back to the platform default). Forcing on only works where a core exists. */
router.post('/:id/play-override', (req, res) => {
  const rom = db.prepare('SELECT r.id, p.slug FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?').get(req.params.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });
  const v = req.body?.value;
  if (v !== true && v !== false && v !== null) return res.status(400).json({ error: 'value must be true, false or null' });
  if (v === true && !playableCore(rom.slug, null, 1)) {
    return res.status(400).json({ error: 'This platform has no in-browser core' });
  }
  db.prepare("UPDATE roms SET play_override = ?, updated_at = datetime('now') WHERE id = ?").run(v === null ? null : (v ? 1 : 0), rom.id);
  res.json({ id: rom.id, play_override: v === null ? null : (v ? 1 : 0) });
});

router.post('/:id/hide', (req, res) => {
  const rom = db.prepare('SELECT id FROM roms WHERE id = ?').get(req.params.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  const wasHidden = !!db.prepare('SELECT 1 FROM hidden_roms WHERE user_id = ? AND rom_id = ?').get(req.user.id, rom.id);

  // The audit middleware already snapshotted { title, platform } before the
  // write; stash the *direction* (hide vs unhide) for the summary line. Reads
  // req.romSnapshot's sibling field so nothing about the write path changes.
  const next = req.body?.hidden === undefined ? (wasHidden ? 0 : 1) : (req.body.hidden ? 1 : 0);
  if (req.romSnapshot) req.romSnapshot.hidden = Boolean(next);
  // Personal: only your own view changes.
  if (next) db.prepare('INSERT OR IGNORE INTO hidden_roms (user_id, rom_id) VALUES (?, ?)').run(req.user.id, rom.id);
  else db.prepare('DELETE FROM hidden_roms WHERE user_id = ? AND rom_id = ?').run(req.user.id, rom.id);

  res.json({ id: Number(req.params.id), hidden: next });
});

router.post('/:id/favorite', (req, res) => {
  const rom = db.prepare('SELECT id FROM roms WHERE id = ?').get(req.params.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  // Favourites belong to the person who set them; nobody else's list changes.
  const had = !!db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND rom_id = ?').get(req.user.id, rom.id);
  const next = req.body?.favorite === undefined ? (had ? 0 : 1) : (req.body.favorite ? 1 : 0);
  if (next) db.prepare('INSERT OR IGNORE INTO favorites (user_id, rom_id) VALUES (?, ?)').run(req.user.id, rom.id);
  else db.prepare('DELETE FROM favorites WHERE user_id = ? AND rom_id = ?').run(req.user.id, rom.id);
  res.json({ id: Number(rom.id), favorite: next });
});

/* -------------------------------------------------------------- edit */

const EDITABLE = [
  'title', 'developer', 'publisher', 'genre', 'region', 'revision',
  'release_year', 'players', 'rating', 'description'
];

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM roms WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'ROM not found' });

  const sets = [];
  const params = { id: Number(req.params.id) };

  for (const field of EDITABLE) {
    if (req.body[field] !== undefined) {
      sets.push(`${field} = @${field}`);
      params[field] = req.body[field] === '' ? null : req.body[field];
    }
  }

  if (req.body.title !== undefined && req.body.title) {
    sets.push('sort_title = @sort_title');
    params.sort_title = sortTitle(req.body.title);
  }

  if (req.body.platform !== undefined && (PLATFORM_SLUGS.has(req.body.platform) || db.prepare('SELECT 1 FROM platforms WHERE slug = ?').get(String(req.body.platform)))) {
    sets.push('platform_id = (SELECT id FROM platforms WHERE slug = @platform)');
    params.platform = req.body.platform;
  }

  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE roms SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  if (req.body.tags !== undefined) setTags(Number(req.params.id), req.body.tags);

  res.json(romById(req.params.id, req.user?.id));
});

/* -------------------------------------------------- bulk enrichment */

/**
 * Fetch metadata for many ROMs. Deliberately sequential with a small gap:
 * ScreenScraper throttles per account, and a parallel burst gets the account
 * rate-limited. `limit` lets the UI work through a big library in chunks.
 */
router.post('/bulk/enrich', async (req, res, next) => {
  try {
    // after_id: page through every candidate in id order (the UI loops with this),
    // so ROMs that never match can't hog the same first batch forever.
    const afterId = Number(req.body?.after_id);
    const paging = Number.isFinite(afterId) && req.body?.after_id !== undefined && req.body?.after_id !== null;
    const batchSize = Math.min(Number(req.body?.limit) || 25, 100);
    const ids = Array.isArray(req.body?.ids) && req.body.ids.length
      ? req.body.ids.map(Number).filter(Boolean)
      : paging ? db.prepare(`
          SELECT id FROM roms
          WHERE id > ? AND (meta_source IS NULL OR meta_source IN ('filename','seed','mame-list')
             OR (cover_path IS NULL AND meta_source IN ('thegamesdb','igdb','screenscraper','dat')))
            AND (? = 0 OR cover_path IS NULL)
          ORDER BY id LIMIT ?
        `).all(afterId, req.body?.only_missing_covers === true ? 1 : 0, batchSize).map((r) => r.id)
      : db.prepare(`
          SELECT id FROM roms
          WHERE meta_source IS NULL OR meta_source IN ('filename','seed')
             OR (cover_path IS NULL AND meta_source IN ('thegamesdb','igdb','screenscraper','dat'))
             OR (cover_path IS NULL AND meta_source = 'mame-list' AND meta_synced_at IS NULL)
          ORDER BY cover_path IS NOT NULL, id LIMIT ?
        `).all(Math.min(Number(req.body?.limit) || 25, 100)).map((r) => r.id);

    const onlyMissingCovers = req.body?.only_missing_covers === true;
    const results = [];
    let updated = 0, failed = 0, skipped = 0;

    for (const id of ids) {
      const rom = db.prepare(`
        SELECT r.*, p.slug AS platform_slug, p.name AS platform_name,
               p.screenscraper_id, p.tgdb_id, p.family
        FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?
      `).get(id);
      if (!rom) { skipped++; continue; }
      // "Fetch missing covers" must include ROMs that matched metadata earlier
      // but never got art: without this, one cover-less enrichment permanently
      // removes the ROM from every future bulk run (the exact stuck state
      // where only per-game Refresh ever fixes anything).
      if (onlyMissingCovers && rom.cover_path) { skipped++; continue; }

      const meta = await enrich({
        filename: rom.filename,
        titleTrusted: mameTitleTrusted(rom.platform_slug, rom.filename),
        title: rom.title,
        platform: {
          slug: rom.platform_slug,
          name: rom.platform_name,
          family: rom.family,
          screenscraper_id: rom.screenscraper_id,
          tgdb_id: rom.tgdb_id
        },
        hashes: { crc32: rom.crc32, md5: rom.md5, sha1: rom.sha1 }
      });

      if (!meta) {
        skipped++; results.push({ id, title: rom.title, status: 'no match' });
        // Mark attempted so the default batch moves on instead of retrying the same 25 forever.
        if (rom.meta_source === 'mame-list') db.prepare("UPDATE roms SET meta_synced_at = datetime('now') WHERE id = ?").run(id);
        continue;
      }
      if (meta.error) { failed++; results.push({ id, title: rom.title, status: meta.error }); continue; }

      // Surface which stripped query actually hit: when the raw filename
      // never matches, "updated via 'Bare Title'" explains the magic.
      const via = meta.matched_query && meta.matched_query !== rom.title ? ` via “${meta.matched_query}”` : '';
      // MAME: the zip-name title is authoritative; take art/year/etc. but not a provider's title.
      if (mameTitleTrusted(rom.platform_slug, rom.filename)) meta.title = null;
      await applyMetadataRecord(id, meta);

      updated++;
      results.push({ id, title: meta.title || rom.title, status: `updated${via}`, source: meta.source, cached: Boolean(meta.cached) });
    }

    res.json({
      requested: ids.length, updated, failed, skipped, results,
      // Paging cursor for the UI loop: more=false means the library has been walked.
      next_after_id: ids.length ? Math.max(...ids) : (paging ? afterId : null),
      more: paging ? ids.length >= batchSize : false
    });
  } catch (err) {
    next(err);
  }
});


/* ---------------------------------------- bulk enrichment as a server job
 * The browser used to drive the batches, so a page refresh stopped the run.
 * The server now owns the loop; the UI only starts, stops and polls it. */
const CANDIDATES_SQL = `
  (is_system = 0 AND (meta_source IS NULL OR meta_source IN ('filename','seed','mame-list')
     OR (cover_path IS NULL AND meta_source IN ('thegamesdb','igdb','screenscraper','dat'))))`;
const enrichJob = { running: false, stop: false, onlyMissingCovers: false, platform: '', total: 0, done: 0, updated: 0, skipped: 0, failed: 0, lastError: '', startedAt: null, finishedAt: null };

async function enrichOneRom(id, onlyMissingCovers) {
  const rom = db.prepare(`
    SELECT r.*, p.slug AS platform_slug, p.name AS platform_name, p.screenscraper_id, p.tgdb_id, p.family
    FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?
  `).get(id);
  if (!rom) return { kind: 'skipped' };
  if (onlyMissingCovers && rom.cover_path) return { kind: 'skipped' };
  const meta = await enrich({
    filename: rom.filename,
    titleTrusted: mameTitleTrusted(rom.platform_slug, rom.filename),
    title: rom.title,
    year: rom.release_year,
    platform: { slug: rom.platform_slug, name: rom.platform_name, family: rom.family, screenscraper_id: rom.screenscraper_id, tgdb_id: rom.tgdb_id },
    hashes: { crc32: rom.crc32, md5: rom.md5, sha1: rom.sha1 }
  });
  if (!meta) {
    if (rom.meta_source === 'mame-list') db.prepare("UPDATE roms SET meta_synced_at = datetime('now') WHERE id = ?").run(id);
    return { kind: 'skipped' };
  }
  if (meta.error) return { kind: 'failed', error: String(meta.error) };
  if (mameTitleTrusted(rom.platform_slug, rom.filename)) meta.title = null;
  await applyMetadataRecord(id, meta);
  return { kind: 'updated' };
}

async function runEnrichJob() {
  let cursor = 0;
  try {
    for (;;) {
      if (enrichJob.stop) break;
      const ids = db.prepare(`SELECT id FROM roms WHERE id > ? AND ${CANDIDATES_SQL} AND (? = 0 OR cover_path IS NULL) AND (? = '' OR platform_id = (SELECT id FROM platforms WHERE slug = ?)) ORDER BY id LIMIT 25`)
        .all(cursor, enrichJob.onlyMissingCovers ? 1 : 0, enrichJob.platform, enrichJob.platform).map((r) => r.id);
      if (!ids.length) break;
      for (const id of ids) {
        if (enrichJob.stop) break;
        cursor = id;
        try {
          const r = await enrichOneRom(id, enrichJob.onlyMissingCovers);
          if (r.kind === 'updated') enrichJob.updated++;
          else if (r.kind === 'failed') { enrichJob.failed++; enrichJob.lastError = r.error; }
          else enrichJob.skipped++;
        } catch (err) { enrichJob.failed++; enrichJob.lastError = err.message; }
        enrichJob.done++;
      }
    }
  } finally {
    enrichJob.running = false;
    enrichJob.finishedAt = new Date().toISOString();
  }
}

router.post('/bulk/enrich-job', requireAdmin, (req, res) => {
  if (enrichJob.running) return res.status(409).json({ error: 'A metadata run is already in progress', ...enrichJob });
  const onlyMissingCovers = req.body?.only_missing_covers === true;
  // Optional platform scope (the Library's selected platform): only that platform's games are looked up.
  const platform = String(req.body?.platform || '').trim();
  if (platform && platform !== 'all' && !db.prepare('SELECT 1 FROM platforms WHERE slug = ?').get(platform)) return res.status(400).json({ error: 'Unknown platform' });
  const scope = platform === 'all' ? '' : platform;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM roms WHERE ${CANDIDATES_SQL} AND (? = 0 OR cover_path IS NULL) AND (? = '' OR platform_id = (SELECT id FROM platforms WHERE slug = ?))`).get(onlyMissingCovers ? 1 : 0, scope, scope).n;
  Object.assign(enrichJob, { running: true, stop: false, onlyMissingCovers, platform: scope, total, done: 0, updated: 0, skipped: 0, failed: 0, lastError: '', startedAt: new Date().toISOString(), finishedAt: null });
  runEnrichJob();
  res.status(202).json({ ...enrichJob });
});

router.delete('/bulk/enrich-job', requireAdmin, (req, res) => {
  if (enrichJob.running) enrichJob.stop = true;
  res.json({ ...enrichJob });
});

/* ------------------------------------------------------------ upload */

router.post('/upload', upload.array('roms', 50), async (req, res, next) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

  const created = [];
  const skipped = [];
  const errors = [];

  for (const file of files) {
    try {
      const hashes = await hashFile(file.path);

      const duplicate = db.prepare('SELECT id, title FROM roms WHERE sha1 = ?').get(hashes.sha1);
      if (duplicate) {
        fs.unlinkSync(file.path);
        skipped.push({ filename: file.originalname, reason: 'duplicate', existing_id: duplicate.id, existing_title: duplicate.title });
        continue;
      }

      const parsed = parseFilename(file.originalname);
      if (req.body?.platform && !extensionAllowed(req.body.platform, file.originalname)) {
        fs.unlinkSync(file.path);
        skipped.push({ filename: file.originalname, reason: 'not a valid file type for this platform (MAME accepts .zip only)' });
        continue;
      }
      // Explicit choice wins; otherwise only an unambiguous extension is trusted,
      // and anything ambiguous is parked under "other" for the user to re-file.
      const platformSlug =
        req.body?.platform && (PLATFORM_SLUGS.has(req.body.platform) || db.prepare('SELECT 1 FROM platforms WHERE slug = ?').get(String(req.body.platform))) && req.body.platform !== 'auto'
          ? req.body.platform
          : (detectPlatform(file.originalname) || 'other');

      const platform = db.prepare('SELECT * FROM platforms WHERE slug = ?').get(platformSlug);
      const storagePath = placeRom(file.path, platformSlug, hashes.sha1, file.originalname);

      const info = db.prepare(`
        INSERT INTO roms (
          platform_id, title, sort_title, filename, storage_path, size_bytes,
          region, revision, release_year, crc32, md5, sha1
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        platform.id, parsed.title, sortTitle(parsed.title), file.originalname,
        storagePath, hashes.size, parsed.region, parsed.revision, parsed.year,
        hashes.crc32, hashes.md5, hashes.sha1
      );

      const romId = Number(info.lastInsertRowid);
      if (platformSlug === 'mame') applyMameNames(romId);
      if (parsed.tags.length) setTags(romId, parsed.tags);

      if (req.body?.enrich !== 'false') {
        const meta = await enrich({
          filename: file.originalname,
          titleTrusted: mameTitleTrusted(platformSlug, file.originalname),
          title: platformSlug === 'mame' ? (db.prepare('SELECT title FROM roms WHERE id = ?').get(romId)?.title || parsed.title) : parsed.title,
          platform,
          hashes
        }).catch(() => null);

        if (meta && !meta.error) {
          const { coverPath, mediaJson } = await applyProviderMedia(meta, hashes.sha1);

          db.prepare(`
            UPDATE roms SET
              title = COALESCE(?, title), sort_title = COALESCE(?, sort_title),
              developer = ?, publisher = ?, genre = ?, release_year = ?,
              players = ?, rating = ?, description = ?,
              cover_url = ?, cover_path = ?, provider_media = ?, meta_source = ?,
              meta_synced_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
          `).run(
            meta.title, meta.title ? sortTitle(meta.title) : null,
            meta.developer, meta.publisher, meta.genre, meta.release_year,
            meta.players, meta.rating, meta.description,
            meta.cover_url, coverPath, mediaJson, meta.source, romId
          );
        }
      }

      created.push(romById(romId, req.user?.id));
    } catch (err) {
      try { fs.unlinkSync(file.path); } catch { /* already moved */ }
      errors.push({ filename: file.originalname, error: err.message });
    }
  }

  res.status(created.length ? 201 : 200).json({ created, skipped, errors });
});

/* ------------------------------------------------------------ delete */

router.delete('/:id', (req, res) => {
  const rom = db.prepare('SELECT * FROM roms WHERE id = ?').get(req.params.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });

  if (rom.keep_override === 1) return res.status(409).json({ error: 'This game is locked. Unlock it first if you want to delete it.', locked: true });
  const favBy = db.prepare('SELECT u.username FROM favorites f JOIN users u ON u.id = f.user_id WHERE f.rom_id = ? ORDER BY u.username').all(rom.id).map((x) => x.username);
  if (favBy.length && req.query.confirm_favorites !== '1') {
    return res.status(409).json({ error: `This is a favourite of ${favBy.join(', ')}.`, favourite_of: favBy });
  }
  const keepFile = req.query.keep_file === '1';
  const { fileDeleted } = deleteRomRow(rom, {
    deleteFile: !keepFile && (req.query.delete_file === '1' || !rom.in_place)
  });
  res.json({ deleted: rom.id, file_deleted: fileDeleted, in_place: Boolean(rom.in_place) });
});

/**
 * Admin database maintenance: delete ROMs with no valid source. These are the
 * leftovers from "remove source but keep ROMs" — they can never be re-scanned
 * and have no folder to belong to.
 *
 * Query params:
 *   dry_run=1  (default) — count only, delete nothing
 *   delete_file=1 — also delete imported copies from storage (in-place files
 *     are NEVER touched by this endpoint)
 */
/* Admin: clear cover art for every ROM on one platform (e.g. wrong/duplicate
 * covers from title-based matching on MAME zips). Removes only cached cover
 * files and the cover columns; titles, metadata and the ROM files are untouched.
 * dry_run=1 (default) counts only. */
router.post('/clear-covers', requireAdmin, (req, res) => {
  const slug = String(req.body?.platform || req.query.platform || '');
  const plat = db.prepare('SELECT id FROM platforms WHERE slug = ?').get(slug);
  if (!plat) return res.status(400).json({ error: 'Unknown platform' });
  const rows = db.prepare("SELECT id, cover_path FROM roms WHERE platform_id = ? AND cover_locked = 0 AND (cover_path IS NOT NULL OR cover_url IS NOT NULL OR provider_media IS NOT NULL)").all(plat.id);
  if (req.body?.dry_run !== false && req.query.dry_run !== '0') return res.json({ platform: slug, would_clear: rows.length });
  const upd = db.prepare("UPDATE roms SET cover_path = NULL, cover_url = NULL, provider_media = NULL, updated_at = datetime('now') WHERE id = ?");
  db.transaction(() => { for (const r of rows) upd.run(r.id); })();
  for (const r of rows) { try { removeCoverFile(r.cover_path); } catch { /* best effort */ } }
  res.json({ platform: slug, cleared: rows.length });
});

router.delete('/', requireAdmin, (req, res) => {
  const orphans = db.prepare(`
    SELECT * FROM roms
    WHERE (source_id IS NULL
       OR source_id NOT IN (SELECT id FROM sources))
      AND COALESCE(keep_override, -1) <> 1
  `).all(); // copies marked Keep are never purged

  if (req.query.dry_run !== '0' && req.query.dry_run !== 'false') {
    return res.json({
      dry_run: true,
      orphans: orphans.length,
      bytes: orphans.reduce((n, r) => n + (r.size_bytes || 0), 0),
      sample: orphans.slice(0, 10).map((r) => ({ id: r.id, title: r.title }))
    });
  }

  let deleted = 0;
  let filesDeleted = 0;
  const errors = [];
  for (const rom of orphans) {
    try {
      const { fileDeleted } = deleteRomRow(rom, {
        // In-place orphans: catalogue row only, the user's own file stays put.
        deleteFile: req.query.delete_file === '1' && !rom.in_place
      });
      deleted++;
      if (fileDeleted) filesDeleted++;
    } catch (err) {
      errors.push({ id: rom.id, error: err.message });
    }
  }
  res.json({ dry_run: false, deleted, files_deleted: filesDeleted, errors: errors.slice(0, 20) });
});

/* -------------------------------------------------------- cover upload */

const coverUpload = multer({ limits: { fileSize: 8 * 1024 * 1024 } });

/** Identify an image by its first bytes. The browser's claimed type and the file name
 *  are not trusted: a renamed text/HTML/SVG file must never be stored as a cover. */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null; // GIF and SVG are deliberately not accepted (SVG can carry scripts)
}

router.post('/:id/cover', coverUpload.single('cover'), (req, res) => {
  const rom = db.prepare('SELECT * FROM roms WHERE id = ?').get(req.params.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const type = sniffImage(req.file.buffer);
  if (!type) return res.status(400).json({ error: 'That file is not a JPEG, PNG or WebP image' });

  if (rom.cover_path) removeCoverFile(rom.cover_path);
  // Own file name per ROM id (not the ROM's SHA1): provider covers are named by hash/URL,
  // and a custom cover must never share a file with, or be deleted by, another game.
  const coverPath = saveCover(req.file.buffer, `custom-${rom.id}-${Date.now()}`, type);
  db.prepare("UPDATE roms SET cover_path = ?, cover_locked = 1, updated_at = datetime('now') WHERE id = ?")
    .run(coverPath, rom.id);

  res.json(romById(rom.id, req.user?.id));
});

// Go back to automatic covers: forget the custom image and unlock the cover.
router.delete('/:id/cover', (req, res) => {
  const rom = db.prepare('SELECT id, cover_path, cover_locked FROM roms WHERE id = ?').get(req.params.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });
  if (rom.cover_locked && rom.cover_path) removeCoverFile(rom.cover_path);
  db.prepare("UPDATE roms SET cover_path = NULL, cover_url = NULL, cover_locked = 0, updated_at = datetime('now') WHERE id = ?").run(rom.id);
  res.json(romById(rom.id, req.user?.id));
});

/* ------------------------------------------------------ bulk actions */



export default router;
