// Classic has a Home page again: a menu item above ROM Library, with the ticker and then Continue playing and Recently added one under the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('public/index.html'), app = read('public/app.js'), css = read('public/styles.css'), modern = read('public/modern.js');
const section = (id) => { const i = html.indexOf(`id="${id}"`); const next = html.indexOf('<section class="view', i + 10); return html.slice(i, next); };

test('the Home menu item is above ROM Library, and Home holds the ticker and the two panels', () => {
  const nav = html.slice(html.indexOf('<nav class="nav" id="nav">'));
  assert.ok(nav.indexOf('data-view="home"') > 0 && nav.indexOf('data-view="home"') < nav.indexOf('data-view="library"'), 'Home comes first');
  const home = section('view-home');
  for (const id of ['lib-overview', 'lib-played-wrap', 'played-row', 'lib-recent-wrap', 'recent-row']) assert.ok(home.includes(`id="${id}"`), `${id} is on Home`);
  assert.ok(home.indexOf('lib-played-wrap') < home.indexOf('lib-recent-wrap'), 'Continue playing above Recently added');
  const lib = section('view-library');
  for (const id of ['lib-overview', 'lib-played-wrap', 'lib-recent-wrap', 'home-divider']) assert.ok(!lib.includes(id), `${id} is no longer above the Library grid`);
});

test('the two panels are stacked, the ticker is drawn in Classic, and Home loads when it is shown', () => {
  assert.match(css, /#view-home \.strips[^{]*\{ display: block; grid-template-columns: none; \}/, 'one under the other at every width');
  assert.match(app, /if \(view === 'home'\) loadHome\(\);/);
  assert.match(app, /async function loadHome\(\)[\s\S]{0,300}renderOverview\(\)[\s\S]{0,120}renderPlayedRow\(\)/);
  assert.match(app, /if \(document\.body\.classList\.contains\('ui-modern'\)\) \{ clearInterval\(overviewTimer\)/, 'Classic draws the ticker; Modern has its own');
  assert.match(app, /\.modern-home, #view-home/, 'the fold arrows work on this Home too, and a short window does not fold the rows');
  // the Library no longer draws the rows above its grid
  const lib = app.slice(app.indexOf('async function loadLibrary()'), app.indexOf('async function loadLibrary()') + 3000);
  assert.ok(!lib.includes('renderOverview') && !lib.includes('renderPlayedRow'));
});

test('a fresh sign-in starts on Home in Classic, a refresh keeps Home, and the two looks hand Home to each other', () => {
  assert.match(app, /setView\(document\.body\.classList\.contains\('ui-modern'\) \? 'library' : 'home'\)/);
  assert.match(app, /\['home', 'library', 'collections'/, 'a saved Home is restored');
  assert.match(app, /saved\.view === 'home' && document\.body\.classList\.contains\('ui-modern'\)\) saved\.view = 'library'/, "Modern shows its own Home over the Library");
  assert.match(app, /if \(view !== 'home'\) modern\.syncView\?\.\(view\)/, "Modern's own Home is never overwritten by Classic's");
  assert.match(modern, /const onHome = document\.body\.dataset\.mview === 'home';[\s\S]{0,200}ctx\.setView\(onHome \? 'home' : ctx\.state\(\)\.view/, 'leaving Modern from its Home lands on Classic Home');
  assert.match(css, /body\.play-only \.nav-item\[data-view="home"\]/, 'a play-only account keeps its Play screen');
  assert.match(app, /if \(state\.view === 'home'\) renderPlayedRow\?\.\(\);/, 'a game just played moves to the front of Continue playing');
});

test('Home keeps the ordinary page padding, and the Modern tooltip box never lingers in Classic', () => {
  assert.match(css, /#view-home \{ padding-bottom: [\d.]+rem; \}/, 'only the bottom padding is set, so the sides and top are the ordinary .view ones');
  assert.ok(!/#view-home \{ padding: 0/.test(css), 'no zero side padding against the sidebar and the window edge');
  assert.ok(!css.includes('ui-modern'), 'Classic stylesheet carries no Modern rules, so the fix is in Modern: the tooltip box is taken away when the look changes');
  assert.match(modern, /function untipify\(\)[^\n]*tipHide\(\); \$\('#mb-tip'\)\?\.remove\(\); tipEl = null;/, 'leaving Modern takes the tooltip box away');
});
