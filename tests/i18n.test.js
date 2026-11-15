import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { makeTranslator, browserLanguage, LANGS } = await import('../public/i18n.js');
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('i18n: a known string is translated, with its whitespace ignored; an unknown one is left to English', () => {
  const t = makeTranslator({ 'Add to favourites': 'Ajouter aux favoris', 'Sign in': 'Se connecter' });
  assert.equal(t.lookup('Add to favourites'), 'Ajouter aux favoris');
  assert.equal(t.lookup('  Sign\n    in  '), 'Se connecter', 'line breaks and spaces in the page do not matter');
  assert.equal(t.lookup('Something new'), null, 'no entry: null, so the page keeps its English');
  assert.equal(t.lookup(''), null);
});

test('i18n: a pattern fills in the numbers and names, and the most specific pattern wins', () => {
  const t = makeTranslator({ 'Delete {n} games?': 'Supprimer {n} jeux ?', 'Delete {n} games from {src}?': 'Supprimer {n} jeux de {src} ?', '{n} games': '{n} jeux' });
  assert.equal(t.lookup('Delete 12 games?'), 'Supprimer 12 jeux ?');
  assert.equal(t.lookup('Delete 3 games from Roms?'), 'Supprimer 3 jeux de Roms ?', 'the longer pattern is tried first');
  assert.equal(t.lookup('1,074 games'), '1,074 jeux');
  assert.equal(t.lookup('Delete games?'), null);
});

test('i18n: characters that mean something in a pattern are taken literally', () => {
  const t = makeTranslator({ 'Done (1+1)? {n}.': 'Fait (1+1) ? {n}.' });
  assert.equal(t.lookup('Done (1+1)? 5.'), 'Fait (1+1) ? 5.');
  assert.equal(t.lookup('Done (1+1)x 5.'), null);
});

test('i18n: the browser language picks one of ours, else English', () => {
  assert.equal(browserLanguage(['fr-FR', 'en']), 'fr');
  assert.equal(browserLanguage(['zh-CN']), 'zh');
  assert.equal(browserLanguage(['zh-TW']), 'zh', 'Chinese in any form gets the Chinese file');
  assert.equal(browserLanguage(['ko-KR', 'fr']), 'fr', 'the first language of ours in the list wins');
  assert.equal(browserLanguage(['ko-KR']), 'en');
  assert.equal(browserLanguage([]), 'en');
});

test('i18n: every language has a file, valid JSON, and the Settings picker and the server agree on the codes', () => {
  for (const l of LANGS) {
    if (l.code === 'en') continue;
    const j = JSON.parse(read(`public/lang/${l.code}.json`));
    assert.equal(typeof j, 'object');
    for (const [k, v] of Object.entries(j)) { assert.equal(typeof k, 'string'); assert.equal(typeof v, 'string', `${l.code}: "${k}" must map to a string`); }
  }
  const server = read('src/app.js');
  assert.ok(server.includes("import { LANGS } from '../public/i18n.js'") && server.includes('...LANGS.map'), 'the server takes the accepted languages from the one list');
  for (const l of LANGS) {
    assert.ok(l.flag && fs.existsSync(new URL(`../public/flags/${l.flag}.svg`, import.meta.url)), `${l.code}: a flag picture`);
    assert.ok(fs.existsSync(new URL(`../site/flags/${l.flag}.svg`, import.meta.url)), `${l.code}: a flag picture for the website`);
    if (l.code !== 'en') assert.ok(fs.existsSync(new URL(`../site/${l.code}/index.html`, import.meta.url)), `${l.code}: a website page`);
  }
});

test('i18n: a pattern in a language file uses only the {names} its English key has', () => {
  for (const { code } of LANGS.filter((l) => l.code !== 'en')) {
    const j = JSON.parse(read(`public/lang/${code}.json`));
    for (const [en, tr] of Object.entries(j)) {
      const a = new Set([...en.matchAll(/\{([a-z0-9_]+)\}/gi)].map((m) => m[1])), b = [...tr.matchAll(/\{([a-z0-9_]+)\}/gi)].map((m) => m[1]);
      for (const n of b) assert.ok(a.has(n), `${code}: "${en}": the translation uses {${n}}, which the English does not`);
    }
  }
});

test('i18n: the code adds an "s" to make a plural; French and German make their own plural from it', () => {
  const fr = makeTranslator({ 'Delete {a} game{b}?': 'Supprimer {a} jeu{b} ?' }, 'fr');
  assert.equal(fr.lookup('Delete 3 games?'), 'Supprimer 3 jeux ?');
  assert.equal(fr.lookup('Delete 1 game?'), 'Supprimer 1 jeu ?');
  const de = makeTranslator({ '{a} game{b} and {c} file{d}': '{a} Spiel{b} und {c} Datei{d}' }, 'de');
  assert.equal(de.lookup('3 games and 2 files'), '3 Spiele und 2 Dateien');
  assert.equal(de.lookup('1 game and 1 file'), '1 Spiel und 1 Datei');
});
