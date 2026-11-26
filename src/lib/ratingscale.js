// Age ratings: the labels of the three boards we use, how they line up, and how a game's rating is chosen from what the providers said.
// Pure (no database), so the providers can use it and it can be tested on its own.
//
// Every rating is held as a level on one scale, so ratings from different boards can be compared:
//
//   level   ACB (Australia)   ESRB        PEGI
//     1     G                 E (and EC)  3
//     2     PG                E10+        7
//     3     M                 T           12
//     4     MA 15+            M           16
//     5     R 18+             AO          18
//     6     RC (refused classification: only an admin or ACB says this)
//
// This table is the app's own, not an official equivalence. Where boards do not line up exactly it rounds to the stricter one.

export const BOARDS = ['acb', 'esrb', 'pegi'];
export const RC_LEVEL = 6;

/** The classification setting: which board's labels the app shows. */
export const SYSTEMS = {
  acb: { board: 'ACB', name: 'Australia (ACB)', labels: ['G', 'PG', 'M', 'MA 15+', 'R 18+', 'RC'] },
  esrb: { board: 'ESRB', name: 'United States and Canada (ESRB)', labels: ['E', 'E10+', 'T', 'M', 'AO', 'RC'] },
  pegi: { board: 'PEGI', name: 'Europe and the United Kingdom (PEGI)', labels: ['3', '7', '12', '16', '18', 'RC'] }
};
export const DEFAULT_SYSTEM = 'acb';

/** Every way we accept each label being written (upper case, no spaces). Anything else, "Not Rated" and "Rating Pending" included, is no rating at all. */
const SPELLINGS = {
  acb: { G: 1, PG: 2, M: 3, MA15: 4, 'MA15+': 4, R18: 5, 'R18+': 5, RC: 6 },
  esrb: { EC: 1, E: 1, E10: 2, 'E10+': 2, T: 3, M: 4, 'M17+': 4, AO: 5, 'AO18+': 5 },
  pegi: { 3: 1, 7: 2, 12: 3, 16: 4, 18: 5 }
};

/** The level a board's label stands for, or null. Takes the long forms the providers send ("M - Mature 17+", "MA 15+"). */
export function levelOf(board, text) {
  const table = SPELLINGS[String(board || '').toLowerCase()];
  if (!table) return null;
  const short = String(text ?? '').split(' - ')[0].replace(/\s+/g, '').toUpperCase();
  return Object.hasOwn(table, short) ? table[short] : null;
}

/** How a level is written in a system: label(‘esrb’, 4) -> 'M'. */
export const labelOf = (system, level) => SYSTEMS[system]?.labels[level - 1] ?? null;

/** "ACB MA 15+": a rating with its board, which means the same whatever the setting is. */
export const withBoard = (board, level) => `${SYSTEMS[board].board} ${labelOf(board, level)}`;

/** One { board, level, source } for a provider's board name and label, or null when it is not a board we use or not a rating. */
export function ratingItem(boardName, text, source) {
  const board = String(boardName || '').trim().toLowerCase();
  const level = levelOf(board, text);
  return level ? { board, level, source } : null;
}

/**
 * Evidence is what the providers have said about a game, the strictest per board: { acb: { level, source }, esrb: ..., pegi: ... }.
 * Returns a new object with the items added. A board's entry only ever gets stricter.
 */
export function addEvidence(evidence, items) {
  const out = { ...(evidence || {}) };
  for (const it of items || []) {
    if (!BOARDS.includes(it?.board) || !(it.level >= 1 && it.level <= RC_LEVEL)) continue;
    if (!out[it.board] || it.level > out[it.board].level) out[it.board] = { level: it.level, source: it.source };
  }
  return out;
}

/** The rating the evidence gives under a system: that system's own board when any source has it, else the strictest of the others, converted. */
export function pickRating(evidence, system) {
  const own = evidence?.[system];
  if (own) return { level: own.level, board: system, source: own.source };
  let best = null;
  for (const board of BOARDS) {
    const e = evidence?.[board];
    if (e && (!best || e.level > best.level)) best = { level: e.level, board, source: e.source };
  }
  return best;
}

/**
 * What a game holds after a new lookup. A fetched rating may get stricter and never gets lower or goes away. At the same level, the system's own
 * board replaces a converted one.
 */
export function keepStrictest(held, found, system) {
  if (!found) return held || null;
  if (!held || found.level > held.level) return found;
  if (found.level === held.level && found.board === system && held.board !== system) return found;
  return held;
}

/**
 * A rating a person typed (the CSV column): "ACB MA 15+", "ESRB T", "PEGI 16", "RC", or a bare label of the current system.
 * { level, board, named: whether the text said which board }, or null when it is not a rating.
 */
export function parseTyped(text, system) {
  const s = String(text ?? '').trim();
  const m = s.match(/^(ACB|ESRB|PEGI)\s*[:\s]\s*(.+)$/i);
  const board = m ? m[1].toLowerCase() : system;
  const value = m ? m[2] : s;
  if (value.replace(/\s+/g, '').toUpperCase() === 'RC') return { level: RC_LEVEL, board, named: Boolean(m) };
  const level = levelOf(board, value);
  return level ? { level, board, named: Boolean(m) } : null;
}
