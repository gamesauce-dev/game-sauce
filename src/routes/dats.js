import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import {
  datCoverage, datHolding, deleteDatfile, importDat, listDatfiles, rematchAll,
  SUPPORTED_DAT_PLATFORMS
} from '../dats.js';
import db from '../db.js';
import { storageDir } from '../lib/storage.js';
import { importMameNames, applyMameNames, ARCADE_ROMSET } from '../lib/mamenames.js';

/** True for a MAME `-listxml` file (UTF-8 or UTF-16): <!DOCTYPE mame / <mame build=. */
function isMameListXml(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(4096);
  const n = fs.readSync(fd, b, 0, b.length, 0);
  fs.closeSync(fd);
  const head = b.subarray(0, n);
  const text = head[0] === 0xff && head[1] === 0xfe ? head.toString('utf16le') : head.toString('utf8');
  return /<!DOCTYPE\s+mame\b|<mame\s+build=/i.test(text);
}

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, storageDir('dats')),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${path.basename(file.originalname).replace(/[^\w.\-]+/g, '_')}`)
  }),
  limits: { fileSize: Number(process.env.GAMESAUCE_MAX_DAT || 512 * 1024 * 1024) },
  fileFilter: (req, file, cb) => {
    const ok = /\.(dat|xml)$/i.test(file.originalname);
    cb(ok ? null : Object.assign(new Error('DAT files must be .dat or .xml'), { status: 400 }), ok);
  }
});

router.get('/', (req, res) => {
  res.json({
    items: listDatfiles(),
    coverage: datCoverage(),
    platforms: SUPPORTED_DAT_PLATFORMS
  });
});

/**
 * Import a DAT from an uploaded file, or from a path already on this machine.
 * Both go through the same streaming parser.
 */
router.post('/', upload.single('dat'), async (req, res, next) => {
  let uploadedPath = req.file?.path || null;
  try {
    const sourcePath = uploadedPath || (req.body?.path ? path.resolve(String(req.body.path)) : null);
    if (!sourcePath) return res.status(400).json({ error: 'Upload a DAT file or provide a path' });

    // MAME -listxml is a name list, not a checksum DAT: route it to the name table.
    if (isMameListXml(sourcePath)) {
      const out = await importMameNames(sourcePath);
      let datMatched = 0;
      for (const slug of ARCADE_ROMSET) datMatched += rematchAll({ platform: slug }).matched;   // the machines it listed are now sets: match the arcade games on them
      if (uploadedPath) { try { fs.unlinkSync(uploadedPath); } catch { /* best effort */ } }
      uploadedPath = null;
      return res.status(201).json({ kind: 'mame-names', platform: 'mame', platform_name: 'MAME', entries: out.names, ...out, dat_matched: datMatched, coverage: datCoverage() });
    }

    const result = await importDat({
      filePath: sourcePath,
      platform: req.body?.platform && req.body.platform !== 'auto' ? req.body.platform : null,
      name: req.body?.name || null,
      userId: req.user?.id || null
    });

    // The DAT itself is not kept — entries are in the database now, and the file
    // can be tens of MB.
    if (uploadedPath) { try { fs.unlinkSync(uploadedPath); } catch { /* best effort */ } }
    uploadedPath = null;

    res.status(201).json({ ...result, coverage: datCoverage() });
  } catch (err) {
    if (uploadedPath) { try { fs.unlinkSync(uploadedPath); } catch { /* best effort */ } }
    next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    res.json(deleteDatfile(Number(req.params.id)));
  } catch (err) { next(err); }
});

/** Re-run matching across the library after importing or removing a DAT. */
router.post('/rematch', (req, res, next) => {
  try {
    const stats = rematchAll({
      platform: req.body?.platform && req.body.platform !== 'all' ? req.body.platform : null,
      force: req.body?.force === true
    });
    // MAME zips can't match a checksum DAT; re-apply the name list too.
    const mame = applyMameNames();
    res.json({ ...stats, mame_titled: mame.matched, coverage: datCoverage() });
  } catch (err) { next(err); }
});

/** Which of my ROMs does this DAT know about, and which does it not? */
router.get('/:id/coverage', (req, res) => {
  const id = Number(req.params.id);
  const datfile = listDatfiles().find((d) => d.id === id);
  if (!datfile) return res.status(404).json({ error: 'DAT not found' });

  const matched = datfile.roms_matched;   // by checksum, or by set name for an arcade DAT

  const statuses = db.prepare(`
    SELECT COALESCE(r.dat_status,'unchecked') AS status, COUNT(*) AS count
    FROM roms r
    WHERE r.platform_id = (SELECT id FROM platforms WHERE slug = ?)
    GROUP BY r.dat_status
  `).all(datfile.platform_slug);

  res.json({ datfile, matched, entries: datfile.entries, statuses });
});

/**
 * Have/want report for one DAT: every entry the DAT lists, flagged have/missing
 * against this library, plus the summary counts. Paginated — DATs are big.
 *
 * NOTE: Express matches '/:id/coverage' before '/:id/have-want' only by order;
 * keep literal-ish suffix routes specific and registered where they cannot be
 * shadowed. '/:id/have-want' must not collide with '/:id' elsewhere — this router
 * only has '/:id/coverage' and '/:id/have-want', so both are safe.
 */
router.get('/:id/have-want', (req, res) => {
  const id = Number(req.params.id);
  const datfile = listDatfiles().find((d) => d.id === id);
  if (!datfile) return res.status(404).json({ error: 'DAT not found' });

  const want = String(req.query.want || 'missing').toLowerCase(); // missing | have | all
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  // An arcade DAT is kept by game (set), so its report is one row per game, not one per chip.
  if (datfile.sets > 0) {
    const w = ['s.datfile_id = @datfile'], p = { datfile: id };
    if (want === 'missing') w.push('NOT EXISTS (SELECT 1 FROM roms r WHERE r.dat_set_id = s.id)');
    else if (want === 'have') w.push('EXISTS (SELECT 1 FROM roms r WHERE r.dat_set_id = s.id)');
    if (q) { w.push('(instr(lower(s.title), lower(@q)) > 0 OR instr(s.set_name, lower(@q)) > 0)'); p.q = q; }
    const total = db.prepare(`SELECT COUNT(*) AS n FROM dat_sets s WHERE ${w.join(' AND ')}`).get(p).n;
    const items = db.prepare(`
      SELECT s.id, s.title, s.set_name AS rom_name, NULL AS size, NULL AS crc32, NULL AS md5, NULL AS sha1, s.status, s.cloneof,
             (SELECT r.id FROM roms r WHERE r.dat_set_id = s.id LIMIT 1) AS have_rom_id,
             EXISTS (SELECT 1 FROM roms r WHERE r.dat_set_id = s.id) AS have
      FROM dat_sets s WHERE ${w.join(' AND ')} ORDER BY s.title LIMIT ${limit} OFFSET ${offset}
    `).all(p).map((e) => ({ ...e, have: Boolean(e.have) }));
    return res.json({ datfile, want, total, limit, offset, items });
  }

  // One line per game, whatever the region: "Halo 3 (USA)", "Halo 3 (Europe)" and "Halo 3 (Japan)" are one game. It is held if a ROM matched any of them, or
  // the same game is on the Physical shelf or in Digital (by anyone on the server), so the report looks across the whole platform, not only the ROMs.
  if (String(req.query.group || '') === 'game') {
    const baseTitle = (t) => String(t).replace(/\s*[(\[][^)\]]*[)\]]/g, '').trim() || t;
    const h = datHolding(id, datfile.platform_slug);
    const ql = q.toLowerCase();
    let list = [...h.names.entries()].filter(([, e]) => !ql || e.title.toLowerCase().includes(ql)).sort((x, y) => (x[0] < y[0] ? -1 : 1))
      .map(([norm, e]) => ({ id: null, title: baseTitle(e.title), rom_name: null, releases: e.releases, held: h.heldAs(norm), libs: h.libsOf(norm) }));
    list = list.map((e) => ({ ...e, have: Boolean(e.held) }));
    if (want === 'missing') list = list.filter((e) => !e.have); else if (want === 'have') list = list.filter((e) => e.have);
    return res.json({ datfile, want, group: 'game', games: h.games, games_have: h.games_have, held: h.count, in_libs: h.inLib, total: list.length, limit, offset, items: list.slice(offset, offset + limit) });
  }

  const where = ['e.datfile_id = @datfile'];
  const params = { datfile: id };
  if (want === 'missing') where.push('NOT EXISTS (SELECT 1 FROM roms r WHERE r.dat_entry_id = e.id)');
  else if (want === 'have') where.push('EXISTS (SELECT 1 FROM roms r WHERE r.dat_entry_id = e.id)');
  if (q) { where.push('(instr(lower(e.title), lower(@q)) > 0)'); params.q = q; }

  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM dat_entries e WHERE ${where.join(' AND ')}
  `).get(params).n;

  const items = db.prepare(`
    SELECT e.id, e.title, e.rom_name, e.size, e.crc32, e.md5, e.sha1, e.status, e.cloneof,
           (SELECT r.id FROM roms r WHERE r.dat_entry_id = e.id) AS have_rom_id,
           EXISTS (SELECT 1 FROM roms r WHERE r.dat_entry_id = e.id) AS have
    FROM dat_entries e
    WHERE ${where.join(' AND ')}
    ORDER BY e.title
    LIMIT ${limit} OFFSET ${offset}
  `).all(params).map((e) => ({ ...e, have: Boolean(e.have) }));

  res.json({ datfile, want, total, limit, offset, items });
});

export default router;
