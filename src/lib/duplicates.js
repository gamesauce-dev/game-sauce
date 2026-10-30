// Duplicate finder. Byte-identical files can't both be in the library (SHA1 is unique), so what is
// left are different versions of the same game: "Sonic 2 (USA)", "Sonic 2 (Europe)", "Sonic 2 (Rev A)".
// This groups those, suggests the one most people would keep, and lets the caller hide the others.
// It only reads. Hiding is reversible and nothing here ever touches a file on disk.
import path from 'node:path';
import db from '../db.js';
import { parseFilename, sortTitle } from './metadata.js';

const REGION_RANK = ['USA', 'World', 'Europe', 'Australia', 'Canada', 'Japan'];
// Arcade romsets: the zip name IS the game, so two zips are the same game only if MAME's name list says one is a clone of the other.
const ARCADE = new Set(['arcade', 'mame', 'fba', 'cps1', 'cps2', 'cps3', 'neogeo', 'naomi', 'atomiswave', 'coinop']);

const stem = (filename) => path.basename(String(filename || '')).replace(/\.(zip|7z)$/i, '').toLowerCase();

/**
 * What tells two games apart even when their stored titles are identical: the numbers in the file's own
 * name (Volume 2 vs Volume 3, Disc 1 vs Disc 2, Part 1 vs Part 2, "Game 2" vs "Game 3") and roman numerals.
 * Metadata providers and DATs sometimes give sequels or volumes the same title, so the stored title
 * alone is not trustworthy. Region and revision tags are already stripped by parseFilename, and a
 * four-digit year is ignored. Two files only count as the same game when these signatures agree.
 */
export function distinguishers(filename) {
  const title = parseFilename(String(filename || '')).title.toLowerCase();
  const nums = (title.replace(/\b(19|20)\d{2}\b/g, ' ').match(/\d+/g) || []).map((n) => String(Number(n)));
  const roman = (title.match(/\b[ivxlcdm]{2,6}\b/g) || []).filter((w) => /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/.test(w));
  return [...nums, ...roman].sort().join(',');
}

/** Arcade sets: clones of one game share their parent's short name, so group by that. */
function arcadeParent(row, names) {
  const n = names.get(stem(row.filename));
  return n ? (n.cloneof || n.name) : null;
}

function revisionRank(rev) {
  if (!rev) return 0;
  const m = String(rev).match(/(\d+(?:\.\d+)*)/);
  if (m) return 1 + parseFloat(m[1]);
  const letter = String(rev).match(/^[A-Z]$/i);
  return letter ? 1 + (letter[0].toUpperCase().charCodeAt(0) - 64) : 1;
}

/** Higher is better. Explains itself so the screen can say why one copy is suggested. */
export function score(r) {
  let s = 0;
  const why = [];
  if (r.dat_status === 'verified') { s += 1000; why.push('verified against a DAT'); }
  else if (r.dat_status === 'bad') { s -= 1000; why.push('flagged as a bad dump'); }
  else if (r.dat_status === 'variant') { s += 200; }
  const reg = REGION_RANK.indexOf(r.region);
  if (reg !== -1) { s += (REGION_RANK.length - reg) * 20; if (reg === 0) why.push('USA release'); }
  const rev = revisionRank(r.revision);
  if (rev) { s += rev * 5; why.push(`revision ${r.revision}`); }
  if (r.keep_override === 1) { s += 100000; why.push('you chose to keep this one'); }
  else if (r.keep_override === 0) { s -= 100000; }
  if (r.favorite) { s += 150; why.push('a favourite'); }
  if (r.cover_path) s += 15;
  if (r.meta_source && !['none', 'filename', 'seed'].includes(r.meta_source)) s += 10;
  return { score: s, why };
}

// Recomputing groups means reading the whole library, so a recent answer is reused (a few seconds' staleness is harmless).
// Anything that can change the groups (lock, hide, system, rename, delete, scan...) calls clearDuplicateCache().
const CACHE_MS = 30_000;
const cache = new Map();
export function clearDuplicateCache() { cache.clear(); }

export function findDuplicates(opts = {}) {
  const { platform = null, limit = 50, offset = 0, uid = null } = opts;
  const key = `${uid ?? ''}|${platform ?? ''}`;
  const hit = cache.get(key);
  let all;
  if (hit && Date.now() - hit.at < CACHE_MS) all = hit.value;
  else { all = computeDuplicates({ platform, uid }); cache.set(key, { at: Date.now(), value: all }); if (cache.size > 40) cache.delete(cache.keys().next().value); }
  return { total: all.total, extra: all.extra, groups: all.groups.slice(offset, offset + limit) };
}

function computeDuplicates({ platform = null, uid = null } = {}) {
  const rows = db.prepare(`
    SELECT r.id, r.title, r.sort_title, r.filename, r.size_bytes, r.region, r.revision, r.release_year,
           r.dat_status, r.source_path, r.storage_path, (SELECT name FROM sources WHERE id = r.source_id) AS source_name, EXISTS (SELECT 1 FROM favorites fv WHERE fv.rom_id = r.id) AS favorite, r.keep_override, r.cover_path, r.meta_source, r.source_id,
           p.id AS platform_id, p.slug AS platform_slug, p.name AS platform_name, p.short_name AS platform_short
    FROM roms r JOIN platforms p ON p.id = r.platform_id
    WHERE r.is_system = 0 AND r.missing = 0
      AND NOT EXISTS (SELECT 1 FROM hidden_roms hr WHERE hr.rom_id = r.id AND hr.user_id = @uid) ${platform ? 'AND p.slug = @platform' : ''}
  `).all({ uid: uid ?? -1, ...(platform ? { platform } : {}) });

  const names = new Map();
  if (rows.some((r) => ARCADE.has(r.platform_slug))) {
    for (const n of db.prepare('SELECT name, cloneof FROM mame_names WHERE isbios = 0 AND isdevice = 0').all()) names.set(n.name, n);
  }

  const groups = new Map();
  for (const r of rows) {
    let key;
    if (ARCADE.has(r.platform_slug)) {
      const parent = arcadeParent(r, names);
      // The platform is part of the key: FinalBurn Neo's enduror.zip and MAME's enduror.zip are different romsets, not duplicates.
      // No clone information? Then never guess from the title: a zip with no parent stays on its own (its zip name is its identity).
      key = parent ? `a|${r.platform_id}|${parent}` : `z|${r.platform_id}|${stem(r.filename)}`;
    } else {
      key = `t|${r.platform_id}|${r.sort_title || sortTitle(r.title)}|${distinguishers(r.filename)}`;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const dupes = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const ranked = list.map((r) => ({ r, ...score(r) })).sort((a, b) => b.score - a.score || a.r.id - b.r.id);
    // Display order is fixed (file name, then id) so locking or unlocking a copy never moves it under your pointer.
    // The score above still decides which copy is suggested and kept.
    const keepIndex = new Map(ranked.map((x, i) => [x.r.id, i]));
    const display = [...ranked].sort((a, b) => String(a.r.filename).localeCompare(String(b.r.filename)) || a.r.id - b.r.id);
    const best = ranked[0];
    // Copies you pinned all stay; otherwise just the top-scored one. At least one copy is always kept.
    const pinned = ranked.some((x) => x.r.keep_override === 1);
    // A tie: nothing in the score separates the top copies (and you haven't chosen). Say so instead of pretending.
    const tied = !pinned && ranked.length > 1 && ranked[0].score === ranked[1].score;
    // Disc images: the same stored title but very different sizes usually means two different games that got one title.
    const sizes = ranked.map((x) => Number(x.r.size_bytes) || 0).filter(Boolean);
    const sizeMismatch = !ARCADE.has(best.r.platform_slug) && sizes.length > 1 && Math.max(...sizes) / Math.min(...sizes) >= 1.6 && Math.max(...sizes) > 50 * 1048576;
    dupes.push({
      key,
      tied,
      size_mismatch: sizeMismatch,
      title: best.r.title,
      platform: best.r.platform_name,
      platform_slug: best.r.platform_slug,
      platform_short: best.r.platform_short,
      items: display.map((x) => ({ x, i: keepIndex.get(x.r.id) })).map(({ x, i }) => ({
        id: x.r.id, title: x.r.title, filename: x.r.filename, size_bytes: x.r.size_bytes,
        path: x.r.source_path || x.r.storage_path || null, source_name: x.r.source_name || null,
        region: x.r.region, revision: x.r.revision, year: x.r.release_year,
        dat_status: x.r.dat_status, favorite: !!x.r.favorite,
        cover_url: x.r.cover_path ? `/api/roms/${x.r.id}/cover` : null,
        keep: pinned ? x.r.keep_override === 1 : i === 0,
        chosen: x.r.keep_override === 1 ? 'keep' : x.r.keep_override === 0 ? 'drop' : null,
        tie: tied && x.score === ranked[0].score,
        why: (pinned ? x.r.keep_override === 1 : i === 0) ? (x.why.length ? x.why.join(', ') : 'the best match of the group') : null
      }))
    });
  }
  dupes.sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : a.title.localeCompare(b.title)));
  const total = dupes.length;
  const extra = dupes.reduce((n, g) => n + g.items.length - 1, 0);
  return { total, extra, groups: dupes };
}
