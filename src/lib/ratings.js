// ROM Library age ratings: where they are kept and how a game gets one. Nothing here restricts anybody.
//
// The record of a rating (game_ratings) is kept APART from the game: it is known by platform and file name, and by fingerprint once there is one,
// so a game that is removed and added again (or renamed after its fingerprint is known) gets its rating back. The age_* columns on roms are a copy
// made from those records, so lists and queries can use them:
//   age_level      the level (src/lib/ratingscale.js), NULL = unrated
//   age_board      the board that said it; when it is not the board of the setting, the rating shown is a converted one
//   age_source     'admin', 'igdb', 'launchbox' or 'thegamesdb'
//   age_inherited  1 when the game has no rating of its own and shows the strictest one of the other versions (same title) on the SAME platform
//
// An admin's rating always wins and no lookup touches it. A fetched rating may get stricter with a later lookup and is never lowered or removed.
//
// The copy is brought up to date by flushRatings(). Database triggers (src/migrations.js) note every game that is added, removed, retitled, moved
// to another platform or given a fingerprint, so no code that writes games has to remember this.
import path from 'node:path';
import db from '../db.js';
import { SYSTEMS, DEFAULT_SYSTEM, RC_LEVEL, addEvidence, pickRating, keepStrictest, labelOf, withBoard } from './ratingscale.js';

const SETTING = 'rating_system';
export function ratingSystem() {
  const v = db.prepare('SELECT value FROM meta WHERE key = ?').get(SETTING)?.value;
  return SYSTEMS[v] ? v : DEFAULT_SYSTEM;
}

/* ───────── the record ───────── */

// File names that thousands of unrelated games share (one per folder in disc and console layouts): these are known by their folder as well,
// so a rating can never pass from one game to another that merely has a "disc.gdi" too.
const SHARED_NAME = /^(disc|disk|dvd|cd|game|boot|default|eboot|main|rom|image|track|play|start|launch)[ _-]?\d{0,3}(\.[a-z0-9]{1,8})?$/;

/** The name a game's rating is remembered under: its file name in lower case, with the folder in front for a name that says nothing. */
export function fileKey(rom) {
  const name = String(rom.filename || '').toLowerCase();
  if (!SHARED_NAME.test(name)) return name;
  const folder = path.basename(path.dirname(String(rom.source_path || rom.storage_path || ''))).toLowerCase();
  return `${folder}/${name}`;
}

const ROM_FIELDS = 'r.id, r.filename, r.source_path, r.storage_path, r.sha1, r.platform_id, r.sort_title, r.age_level, r.age_board, r.age_source, r.age_inherited, p.slug AS slug';
const romRow = (id) => db.prepare(`SELECT ${ROM_FIELDS} FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?`).get(id);

const recordByName = (slug, key) => db.prepare('SELECT * FROM game_ratings WHERE platform = ? AND file_key = ?').get(slug, key);
/** Every record that speaks for this game: the one under its name, and any with the same fingerprint. */
function recordsFor(rom) {
  const named = recordByName(rom.slug, fileKey(rom));
  const printed = rom.sha1 ? db.prepare('SELECT * FROM game_ratings WHERE sha1 = ?').all(rom.sha1) : [];
  return [...(named ? [named] : []), ...printed.filter((x) => x.id !== named?.id)];
}

const heldOf = (rec) => (rec.level ? { level: rec.level, board: rec.board, source: rec.source } : null);
const evidenceOf = (rec) => { try { return JSON.parse(rec.evidence || '{}'); } catch { return {}; } };

/** The records' answer: the latest admin rating when there is one, else the strictest fetched one. { level, board, source } or null. */
function resolve(records) {
  const admin = records.filter((x) => x.admin_level).sort((a, b) => String(b.admin_at).localeCompare(String(a.admin_at)) || b.id - a.id)[0];
  if (admin) return { level: admin.admin_level, board: admin.admin_board, source: 'admin' };
  let best = null;
  for (const rec of records) { const h = heldOf(rec); if (h && (!best || h.level > best.level)) best = h; }
  return best;
}

/** The record under this game's own name, made (as a copy of what already speaks for the game) when there is none yet. */
function ownRecord(rom, records = recordsFor(rom)) {
  const key = fileKey(rom);
  let own = recordByName(rom.slug, key);
  if (own) {
    if (rom.sha1 && !own.sha1) { db.prepare('UPDATE game_ratings SET sha1 = ? WHERE id = ?').run(rom.sha1, own.id); own.sha1 = rom.sha1; }
    return own;
  }
  const from = records.find((x) => x.admin_level) || records.find((x) => x.level) || {};
  db.prepare(`INSERT INTO game_ratings (platform, file_key, sha1, admin_level, admin_board, admin_at, evidence, level, board, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(rom.slug, key, rom.sha1 || null, from.admin_level ?? null, from.admin_board ?? null, from.admin_at ?? null,
    from.evidence ?? null, from.level ?? null, from.board ?? null, from.source ?? null);
  return recordByName(rom.slug, key);
}

/* ───────── the copy on the games ───────── */

const markDirtyStmt = () => db.prepare('INSERT INTO rating_dirty (rom_id, platform_id, sort_title) VALUES (?, ?, ?)');
/** Note every game that this one's records may speak for: itself, those with its file name on its platform, and those with its fingerprint. */
function markRelated(rom) {
  // (three lookups joined, so that each uses its own index: rating thousands of games at once stays quick)
  const ids = db.prepare(`SELECT id, platform_id, sort_title FROM roms WHERE id = ?
    UNION SELECT id, platform_id, sort_title FROM roms WHERE platform_id = ? AND lower(filename) = lower(?)
    UNION SELECT id, platform_id, sort_title FROM roms WHERE sha1 = ?`)
    .all(rom.id, rom.platform_id, rom.filename, rom.sha1);
  const ins = markDirtyStmt();
  for (const r of ids) ins.run(r.id, r.platform_id, r.sort_title);
}

/** Work out the age_* columns for one set of versions: the games of one title on one platform. A title with no letters or digits groups nothing. */
function recomputeGroup(rows) {
  const own = rows.map((r) => resolve(recordsFor(r)));
  let strictest = null;
  for (const o of own) if (o && (!strictest || o.level > strictest.level)) strictest = o;
  const write = db.prepare('UPDATE roms SET age_level = ?, age_board = ?, age_source = ?, age_inherited = ? WHERE id = ?');
  rows.forEach((r, i) => {
    const grouped = Boolean(r.sort_title);
    const value = own[i] || (grouped ? strictest : null);
    const inherited = !own[i] && value ? 1 : 0;
    const next = [value?.level ?? null, value?.board ?? null, value?.source ?? null, inherited];
    if (next[0] !== r.age_level || next[1] !== r.age_board || next[2] !== r.age_source || next[3] !== r.age_inherited) write.run(...next, r.id);
  });
}

/** Bring the games up to date with the rating records. Cheap when nothing has changed. */
export function flushRatings() {
  if (!db.prepare('SELECT 1 FROM rating_dirty LIMIT 1').get()) return;
  db.transaction(() => {
    const notes = db.prepare('SELECT * FROM rating_dirty ORDER BY seq').all();
    const anyRecords = Boolean(db.prepare('SELECT 1 FROM game_ratings LIMIT 1').get());
    const rated = Boolean(db.prepare('SELECT 1 FROM roms WHERE age_level IS NOT NULL LIMIT 1').get());
    if (anyRecords || rated) {   // with no ratings anywhere there is nothing to copy (every scan of a new library comes through here)
      const groups = new Map();
      const addGroup = (platformId, title, romId) => {
        const key = title ? `${platformId}|${title}` : `id|${romId}`;
        if (!groups.has(key)) groups.set(key, { platformId, title, romId });
      };
      for (const n of notes) {
        const rom = n.rom_id ? romRow(n.rom_id) : null;
        if (rom) {
          // A game moved to another platform takes its rating with it.
          if (n.from_platform_id && n.from_platform_id !== rom.platform_id) {
            const from = db.prepare('SELECT slug FROM platforms WHERE id = ?').get(n.from_platform_id)?.slug;
            const old = from ? recordByName(from, fileKey(rom)) : null;
            if (old) ownRecord(rom, [old, ...recordsFor(rom)]);
          }
          const records = recordsFor(rom);
          if (records.length) ownRecord(rom, records);   // a fingerprint is added to the record, and a game found by fingerprint is remembered by its new name too
          addGroup(rom.platform_id, rom.sort_title, rom.id);
        }
        if (n.platform_id) addGroup(n.platform_id, n.sort_title, n.rom_id);   // where it was before
      }
      const members = db.prepare(`SELECT ${ROM_FIELDS} FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.platform_id = ? AND r.sort_title = ?`);
      for (const g of groups.values()) {
        const rows = g.title ? members.all(g.platformId, g.title) : [romRow(g.romId)].filter(Boolean);
        recomputeGroup(rows);
      }
    }
    db.prepare('DELETE FROM rating_dirty WHERE seq <= ?').run(notes.at(-1).seq);
  })();
}

/* ───────── changing a rating ───────── */

/** Does an admin's rating speak for this game? Then no lookup changes anything. */
export function hasAdminRating(romId) {
  const rom = romRow(romId);
  return Boolean(rom && recordsFor(rom).some((x) => x.admin_level));
}

/**
 * Take in what providers said about one game: [{ board, level, source }]. Returns true when the game's own fetched rating changed.
 * An admin's rating is left alone, and a fetched rating is only ever made stricter.
 */
export function addFetched(romId, items) {
  const rom = romRow(romId);
  if (!rom || !items?.length) return false;
  let changed = false;
  db.transaction(() => {
    const records = recordsFor(rom);
    if (records.some((x) => x.admin_level)) return;
    const system = ratingSystem();
    const before = resolve(records);
    const own = ownRecord(rom, records);
    const evidence = addEvidence(evidenceOf(own), items);
    const held = keepStrictest(keepStrictest(heldOf(own), before, system), pickRating(evidence, system), system);
    if (!held) return;
    db.prepare("UPDATE game_ratings SET evidence = ?, level = ?, board = ?, source = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(evidence), held.level, held.board, held.source, own.id);
    changed = !before || before.level !== held.level || before.board !== held.board;
    markRelated(rom);
  })();
  flushRatings();
  return changed;
}

/**
 * An admin rates games: level 1 to 6 on the board given (the setting's own when none is), or null to take the rating away, fetched ones too
 * (a later lookup may then fill it in again). Returns how many of the ids named a game.
 */
export function setAdminRating(romIds, level, board = ratingSystem()) {
  if (level !== null && !(Number.isInteger(level) && level >= 1 && level <= RC_LEVEL)) throw Object.assign(new Error('Choose a rating from the list.'), { status: 400 });
  let done = 0;
  const at = new Date().toISOString();
  db.transaction(() => {
    for (const id of romIds) {
      const rom = romRow(id);
      if (!rom) continue;
      done++;
      const records = recordsFor(rom);
      markRelated(rom);
      if (level === null) {
        const del = db.prepare('DELETE FROM game_ratings WHERE id = ?');
        for (const rec of records) del.run(rec.id);
        continue;
      }
      const own = ownRecord(rom, records);
      const write = db.prepare("UPDATE game_ratings SET admin_level = ?, admin_board = ?, admin_at = ?, updated_at = datetime('now') WHERE id = ?");
      for (const rec of new Set([own.id, ...records.map((x) => x.id)])) write.run(level, board, at, rec);
    }
  })();
  flushRatings();
  return done;
}

/** Change which board's labels the app shows. Fetched ratings are chosen again from what the providers said, so the new board's own come first. */
export function setRatingSystem(system) {
  if (!SYSTEMS[system]) throw Object.assign(new Error('Choose a classification from the list.'), { status: 400 });
  if (system === ratingSystem()) return;
  flushRatings();
  db.transaction(() => {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SETTING, system);
    const write = db.prepare("UPDATE game_ratings SET level = ?, board = ?, source = ?, updated_at = datetime('now') WHERE id = ?");
    for (const rec of db.prepare('SELECT * FROM game_ratings WHERE evidence IS NOT NULL').all()) {
      const pick = pickRating(evidenceOf(rec), system);
      if (pick) write.run(pick.level, pick.board, pick.source, rec.id);
    }
    db.prepare('INSERT INTO rating_dirty (rom_id, platform_id, sort_title) SELECT id, platform_id, sort_title FROM roms WHERE age_level IS NOT NULL').run();
  })();
  flushRatings();
}

/* ───────── showing ratings ───────── */

/** What the app shows for a games row's age_* columns: null when unrated. */
export function ageOf(row, system = ratingSystem()) {
  if (!row?.age_level) return null;
  const converted = row.age_board !== system && row.age_level !== RC_LEVEL;
  return {
    level: row.age_level,
    label: labelOf(system, row.age_level),
    converted,
    from: converted ? withBoard(row.age_board, row.age_level) : null,   // what the board that rated it calls it
    source: row.age_source,
    inherited: Boolean(row.age_inherited)
  };
}

/** SQL for a roms row named `alias`: its rating came from another board than the one shown (RC means the same everywhere). */
export const convertedSql = (alias = 'r') => `(${alias}.age_level IS NOT NULL AND ${alias}.age_level <> ${RC_LEVEL} AND ${alias}.age_board <> '${ratingSystem()}')`;

/** The admin's totals. System entries (BIOS and the like) are not counted. */
export function ratingCounts() {
  flushRatings();
  return db.prepare(`SELECT COUNT(*) AS games, COUNT(age_level) AS rated, COUNT(*) - COUNT(age_level) AS unrated,
      COALESCE(SUM(${convertedSql('r')}), 0) AS converted, COALESCE(SUM(r.age_inherited), 0) AS inherited,
      COALESCE(SUM(r.age_source = 'admin' AND r.age_inherited = 0), 0) AS by_admin
    FROM roms r WHERE r.is_system = 0`).get();
}
