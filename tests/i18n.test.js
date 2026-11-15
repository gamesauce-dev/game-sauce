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
  assert.equal(browserLanguage(['de-DE', 'fr']), 'fr', 'the first language of ours in the list wins');
  assert.equal(browserLanguage(['de-DE']), 'en');
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
  for (const l of LANGS) assert.ok(server.includes(`'${l.code}'`), l.code);
});

test('i18n: a pattern in a language file uses only the {names} its English key has', () => {
  for (const code of ['fr', 'zh']) {
    const j = JSON.parse(read(`public/lang/${code}.json`));
    for (const [en, tr] of Object.entries(j)) {
      const a = new Set([...en.matchAll(/\{([a-z0-9_]+)\}/gi)].map((m) => m[1])), b = [...tr.matchAll(/\{([a-z0-9_]+)\}/gi)].map((m) => m[1]);
      for (const n of b) assert.ok(a.has(n), `${code}: "${en}": the translation uses {${n}}, which the English does not`);
    }
  }
});
