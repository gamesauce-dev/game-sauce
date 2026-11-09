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
  assert.ok(app.includes("import * as carousel from './carousel.js'") && app.includes("#open-carousel, [data-open=\"carousel\"]") && app.includes('carousel.openCarousel('));
  assert.ok(modern.includes('id="tl-carousel"') && modern.includes("q('#open-carousel')?.click()") && modern.includes("'carousel'"));
  assert.ok(fs.existsSync(new URL('../public/modern/icons/carousel.svg', import.meta.url)));
});

test('carousel: plays in the browser when the game can be, otherwise on this PC; Esc closes; people who asked for less motion get none', () => {
  const js = read('public/carousel.js'), css = read('public/carousel.css');
  assert.ok(js.includes('openBrowser(g)') && js.includes('/launch') && js.includes('gamesauce://launch'));
  assert.ok(js.includes("e.key === 'Escape'") && js.includes('can_download === false'));
  assert.ok(js.includes('play_only') && js.includes('/roms?'), 'a play-only account only sees playable games');
  assert.ok(/prefers-reduced-motion: reduce[\s\S]*animation: none/.test(css));
  assert.ok(css.includes('.cv-tint') && css.includes('.cv-grain') && css.includes('.cv-blob'));
});

test('carousel: the controller drives it (and the page underneath no longer gets the pad), and the backdrop follows the middle cover', () => {
  const pad = read('public/gamepad.js'), js = read('public/carousel.js'), css = read('public/carousel.css');
  assert.ok(pad.includes("$('.cv')") && pad.includes("new CustomEvent('cv-pad'"), 'while the carousel is open, the pad belongs to it');
  for (const a of ["'left'", "'right'", "'up'", "'down'", "'prev-family'", "'next-family'", "'select'", "'local'", "'back'"]) assert.ok(js.includes(`a === ${a}`), a);
  const flat = css.replace(/\r?\n/g, ' ');
  assert.ok(js.includes('cv-tint t1') && js.includes('cv-tint t2') && /\.cv-tint \{[^}]*transition: opacity/.test(flat), 'the middle cover colours cross-fade by opacity (cheap), instead of repainting blurred blobs every frame');
  assert.ok(!/(^|[^-])filter: blur\(/.test(css) && !/mix-blend-mode/.test(css), 'no full-screen blur or blend work behind the moving covers');
  assert.ok(css.includes('.cv-card.mid .cv-face::after') && css.includes('conic-gradient') && css.includes('@property --ang'), 'the middle cover has a border with a light point running round it');
});

test('carousel: Steam games with their Play button on are a family of their own, and play opens them in Steam', () => {
  const js = read('public/carousel.js');
  assert.ok(js.includes("'steam:installed'") && js.includes('/digital/games?store=steam&installed=1') && js.includes('launch_url') && js.includes('launchSteam'));
  assert.ok(js.includes('cover_fallback_url'), 'a Steam cover that is missing falls back to its header picture');
});

test('carousel: it hides games this PC cannot start once the launcher has reported (and shows everything until then)', () => {
  const js = read('public/carousel.js'), app = read('src/app.js');
  assert.ok(js.includes('launcher_platforms') && js.includes('/launcher/sync-token') && js.includes('gamesauce://sync?'), 'Check my PC asks the launcher');
  assert.ok(js.includes('const launchable = (slug) => known() === null || known().includes(slug)'), 'nothing is hidden until the PC has reported');
  assert.ok(js.includes("q.set('playable', '1')") && js.includes('!g.missing'), 'only browser-playable games for platforms with no emulator here; unreachable files are left out');
  assert.ok(js.includes('can_download === false'), 'an account that cannot download has no launcher, so only browser games');
  assert.ok(app.includes("api.post('/launcher/sync', launcherSyncHandler)") && app.includes("'/launcher/sync-token'"));
});

test('carousel: the controller can choose chips (up from the covers), and both ways to play are offered, with the preferred one on Enter, A and a click', () => {
  const js = read('public/carousel.js'), css = read('public/carousel.css'), pad = read('public/gamepad.js');
  for (const w of ["setZone('subs')", "setZone('fams')", "setZone('covers')", 'hlStep(']) assert.ok(js.includes(w), w);
  assert.ok(js.includes("a === 'select'") && js.includes("if (z === 'covers') close(); else setZone('covers')"), 'B steps back out of the chips before it closes the carousel');
  assert.ok(css.includes('.cv-chip.pad'), 'the highlighted chip has a ring');
  assert.ok(js.includes('canBrowser') && js.includes('canLocalPlay') && js.includes("data-act=\"prefer\"") && js.includes("'gamesauce_cv_prefer'"), 'both buttons, and a switch for which one Enter uses');
  assert.ok(js.includes("preferred() === 'local' ? playLocal(g) : openBrowser(g)"), 'a game that can be played both ways uses the preferred one');
  assert.ok(pad.includes("cvPad(root, 'browser')") && pad.includes("cvPad(root, 'local')"), 'X plays in the browser, Y on this PC');
  assert.ok(/\.cv-chip \{[^}]*rgba\(255, 255, 255, \.62\)/.test(css.replace(/\r?\n/g, ' ')) && /\.cv-chip\.on \{ background: var\(--ink\); color: #fff; \}/.test(css), 'chips look like the Play buttons: a glass pill, and the chosen one dark with light text');
});

test('carousel: it has its own entry after Collections (Modern top bar and Classic sidebar), opens over any page, and starts on Steam when you come from Digital', () => {
  const html = read('public/index.html'), modern = read('public/modern.js'), app = read('public/app.js');
  assert.ok(html.indexOf('data-view="collections"') < html.indexOf('data-open="carousel"') && html.indexOf('data-open="carousel"') < html.indexOf('data-view="sources"'), 'Classic: after Collections');
  assert.ok(modern.indexOf("view: 'collections'") < modern.indexOf("view: 'carousel'") && modern.indexOf("view: 'carousel'") < modern.indexOf("view: 'sources'"), 'Modern: after Collections');
  assert.ok(modern.includes("if (v === 'carousel') { ctx.openCarousel?.(); return; }") && modern.includes('openCarousel'), 'it is not a page: it opens over the current one');
  assert.ok(app.includes('function openCarouselView()') && app.includes("state.view === 'digital' ? 'steam:installed'") && app.includes('[data-open="carousel"]'));
});

test('carousel: the platform chips carry no disc or cartridge icon', () => {
  assert.ok(!read('public/carousel.js').includes('cv-ico') && !read('public/carousel.css').includes('.cv-ico'));
});
