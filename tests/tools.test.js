import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('Add My Games: a Library column splits one CSV into the Digital and the Physical part', async () => {
  const { splitByLibrary, parseCsv } = await import('../public/csvsplit.js');
  const csv = 'Platform,Game,Country,Library\r\nPS5,"Astro Bot, the game",AU,Digital\r\nSNES,Super Metroid,,physical\r\nXbox 360,Halo 3,,\r\nPS4,Bloodborne,,Both\r\n';
  const r = splitByLibrary(csv, 'physical');
  assert.equal(r.hasColumn, true);
  assert.deepEqual(parseCsv(r.digital), [['Platform', 'Game', 'Country'], ['PS5', 'Astro Bot, the game', 'AU']], 'the Library column is taken out, quoting kept');
  assert.deepEqual(parseCsv(r.physical).map((x) => x[1]), ['Game', 'Super Metroid', 'Halo 3'], 'a blank Library goes to the chosen list');
  assert.deepEqual(r.counts, { digital: 1, physical: 2 });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].reason, /Digital or Physical/);
  assert.equal(r.problems[0].line, 5);
  assert.equal(splitByLibrary(csv, 'digital').counts.digital, 2, 'the chosen list changes where a blank goes');
  const none = splitByLibrary('Platform,Game\nPS5,Astro Bot\n', 'digital');
  assert.equal(none.hasColumn, false, 'no Library column: the whole file goes to the chosen list');
});

test('Tools: a menu option before Settings, with Emulators, Controller, Add My Games, Game Assets and Steam; those moved out of My account and the two libraries', async () => {
  const html = read('public/index.html'), app = read('public/app.js'), mj = read('public/modern.js'), dg = read('public/digital.js'), ph = read('public/physical.js');
  assert.ok(html.includes('data-view="tools"') && html.indexOf('data-view="messages"') < html.indexOf('data-view="tools"'), 'the sidebar entry comes after the pages and before Settings');
  assert.ok(mj.indexOf("view: 'tools'") > mj.indexOf("view: 'messages'") && mj.indexOf("view: 'tools'") < mj.indexOf("view: 'settings'"), 'and so does the Modern bar');
  const view = html.slice(html.indexOf('id="view-tools"'), html.indexOf('id="view-settings"'));
  for (const id of ['mod-playpc', 'mod-controller', 'mod-addgames', 'mod-gameassets', 'mod-steam', 'tools-tiles', 'dgc-file']) assert.ok(view.includes(`id="${id}"`), id + ' is in the Tools page');
  const settings = html.slice(html.indexOf('id="view-settings"'), html.indexOf('id="view-sources"'));
  for (const id of ['mod-playpc', 'mod-controller', 'mod-steam', 'dgc-box']) assert.ok(!settings.includes(`id="${id}"`), id + ' left Settings');
  for (const [label, mi] of [['Emulators', 'emulators-2'], ['Controller', 'gamepad'], ['Add My Games', 'game-add'], ['Game Assets', 'game-assets'], ['Steam', 'steam']]) assert.ok(app.includes(`label: '${label}', mi: '${mi}'`), label);
  assert.ok(app.includes("if (view === 'tools') loadTools();") && app.includes('toolsModule: activeToolsModule'));
  assert.ok(!/data-(dg|ph)-act="(import|art)"/.test(html), 'no Import CSV / Import game assets buttons in Digital or Physical');
  assert.ok(!dg.includes('openImport') && !ph.includes('openImport') && !dg.includes('openArtImport') && !ph.includes('openArtImport'));
  assert.ok(dg.includes("ctx.setView('tools'); ctx.showToolsModule('steam')") && dg.includes("ctx.showToolsModule('addgames')") && ph.includes("ctx.showToolsModule('addgames')"));
  assert.ok(app.includes("splitByLibrary(csv, dest())") && app.includes("'/physical/import'") && app.includes("'/digital/consoles/import'"));
  assert.ok(app.includes('!m.own || !authState.user?.play_only'), 'a play-only account gets Emulators and Controller only');
});

test('the Tools page scrolls, and Game Assets puts its explanation beside the importer', () => {
  const css = read('public/styles.css');
  assert.match(css, /#view-settings, #view-tools, #view-account[^{]*\{ overflow-y: auto;/, 'the page scrolls like Settings');
  assert.match(css, /#ga-body \{ display: grid; grid-template-columns: minmax\(0, 3fr\) minmax\(0, 2fr\);/);
  assert.match(css, /#ga-body > \.hint \{ grid-column: 2; grid-row: 2;/, 'the explanation is the right-hand column');
});
