// Name list import (CSV): maps a ROM file name to a proper game name, so title-based
// metadata providers can find the game. Works for any platform (arcade romsets first).
import db from '../db.js';
import { sortTitle } from './metadata.js';

/** Minimal RFC-4180 CSV parser (quotes, doubled quotes, CRLF, BOM). */
export function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

const keyOf = (name) => String(name || '').trim().replace(/\.(zip|7z|rar)$/i, '').toLowerCase();

/**
 * @param {{csvText:string, platform:string, romCol?:string, nameCol?:string, yearCol?:string, makerCol?:string, apply?:boolean}} o
 */
export function importNames({ csvText, platform, romCol = 'rom_name', nameCol = 'short_game_name', yearCol = 'year', makerCol = 'manufacturer', hideSystem = false, apply = false }) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw Object.assign(new Error('The CSV has no data rows'), { status: 400 });
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n) => head.indexOf(String(n || '').trim().toLowerCase());
  const iRom = col(romCol), iName = col(nameCol), iYear = col(yearCol), iMaker = col(makerCol);
  const iBios = col('is_bios'), iDev = col('is_device');
  const yes = (v) => /^(yes|y|true|1)$/i.test(String(v || '').trim());
  if (iRom < 0) throw Object.assign(new Error(`No "${romCol}" column. Columns found: ${rows[0].join(', ')}`), { status: 400 });
  if (iName < 0) throw Object.assign(new Error(`No "${nameCol}" column. Columns found: ${rows[0].join(', ')}`), { status: 400 });

  const map = new Map();
  for (const r of rows.slice(1)) {
    const k = keyOf(r[iRom]); const title = String(r[iName] || '').trim();
    if (k && title && !map.has(k)) map.set(k, { title, year: iYear >= 0 && /^\d{4}/.test(r[iYear] || '') ? Number(r[iYear].slice(0, 4)) : null, maker: iMaker >= 0 ? String(r[iMaker] || '').trim() || null : null, system: (iBios >= 0 && yes(r[iBios])) || (iDev >= 0 && yes(r[iDev])) });
  }

  const roms = db.prepare('SELECT r.id, r.filename, r.title FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE p.slug = ?').all(platform);
  const hits = []; let unmatched = 0;
  for (const r of roms) { const m = map.get(keyOf(r.filename)); if (m) hits.push({ id: r.id, filename: r.filename, from: r.title, ...m }); else unmatched++; }

  const systemHits = hits.filter((h) => h.system);
  if (apply) {
    if (hideSystem && systemHits.length) {
      const hide = db.prepare("UPDATE roms SET hidden = 1, hidden_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND hidden = 0");
      db.transaction(() => { for (const h of systemHits) hide.run(h.id); })();
    }
    // MAME: titles from your CSV count as trusted names, so title-based providers are allowed to search them.
    if (platform === 'mame') {
      const ins = db.prepare('INSERT INTO mame_names (name, title, year, manufacturer) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO NOTHING');
      db.transaction(() => { for (const h of hits) ins.run(keyOf(h.filename), h.title, h.year, h.maker); })();
    }
    const upd = db.prepare(`UPDATE roms SET title = ?, sort_title = ?, release_year = COALESCE(?, release_year),
      developer = COALESCE(developer, ?), updated_at = datetime('now') WHERE id = ?`);
    db.transaction(() => { for (const h of hits) upd.run(h.title, sortTitle(h.title), h.year, h.maker, h.id); })();
  }
  return { applied: apply, system_files: systemHits.length, hid: apply && hideSystem ? systemHits.length : 0, has_system_columns: iBios >= 0 || iDev >= 0, csv_rows: rows.length - 1, roms_on_platform: roms.length, matched: hits.length, unmatched, sample: hits.slice(0, 8).map(({ filename, from, title }) => ({ filename, from, title })) };
}
