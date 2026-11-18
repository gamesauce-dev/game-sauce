// Builds the website's other-language pages from site/index.html (the English page) and i18n/site.json.
//   node scripts/build-site-langs.mjs          writes site/<code>/index.html for every language in public/i18n.js, and refreshes the language menu of the English page
//   node scripts/build-site-langs.mjs --list   prints the English text of the page that i18n/site.json does not cover (for any language)
// i18n/site.json is { "English text or inner HTML": { "fr": "...", "zh": "..." } }. Edit the English page, run this, commit the result.
// The list of languages is the one in public/i18n.js (the app uses it too); each language also needs its flag in public/flags (copied to site/flags).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const { LANGS } = await import(pathToFileURL(path.join(root, 'public', 'i18n.js')).href);
const srcFile = path.join(root, 'site', 'index.html');
let src = fs.readFileSync(srcFile, 'utf8');
const dict = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'site.json'), 'utf8'));
const others = LANGS.filter((l) => l.code !== 'en');
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const missing = new Map();   // English text -> the languages that lack it

for (const l of LANGS) fs.copyFileSync(path.join(root, 'public', 'flags', l.flag + '.svg'), path.join(root, 'site', 'flags', l.flag + '.svg'));

const region = (html, name, body) => html.replace(new RegExp(`<!--${name}-->[\\s\\S]*?<!--/${name}-->`), () => `<!--${name}-->${body}<!--/${name}-->`);
const pathOf = (l) => (l.code === 'en' ? '/' : `/${l.code}/`);

/** The head links that tell search engines about every version, the language menu (the current language on top) and the list the browser-language redirect uses. */
function chrome(html, current) {
  let h = region(html, 'hreflang', '\n' + LANGS.map((l) => `<link rel="alternate" hreflang="${l.html}" href="https://gamesauce.app${pathOf(l)}">`).join('\n') + '\n<link rel="alternate" hreflang="x-default" href="https://gamesauce.app/">\n');
  const item = (l) => `<li><a href="${pathOf(l)}" hreflang="${l.html}" lang="${l.html}" data-lang="${l.code}"${l.code === current.code ? ' aria-current="true"' : ''}><img src="/flags/${l.flag}.svg" alt="" width="24" height="16"><span>${l.name}</span></a></li>`;
  h = region(h, 'langmenu', `<details class="langmenu"><summary aria-label="${esc((dict['Language'] || {})[current.code] || 'Language')}"><img src="/flags/${current.flag}.svg" alt="" width="24" height="16"><span>${current.name}</span></summary><ul>${LANGS.map(item).join('')}</ul></details>`);
  return h.replace(/\/\*langs\*\/[\s\S]*?\/\*\/langs\*\//, () => `/*langs*/${JSON.stringify(others.map((l) => l.code))}/*/langs*/`);
}

function translate(html, code) {
  const get = (key) => { const e = dict[norm(key)]; return e && e[code] ? e[code] : null; };
  const need = (key) => {
    const n = norm(key);
    if (!/[A-Za-z]{3}/.test(n.replace(/<[^>]*>/g, ''))) return;
    (missing.get(n) || missing.set(n, new Set()).get(n)).add(code);
  };
  // blocks (their inner HTML is the key), the outermost first so a link inside a paragraph travels with it
  let out = html.replace(/<(p|li|h1|h2|h3|figcaption|summary|a|title)\b([^>]*)>([\s\S]*?)<\/\1>/g, (all, tag, attrs, inner) => {
    if (/class="(brand|wordmark|foot-brand)"/.test(attrs) || /^\s*<(img|span)/.test(inner) || /data-lang=/.test(attrs) || /data-lang=|langmenu/.test(inner)) return all;
    if (!/[A-Za-z]{3}/.test(inner.replace(/<[^>]*>/g, ''))) return all;
    const t = get(inner); if (t === null) { need(inner); return all; }
    return `<${tag}${attrs}>${t}</${tag}>`;
  });
  // attributes people read: alt, aria-label, the description / social text and the coffee button's message
  out = out.replace(/\b(alt|aria-label)="([^"]*)"/g, (all, a, v) => { if (!/[A-Za-z]{3}/.test(v)) return all; const t = get(unesc(v)); if (t === null) { need(unesc(v)); return all; } return `${a}="${esc(t)}"`; });
  out = out.replace(/(<meta (?:name="description"|property="og:title"|property="og:description") content=")([^"]*)(")/g, (all, a, v, c) => { const t = get(unesc(v)); if (t === null) { need(unesc(v)); return all; } return a + esc(t) + c; });
  out = out.replace(/(data-description|data-message)="([^"]*)"/g, (all, a, v) => { const t = get(unesc(v)); if (t === null) { need(unesc(v)); return all; } return `${a}="${esc(t)}"`; });
  return out;
}

const list = process.argv.includes('--list');
const english = LANGS.find((l) => l.code === 'en');
if (!list) { src = chrome(src, english); fs.writeFileSync(srcFile, src); }
for (const l of others) {
  let html = translate(src, l.code);
  html = chrome(html, l);
  html = html.replace('<html lang="en">', `<html lang="${l.html}">`);
  html = html.replace('video/intro-en.mp4', `video/intro-${l.code}.mp4`);   // the intro film in this language
  // the page lives one folder down, so the files it shares with the English page are found one level up
  html = html.replace(/(href|src|poster)="(img|video|styles\.css)([^"]*)"/g, (all, a, d, rest) => `${a}="../${d}${rest}"`);
  html = html.replace('<link rel="canonical" href="https://gamesauce.app/">', `<link rel="canonical" href="https://gamesauce.app/${l.code}/">`);
  html = html.replace('<meta property="og:url" content="https://gamesauce.app/">', `<meta property="og:url" content="https://gamesauce.app/${l.code}/">`);
  if (!list) { fs.mkdirSync(path.join(root, 'site', l.code), { recursive: true }); fs.writeFileSync(path.join(root, 'site', l.code, 'index.html'), html); }
}
const lines = [...missing].filter(([k]) => !/^(GitHub|hello@gamesauce\.app)$/.test(k));
if (list) { console.log(lines.map(([k, v]) => `${[...v].join(',')}\t${k}`).join('\n')); console.log(`\n${lines.length} texts not covered`); }
else console.log(`site pages written for ${others.map((l) => l.code).join(', ')}. ${lines.length} English texts have no translation yet${lines.length ? ' (run with --list)' : ''}.`);
