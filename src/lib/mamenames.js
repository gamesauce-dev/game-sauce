// MAME short-name list (mame -listxml): maps zip names like "sf2" to real titles.
// Streams the XML (the file is hundreds of MB, and MAME writes it as UTF-16 on
// Windows) and keeps only name/title/year/manufacturer/cloneof — a few tens of
// thousands of rows. Titles then drive correct display and title-based lookups.
import fs from 'node:fs';
import db from '../db.js';
import { sortTitle } from './metadata.js';

const unesc = (s) => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const attr = (head, name) => unesc((head.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1] || '') || null;
const tag = (body, name) => unesc((body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1] || '') || null;

function parseBlock(block) {
  // block = text after "<machine " up to the next machine; only the head matters.
  const headEnd = block.indexOf('>');
  if (headEnd < 0) return null;
  const head = block.slice(0, headEnd);
  const name = attr(head, 'name');
  if (!name) return null;
  const body = block.slice(headEnd, headEnd + 3000); // description/year/manufacturer come first
  return {
    name: name.toLowerCase(),
    title: tag(body, 'description'),
    year: /^\d{4}/.test(tag(body, 'year') || '') ? Number(tag(body, 'year').slice(0, 4)) : null,
    manufacturer: tag(body, 'manufacturer'),
    cloneof: attr(head, 'cloneof'),
    isbios: attr(head, 'isbios') === 'yes' ? 1 : 0,
    isdevice: attr(head, 'isdevice') === 'yes' ? 1 : 0
  };
}

export async function importMameNames(filePath) {
  if (!fs.existsSync(filePath)) throw Object.assign(new Error(`File not found: ${filePath}`), { status: 400 });
  const fd = fs.openSync(filePath, 'r');
  const bom = Buffer.alloc(2); fs.readSync(fd, bom, 0, 2, 0); fs.closeSync(fd);
  const enc = bom[0] === 0xff && bom[1] === 0xfe ? 'utf-16le' : 'utf-8';

  const ins = db.prepare(`INSERT INTO mame_names (name, title, year, manufacturer, cloneof, isbios, isdevice)
    VALUES (@name, @title, @year, @manufacturer, @cloneof, @isbios, @isdevice)
    ON CONFLICT(name) DO UPDATE SET title = excluded.title, year = excluded.year, manufacturer = excluded.manufacturer,
      cloneof = excluded.cloneof, isbios = excluded.isbios, isdevice = excluded.isdevice`);
  const write = db.transaction((rows) => { for (const r of rows) ins.run(r); });

  const decoder = new TextDecoder(enc);
  let buf = '', count = 0, sawMachine = false, batch = [];
  const flush = () => { if (batch.length) { write(batch); count += batch.length; batch = []; } };
  const consume = (final) => {
    // The mame DTD header also contains "<machine " mentions only inside <!ELEMENT…>,
    // which never match '<machine name='.
    let i;
    while ((i = buf.indexOf('<machine name=')) >= 0) {
      const next = buf.indexOf('<machine name=', i + 14);
      if (next < 0 && !final) { buf = buf.slice(i); return; }
      const row = parseBlock(buf.slice(i + 9, next < 0 ? undefined : next));
      sawMachine = true;
      if (row && row.title) batch.push(row);
      buf = next < 0 ? '' : buf.slice(next);
      if (batch.length >= 2000) flush();
      if (next < 0) break;
    }
    if (!sawMachine && buf.length > 2_000_000) buf = buf.slice(-1000); // DTD preamble
  };

  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })) {
    buf += decoder.decode(chunk, { stream: true });
    consume(false);
  }
  buf += decoder.decode();
  consume(true);
  flush();
  if (!sawMachine) throw Object.assign(new Error('That does not look like a MAME -listxml file (no <machine> entries)'), { status: 400 });

  const applied = applyMameNames();
  return { names: db.prepare('SELECT COUNT(*) n FROM mame_names').get().n, imported: count, ...applied };
}

/** True when this MAME zip has a real title from the name list, so title-based
 *  providers can be trusted. Based on the list itself (not meta_source), because
 *  a provider hit later rewrites meta_source. */
export function mameTitleTrusted(platformSlug, filename) {
  if (platformSlug !== 'mame') return false;
  const key = String(filename || '').replace(/\.(zip|7z)$/i, '').toLowerCase();
  return !!db.prepare('SELECT 1 FROM mame_names WHERE name = ?').get(key);
}

/** Title/year/developer from the list for MAME ROMs (all of them, or one id).
 *  Authoritative: a zip name IS the identifier, so this replaces filename-derived
 *  and (mis)matched provider titles. */
export function applyMameNames(romId = null) {
  const rows = db.prepare(`
    SELECT r.id, r.filename FROM roms r JOIN platforms p ON p.id = r.platform_id
    WHERE p.slug = 'mame' ${romId ? 'AND r.id = ?' : ''}
  `).all(...(romId ? [romId] : []));
  const find = db.prepare('SELECT * FROM mame_names WHERE name = ?');
  const upd = db.prepare(`UPDATE roms SET title = ?, sort_title = ?, release_year = COALESCE(?, release_year),
    developer = COALESCE(developer, ?), meta_source = 'mame-list', updated_at = datetime('now') WHERE id = ?`);
  let matched = 0;
  db.transaction(() => {
    for (const r of rows) {
      const key = String(r.filename).replace(/\.(zip|7z)$/i, '').toLowerCase();
      const n = find.get(key);
      if (!n) continue;
      upd.run(n.title, sortTitle(n.title), n.year, n.manufacturer, r.id);
      matched++;
    }
  })();
  return { mame_roms: rows.length, matched };
}
