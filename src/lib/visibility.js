// Who may see which ROM Library game. ONE place for the rule, so a new route cannot invent its own.
//
// The rule has two parts:
//   1. Hidden from everyone: an admin hid the game (hidden_all) or its source hides its games (source_hidden). A member does not see such a game;
//      an admin does. A few lists leave these games out for the admin too, and have their own helper below.
//   2. Limits on a person: a game a limit rules out must not reach them by ANY way, including the few places where a game hidden from everyone
//      still shows (a count of their own things, a message, a video found by title). The limits are age limits and blocks, on a person or on
//      their groups (src/lib/restrictions.js keeps the records; the rule itself is restrictionSql below). Every helper here applies them.
//      Admins are never limited.
// A person's own Hide (hidden_roms) is a viewing preference, not access control, and is not part of this rule.
//
// Every query that decides which games somebody gets uses one of these helpers. tests/visibility-guard.test.js fails when one writes the
// condition itself, and tests/visibility-rule.test.js puts a limit on a game and looks for it on every route.
import db from '../db.js';
import { titleKey } from './titlekey.js';
import { ageLimitOf, hasBlocks, flushRecords } from './restrictions.js';

const isAdmin = (user) => user?.role === 'admin';

/* ───────── limits ───────── */

/** The age limit and blocks on this person. A game with no age rating is not held back by an age limit. */
function restrictionSql(user, alias) {
  const id = Number(user?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  flushRecords();   // a game just added or changed has its rating and blocks before this person's question about it is answered
  const parts = [];
  const limit = ageLimitOf(id);
  if (limit !== null) parts.push(`(${alias}.age_level IS NULL OR ${alias}.age_level <= ${Number(limit)})`);
  if (hasBlocks(id)) {
    parts.push(`NOT EXISTS (SELECT 1 FROM rom_blocks blk WHERE blk.rom_id = ${alias}.id AND ((blk.kind = 'user' AND blk.subject_id = ${id})
      OR (blk.kind = 'group' AND blk.subject_id IN (SELECT group_id FROM account_group_members WHERE user_id = ${id}))))`);
  }
  return parts.length ? parts.join(' AND ') : null;
}

const LIMITS = [restrictionSql];

/**
 * Add another limit (the tests use this): rule(user, alias) returns an SQL condition, for a roms row named `alias`, that holds for the games this person is still allowed,
 * or nothing when the rule does not touch them. A rule can only take games away. The condition goes into larger queries, so it carries its own
 * values (no ? or @ parameters; numbers through Number()) and names the roms columns through `alias`. A condition that comes out as NULL counts
 * as not allowed. `user` has at least { id, role }: look anything else up by id. Returns a function that takes the rule out again.
 */
export function addLimit(rule) {
  LIMITS.push(rule);
  return () => { const i = LIMITS.indexOf(rule); if (i >= 0) LIMITS.splice(i, 1); };
}

/** The limits alone, as an SQL condition for a roms row named `alias`. '1 = 1' when nothing limits this person. */
export function withinLimitsSql(user, alias = 'r') {
  if (isAdmin(user)) return '1 = 1';
  const parts = LIMITS.map((rule) => rule(user, alias)).filter(Boolean).map((sql) => `COALESCE((${sql}), 0)`);
  return parts.length ? parts.join(' AND ') : '1 = 1';
}

/* ───────── conditions for queries ───────── */

/** An SQL condition (for a roms row named `alias`) that holds for the games this user may see. */
export const visibleSql = (user, alias = 'r') => (isAdmin(user) ? '1 = 1' : `${notHiddenSql(alias)} AND ${withinLimitsSql(user, alias)}`);

/** For the lists that leave a hidden source's games out for the admin too (platform and sidebar counts, collections, Home totals). A member gets visibleSql. */
export const listedSql = (user, alias = 'r') => (isAdmin(user) ? `${alias}.source_hidden = 0` : visibleSql(user, alias));

/** For the lists that leave out everything hidden from everyone, for the admin too (recently added and played, platform totals). A member gets visibleSql. */
export const unhiddenSql = (user, alias = 'r') => `${notHiddenSql(alias)} AND ${withinLimitsSql(user, alias)}`;

/** Not hidden from everyone, whoever is asking. On its own it is only for the admin's own tools (export, the duplicate finder): it applies no limits. */
export const notHiddenSql = (alias = 'r') => `${alias}.hidden_all = 0 AND ${alias}.source_hidden = 0`;

/** The other way round: what the admin's Hidden filter looks for. */
export const hiddenFromEveryoneSql = (alias = 'r') => `(${alias}.hidden_all = 1 OR ${alias}.source_hidden = 1)`;

/** Not hidden by an admin's own Hide (a hidden source's games still count). Only for the admin's Reports; it applies no limits. */
export const notHiddenByAdminSql = (alias = 'r') => `${alias}.hidden_all = 0`;

/** For a count or list of rows that only point at a game (favourites, the download log): holds unless `column`, a rom's id, is a game this person is
 *  limited from. Name the column with its table ('downloads.rom_id'). It applies the limits alone, not "hidden from everyone". */
export const refWithinLimitsSql = (user, column) => `NOT EXISTS (SELECT 1 FROM roms lim WHERE lim.id = ${column} AND NOT (${withinLimitsSql(user, 'lim')}))`;

/* ───────── questions about one game ───────── */

/** A game's number written the one way we accept: plain digits, no leading zero. The database would also read other spellings as a number, so
 *  nothing that fails this may reach a query. */
export const isRomId = (id) => /^[1-9]\d*$/.test(String(id));

/** May this user see this ROM? A ROM that does not exist is nobody's to see (an admin gets the usual "not found" from the route itself). */
export function canSeeRom(user, romId) {
  if (isAdmin(user)) return true;
  if (!isRomId(romId)) return false;
  return Boolean(db.prepare(`SELECT 1 FROM roms r WHERE r.id = ? AND ${visibleSql(user)}`).get(Number(romId)));
}

/** False only when a limit rules this ROM out for this person. For what may still be shown about a game that is hidden from everyone. A ROM that is not there is not ruled out. */
export function withinLimits(user, romId) {
  return !db.prepare(`SELECT 1 FROM roms r WHERE r.id = ? AND NOT (${withinLimitsSql(user)})`).get(Number(romId));
}

/**
 * For things found by platform and title rather than by game (the videos shared by every list, including a person's own Physical and Digital
 * games): false when a Library game of that title on that platform is ruled out for this person by a limit. Being hidden from everyone does not
 * count here. `platform` is the Library's platform name (slug).
 */
export function titleWithinLimits(user, { title, platform }) {
  const slug = String(platform?.slug || platform || '');
  const within = withinLimitsSql(user);
  if (within === '1 = 1') return true;
  return !ruledOutTitles(within, slug).has(titleKey(title));
}

// A list of a person's own games asks about each one, and a strict limit can rule out thousands of Library games, so the titles ruled out on a
// platform are kept until anything in the database changes.
let titles = new Map(), titlesAt = '';
function ruledOutTitles(within, slug) {
  const at = `${db.prepare('SELECT total_changes() AS n').get().n}:${db.pragma('data_version', { simple: true })}`;
  if (at !== titlesAt) { titles = new Map(); titlesAt = at; }
  const wanted = `${slug}\n${within}`;
  let set = titles.get(wanted);
  if (!set) {
    set = new Set();
    for (const r of db.prepare(`SELECT r.title, r.long_title FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE p.slug = ? AND NOT (${within})`).all(slug)) {
      set.add(titleKey(r.title));
      if (r.long_title) set.add(titleKey(r.long_title));
    }
    titles.set(wanted, set);
  }
  return set;
}

/** The { id, role } the helpers need, for the places that only have a person's number (a launch code, a message thread). */
export const accountById = (id) => db.prepare('SELECT id, role FROM users WHERE id = ?').get(Number(id)) || { id: Number(id), role: 'user' };
