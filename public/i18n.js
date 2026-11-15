// Translation layer. The app's text is written in English, in the page and in the code. A language file (public/lang/<code>.json) maps each English string to its translation,
// and a watcher swaps the text of the page, and its hover text, placeholders and labels, as it appears: new screens, pop-up messages and menus are translated without wrapping
// each string in a function. English is the fallback: anything the file does not know stays as written.
//   - A string with a {name} in it is a pattern: "Delete {n} games" matches "Delete 12 games" and fills the translation's {n} with 12.
//   - Text inside an element marked translate="no" (or class notranslate), a script, a style or a text box is left alone.
// The language is the one the person chose in Settings (kept on this device and, once signed in, with the account), else the one the browser asks for.

// The languages we have, in the order they are listed. `flag` is the picture in public/flags (a flag is only a picture beside the name: the name is what counts), `html` the lang attribute.
// Adding a language: a line here, public/lang/<code>.json, a flag, and `node scripts/build-site-langs.mjs` for the website. The server and the tests read this list.
export const LANGS = [
  { code: 'en', name: 'English', flag: 'gb', html: 'en' },
  { code: 'fr', name: 'Français', flag: 'fr', html: 'fr' },
  { code: 'zh', name: '简体中文', flag: 'cn', html: 'zh-Hans' }
];
const KEY = 'gamesauce_lang';          // 'auto' (or nothing) follows the browser
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt', 'data-tip'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'CODE', 'PRE']);
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const hasLetters = (s) => /[A-Za-zÀ-ɏ]/.test(s);

/** A translator for one language file: { lookup(text) } returns the translation, or null when there is none. Pure, so it can be tested. */
export function makeTranslator(strings = {}, lang = '') {
  const words = new Map(), patterns = [];
  for (const [en, tr] of Object.entries(strings)) {
    if (typeof tr !== 'string' || !tr) continue;
    const key = norm(en);
    if (/\{[a-z0-9_]+\}/i.test(key)) {
      const names = [];
      const src = key.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{([a-z0-9_]+)\}/gi, (_, n) => { names.push(n); return '(.+?)'; });
      patterns.push({ re: new RegExp('^' + src + '$'), names, tr });
    } else words.set(key, tr);
  }
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);   // the longest (most specific) pattern first
  const fix = lang === 'fr' ? (x) => x.replace(/\bjeus\b/g, 'jeux') : (x) => x;   // the code adds an "s" to make a plural: jeu + s is jeux in French
  return {
    size: words.size + patterns.length,
    lookup(text) {
      const n = norm(text);
      if (!n) return null;
      const w = words.get(n);
      if (w !== undefined) return fix(w);
      for (const p of patterns) {
        const m = p.re.exec(n);
        if (m) return fix(p.tr.replace(/\{([a-z0-9_]+)\}/gi, (all, name) => { const i = p.names.indexOf(name); return i >= 0 ? m[i + 1] : all; }));
      }
      return null;
    }
  };
}

/** The language the browser asks for, as one of ours ('en' when none of ours is wanted). */
export function browserLanguage(list = (typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : [])) {
  for (const l of list) {
    const c = String(l || '').toLowerCase().slice(0, 2);
    if (LANGS.some((x) => x.code === c)) return c;
  }
  return 'en';
}

let active = 'en', tr = null, obs = null, debug = false;
const seen = new Map();   // dev language only: every string met that no language file covers, for the harvest tool

export const currentLanguage = () => active;
/** What the person chose: 'auto', or a language code. */
export function chosenLanguage() { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } }
/** Choose a language ('auto' follows the browser) and start again in it. */
export function setLanguage(code, { reload = true } = {}) {
  try { if (code === 'auto' || !code) localStorage.removeItem(KEY); else localStorage.setItem(KEY, code); } catch { /* not kept on this device */ }
  if (reload) location.reload();
}
/** Translate a string from code (for text put together in JS before it is shown). */
export function t(text, vars) {
  let out = (tr && tr.lookup(text)) ?? String(text);
  if (vars) out = out.replace(/\{([a-z0-9_]+)\}/gi, (all, n) => (vars[n] ?? all));
  return out;
}

const lead = (s) => /^\s*/.exec(s)[0], trail = (s) => /\s*$/.exec(s)[0];
function note(s) { const n = norm(s); if (n.length >= 2 && hasLetters(n)) seen.set(n, (seen.get(n) || 0) + 1); }
function fixText(node) {
  const v = node.nodeValue;
  if (!v || !hasLetters(v)) return;
  if (debug) { note(v); return; }
  const out = tr.lookup(v);
  if (out !== null && out !== norm(v)) node.nodeValue = lead(v) + out + trail(v);
}
function fixAttrs(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute?.(a);
    if (!v || !hasLetters(v)) continue;
    if (debug) { note(v); continue; }
    const out = tr.lookup(v);
    if (out !== null && out !== norm(v)) el.setAttribute(a, out);
  }
  if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type || '')) {
    const v = el.getAttribute('value');
    if (v && hasLetters(v)) { if (debug) note(v); else { const out = tr.lookup(v); if (out !== null) el.setAttribute('value', out); } }
  }
}
const skipped = (el) => !el || SKIP.has(el.tagName) || el.isContentEditable || el.getAttribute?.('translate') === 'no' || el.classList?.contains('notranslate');
function walk(root) {
  if (!root) return;
  if (root.nodeType === 3) { if (!skipped(root.parentElement)) fixText(root); return; }
  if (root.nodeType !== 1 || skipped(root)) return;
  fixAttrs(root);
  for (let n = root.firstChild; n; n = n.nextSibling) walk(n);
}

/** Start: pick the language, load its file, translate the page and keep translating what appears. Safe to call once, early. */
export async function initI18n() {
  const chosen = chosenLanguage();
  debug = chosen === 'dev';
  active = debug ? 'dev' : (chosen === 'auto' ? browserLanguage() : (LANGS.some((x) => x.code === chosen) ? chosen : 'en'));
  if (typeof document === 'undefined') return;
  document.documentElement.lang = debug ? 'en' : active;
  if (debug) { window.__i18nSeen = seen; tr = makeTranslator({}); }
  else if (active === 'en') return;
  else {
    try {
      const res = await fetch(`/lang/${active}.json`, { cache: 'no-cache' });
      tr = makeTranslator(res.ok ? await res.json() : {}, active);
    } catch { tr = makeTranslator({}); }
  }
  walk(document.documentElement);
  let queue = new Set(), timer = 0;
  const flush = () => {
    timer = 0; const q = queue; queue = new Set();
    for (const item of q) { if (item.isConnected !== false) walk(item); }
  };
  obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach((n) => queue.add(n));
      else if (m.type === 'characterData') queue.add(m.target);
      else if (m.type === 'attributes') queue.add(m.target);
    }
    if (!timer) timer = setTimeout(flush, 0);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
