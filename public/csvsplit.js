// Tools > Add My Games: one CSV can carry a "Library" column (Digital or Physical) that says which list each game goes in.
// splitByLibrary() reads the file, and gives back one CSV for each list (the Library column is taken out; every other column is kept as it is), ready to send to the two importers.

/** Minimal RFC-4180 CSV reader (quotes, doubled quotes, CRLF, BOM): the same reading the server does. */
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
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

const cell = (v) => (/[",\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const toCsv = (rows) => rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

/**
 * @param {string} text the CSV
 * @param {'digital'|'physical'} fallback where a game with no Library value goes (and where all of them go when there is no Library column)
 * @returns {{ hasColumn: boolean, digital: string|null, physical: string|null, counts: {digital:number, physical:number}, problems: {line:number, reason:string}[] }}
 */
export function splitByLibrary(text, fallback = 'digital') {
  const rows = parseCsv(text);
  const out = { hasColumn: false, digital: null, physical: null, counts: { digital: 0, physical: 0 }, problems: [] };
  if (!rows.length) return out;
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const li = head.indexOf('library');
  if (li < 0) return out;
  out.hasColumn = true;
  const keep = head.map((_, i) => i).filter((i) => i !== li);
  const parts = { digital: [keep.map((i) => rows[0][i])], physical: [keep.map((i) => rows[0][i])] };
  rows.slice(1).forEach((r, k) => {
    const v = String(r[li] ?? '').trim().toLowerCase();
    const to = v === '' ? fallback : /^(d|dig|digital)$/.test(v) ? 'digital' : /^(p|phys|physical)$/.test(v) ? 'physical' : null;
    if (!to) { out.problems.push({ line: k + 2, reason: `Library must be Digital or Physical (this says "${String(r[li]).trim().slice(0, 30)}")` }); return; }
    parts[to].push(keep.map((i) => r[i] ?? ''));
    out.counts[to]++;
  });
  for (const lib of ['digital', 'physical']) if (parts[lib].length > 1) out[lib] = toCsv(parts[lib]);
  return out;
}
