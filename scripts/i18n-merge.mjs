// Adds a batch of translations to public/lang/<code>.json.   node scripts/i18n-merge.mjs path/to/batch.json
// A batch is { "<position in i18n/strings.snapshot.json>": { "es": "Spanish", "de": "German" }, ... }  (an older batch may be ["French", "Chinese"], read as fr and zh).
// The English comes from the snapshot, so it is never retyped.
// A translation may leave a {name} out (Chinese has no plural "s") but may not invent one; anything that breaks that is reported and skipped.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'strings.snapshot.json'), 'utf8')));
const batch = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const legacy = ['fr', 'zh'];
const dict = {}, files = {};
const load = (l) => {
  if (dict[l]) return dict[l];
  files[l] = path.join(root, 'public', 'lang', l + '.json');
  dict[l] = fs.existsSync(files[l]) ? JSON.parse(fs.readFileSync(files[l], 'utf8')) : {};
  return dict[l];
};
const names = (s) => new Set([...String(s).matchAll(/\{([a-z0-9_]+)\}/gi)].map((m) => m[1]));
let added = 0, bad = 0;
for (const [idx, entry] of Object.entries(batch)) {
  const en = keys[Number(idx)];
  if (en === undefined) { console.log(`#${idx}: no such position`); bad++; continue; }
  const byLang = Array.isArray(entry) ? Object.fromEntries(entry.map((v, i) => [legacy[i], v])) : entry;
  for (const [l, tr] of Object.entries(byLang || {})) {
    if (typeof tr !== 'string' || !tr) continue;
    const have = names(en), used = names(tr);
    const extra = [...used].filter((n) => !have.has(n));
    if (extra.length) { console.log(`#${idx} ${l}: uses {${extra.join('}, {')}} which the English does not have: skipped`); bad++; continue; }
    load(l)[en] = tr; added++;
  }
}
for (const l of Object.keys(dict)) fs.writeFileSync(files[l], JSON.stringify(Object.fromEntries(Object.entries(dict[l]).sort((a, b) => a[0].localeCompare(b[0]))), null, 1) + '\n');
console.log(`${added} translations added, ${bad} problems. ` + Object.keys(dict).map((l) => `${l}: ${Object.keys(dict[l]).length}`).join(', '));
