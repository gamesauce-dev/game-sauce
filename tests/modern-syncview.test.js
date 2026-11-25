// In Modern, a button elsewhere that makes the app open the Library by itself (Settings > Show orphans ...) must take Modern's bar and page rules with it,
// or the Library shows up dressed as Classic: its home strips and overview, and none of the library tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('every view the app opens by itself is followed by Modern', () => {
  const app = read('public/app.js'), modern = read('public/modern.js');
  const sv = app.slice(app.indexOf('function setView('), app.indexOf('function setView(') + 1400);
  assert.match(sv, /state\.view = view;\n  saveNav\(\);\n  if \(view !== 'home'\) modern\.syncView\?\.\(view\);/, "setView tells Modern which view is showing (Home is Classic's own page)");
  // go() and syncView() share one routine, so they cannot drift apart
  const go = modern.slice(modern.indexOf('export function go('), modern.indexOf('export const currentView'));
  assert.match(go, /applyMview\(view\);/);
  const fn = modern.slice(modern.indexOf('export function syncView('), modern.indexOf('export const currentView'));
  assert.match(fn, /document\.body\.dataset\.mview === view\) return;/, 'nothing to do when Modern already shows it (go() sets it before calling setView)');
  assert.match(fn, /applyMview\(view\);/); assert.match(fn, /hideHome\(\);/);
  assert.match(fn, /!isModern\(\) \|\| homeSwitch/, 'Classic is untouched, and Home asking for the Library underneath it is not a visit');
  const home = modern.slice(modern.indexOf('function showHome()'), modern.indexOf('function hideHome()'));
  assert.match(home, /homeSwitch = true; try \{ ctx\.setView\('library'\); \} finally \{ homeSwitch = false; \}/);
  // the routine sets what the page rules (modern.css) key on
  const apply = modern.slice(modern.indexOf('function applyMview('), modern.indexOf('let homeSwitch'));
  for (const part of ['retool(view)', 'refreshTicker(view', 'document.body.dataset.mview = view', "gamesauce_mview", 'is-on']) assert.ok(apply.includes(part), part);
});

test('the places that open the Library or another page by themselves exist, so this matters', () => {
  const app = read('public/app.js'), dg = read('public/digital.js');
  assert.ok((app.match(/setView\('library'\)/g) || []).length >= 5, 'several buttons open the Library directly');
  assert.match(dg, /ctx\.setView\('tools'\)/, "Digital's own links go straight to Tools");
});
