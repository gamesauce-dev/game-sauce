import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import {
  datCoverage, deleteDatfile, importDat, listDatfiles, rematchAll,
  SUPPORTED_DAT_PLATFORMS
} from '../dats.js';
import db from '../db.js';
import { storageDir } from '../lib/storage.js';
import { importMameNames, applyMameNames } from '../lib/mamenames.js';

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
      if (uploadedPath) { try { fs.unlinkSync(uploadedPath); } catch { /* best effort */ } }
      uploadedPath = null;
      return res.status(201).json({ kind: 'mame-names', platform: 'mame', platform_name: 'MAME', entries: out.names, ...out, coverage: datCoverage() });
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

  const matched = db.prepare(`
    SELECT COUNT(*) AS n FROM roms
    WHERE dat_entry_id IN (SELECT id FROM dat_entries WHERE datfile_id = ?)
  `).get(id).n;

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
