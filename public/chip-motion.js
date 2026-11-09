// When a family chip is opened, its platform chips land one after another (the way the games drop onto the shelf). Picking a platform afterwards redraws the row,
// but it does not play again: the animation runs only when the row has just opened, or changed to another family. Nothing moves for people who ask for less motion.
const lastKey = new WeakMap();   // chip box -> the family its row showed the last time

/** Call right after a chip box has been drawn. host: the box; key: the open family (or null / empty when none). */
export function landChips(host, key) {
  const row = host.querySelector('.chip-plats, .ph-chip-plats');
  const prev = lastKey.get(host) ?? null;
  lastKey.set(host, key || null);
  if (!row || !key || prev === key) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  [...row.children].forEach((c, i) => c.style.setProperty('--i', String(Math.min(i, 24))));
  row.classList.add('land');
}
