// Settings and Tools opened from the navigation start on their first area; only a page refresh restores the last one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('Settings and Tools opened from the navigation start on their first area; a refresh still restores', () => {
  const app = read('public/app.js');
  const sv = app.slice(app.indexOf('function setView('), app.indexOf('function setView(') + 900);
  assert.match(sv, /restore = false/);
  assert.match(sv, /!restore && view === 'settings'\) \{ activeSettingsModule = null;[^}]*settingsLastInGroup/);
  assert.match(sv, /!restore && view === 'tools'\) activeToolsModule = null/);
  assert.match(app, /setView\(target, \{ restore: true \}\)/, 'the refresh path keeps where they were');
  const modern = read('public/modern.js');
  assert.match(modern, /ctx\.setView\(view, opts\)/, 'Modern passes the choice on');
  assert.match(modern, /\{ restore: !fresh \}/, 'and its own refresh restores');
  assert.match(app, /function loadTools\(\) \{ showToolsModule\(activeToolsModule \|\| toolsVisible\(\)\[0\]\.id\)/);
});

