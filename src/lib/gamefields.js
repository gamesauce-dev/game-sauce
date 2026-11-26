// What may be stored in a ROM Library game's own details. Two ways in: an edit by hand (a wrong value is refused) and a match from a metadata
// provider (a wrong value is left out). Both matter for safety: since members can be allowed to edit, these values are not only the admin's, and
// everyone who opens the Library, the admin included, is shown them. The database would store any text in a column meant for a number.

const TEXT = { title: 1000, developer: 1000, publisher: 1000, genre: 1000, region: 200, revision: 200, description: 100000 };
const NUMBERS = {
  release_year: { min: 1000, max: 9999, whole: true },
  players: { min: 0, max: 999, whole: true },
  rating: { min: 0, max: 100, whole: false }
};
const MAX_TAGS = 100, MAX_TAG = 100;
const BAD = Symbol('bad value');

function textValue(value, max, cut) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return BAD;
  const s = String(value);
  if (s.length <= max) return s;
  return cut ? s.slice(0, max) : BAD;
}

function numberValue(value, { min, max, whole }) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) return BAD;
  return n;
}

function clean(field, value, cut) {
  if (value === null || value === undefined || value === '') return null;
  const out = field in TEXT ? textValue(value, TEXT[field], cut) : numberValue(value, NUMBERS[field]);
  return out === '' ? null : out;
}

export const BAD_VALUE = 'One of the values is not allowed. Years, players and ratings must be numbers, and text must not be too long.';
const refuse = () => Object.assign(new Error(BAD_VALUE), { status: 400 });

/** One field of an edit by hand: the value to store (null empties it). Throws a 400 for anything that may not be stored. */
export function editedValue(field, value) {
  const out = clean(field, value, false);
  if (out === BAD || (field === 'title' && out === null)) throw refuse();
  return out;
}

/** The tags of an edit by hand: a list of short pieces of text. Throws a 400 for anything else. */
export function editedTags(tags) {
  if (!Array.isArray(tags) || tags.length > MAX_TAGS || tags.some((t) => typeof t !== 'string' || t.length > MAX_TAG)) throw refuse();
  return tags;
}

/** A provider's match, made safe to store: text that is too long is cut, and anything of the wrong kind is left out. Changes `meta` itself. */
export function cleanMatch(meta) {
  for (const field of [...Object.keys(TEXT), ...Object.keys(NUMBERS)]) {
    if (!(field in meta)) continue;
    const out = clean(field, meta[field], true);
    meta[field] = out === BAD ? null : out;
  }
  return meta;
}
