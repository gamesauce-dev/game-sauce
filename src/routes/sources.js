import express from 'express';
import { clearDuplicateCache } from '../lib/duplicates.js';
import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { scanSource, scanAll, getScanProgress, getAllScanProgress, sourceRoots } from '../lib/scanner.js';
import { PLATFORM_SLUGS, PLATFORMS } from '../lib/platforms.js';

const router = express.Router();

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const shape = (s) => ({
  ...s,
  extra_paths: db.prepare('SELECT id, path FROM source_paths WHERE source_id = ? ORDER BY id').all(s.id).map((r) => ({ ...r, exists: isDir(r.path) })),
  enabled: Boolean(s.enabled),
  hide_games: Boolean(s.hide_games),
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

/** Add another folder to a source (a collection split across drives). */
router.post('/:id/paths', (req, res) => {
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'Source not found' });
  const raw = String(req.body?.path || '').trim();
  if (!raw) return res.status(400).json({ error: 'path is required' });
  const resolved = path.resolve(raw);
  if (!isDir(resolved)) return res.status(400).json({ error: `Folder does not exist or is not readable: ${resolved}` });
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (sourceRoots(src).some((p) => same(p, resolved))) return res.status(409).json({ error: 'That folder is already part of this source' });
  const other = db.prepare('SELECT s.id, s.name FROM sources s WHERE s.id <> ? AND lower(s.path) = lower(?)').get(src.id, resolved)
    || db.prepare('SELECT s.id, s.name FROM source_paths sp JOIN sources s ON s.id = sp.source_id WHERE sp.source_id <> ? AND lower(sp.path) = lower(?)').get(src.id, resolved);
  if (other) return res.status(409).json({ error: `That folder already belongs to the source "${other.name}"` });
  db.prepare('INSERT INTO source_paths (source_id, path) VALUES (?, ?)').run(src.id, resolved);
  res.status(201).json(shape(db.prepare('SELECT * FROM sources WHERE id = ?').get(src.id)));
});

/** The folder was renamed or moved on disk: point the source at its new place. Every game of the source keeps its entry (details, covers, saves, locks); only where its file is changes. */
router.post('/:id/relocate', (req, res) => {
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'Source not found' });
  const raw = String(req.body?.path || '').trim();
  if (!raw) return res.status(400).json({ error: 'path is required' });
  const next = path.resolve(raw), old = path.resolve(src.path);
  if (!isDir(next)) return res.status(400).json({ error: `Folder does not exist or is not readable: ${next}` });
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const key = (p) => (ci ? p.toLowerCase() : p);
  if (key(old) === key(next)) return res.status(400).json({ error: "That is already this source's folder" });
  const other = db.prepare('SELECT s.name FROM sources s WHERE s.id <> ? AND lower(s.path) = lower(?)').get(src.id, next)
    || db.prepare('SELECT s.name FROM source_paths sp JOIN sources s ON s.id = sp.source_id WHERE lower(sp.path) = lower(?)').get(next);
  if (other) return res.status(409).json({ error: `That folder already belongs to the source "${other.name}"` });

  const inside = (p) => typeof p === 'string' && (key(p) === key(old) || key(p).startsWith(key(old) + path.sep));
  const moved = (p) => next + p.slice(old.length);
  const rows = db.prepare('SELECT id, source_path, storage_path FROM roms WHERE source_id = ? AND in_place = 1').all(src.id).filter((x) => inside(x.source_path));
  const plan = rows.map((x) => ({ id: x.id, source_path: moved(x.source_path), storage_path: inside(x.storage_path) ? moved(x.storage_path) : x.storage_path }));
  const found = plan.filter((x) => { try { return fs.statSync(x.source_path).isFile(); } catch { return false; } });
  // A wrong folder would mark the whole source missing: refuse when none of its games are there.
  if (plan.length && !found.length) return res.status(400).json({ error: `None of this source's ${plan.length} games were found in ${next}. Choose the folder that holds the same files.` });
  const foundIds = new Set(found.map((x) => x.id));
  const upd = db.prepare('UPDATE roms SET source_path = ?, storage_path = ?, missing = ?, updated_at = datetime(\'now\') WHERE id = ?');
  db.transaction(() => {
    for (const x of plan) upd.run(x.source_path, x.storage_path, foundIds.has(x.id) ? 0 : 1, x.id);
    db.prepare('UPDATE sources SET path = ? WHERE id = ?').run(next, src.id);
  })();
  clearDuplicateCache();
  res.json({ moved: plan.length, found: found.length, not_found: plan.length - found.length, source: shape(db.prepare('SELECT * FROM sources WHERE id = ?').get(src.id)) });
});

router.delete('/:id/paths/:pathId', (req, res) => {
  const row = db.prepare('SELECT * FROM source_paths WHERE id = ? AND source_id = ?').get(req.params.pathId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Folder not found' });
  // Its games stay in the library (flagged missing at the next scan); nothing on disk is touched.
  db.prepare('DELETE FROM source_paths WHERE id = ?').run(row.id);
  res.json({ removed: row.id, shape: shape(db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id)) });
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
  if (req.body.hide_games !== undefined) {
    const v = req.body.hide_games ? 1 : 0;
    sets.push('hide_games = @hide_games'); params.hide_games = v;
    db.prepare("UPDATE roms SET source_hidden = ? WHERE source_id = ?").run(v, src.id);
    clearDuplicateCache();
  }
  if (sets.length) db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = @id`).run(params);
  res.json(shape(db.prepare('SELECT * FROM sources WHERE id = ?').get(src.id)));
});

router.delete('/:id', (req, res) => {
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'Source not found' });

  const removeRoms = req.query.remove_roms === '1';
  db.prepare('UPDATE roms SET source_hidden = 0 WHERE source_id = ?').run(src.id);
  if (removeRoms) {
    // Only the catalogue entries go; the files on disk are never touched for an
    // in-place source. That is the whole point of scanning in place.
    // Copies marked Keep in the duplicate finder survive: they stay as orphans instead of being removed.
    db.prepare('UPDATE roms SET source_id = NULL WHERE source_id = ? AND keep_override = 1').run(src.id);
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
const DRIVES = '::drives';   // the "This PC" list on Windows: one entry per drive, reached by going Up from a drive's top folder
function windowsDrives() {
  const out = [];
  for (let c = 65; c <= 90; c++) { const drive = `${String.fromCharCode(c)}:\\`; try { fs.accessSync(drive); out.push({ name: `${String.fromCharCode(c)}:`, path: drive }); } catch { /* not present */ } }
  return out;
}
router.get('/browse', (req, res) => {
  if (process.platform === 'win32' && String(req.query.path || '') === DRIVES) return res.json({ path: 'This PC', parent: null, dirs: windowsDrives(), sample_files: [] });
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
    parent: parent === dir ? (process.platform === 'win32' ? DRIVES : null) : parent,
    dirs,
    // A cheap preview of what we would find here, so the user can tell before adding.
    sample_files: entries.filter((e) => e.isFile()).slice(0, 12).map((e) => e.name)
  });
});

export default router;
