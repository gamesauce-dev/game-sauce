// Who may see which ROM Library game. ONE place for the rule, so a new route cannot invent its own.
//
// Today a member does not see a game an admin hid from everyone (hidden_all) or one whose source hides its games (source_hidden); an admin sees
// everything. A person's own Hide (hidden_roms) is a viewing preference, not access control, and is not part of this rule. Age limits and
// per-person or per-group blocks, when they come, belong here too.
import db from '../db.js';

const isAdmin = (user) => user?.role === 'admin';

/** An SQL condition (for a roms row named `alias`) that holds for the games this user may see. */
export const visibleSql = (user, alias = 'r') => (isAdmin(user) ? '1 = 1' : `${alias}.hidden_all = 0 AND ${alias}.source_hidden = 0`);

/** May this user see this ROM? A ROM that does not exist is nobody's to see (an admin gets the usual "not found" from the route itself). */
export function canSeeRom(user, romId) {
  if (isAdmin(user)) return true;
  return Boolean(db.prepare(`SELECT 1 FROM roms r WHERE r.id = ? AND ${visibleSql(user)}`).get(Number(romId)));
}
