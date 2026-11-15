// Builds the French and Chinese pages of the website from site/index.html (the English page) and i18n/site.json.
//   node scripts/build-site-langs.mjs          writes site/fr/index.html and site/zh/index.html
//   node scripts/build-site-langs.mjs --list   prints the English text of the page that i18n/site.json does not cover
// i18n/site.json is { "English text or inner HTML": ["French", "Chinese"] }. Edit the English page, run this, commit the result.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const src = fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8');
const dict = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'site.json'), 'utf8'));
const LANGS = [['fr', 0, 'Français'], ['zh', 1, '简体中文']];
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const missing = new Set();

function translate(html, idx) {
  const get = (key) => { const e = dict[norm(key)]; return e && e[idx] ? e[idx] : null; };
  const need = (key) => { const n = norm(key); if (/[A-Za-z]{3}/.test(n.replace(/<[^>]*>/g, '')) && !dict[n]) missing.add(n); };
  // blocks (their inner HTML is the key), the outermost first so a link inside a paragraph travels with it
  let out = html.replace(/<(p|li|h1|h2|h3|figcaption|summary|a|title)\b([^>]*)>([\s\S]*?)<\/\1>/g, (all, tag, attrs, inner) => {
    if (/class="(brand|wordmark|foot-brand)"/.test(attrs) || /^\s*<(img|span)/.test(inner)) return all;
    if (!/[A-Za-z]{3}/.test(inner.replace(/<[^>]*>/g, ''))) return all;
    const t = get(inner); if (t === null) { need(inner); return all; }
    return `<${tag}${attrs}>${t}</${tag}>`;
  });
  // attributes people read: alt, aria-label and the description / social text
  out = out.replace(/\b(alt|aria-label)="([^"]*)"/g, (all, a, v) => { if (!/[A-Za-z]{3}/.test(v)) return all; const t = get(unesc(v)); if (t === null) { need(unesc(v)); return all; } return `${a}="${esc(t)}"`; });
  out = out.replace(/(<meta (?:name="description"|property="og:title"|property="og:description") content=")([^"]*)(")/g, (all, a, v, c) => { const t = get(unesc(v)); if (t === null) { need(unesc(v)); return all; } return a + esc(t) + c; });
  return out;
}

const list = process.argv.includes('--list');
for (const [code, idx, label] of LANGS) {
  let html = translate(src, idx);
  html = html.replace('<html lang="en">', `<html lang="${code === 'zh' ? 'zh-Hans' : code}">`);
  // the page lives one folder down, so the files it shares with the English page are found one level up
  html = html.replace(/(href|src|poster)="(img|video|styles\.css)([^"]*)"/g, (all, a, d, rest) => `${a}="../${d}${rest}"`);
  html = html.replace(/href="#top"/g, 'href="#top"');
  html = html.replace('<link rel="canonical" href="https://gamesauce.app/">', `<link rel="canonical" href="https://gamesauce.app/${code}/">`);
  html = html.replace('<meta property="og:url" content="https://gamesauce.app/">', `<meta property="og:url" content="https://gamesauce.app/${code}/">`);
  if (!list) { fs.mkdirSync(path.join(root, 'site', code), { recursive: true }); fs.writeFileSync(path.join(root, 'site', code, 'index.html'), html); }
}
if (list) { console.log([...missing].join('\n')); console.log(`\n${missing.size} texts not covered`); }
else console.log(`site/fr and site/zh written. ${missing.size} English texts have no translation yet${missing.size ? ' (run with --list)' : ''}.`);
