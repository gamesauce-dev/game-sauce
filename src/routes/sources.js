import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { scanSource, scanAll, getScanProgress, getAllScanProgress } from '../lib/scanner.js';
import { PLATFORM_SLUGS, PLATFORMS } from '../lib/platforms.js';

const router = express.Router();

const shape = (s) => ({
  ...s,
  enabled: Boolean(s.enabled),
  watch: Boolean(s.watch),
  recursive: Boolean(s.recursive),
  exists: (() => { try { return fs.statSync(s.path).isDirectory(); } catch { return false; } })(),
  rom_count: db.prepare('SELECT COUNT(*) AS n FROM roms WHERE source_id = ?').get(s.id).n,
  missing_count: db.prepare('SELECT COUNT(*) AS n FROM roms WHERE source_id = ? AND missing = 1').get(s.id).n,
  total_bytes: db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS n FROM roms WHERE source_id = ?').get(s.id).n
});

router.get('/', (req, res) => {
  const items = db.prepare('SELECT * FROM sources ORDER BY name COLLATE NOCASE').all().map(shape);
  res.json({ items });
});

router.post('/', (req, res) => {
  const raw = String(req.body?.path || '').trim();
  if (!raw) return res.status(400).json({ error: 'path is required' });

  const resolved = path.resolve(raw);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return res.status(400).json({ error: `Folder does not exist or is not readable: ${resolved}` });
  }
  if (!stat.isDirectory()) return res.status(400).json({ error: 'Path must be a folder' });

  const hint = req.body?.platform_hint || req.body?.platform || null;
  if (!hint || hint === 'auto' || !(PLATFORM_SLUGS.has(hint) || db.prepare('SELECT 1 FROM platforms WHERE slug = ?').get(String(hint)))) {
    return res.status(400).json({ error: 'Platform is required: pick the platform this folder holds (no auto-detect)' });
  }

  try {
    const info = db.prepare(`
      INSERT INTO sources (name, path, platform_hint, recursive, ignore_globs)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      String(req.body?.name || path.basename(resolved) || resolved).trim(),
      resolved,
      hint,
      req.body?.recursive === false ? 0 : 1,
      req.body?.ignore_globs || null
    );
    res.status(201).json(shape(db.prepare('SELECT * FROM sources WHERE id = ?').get(info.lastInsertRowid)));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That folder is already a source' });
    }
    throw err;
  }
});

router.patch('/:id', (req, res) => {
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'Source not found' });

  const sets = [];
  const params = { id: src.id };
  for (const field of ['name', 'ignore_globs']) {
    if (req.body[field] !== undefined) {
      sets.push(`${field} = @${field}`);
      params[field] = req.body[field] === '' ? null : req.body[field];
    }
  }
  // platform_hint: blank/'auto' clears the override here (the edit-source
  // form still allows it), but creation requires a real platform.
  if (req.body.platform_hint !== undefined || req.body.platform !== undefined) {
    const v = req.body.platform_hint ?? req.body.platform;
    sets.push('platform_hint = @platform_hint');
    params.platform_hint = (v === '' || v === 'auto') ? null : v;
  }
  for (const field of ['enabled', 'watch', 'recursive']) {
    if (req.body[field] !== undefined) {
      sets.push(`${field} = @${field}`);
      params[field] = req.body[field] ? 1 : 0;
    }
  }
  if (sets.length) db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = @id`).run(params);
  res.json(shape(db.prepare('SELECT * FROM sources WHERE id = ?').get(src.id)));
});

router.delete('/:id', (req, res) => {
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'Source not found' });

  const removeRoms = req.query.remove_roms === '1';
  if (removeRoms) {
    // Only the catalogue entries go; the files on disk are never touched for an
    // in-place source. That is the whole point of scanning in place.
    db.prepare('DELETE FROM roms WHERE source_id = ?').run(src.id);
  } else {
    db.prepare('UPDATE roms SET source_id = NULL WHERE source_id = ?').run(src.id);
  }
  db.prepare('DELETE FROM sources WHERE id = ?').run(src.id);
  res.json({ deleted: src.id, removed_roms: removeRoms });
});

// Live progress for the UI bar (polled). Empty list = nothing running.
router.get('/scan/progress', (req, res) => res.json({ items: getAllScanProgress() }));
router.get('/:id/scan/progress', (req, res) => res.json(getScanProgress(req.params.id) || { phase: 'idle' }));

router.post('/:id/scan', async (req, res, next) => {
  try {
    const result = await scanSource(Number(req.params.id), {
      hash: req.body?.hash !== false,
      // Auto-enrich: UI sends enrich=true on "scan now"; create-source also
      // passes it so a freshly added folder gets metadata immediately.
      enrich: req.body?.enrich === true
    });
    res.json(result);
  } catch (err) {
    if (err.message === 'Source not found') return res.status(404).json({ error: err.message });
    if (err.status === 409) return res.status(409).json({ error: err.message });
    next(err);
  }
});

router.post('/scan', async (req, res, next) => {
  try {
    const results = await scanAll({ hash: req.body?.hash !== false, enrich: req.body?.enrich === true });
    res.json({ sources: results });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/log', (req, res) => {
  const items = db.prepare('SELECT * FROM scan_log WHERE source_id = ? ORDER BY id DESC LIMIT 20')
    .all(req.params.id);
  res.json({ items });
});

/** Ask the OS which drives exist, so the UI can offer them instead of a bare text box. */
router.get('/roots', (req, res) => {
  const roots = [];
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const drive = `${String.fromCharCode(c)}:\\`;
      try {
        fs.accessSync(drive);
        roots.push(drive);
      } catch { /* not present */ }
    }
  } else {
    roots.push('/');
    for (const mount of ['/mnt', '/media', '/Volumes', '/run/media']) {
      try {
        for (const entry of fs.readdirSync(mount, { withFileTypes: true })) {
          if (entry.isDirectory()) roots.push(path.join(mount, entry.name));
        }
      } catch { /* not present */ }
    }
  }
  res.json({ roots, platform_families: [...new Set(PLATFORMS.map((p) => p.family))] });
});

/** Browse a folder server-side (localhost app), so the user can pick a path in the UI. */
router.get('/browse', (req, res) => {
  const dir = path.resolve(String(req.query.path || (process.platform === 'win32' ? 'C:\\' : '/')));
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return res.status(400).json({ error: `Cannot read ${dir}: ${err.code || err.message}` });
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('$') && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const parent = path.dirname(dir);
  res.json({
    path: dir,
    parent: parent === dir ? null : parent,
    dirs,
    // A cheap preview of what we would find here, so the user can tell before adding.
    sample_files: entries.filter((e) => e.isFile()).slice(0, 12).map((e) => e.name)
  });
});

export default router;
