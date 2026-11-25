// Modern Home: the search box searches the ROM, Physical and Digital libraries together and shows what each has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const js = read('public/modern.js'), css = read('public/modern.css'), app = read('public/app.js');

test('All platforms searches the three libraries, a chosen platform still searches the ROM Library', () => {
  const submit = js.slice(js.indexOf('function submitHomeSearch()'), js.indexOf('/* ───────────── Home search across every library'));
  assert.match(submit, /if \(text && plat === 'all'\) \{ searchEverywhere\(text\); return; \}/);
  assert.match(submit, /clearHomeResults\(\);[\s\S]{0,700}go\('library'\)/, 'a platform search goes to the Library as before');
  const fn = js.slice(js.indexOf('async function searchEverywhere('), js.indexOf('function showAllIn('));
  for (const url of ['/roms?q=', '/physical/games?q=', '/digital/games?q=']) assert.ok(fn.includes('`' + url), `${url} is asked`);
  assert.match(fn, /Promise\.all\(\[get\(/, 'the three are asked at once');
  assert.match(fn, /if \(mine !== homeSearchSeq\) return;/, 'a newer search wins over a slow one');
  for (const g of ["'rom', 'ROM Library'", "'phys', 'Physical Library'", "'dig', 'Digital Library'"]) assert.ok(fn.includes(g), g);
  assert.match(fn, /openPhysicalDetail/); assert.match(fn, /openDigitalDetail/);
  assert.match(fn, /data-mh-all/, 'each group has a Show all');
});

test('the search box says so, and the results step the Home rows aside', () => {
  assert.match(js, /placeholder="Search all your libraries"/);
  assert.match(js, /id="mh-results"/);
  assert.match(css, /\.modern-home\.show-results \.mh-strips \{ display: none !important; \}/);
  assert.match(js, /function clearHomeResults\(\)/);
});

test('the app hands Modern the two detail openers, and ROM results are browse-only like the Home rows', () => {
  assert.match(app, /openPhysicalDetail: physical\.openDetail, openDigitalDetail: digital\.openDigitalDetail \}\)/);
  assert.match(app, /root\.classList\.contains\('browse-only'\)/);
  assert.match(app, /closest\('#grid, #recent-row, #played-row, \.browse-only'\)/, 'prev/next walks the results');
  const show = js.slice(js.indexOf('function showAllIn('), js.indexOf('function fillRow('));
  assert.match(show, /'#ph-q' : '#dg-q'/, "Show all fills the Physical or Digital page's own search box");
});

test('the Show button just says Show all, and arriving at Home again starts clean with the two rows back', () => {
  const fn = js.slice(js.indexOf('async function searchEverywhere('), js.indexOf('function showAllIn('));
  assert.match(fn, /data-mh-all="\$\{id\}">Show all<\/button>/, 'the count is already shown beside it');
  assert.ok(!/Show \$\{total > HOME_HITS/.test(fn));
  const home = js.slice(js.indexOf('async function renderHome()'), js.indexOf('async function renderHome()') + 600);
  assert.match(home, /homeSearchSeq\+\+; host\.classList\.remove\('show-results'\);/, "a Home page rebuilt after a search must not keep the class that hides the rows");
});
