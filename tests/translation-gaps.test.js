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
