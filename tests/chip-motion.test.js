import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// a stand-in for the page: just enough of an element for the helper
const row = (n) => ({ children: Array.from({ length: n }, () => ({ vars: {}, style: { setProperty(k, v) { this.owner.vars[k] = v; } } })).map((c) => { c.style.owner = c; return c; }), cls: new Set(), classList: { add(c) { this.owner.cls.add(c); } } });
const box = (r) => ({ querySelector: (sel) => (r && /chip-plats/.test(sel) ? r : null) });

test('the sub chips land one after another when a family opens, not again for every pick, and not for people who ask for less motion', async () => {
  const { landChips } = await import('../public/chip-motion.js');
  globalThis.matchMedia = () => ({ matches: false });
  const mk = () => { const r = row(4); r.classList.owner = r; return r; };
  const host = {}, r1 = mk(); host.querySelector = box(r1).querySelector;
  landChips(host, 'Nintendo');
  assert.ok(r1.cls.has('land'), 'the family has just opened');
  assert.deepEqual(r1.children.map((c) => c.vars['--i']), ['0', '1', '2', '3'], 'each chip waits its turn');
  const r2 = mk(); host.querySelector = box(r2).querySelector;
  landChips(host, 'Nintendo');
  assert.ok(!r2.cls.has('land'), 'a redraw of the same open family (a platform picked) does not play it again');
  const r3 = mk(); host.querySelector = box(r3).querySelector;
  landChips(host, 'Sony');
  assert.ok(r3.cls.has('land'), 'another family opens: it lands');
  host.querySelector = box(null).querySelector; landChips(host, null);   // closed
  const r4 = mk(); host.querySelector = box(r4).querySelector;
  landChips(host, 'Sony');
  assert.ok(r4.cls.has('land'), 'opened again after being closed: it lands again');
  globalThis.matchMedia = () => ({ matches: true });
  const r5 = mk(); host.querySelector = box(r5).querySelector; landChips(host, 'Sega');
  assert.ok(!r5.cls.has('land'), 'reduced motion: nothing moves');
});

test('every chip row (ROM Library, Physical, Digital) calls it, and the animation is in the shared stylesheet', () => {
  for (const f of ['public/modern.js', 'public/physical.js', 'public/digital.js']) assert.ok(read(f).includes("import { landChips } from './chip-motion.js';") && /landChips\(host, [A-Za-z.]+\);/.test(read(f)), f);
  const css = read('public/styles.css');
  assert.ok(css.includes('@keyframes chip-land') && css.includes('.chip-plats.land > *, .ph-chip-plats.land > *') && css.includes('prefers-reduced-motion'));
});
