import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('carousel: the arc puts the middle cover in front and its neighbours further out, lower, smaller and fainter', async () => {
  const { arcStyle } = await import('../public/carousel.js');
  const mid = arcStyle(0), r1 = arcStyle(1), r2 = arcStyle(2), l1 = arcStyle(-1);
  assert.equal(mid.x, 0); assert.equal(mid.y, 0); assert.equal(mid.rot, 0); assert.equal(mid.opacity, 1);
  assert.ok(mid.z > r1.z && r1.z > r2.z, 'the middle one is in front');
  assert.ok(r1.x > 0 && r2.x > r1.x && l1.x === -r1.x, 'the two sides mirror each other');
  assert.ok(r2.y > r1.y && r1.y > mid.y, 'it curves: the further out, the lower');
  assert.ok(r1.scale < mid.scale && r2.scale < r1.scale && r1.opacity < 1 && r2.opacity < r1.opacity);
  assert.equal(arcStyle(7).opacity, 0, 'covers far out are invisible');
  assert.ok(r1.x - mid.x >= 170, 'the neighbours clear the (larger) middle cover');
});

test('carousel: it opens from the Library bar in Classic and Modern, with its own stylesheet and icon', () => {
  const html = read('public/index.html'), app = read('public/app.js'), modern = read('public/modern.js');
  assert.ok(html.includes('id="open-carousel"') && html.includes('/carousel.css'));
  assert.ok(app.includes("import * as carousel from './carousel.js'") && app.includes("closest('#open-carousel')") && app.includes('carousel.openCarousel('));
  assert.ok(modern.includes('id="tl-carousel"') && modern.includes("q('#open-carousel')?.click()") && modern.includes("'carousel'"));
  assert.ok(fs.existsSync(new URL('../public/modern/icons/carousel.svg', import.meta.url)));
});

test('carousel: plays in the browser when the game can be, otherwise on this PC; Esc closes; people who asked for less motion get none', () => {
  const js = read('public/carousel.js'), css = read('public/carousel.css');
  assert.ok(js.includes('openBrowser(g)') && js.includes('/launch') && js.includes('gamesauce://launch'));
  assert.ok(js.includes("e.key === 'Escape'") && js.includes('can_download === false'));
  assert.ok(js.includes('play_only') && js.includes('/roms?'), 'a play-only account only sees playable games');
  assert.ok(/prefers-reduced-motion: reduce[\s\S]*animation: none/.test(css));
  assert.ok(css.includes('@property --tint') && css.includes('.cv-grain') && css.includes('.cv-blob'));
});
