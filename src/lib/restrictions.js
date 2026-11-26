// Groups, age limits, per-game blocks, and what is remembered about a ROM Library game apart from its entry. This file keeps the records; the rule
// that uses them is in src/lib/visibility.js. All of it is about the ROM Library only, and admins are never limited.
//
// Limits: a group may have an age limit, and so may one person. Of all that apply to somebody the strictest wins. A game with no age rating is not
// held back by a limit. Blocks: one game can be blocked for a group or for a person, and a block covers every version of it (the same title) on
// the SAME platform. There are no exceptions that allow a game back.
//
// Blocks and "hidden from everyone" are recorded by platform and file name, and by fingerprint once there is one, so a game that is removed and
// added again keeps them. Database triggers (src/migrations.js) note each change to a game, and flushRecords() acts on the notes:
//   rom_blocks      a copy of the blocks by game number, for queries to use
//   game_hides      the games an admin hid from everyone: when such a game is added again (or recognised by its fingerprint) it is hidden again
import db from '../db.js';
import { fileKey, flushRatings } from './ratings.js';
import { RC_LEVEL } from './ratingscale.js';

export const MAX_LIMIT = RC_LEVEL - 1;   // the highest limit there is: everything but Refused Classification
const MAX_GROUP_NAME = 40;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/* ───────── records about games ───────── */

const FIELDS = 'r.id, r.filename, r.source_path, r.storage_path, r.sha1, r.platform_id, r.sort_title, r.hidden_all, p.slug AS slug';
const FROM = `SELECT ${FIELDS} FROM roms r JOIN platforms p ON p.id = r.platform_id`;
const romRow = (id) => db.prepare(`${FROM} WHERE r.id = ?`).get(id);
/** The games of one title on one platform. A title with no letters or digits groups nothing. */
const versionsOf = (rom) => (rom.sort_title ? db.prepare(`${FROM} WHERE r.platform_id = ? AND r.sort_title = ?`).all(rom.platform_id, rom.sort_title) : [rom]);
const slugOf = (platformId) => db.prepare('SELECT slug FROM platforms WHERE id = ?').get(platformId)?.slug;

/* hidden from everyone */

function rememberHidden(rom) {
  db.prepare(`INSERT INTO game_hides (platform, file_key, sha1) VALUES (?, ?, ?)
    ON CONFLICT(platform, file_key) DO UPDATE SET sha1 = COALESCE(excluded.sha1, game_hides.sha1)`).run(rom.slug, fileKey(rom), rom.sha1 || null);
}

function forgetHidden(rom) {
  db.prepare('DELETE FROM game_hides WHERE platform = ? AND file_key = ?').run(rom.slug, fileKey(rom));
  if (rom.sha1) db.prepare('DELETE FROM game_hides WHERE sha1 = ? AND platform = ?').run(rom.sha1, rom.slug);
  // another file of the same name (in another folder) may still be hidden: the record under that name stays
  const others = db.prepare(`${FROM} WHERE r.hidden_all = 1 AND r.id <> ? AND r.platform_id = ? AND lower(r.filename) = lower(?)`).all(rom.id, rom.platform_id, rom.filename);
  for (const t of others) rememberHidden(t);
}

/** A game was just added, or has just been fingerprinted: hide it again if it is one that was hidden. */
function hideAgain(rom) {
  if (rom.hidden_all) return;
  if (!db.prepare('SELECT 1 FROM game_hides WHERE platform = ? AND file_key = ? UNION ALL SELECT 1 FROM game_hides WHERE sha1 = ? AND platform = ?').get(rom.slug, fileKey(rom), rom.sha1 || null, rom.slug)) return;
  db.prepare("UPDATE roms SET hidden_all = 1, updated_at = datetime('now') WHERE id = ?").run(rom.id);
  rom.hidden_all = 1;
  rememberHidden(rom);
}

/* blocks */

const anyBlocks = () => Boolean(db.prepare('SELECT 1 FROM game_blocks LIMIT 1').get());
/** The block records that speak for this one file: under its name, or with its fingerprint on the same platform. */
// (two lookups joined, here and below, so that each uses its own index: one "A or B" would read every record of the platform)
const blockRecords = (rom) => db.prepare(`SELECT * FROM game_blocks WHERE platform = ? AND file_key = ?
  UNION SELECT * FROM game_blocks WHERE sha1 = ? AND platform = ?`).all(rom.slug, fileKey(rom), rom.sha1 || null, rom.slug);
const subject = (b) => `${b.kind}:${b.subject_id}`;

function writeBlock(rom, kind, subjectId) {
  db.prepare(`INSERT INTO game_blocks (kind, subject_id, platform, file_key, sha1, sort_title) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, subject_id, platform, file_key) DO UPDATE SET sha1 = COALESCE(excluded.sha1, game_blocks.sha1), sort_title = excluded.sort_title`)
    .run(kind, subjectId, rom.slug, fileKey(rom), rom.sha1 || null, rom.sort_title || null);
}

/** Bring one set of versions up to date: a block on any of them is on all of them, and is then recorded under each one's own name, so that it
 *  stays with that file whatever is renamed or removed later. */
function applyBlocks(rows) {
  const union = new Set();
  for (const r of rows) for (const b of blockRecords(r)) union.add(subject(b));
  const clear = db.prepare('DELETE FROM rom_blocks WHERE rom_id = ?');
  const add = db.prepare('INSERT OR IGNORE INTO rom_blocks (rom_id, kind, subject_id) VALUES (?, ?, ?)');
  for (const r of rows) {
    clear.run(r.id);
    for (const s of union) {
      const [kind, id] = s.split(':');
      writeBlock(r, kind, Number(id));
      add.run(r.id, kind, Number(id));
    }
  }
}

/** A game moved to another platform takes its records with it. */
function carryRecords(rom, fromPlatformId) {
  const from = slugOf(fromPlatformId);
  if (!from) return;
  const key = fileKey(rom);
  for (const b of db.prepare('SELECT * FROM game_blocks WHERE platform = ? AND file_key = ?').all(from, key)) writeBlock(rom, b.kind, b.subject_id);
}

/* the notes */

export function flushMemory() {
  if (!db.prepare('SELECT 1 FROM memory_dirty LIMIT 1').get()) return;
  db.transaction(() => {
    // hiding a game again writes a note of its own, which the next round reads
    for (let round = 0; round < 3; round++) {
      const notes = db.prepare('SELECT * FROM memory_dirty ORDER BY seq').all();
      if (!notes.length) break;
      const blocking = anyBlocks();
      const done = new Set();
      for (const n of notes) {
        const rom = romRow(n.rom_id);
        if (!rom) continue;
        if (n.event === 'added' || n.event === 'printed') hideAgain(rom);
        if (n.event === 'shown') { if (!rom.hidden_all) forgetHidden(rom); }
        else if (rom.hidden_all) rememberHidden(rom);
        if (blocking && n.event !== 'hidden' && n.event !== 'shown') {
          if (n.from_platform_id && n.from_platform_id !== rom.platform_id) carryRecords(rom, n.from_platform_id);
          const group = rom.sort_title ? `${rom.platform_id}|${rom.sort_title}` : `id|${rom.id}`;
          if (!done.has(group)) { done.add(group); applyBlocks(versionsOf(rom)); }
        }
      }
      db.prepare('DELETE FROM memory_dirty WHERE seq <= ?').run(notes.at(-1).seq);
    }
  })();
}

/** Bring everything copied onto the games up to date: age ratings, blocks and hidden games. Cheap when nothing has changed. */
export function flushRecords() {
  flushRatings();
  flushMemory();
}

/** Who this game is blocked for: { users: [ids], groups: [ids] }. */
export function blocksOf(romId) {
  flushRecords();
  const rows = db.prepare('SELECT kind, subject_id FROM rom_blocks WHERE rom_id = ? ORDER BY subject_id').all(romId);
  return { users: rows.filter((r) => r.kind === 'user').map((r) => r.subject_id), groups: rows.filter((r) => r.kind === 'group').map((r) => r.subject_id) };
}

const idList = (list) => [...new Set((Array.isArray(list) ? list : []).map(Number))];

/** Set who a game (with its other versions) is blocked for. The lists given replace what was there. Returns null when there is no such game. */
export function setBlocks(romId, { users = [], groups = [] } = {}) {
  flushRecords();
  const rom = romRow(romId);
  if (!rom) return null;
  const userIds = idList(users), groupIds = idList(groups);
  for (const id of userIds) {
    const u = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
    if (!u) throw fail('No such person.');
    if (u.role === 'admin') throw fail('Admins are never limited, so a game cannot be blocked for one.');
  }
  for (const id of groupIds) if (!db.prepare('SELECT 1 FROM account_groups WHERE id = ?').get(id)) throw fail('No such group.');
  const wanted = new Set([...userIds.map((id) => `user:${id}`), ...groupIds.map((id) => `group:${id}`)]);
  db.transaction(() => {
    const rows = versionsOf(rom);
    const held = new Set();
    for (const r of rows) for (const b of blockRecords(r)) held.add(subject(b));
    const drop = db.prepare('DELETE FROM game_blocks WHERE kind = ? AND subject_id = ? AND platform = ? AND (file_key = ? OR sha1 = ? OR sort_title = ?)');
    // an admin's own block list is what the game shows: someone not on it comes off every version, and off versions that have since been removed
    for (const s of held) {
      if (wanted.has(s)) continue;
      const [kind, id] = s.split(':');
      for (const r of rows) drop.run(kind, Number(id), r.slug, fileKey(r), r.sha1 || null, r.sort_title || null);
    }
    for (const s of wanted) {
      const [kind, id] = s.split(':');
      writeBlock(rom, kind, Number(id));
    }
    applyBlocks(rows);
  })();
  return blocksOf(romId);
}

/* ───────── groups and limits ───────── */

/** The strictest age limit on this person, from their own account and their groups: a level, or null for none. */
export function ageLimitOf(userId) {
  return db.prepare(`SELECT MIN(age_limit) AS n FROM (
      SELECT age_limit FROM users WHERE id = @id
      UNION ALL SELECT g.age_limit FROM account_group_members m JOIN account_groups g ON g.id = m.group_id WHERE m.user_id = @id)`).get({ id: userId })?.n ?? null;
}

export function hasBlocks(userId) {
  return Boolean(db.prepare(`SELECT 1 FROM game_blocks WHERE (kind = 'user' AND subject_id = @id)
    OR (kind = 'group' AND subject_id IN (SELECT group_id FROM account_group_members WHERE user_id = @id)) LIMIT 1`).get({ id: userId }));
}

/** May this person edit a ROM Library game's details (text, match and cover)? Admins may. Anyone else needs to be in at least one group, with
 *  every group of theirs allowing it. A play-only account never may. */
export function mayEditGames(user) {
  if (user?.role === 'admin') return true;
  const account = db.prepare('SELECT play_only FROM users WHERE id = ?').get(Number(user?.id));
  if (!account || account.play_only) return false;
  const groups = db.prepare('SELECT g.can_edit FROM account_group_members m JOIN account_groups g ON g.id = m.group_id WHERE m.user_id = ?').all(Number(user.id));
  return groups.length > 0 && groups.every((g) => g.can_edit);
}

export function listGroups() {
  const members = db.prepare('SELECT m.group_id, u.id, u.username FROM account_group_members m JOIN users u ON u.id = m.user_id ORDER BY u.username').all();
  const blocked = new Map(db.prepare("SELECT subject_id AS id, COUNT(*) AS n FROM rom_blocks WHERE kind = 'group' GROUP BY subject_id").all().map((r) => [r.id, r.n]));
  return db.prepare('SELECT id, name, age_limit, can_edit FROM account_groups ORDER BY name COLLATE NOCASE').all().map((g) => ({
    id: g.id, name: g.name, age_limit: g.age_limit, can_edit: Boolean(g.can_edit),
    members: members.filter((m) => m.group_id === g.id).map(({ id, username }) => ({ id, username })),
    blocked_games: blocked.get(g.id) || 0
  }));
}

/** An age limit as it arrives: null (or nothing chosen) for none, else a level from 1 to MAX_LIMIT. Anything else is refused. */
export function limitValue(v) {
  if (v === null || v === '') return null;
  if (!(Number.isInteger(v) && v >= 1 && v <= MAX_LIMIT)) throw fail('Choose an age limit from the list.');
  return v;
}

function groupName(name, exceptId = 0) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean || clean.length > MAX_GROUP_NAME) throw fail(`Give the group a name of up to ${MAX_GROUP_NAME} characters.`);
  if (db.prepare('SELECT 1 FROM account_groups WHERE name = ? AND id <> ?').get(clean, exceptId)) throw fail('There is already a group with that name.', 409);
  return clean;
}

const yesNo = (v) => { if (typeof v !== 'boolean') throw fail('can_edit must be true or false'); return v ? 1 : 0; };

export function createGroup({ name, age_limit = null, can_edit = false } = {}) {
  const info = db.prepare('INSERT INTO account_groups (name, age_limit, can_edit) VALUES (?, ?, ?)').run(groupName(name), limitValue(age_limit), yesNo(can_edit));
  return listGroups().find((g) => g.id === Number(info.lastInsertRowid));
}

export function updateGroup(id, body = {}) {
  const group = db.prepare('SELECT * FROM account_groups WHERE id = ?').get(id);
  if (!group) throw fail('No such group.', 404);
  const name = body.name === undefined ? group.name : groupName(body.name, group.id);
  const limit = body.age_limit === undefined ? group.age_limit : limitValue(body.age_limit);
  const edit = body.can_edit === undefined ? group.can_edit : yesNo(body.can_edit);
  db.prepare('UPDATE account_groups SET name = ?, age_limit = ?, can_edit = ? WHERE id = ?').run(name, limit, edit, group.id);
  return listGroups().find((g) => g.id === group.id);
}

/** Deleting a group takes its limit and its blocks away from its members. */
export function deleteGroup(id) {
  const group = db.prepare('SELECT id, name FROM account_groups WHERE id = ?').get(id);
  if (!group) throw fail('No such group.', 404);
  flushRecords();
  db.transaction(() => {
    forgetSubject('group', group.id);
    db.prepare('DELETE FROM account_group_members WHERE group_id = ?').run(group.id);
    db.prepare('DELETE FROM account_groups WHERE id = ?').run(group.id);
  })();
  return group;
}

/** Take away every block on a person or group that is going. (Their numbers can be given out again.) */
export function forgetSubject(kind, id) {
  db.prepare('DELETE FROM game_blocks WHERE kind = ? AND subject_id = ?').run(kind, id);
  db.prepare('DELETE FROM rom_blocks WHERE kind = ? AND subject_id = ?').run(kind, id);
}

/** Check a list of group numbers, each naming a group. */
export function groupIds(list) {
  if (!Array.isArray(list)) throw fail('groups must be a list');
  const ids = idList(list);
  for (const id of ids) if (!db.prepare('SELECT 1 FROM account_groups WHERE id = ?').get(id)) throw fail('No such group.');
  return ids;
}

export function setUserGroups(userId, ids) {
  db.transaction(() => {
    db.prepare('DELETE FROM account_group_members WHERE user_id = ?').run(userId);
    for (const id of ids) db.prepare('INSERT INTO account_group_members (user_id, group_id) VALUES (?, ?)').run(userId, id);
  })();
}
