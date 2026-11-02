import express from 'express';
import db from '../db.js';
import { playableCore } from './roms.js';

const router = express.Router();

// A collection belongs to whoever made it, and only they see or change it (admins included).
const mine = (req) => Number(req.user?.id ?? -1);
const own = (req, id) => db.prepare('SELECT * FROM collections WHERE id = ? AND user_id = ?').get(id, mine(req));

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.description, c.created_at, COUNT(cr.rom_id) AS count
    FROM collections c LEFT JOIN collection_roms cr ON cr.collection_id = c.id
    WHERE c.user_id = ?
    GROUP BY c.id ORDER BY c.name
  `).all(mine(req));
  // Up to four covers per collection, for the preview strip on its card.
  const admin = req.user?.role === 'admin';
  const pick = db.prepare(`SELECT r.id FROM collection_roms cr JOIN roms r ON r.id = cr.rom_id
    WHERE cr.collection_id = ? AND r.cover_path IS NOT NULL ${admin ? 'AND r.source_hidden = 0' : 'AND r.hidden_all = 0 AND r.source_hidden = 0'} ORDER BY cr.rowid DESC LIMIT 4`);
  for (const c of rows) c.covers = pick.all(c.id).map((x) => `/api/roms/${x.id}/cover`);
  res.json({ items: rows });
});

router.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const info = db.prepare('INSERT INTO collections (user_id, name, description) VALUES (?, ?, ?)')
      .run(mine(req), name, req.body?.description || null);
    res.status(201).json(db.prepare('SELECT * FROM collections WHERE id = ?').get(info.lastInsertRowid));
  } catch {
    res.status(409).json({ error: 'A collection with that name already exists' });
  }
});

router.get('/:id', (req, res) => {
  const collection = own(req, req.params.id);
  if (!collection) return res.status(404).json({ error: 'Collection not found' });

  const items = db.prepare(`
    SELECT r.id, r.title, r.sort_title, r.release_year, r.region, r.cover_path, r.play_override, r.missing,
           p.slug AS platform, p.short_name AS platform_short, p.accent AS platform_accent
    FROM collection_roms cr
    JOIN roms r ON r.id = cr.rom_id
    JOIN platforms p ON p.id = r.platform_id
    WHERE cr.collection_id = ? ${req.user?.role === 'admin' ? 'AND r.source_hidden = 0' : 'AND r.hidden_all = 0 AND r.source_hidden = 0'}
    ORDER BY r.sort_title
  `).all(collection.id).map((r) => ({
    ...r,
    cover_url: r.cover_path ? `/api/roms/${r.id}/cover` : r.cover_url
  })).map(({ play_override, missing, ...r }) => ({ ...r, playable: !missing && playableCore(r.platform, r.release_year, play_override) ? true : false }));

  res.json({ ...collection, items });
});

router.patch('/:id', (req, res) => {
  const existing = own(req, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Collection not found' });
  db.prepare('UPDATE collections SET name = ?, description = ? WHERE id = ?')
    .run(req.body?.name ?? existing.name, req.body?.description ?? existing.description, existing.id);
  res.json(db.prepare('SELECT * FROM collections WHERE id = ?').get(existing.id));
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM collections WHERE id = ? AND user_id = ?').run(req.params.id, mine(req));
  if (!info.changes) return res.status(404).json({ error: 'Collection not found' });
  res.json({ deleted: Number(req.params.id) });
});

router.post('/:id/roms', (req, res) => {
  const collection = own(req, req.params.id);
  if (!collection) return res.status(404).json({ error: 'Collection not found' });

  const ids = Array.isArray(req.body?.rom_ids) ? req.body.rom_ids.map(Number).filter(Boolean) : [];
  const link = db.prepare('INSERT OR IGNORE INTO collection_roms (collection_id, rom_id) VALUES (?, ?)');
  let added = 0;
  db.transaction(() => {
    for (const id of ids) {
      if (db.prepare('SELECT 1 FROM roms WHERE id = ?').get(id)) added += link.run(collection.id, id).changes;
    }
  })();
  res.json({ added });
});

router.delete('/:id/roms/:romId', (req, res) => {
  if (!own(req, req.params.id)) return res.status(404).json({ error: 'Collection not found' });
  const info = db.prepare('DELETE FROM collection_roms WHERE collection_id = ? AND rom_id = ?')
    .run(req.params.id, req.params.romId);
  res.json({ removed: info.changes });
});

export default router;
