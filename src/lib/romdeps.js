// The files a MAME-family game needs besides its own zip.
//
// MAME (and the Naomi, Atomiswave and Model 2/3 sets) find a game by the name of its zip, but a game is often more than that file:
//   - a CHD disk image kept in a folder named like the zip (beachspi.zip needs beachspi/beachspi.chd),
//   - its parent set, when it is a clone (sf2ue needs sf2),
//   - a BIOS set (naomi.zip, neogeo.zip, pgm.zip),
//   - a device set (a controller or sound board that has ROMs of its own).
// A non-merged ROM set has all of these inside each game's zip, so there is nothing to add; a split or merged set keeps them apart, and
// they are sent when the library has them (a parent or BIOS the library lacks is reported, one that is not needed does no harm).
// "Play locally" downloads one file, so the launcher also needs to be told about these. This works out the list from the library
// (where the parent and BIOS zips are) and from the folder next to each zip (where its CHD folder is). It reads the disk only;
// nothing here changes anything.
import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';

/** Platforms whose games are MAME sets (a zip named for the set). */
export const SET_FAMILY = new Set(['arcade', 'mame', 'fba', 'neogeo', 'naomi', 'atomiswave', 'segamodel2', 'segamodel3', 'cps1', 'cps2', 'cps3', 'cave']);

/** True for a MAME-family platform: the built-in ones, and one the person made whose name says so ("seganaomi2"). */
export const isSetFamily = (slug) => SET_FAMILY.has(slug) || /naomi|atomiswave|model[23]|mame|arcade|neogeo|fba|cps[123]?|cave|hikaru|triforce|chihiro/.test(String(slug || ''));

const MAX_FILES = 40;      // extras the launcher is told about (they travel in one response header)
const MAX_DEPTH = 6;       // clone -> parent -> BIOS chains are short; this stops a loop in bad data

const setBase = (filename) => path.basename(String(filename || ''), path.extname(String(filename || ''))).toLowerCase();

/** The folders named like the set, beside its zip (any capitals: on a case-sensitive disk Beachspi and beachspi are two folders, and both count). */
function setFolders(zipPath, name) {
  const dir = path.dirname(zipPath);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && e.name.toLowerCase() === name.toLowerCase()).map((e) => path.join(dir, e.name));
}

/** Every file under a folder (not following links), as { rel, abs, size, mtime }, with rel starting at prefix. */
function listFolder(dir, prefix, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) listFolder(abs, `${prefix}/${e.name}`, out);
    else if (e.isFile() && !e.name.startsWith('._')) {
      try { const st = fs.statSync(abs); if (st.size > 0) out.push({ rel: `${prefix}/${e.name}`, abs, size: st.size, mtime: Math.round(st.mtimeMs) }); } catch { /* gone */ }
    }
  }
}

/**
 * @param {{ filename: string, storage_path: string, platform: string }} rom  the game being launched
 * @returns {{ files: {rel:string, abs:string, size:number, mtime:number}[], missing: string[] }}
 *   files: what to put beside the game's own zip (rel is the path under that folder, with "/");
 *   missing: parent or BIOS sets the library does not have.
 */
export function findCompanions(rom, { allowed = () => true } = {}) {
  const out = { files: [], missing: [] };
  if (!rom || !isSetFamily(rom.platform)) return out;
  if (!/\.(zip|7z)$/i.test(rom.filename || '')) return out;
  const have = new Set();
  const add = (f) => { if (!have.has(f.rel.toLowerCase()) && out.files.length < MAX_FILES) { have.add(f.rel.toLowerCase()); out.files.push(f); } };

  const own = setBase(rom.filename);
  have.add(String(rom.filename).toLowerCase());
  for (const ownDir of setFolders(rom.storage_path, own)) { const l = []; listFolder(ownDir, path.basename(ownDir), l); l.forEach(add); }

  const fromNames = db.prepare('SELECT cloneof, romof, devices, isdevice FROM mame_names WHERE name = ?');
  const fromDat = db.prepare('SELECT cloneof, romof FROM dat_sets WHERE set_name = ? AND (cloneof IS NOT NULL OR romof IS NOT NULL) ORDER BY id LIMIT 1');
  // What is known about a set: the MAME list or name CSV first, and a DAT (FinalBurn Neo, CPS) for whatever they do not say.
  const names = { get(name) {
    const a = fromNames.get(name), b = fromDat.get(name);
    if (!a && !b) return undefined;
    return { cloneof: a?.cloneof || b?.cloneof || null, romof: a?.romof || b?.romof || null, devices: a?.devices || null, isdevice: a?.isdevice || 0 };
  } };
  const findAll = db.prepare(`SELECT r.id, r.filename, r.storage_path, p.slug AS platform FROM roms r JOIN platforms p ON p.id = r.platform_id
    WHERE r.missing = 0 AND lower(r.filename) IN (@a, @b) ORDER BY r.id`);
  const findRom = { get: (q) => findAll.all(q).find((r) => isSetFamily(r.platform) && allowed(r.id)) };
  const seen = new Set([own]);
  const walk = (name, depth) => {
    const row = names.get(name);
    if (!row) return;
    // A device's ROMs are in the game's own zip in a non-merged set and in a zip of their own in a split or merged one: sent when the library has it, and not a problem when it does not.
    const devs = String(row.devices || '').split(',').filter(Boolean);
    for (const dep of [row.cloneof, row.romof, ...devs]) {
      const d = String(dep || '').toLowerCase();
      if (!d || seen.has(d) || depth >= MAX_DEPTH) continue;
      seen.add(d);
      const hit = findRom.get({ a: `${d}.zip`, b: `${d}.7z` });
      if (!hit) { if (!devs.includes(d) && !names.get(d)?.isdevice) out.missing.push(d); continue; }
      try { const st = fs.statSync(hit.storage_path); add({ rel: hit.filename, abs: hit.storage_path, size: st.size, mtime: Math.round(st.mtimeMs) }); } catch { out.missing.push(d); continue; }
      for (const dir of setFolders(hit.storage_path, d)) { const l = []; listFolder(dir, path.basename(dir), l); l.forEach(add); }
      walk(d, depth + 1);
    }
  };
  walk(own, 0);
  return out;
}

/** A short text that changes when any companion file changes (it joins the file's fingerprint for quick launch). */
export function companionFingerprint(files) {
  if (!files.length) return '';
  let h = 0;
  for (const f of files) for (const ch of `${f.rel}:${f.size}:${f.mtime}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `-x${files.length}${h.toString(36)}`;
}
