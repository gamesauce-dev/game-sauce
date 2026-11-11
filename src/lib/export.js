// Export: a CSV of the library's game data, and a zip of the cover pictures named after each game's file.
// Both are read-only and admin only (the CSV names folders on the server). The zip is written as a stream, one cover at a time, so
// a big library never has to fit in memory; covers are stored as they are (they are already compressed pictures).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import db from '../db.js';

/** One CSV cell: quoted when it holds a comma, quote or line break; a leading = + - @ is defused so a spreadsheet never runs it. */
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// The first two columns are what Settings > Game names (CSV) reads back (rom_name, short_game_name), so an export can be edited and
// imported again. The rest are the details window's editable fields, then the rest of what is known about the game.
export const COLUMNS = [
  'rom_name', 'short_game_name', 'platform', 'platform_name', 'where', 'path', 'size_bytes',
  'developer', 'publisher', 'genre', 'region', 'revision', 'year', 'players', 'rating', 'description', 'tags',
  'cover_file', 'metadata_source', 'dat_status', 'crc32', 'md5', 'sha1', 'system_item', 'hidden_for_everyone'
];

/** Which picture type a cover is, from the first bytes (they are saved as .jpg, .png or .webp). */
export function coverExt(file) {
  try {
    const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(12); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
    if (b[0] === 0x89 && b[1] === 0x50) return 'png';
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  } catch { /* fall through */ }
  return path.extname(file).replace('.', '') || 'jpg';
}

/** The picture's name in the zip: the game's file name with its extension swapped, so the two sit together. Unique per platform. */
export function coverName(row, ext, used) {
  const base = String(row.filename || `game-${row.id}`).replace(/\.[A-Za-z0-9]{1,6}$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || `game-${row.id}`;
  let name = `${row.platform}/${base}.${ext}`, n = 2;
  while (used.has(name.toLowerCase())) name = `${row.platform}/${base} (${n++}).${ext}`;
  used.add(name.toLowerCase());
  return name;
}

function query({ platform = '', includeHidden = false } = {}) {
  const slugs = String(platform || '').split(',').map((s) => s.trim()).filter(Boolean);
  const where = [];
  const args = [];
  if (slugs.length) { where.push(`p.slug IN (${slugs.map(() => '?').join(',')})`); args.push(...slugs); }
  if (!includeHidden) where.push('r.hidden_all = 0 AND r.source_hidden = 0');
  return db.prepare(`
    SELECT r.id, r.title, r.filename, r.size_bytes, r.region, r.revision, r.release_year, r.developer, r.publisher, r.genre, r.players,
           r.rating, r.description, r.cover_path, r.meta_source, r.dat_status, r.crc32, r.md5, r.sha1, r.is_system, r.hidden_all,
           r.storage_path, r.source_id, r.in_place, p.slug AS platform, p.name AS platform_name, s.name AS source_name,
           (SELECT group_concat(t.name, '; ') FROM rom_tags rt JOIN tags t ON t.id = rt.tag_id WHERE rt.rom_id = r.id) AS tags
    FROM roms r JOIN platforms p ON p.id = r.platform_id LEFT JOIN sources s ON s.id = r.source_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.slug, r.sort_title, r.id`).all(...args);
}

/** The CSV text for the chosen platforms. */
export function* csvLines(opts) {
  yield '\uFEFF' + COLUMNS.join(',') + '\r\n';
  const used = new Set();
  for (const r of query(opts)) {
    const hasCover = Boolean(r.cover_path && fs.existsSync(r.cover_path));
    const cover = hasCover ? coverName(r, coverExt(r.cover_path), used).split('/').slice(1).join('/') : '';
    const cells = [
      r.filename, r.title, r.platform, r.platform_name, r.source_id ? `source: ${r.source_name || r.source_id}` : 'vault (imported)',
      r.storage_path, r.size_bytes, r.developer, r.publisher, r.genre, r.region, r.revision, r.release_year, r.players, r.rating,
      r.description, r.tags, cover, r.meta_source, r.dat_status, r.crc32, r.md5, r.sha1, r.is_system ? 'yes' : '', r.hidden_all ? 'yes' : ''
    ];
    yield cells.map(csvCell).join(',') + '\r\n';
  }
}

/** How many games and covers an export would hold (shown before the download starts). */
export function exportCounts(opts) {
  const rows = query(opts);
  return { games: rows.length, covers: rows.filter((r) => r.cover_path && fs.existsSync(r.cover_path)).length };
}

/* ───────── a zip written as it goes (stored, no compression: covers are already JPEG/PNG/WebP) ───────── */
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0; let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** Yields zip chunks for [{ name, file }] (or { name, data } for a buffer) one entry at a time. */
export function* zipChunks(entries) {
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const e of entries) {
    let data;
    if (e.data) data = e.data;   // text made on the spot (not a file)
    else { try { data = fs.readFileSync(e.file); } catch { continue; } }
    const name = Buffer.from(e.name, 'utf8'), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    yield local; yield name; yield data;
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dosTime, 12); cd.writeUInt16LE(dosDate, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));
    offset += 30 + name.length + data.length;
    if (offset > 0xf0000000) throw new Error('This export is too large for one zip: pick fewer platforms');
  }
  const cdBuf = Buffer.concat(central);
  yield cdBuf;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  yield end;
}

/** The pictures to put in the zip: [{ name, file }]. */
export function coverEntries(opts) {
  const used = new Set(), out = [];
  for (const r of query(opts)) {
    if (!r.cover_path || !fs.existsSync(r.cover_path)) continue;
    out.push({ name: coverName(r, coverExt(r.cover_path), used), file: r.cover_path });
  }
  return out;
}
