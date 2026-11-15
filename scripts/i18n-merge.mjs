// Adds a batch of translations to public/lang/fr.json and zh.json.   node scripts/i18n-merge.mjs path/to/batch.json
// A batch is { "<position in i18n/strings.snapshot.json>": ["French", "Chinese"], ... }. The English comes from the snapshot, so it is never retyped.
// A translation may leave a {name} out (Chinese has no plural "s") but may not invent one; anything that breaks that is reported and skipped.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'strings.snapshot.json'), 'utf8')));
const batchFile = process.argv[2];
const batch = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
const langs = ['fr', 'zh'];
const files = Object.fromEntries(langs.map((l) => [l, path.join(root, 'public', 'lang', l + '.json')]));
const dict = Object.fromEntries(langs.map((l) => [l, JSON.parse(fs.readFileSync(files[l], 'utf8'))]));
const names = (s) => new Set([...String(s).matchAll(/\{([a-z0-9_]+)\}/gi)].map((m) => m[1]));
let added = 0, bad = 0;
for (const [idx, pair] of Object.entries(batch)) {
  const en = keys[Number(idx)];
  if (en === undefined) { console.log(`#${idx}: no such position`); bad++; continue; }
  if (!Array.isArray(pair)) continue;
  langs.forEach((l, i) => {
    const tr = pair[i];
    if (typeof tr !== 'string' || !tr) return;
    const have = names(en), used = names(tr);
    const extra = [...used].filter((n) => !have.has(n));
    if (extra.length) { console.log(`#${idx} ${l}: uses {${extra.join('}, {')}} which the English does not have: skipped`); bad++; return; }
    dict[l][en] = tr; added++;
  });
}
for (const l of langs) fs.writeFileSync(files[l], JSON.stringify(Object.fromEntries(Object.entries(dict[l]).sort((a, b) => a[0].localeCompare(b[0]))), null, 1) + '\n');
console.log(`${added} translations added, ${bad} problems. fr: ${Object.keys(dict.fr).length}, zh: ${Object.keys(dict.zh).length}`);
