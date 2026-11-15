// Finds the English text a person can see in the app's source, for translation. Output: i18n/strings.json, { "English text": { files: n } }.
//   node scripts/i18n-scan.mjs            writes i18n/strings.json and prints a summary
//   node scripts/i18n-scan.mjs --missing fr   lists what public/lang/fr.json does not cover yet
// It reads: public/index.html and public/*.js (page text, hover text, labels, pop-up messages), and the server's error messages (src/**/*.js: error: '...').
// A ${...} inside text becomes {a}, {b}... in order, so "Delete ${n} games?" is the pattern "Delete {a} games?" (the same pattern the page's translator matches).
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const out = {};
const add = (text, file) => {
  let s = String(text).replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || s.length < 2 || s.length > 400) return;
  if (!/[A-Za-z]{2}/.test(s.replace(/\{[a-z]+\}/g, ''))) return;                    // needs real words, not only numbers and placeholders
  if (/^[a-z][a-z0-9_.-]*$/.test(s) || /^[A-Za-z]+(?:[A-Z][a-z0-9]+)+$/.test(s)) return;   // an identifier, a class name or camelCase
  if (/^(https?:|\/|#|\.|data:|rgba?\(|var\(|[a-z-]+:\s)/.test(s) || /[{};]\s*$/.test(s) || /=>|function\s*\(|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bCREATE TABLE\b/.test(s)) return;
  if (/^[A-Z0-9_]+$/.test(s) && s.length > 4) return;                                // a CONSTANT
  if (/^<|>$/.test(s) || /[<>]/.test(s)) return;
  if (/^\[|^\(\{|^\((hover|max-width|prefers)|data-|\.plat-logo|#settings|^Aa$|^[A-Z0-9]{2,4}$/.test(s)) return;   // selectors, media queries, short acronyms
  if (/^[\W_]*$/.test(s)) return;                                                      // only symbols
  if (/^[W_]*$/.test(s)) return;
  (out[s] ||= { files: new Set() }).files.add(file);
};

/** Read the string literals of a JS file. Calls cb(kind, text, prev) with kind 'str' or 'tpl'; a template's ${...} becomes {a}, {b}... */
function literals(src, cb) {
  let i = 0; const n = src.length;
  const prevCtx = (at) => src.slice(Math.max(0, at - 40), at);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1, text = '';
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { text += src[j + 1] === 'n' ? ' ' : src[j + 1]; j += 2; } else text += src[j++]; }
      cb('str', text, prevCtx(i)); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1, text = '', k = 0; const names = 'abcdefghijklmnopqrstuvwxyz';
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { text += src[j + 1] === 'n' ? ' ' : src[j + 1]; j += 2; }
        else if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1; j += 2; const start = j;
          while (j < n && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; else if (src[j] === '`') { const e = src.indexOf('`', j + 1); j = e < 0 ? n : e; } j++; }
          const inner = src.slice(start, j - 1);
          text += `{${names[k++ % 26]}}`;                                       // a value goes here (the inner expression is ignored)
          void inner;
        } else text += src[j++];
      }
      cb('tpl', text, prevCtx(i)); i = j + 1; continue;
    }
    i++;
  }
}

/** The text of an HTML string (a page or a template literal): text between tags, and text in hover and label attributes. */
function html(text, file) {
  for (const m of text.matchAll(/>([^<>]+)</g)) add(m[1], file);
  for (const m of text.matchAll(/\s(?:title|placeholder|aria-label|alt|data-tip)="([^"]+)"/g)) add(m[1], file);
}

const files = [];
const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (!['node_modules', 'lang', 'modern', 'vendor'].includes(e.name)) walk(p); } else files.push(p); } };
walk(path.join(root, 'public')); walk(path.join(root, 'src'));

for (const f of files) {
  const rel = path.relative(root, f).replace(/\\/g, '/');
  const src = fs.readFileSync(f, 'utf8');
  if (/\.html$/.test(f)) { html(src.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, ''), rel); continue; }
  if (!/\.js$/.test(f) || /i18n\.js$|\.min\.js$|neon-bg\.js$|pdf/.test(f)) continue;
  const inSrc = rel.startsWith('src/');
  literals(src, (kind, text, prev) => {
    if (/[<>]/.test(text) && kind === 'tpl') { html(text, rel); return; }          // markup built in code
    if (/[<>]/.test(text) && kind === 'str') { html(text, rel); return; }
    const ctx = /(?:toast\(|title:\s*|body:\s*|okLabel:\s*|checkLabel:\s*|label:\s*|error:\s*|message:\s*|text:\s*|placeholder:\s*|hint:\s*|note:\s*|new Error\(|say\(|alert\(|confirm\()$/.test(prev);
    if (inSrc) { if (/error:\s*$|new Error\(\s*$|message:\s*$/.test(prev)) add(text, rel); return; }   // the server: only what it sends back as a message
    const words = text.trim().split(/\s+/).length;
    if (ctx || words >= 2) add(text, rel);
  });
}

const sorted = Object.fromEntries(Object.entries(out).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, { files: v.files.size }]));
const missingLang = process.argv.includes('--missing') ? process.argv[process.argv.indexOf('--missing') + 1] : null;
if (missingLang) {
  const dict = JSON.parse(fs.readFileSync(path.join(root, 'public', 'lang', missingLang + '.json'), 'utf8'));
  const have = new Set(Object.keys(dict).map((k) => k.replace(/\s+/g, ' ').trim()));
  const missing = Object.keys(sorted).filter((k) => !have.has(k));
  console.log(`${missing.length} of ${Object.keys(sorted).length} strings are not in ${missingLang}.json`);
  if (process.argv.includes('--list')) console.log(missing.join('\n'));
} else {
  fs.mkdirSync(path.join(root, 'i18n'), { recursive: true });
  fs.writeFileSync(path.join(root, 'i18n', 'strings.json'), JSON.stringify(sorted, null, 1));
  console.log(`${Object.keys(sorted).length} strings found in ${files.length} files -> i18n/strings.json`);
}
