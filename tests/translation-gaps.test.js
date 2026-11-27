import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTranslator, LANGS } from '../public/i18n.js';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('a whole sentence written by hand is shown as written (the German plural fix leaves it alone)', () => {
  const de = makeTranslator({ 'The game\'s title': 'Der Titel des Spiels', '{n} game{s}': '{n} Spiel{s}' }, 'de');
  assert.equal(de.lookup('The game\'s title'), 'Der Titel des Spiels');
  assert.equal(de.lookup('3 games'), '3 Spiele', 'a sentence put together by the code still gets its plural fixed');
});

test('the sentence with the most words of its own wins', () => {
  const tr = makeTranslator({ 'Delete {a}?': 'A {a}', 'Delete platform “{a}”?': 'B {a}', 'Delete {a} {b}?': 'C {a} {b}' });
  assert.equal(tr.lookup('Delete platform “Wii”?'), 'B Wii');
});

test('the ticker, the home search and the file box are translated in every language', () => {
  const sentences = ['{count} games across {platforms} platforms', '{size} of ROMs stored', 'Most downloaded: {title}', 'System health: {state}',
    'Search all your libraries', 'Choose file', 'Choose files', 'No file chosen', 'Files chosen: {count}', '{pct}%, about {time} left'];
  for (const { code } of LANGS.filter((l) => l.code !== 'en')) {
    const dict = JSON.parse(read(`public/lang/${code}.json`));
    for (const s of sentences) assert.ok(dict[s], `${code}: ${s}`);
  }
});

test('file boxes use the app\'s own words, set up once the language is loaded', () => {
  const app = read('public/app.js');
  assert.ok(app.indexOf('await initI18n();') < app.indexOf('initFilePickers();'));
  assert.match(read('public/filepick.js'), /t\('No file chosen'\)/);
});

test('import problem lines and results are whole sentences, with their own translation in every language', async () => {
  const { importLine } = await import('../public/csvsplit.js');
  assert.equal(importLine({ line: 4, reason: 'No platform' }), 'Line 4: No platform');
  assert.equal(importLine({ line: 2, reason: 'The purchase details for "Zeta" were left out: Choose a currency from the list.' }), 'Line 2: The purchase details for "Zeta" were left out: Choose a currency from the list.');
  for (const { code } of LANGS.filter((l) => l.code !== 'en')) {
    const dict = JSON.parse(read(`public/lang/${code}.json`));
    for (const s of ['Line {line}: {reason}', 'Added: {added}. Updated: {updated}. Already there: {unchanged}.', 'Games in the file: {games} ({list}).', 'Rows skipped: {count}.', 'Add My Games']) assert.ok(dict[s], `${code}: ${s}`);
    assert.match(dict['= yes, or'], /yes/, `${code}: the CSV only accepts yes, so the word stays as it is`);
  }
});

test('every emulator description is translated in every language, and the page shows it through the translator', async () => {
  const { EMULATORS } = await import('../src/lib/emulators.js');
  for (const { code } of LANGS.filter((l) => l.code !== 'en')) {
    const dict = JSON.parse(read(`public/lang/${code}.json`));
    for (const e of EMULATORS) assert.ok(dict[e.notes], `${code}: ${e.name}`);
  }
  assert.match(read('public/app.js'), /esc\(t\(e\.notes\)\)/);
});

test('the DAT page, which only fills once a DAT is imported, is translated in every language', () => {
  for (const { code } of LANGS.filter((l) => l.code !== 'en')) {
    const dict = JSON.parse(read(`public/lang/${code}.json`));
    for (const s of ['Collection completeness', 'Whole', 'The whole bar counts a game under the first of these that holds it. A game counts once whatever its region, across everyone on this server.', 'Matched by name', 'Games: {count}', 'Have: {count}', 'Missing: {count}', 'Have / want: {name}', 'Entries imported: {count} ({platform}).', 'ROMs checked: {checked}. Matched: {matched}.']) assert.ok(dict[s], `${code}: ${s}`);
  }
  assert.match(read('public/app.js'), /t\('Collection completeness'\)/);
});

test('the ROM Library menu and toolbar hover words are translated in every language', () => {
  // every line of the "More filters" menu, its name and its explanation
  const line = read('public/modern.js').split('\n').find((l) => l.includes("const items = [['locked'"));
  const words = [...line.matchAll(/\['[a-z]+', '([^']+)', ic\.[a-z]+, '((?:[^'\\]|\\.)+)'/g)].flatMap((m) => [m[1], m[2].replace(/\\'/g, "'")]);
  assert.equal(words.length, 14);
  for (const { code } of LANGS.filter((l) => l.code !== 'en')) {
    const dict = JSON.parse(read(`public/lang/${code}.json`));
    for (const s of [...words, 'Sort: {name}', 'Jump to {letter}', 'No games under {letter}', 'Show the case of {title}', 'Selected: {count}']) assert.ok(dict[s], `${code}: ${s}`);
  }
});

test('hover words that Modern has moved into its own hover box are still translated', () => {
  assert.match(read('public/i18n.js'), /const ATTRS = \[[^\]]*'data-mtip'\]/);
  assert.match(read('public/modern.js'), /el\.dataset\.mtip = /);
});

test('the game details windows: labels, menu and messages are translated in every language', () => {
  const words = ['Source', 'File', 'Location', 'Size', 'Revision', 'Rating', 'Full name: {name}', 'Browser play: on', 'Multi-disc set: no', 'Added: {list}.', 'Not available: {list}.', 'cover', 'manual', 'on your shelf', 'Add manual', 'Read the manual ({name})'];
  for (const { code } of LANGS.filter((l) => l.code !== 'en')) {
    const dict = JSON.parse(read(`public/lang/${code}.json`));
    for (const s of words) assert.ok(dict[s], `${code}: ${s}`);
  }
  assert.match(read('public/video.js'), /list\.map\(\(k\) => t\(ASSET_NAME\[k\] \|\| k\)\)/);
});
