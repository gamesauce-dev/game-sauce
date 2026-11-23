// Theme videos: a short looping video that shows a game off (arcade theme videos), kept apart from the gameplay video (game_videos, src/lib/emumovies.js) so neither replaces the other.
// They are brought in by the game assets importer (src/lib/artimport.js) from a "theme" folder per platform and are linked where they are, not copied.
// A tile's hover preview plays the theme video when the game has one and the gameplay video otherwise; the details window keeps playing the gameplay video.
import fs from 'node:fs';
import db from '../db.js';
import { titleKey } from './emumovies.js';

export function setThemeVideo(platform, key, file, bytes) {
  db.prepare("INSERT INTO theme_videos (platform, title_key, path, bytes) VALUES (?, ?, ?, ?) ON CONFLICT(platform, title_key) DO UPDATE SET path = excluded.path, bytes = excluded.bytes")
    .run(platform, key, file, bytes || null);
}

/** { path, bytes } of a game's theme video, or null (a file that has gone is forgotten). */
export function themeVideoFile({ title, platform }) {
  const slug = String(platform?.slug || platform || ''), key = titleKey(title);
  if (!slug || !key) return null;
  const row = db.prepare('SELECT path, bytes FROM theme_videos WHERE platform = ? AND title_key = ?').get(slug, key);
  if (!row) return null;
  if (!fs.existsSync(row.path)) { db.prepare('DELETE FROM theme_videos WHERE platform = ? AND title_key = ?').run(slug, key); return null; }
  return row;
}

/** Marks list items that have a theme video (item.has_theme = true). One query for the lot. */
export function flagThemeVideos(items, titleOf, platformOf) {
  const keys = new Set(db.prepare('SELECT platform || char(10) || title_key AS k FROM theme_videos').all().map((r) => r.k));
  if (!keys.size) return items;
  for (const it of items) { const p = platformOf(it); if (p && keys.has(p + '\n' + titleKey(titleOf(it)))) it.has_theme = true; }
  return items;
}
