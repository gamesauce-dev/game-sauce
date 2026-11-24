// One order for every platform picker: the families A to Z (Others last), and the platforms in each family A to Z.
// A <select> shows each family as a heading with its platforms under it; a type-to-find list is in the same order.
const by = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const familyOf = (p) => p.family || 'Others';

/** The platforms in the one order: families A to Z with Others last, then the platforms of each family A to Z. */
export function orderPlatforms(list) {
  return [...list].sort((a, b) => ((familyOf(a) === 'Others') - (familyOf(b) === 'Others')) || by(familyOf(a), familyOf(b)) || by(a.name, b.name));
}

/** <optgroup>s of <option>s, one group (a heading and a divider) for each family. label: the text of an option (default the platform's name). */
export function groupedOptions(list, { selected = null, label = (p) => p.name } = {}) {
  const groups = new Map();
  for (const p of orderPlatforms(list)) { const f = familyOf(p); if (!groups.has(f)) groups.set(f, []); groups.get(f).push(p); }
  return [...groups.entries()].map(([fam, plats]) => `<optgroup label="${esc(fam)}">${plats.map((p) => `<option value="${esc(p.slug)}"${p.slug === selected ? ' selected' : ''}>${esc(label(p))}</option>`).join('')}</optgroup>`).join('');
}

/** The family each Digital store sits in, as the Library files its consoles (Steam has none: it is last, like Others). */
export const STORE_FAMILY = { xbox: 'Microsoft', nintendo: 'Nintendo', playstation: 'Sony' };

/** The Digital Library's store chips in the Library's family order: the families A to Z, Steam (no family) last. */
export function orderStores(stores) {
  const fam = (s) => STORE_FAMILY[s.store] || 'Others';
  return [...stores].sort((a, b) => ((fam(a) === 'Others') - (fam(b) === 'Others')) || by(fam(a), fam(b)) || by(a.store, b.store));
}

/** A store's console chips in the Library's order: the platforms A to Z by the Library's name for them. nameOf(p) gives that name. */
export function orderConsoles(list, nameOf = (p) => p.name) {
  return [...list].sort((a, b) => by(nameOf(a), nameOf(b)));
}
