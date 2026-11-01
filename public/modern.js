// "Modern" interface, a second front end on the same library and the same server. It does not replace anything: Classic is
// still the default and is untouched. This file adds an icon-driven top bar, a Home page (ticker, Continue playing, Recently
// added) and light/dark, all switched on by the body class `ui-modern`. The choice is stored per person (prefs: ui_mode).
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ICON_BASE = '/modern/icons/';
const cache = new Map();

/** An icon from the user's SVG set, inlined so it takes the text colour (currentColor) and can be tinted by state. */
export async function icon(name) {
  if (cache.has(name)) return cache.get(name);
  const p = fetch(`${ICON_BASE}${name}.svg`).then((r) => (r.ok ? r.text() : '')).then((t) => t.replace(/<svg /, '<svg class="mi" aria-hidden="true" ').replace(/\s+/g, ' ')).catch(() => '');
  cache.set(name, p);
  return p;
}

const NAV = [
  { view: 'home', icon: 'home', label: 'Home' },
  { view: 'library', icon: 'Library', label: 'Library' },
  { view: 'collections', icon: 'collection', label: 'Collections' },
  { view: 'sources', icon: 'sources', label: 'Sources', admin: true },
  { view: 'upload', icon: 'add-roms', label: 'Add ROMs', admin: true },
  { view: 'emulators', icon: 'emulators', label: 'Emulators' },
  { view: 'settings', icon: 'settings', label: 'Settings' }
];

let api = null, ctx = null, built = false, building = null, tickerTimer = null;
export const isModern = () => document.body.classList.contains('ui-modern');

/** Called once by app.js with the few things Modern needs from it (the API helper and navigation). */
export function initModern(c) { ctx = c; api = c.api; }

/* ───────────── light / dark ───────────── */
export function applyTheme(mode) {
  const m = mode === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = isModern() ? m : 'dark';
  try { localStorage.setItem('gamesauce_theme', m); } catch { /* private mode */ }
  paintToggles();
}
const theme = () => { try { return localStorage.getItem('gamesauce_theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } };

/* ───────────── the bar ───────────── */
// Built once. Two callers can ask at nearly the same moment (sign-in and the look switch), and a second build would attach a
// second click handler, so every button would run twice and undo itself.
function buildBar() { return building || (building = doBuildBar()); }
async function doBuildBar() {
  const bar = $('#modern-bar'); if (!bar) return;
  const ic = Object.fromEntries(await Promise.all(['home', 'Library', 'collection', 'sources', 'add-roms', 'emulators', 'settings', 'light-mode', 'dark-mode', 'gui-toggle', 'sign-out'].map(async (n) => [n, await icon(n)])));
  const isAdmin = ctx.user()?.role === 'admin';
  const playOnly = Boolean(ctx.user()?.play_only);
  const items = NAV.filter((n) => (!n.admin || isAdmin) && !(playOnly && ['collections', 'sources', 'upload', 'emulators'].includes(n.view)));
  bar.innerHTML = `
    <div class="mb-id">
      <a class="mb-brand" href="#" data-mview="home" title="Home"><img src="/logo.svg" alt="game-sauce" /><span class="mb-name">game<b>-sauce</b></span></a>
      <div class="mb-user"><span class="mb-avatar" id="mb-avatar"></span><span class="mb-uname" id="mb-uname"></span>
        <button class="mb-btn" id="mb-signout" title="Sign out" aria-label="Sign out">${ic['sign-out']}</button></div>
    </div>
    <nav class="mb-nav" aria-label="Main">${items.map((n) => `<button class="mb-btn mb-navbtn" data-mview="${n.view}" title="${n.label}" aria-label="${n.label}">${ic[n.icon] || n.label}</button>`).join('')}</nav>
    <div class="mb-slot" id="mb-slot">
      <div class="mh-ticker" id="mh-ticker" aria-live="polite"><div class="mh-track" id="mh-track"></div></div>
      <div class="mb-library-tools" id="mb-library-tools"></div>
    </div>
    <div class="mb-right">
      <button class="mb-btn" id="mb-theme" title="" aria-label="Light or dark">${ic['dark-mode']}${ic['light-mode']}</button>
      <button class="mb-btn mb-gui is-on" id="mb-gui" title="Modern look (click for Classic)" aria-label="Switch look" aria-pressed="true">${ic['gui-toggle']}<small>Modern</small></button>
    </div>`;
  built = true;
  paintUser();
  refreshTicker(true);
  setInterval(() => { if (isModern()) refreshTicker(true); }, 60000);
  bar.addEventListener('click', onBarClick);
  paintToggles();
}

function paintUser() {
  const u = ctx.user(); if (!u) return;
  const label = u.display_name || u.username;
  const name = $('#mb-uname'); if (name) name.textContent = label;
  const av = $('#mb-avatar'); if (av) { av.id = 'mb-avatar'; ctx.paintAvatar(av, u.id, label, u.avatar_v); }
}

function paintToggles() {
  const t = $('#mb-theme'); if (t) { const light = theme() === 'light'; t.dataset.mode = light ? 'light' : 'dark'; t.title = light ? 'Light (click for dark)' : 'Dark (click for light)'; }
  const g = $('#mb-gui'); if (g) { g.classList.toggle('is-on', isModern()); g.setAttribute('aria-pressed', String(isModern())); g.title = isModern() ? 'Modern look (click for Classic)' : 'Classic look (click for Modern)'; }
}

function onBarClick(e) {
  // Only the bar's own buttons: <body> also carries data-mview (the current page), and closest() would find it for every click.
  const nav = e.target.closest('[data-mview]');
  if (nav && e.currentTarget.contains(nav)) { e.preventDefault(); go(nav.dataset.mview); return; }
  if (e.target.closest('#mb-theme')) { applyTheme(theme() === 'light' ? 'dark' : 'light'); return; }
  if (e.target.closest('#mb-gui')) { setUiMode('classic'); return; }
  if (e.target.closest('#mb-signout')) $('#logout')?.click();
}

/* ───────────── pages ───────────── */
let current = 'home';
export function go(view) {
  if (!isModern()) return;
  current = view;
  refreshTicker();
  document.body.dataset.mview = view;
  $$('.mb-navbtn').forEach((b) => b.classList.toggle('is-on', b.dataset.mview === view));
  if (view === 'home') { showHome(); return; }
  hideHome();
  ctx.setView(view);
}
export const currentView = () => current;

function showHome() {
  ctx.setView('library');           // keeps the library data and state in one place
  document.body.dataset.mview = 'home';
  $('#modern-home')?.classList.remove('hidden');
  renderHome();
}
function hideHome() { $('#modern-home')?.classList.add('hidden'); }

/** Home: the ticker, Continue playing and Recently added. The game grid is cleared (Library shows it). */
async function renderHome() {
  const host = $('#modern-home'); if (!host) return;
  host.innerHTML = `
    <div class="strips mh-strips">
      <div class="strip" data-strip="played"><button type="button" class="strip-head" data-strip-toggle="played" aria-expanded="true" title="Show or hide this row"><span class="strip-caret">▾</span><span class="section-label" style="margin:0">Continue playing</span></button><div class="recent-row" id="mh-played"></div></div>
      <div class="strip" data-strip="recent"><button type="button" class="strip-head" data-strip-toggle="recent" aria-expanded="true" title="Show or hide this row"><span class="strip-caret">▾</span><span class="section-label" style="margin:0">Recently added</span></button><div class="recent-row" id="mh-recent"></div></div>
    </div>`;
  ctx.applyStrips?.(host, false);
  try {
    const [stats, played] = await Promise.all([api('/stats'), api('/roms/recently-played?limit=14').catch(() => ({ items: [] }))]);
    fillRow('#mh-recent', stats.recent || []);
    fillRow('#mh-played', played.items || [], 'Nothing played yet');
  } catch { /* the home page degrades to empty rows */ }
}

function fillRow(sel, items, empty = '') {
  const el = $(sel); if (!el) return;
  if (!items.length) { el.innerHTML = empty ? `<div class="side-empty" style="grid-column:1/-1">${empty}</div>` : ''; return; }
  // The same tiles as the library grid (cover, platform badge, play button), so they behave the same.
  el.innerHTML = items.slice(0, 16).map(ctx.cardHtml).join('');
  ctx.bindCards(el);
}

/** Fetch what the ticker says (cheap: it reuses /stats). It sits in the bar on every page except Library, where the library tools take its place. */
let lastTicker = 0;
async function refreshTicker(force = false) {
  if (!force && Date.now() - lastTicker < 20000) return;
  lastTicker = Date.now();
  try { await fillTicker(await api('/stats')); } catch { /* the bar just stays without a ticker */ }
}

/** The ticker: one line at a time, rolling upwards. Synopsis facts plus anything the system wants to say. */
async function fillTicker(stats) {
  const lib = stats.library || {};
  const lines = [];
  const top = stats.topDownloaded;
  lines.push(`<b>${Number(lib.roms || 0).toLocaleString()}</b> games across <b>${lib.platforms || 0}</b> platforms`);
  if (stats.mine) lines.push(`<b>${stats.mine.favorites || 0}</b> in your favourites`);
  if (top) lines.push(`Most downloaded: <b>${String(top.title || '').replace(/</g, '&lt;')}</b>`);
  try {
    const u = await api('/emulators/updates').catch(() => ({ updates: [] }));
    if ((u.updates || []).length) lines.push(`<b>${u.updates.length}</b> emulator update${u.updates.length === 1 ? '' : 's'} available`);
  } catch { /* optional */ }
  try {
    if (ctx.user()?.role === 'admin') {
      const j = await api('/roms/bulk/enrich-job').catch(() => null);
      if (j?.running) lines.unshift(`Fetching metadata: <b>${j.done}</b> of <b>${j.total}</b>`);
      const h = await api('/admin/health').catch(() => null);
      if (h && h.status && h.status !== 'ok') lines.unshift(`System health: <b>${h.status === 'bad' ? 'needs attention' : 'has warnings'}</b>`);
    }
  } catch { /* optional */ }
  const track = $('#mh-track'); if (!track) return;
  track.innerHTML = lines.map((l) => `<div class="mh-line">${l}</div>`).join('');
  clearInterval(tickerTimer);
  const rows = $$('.mh-line', track);
  if (rows.length > 1) {
    let i = 0;
    tickerTimer = setInterval(() => { i = (i + 1) % rows.length; track.style.transform = `translateY(-${i * rows[0].offsetHeight}px)`; }, 3500);
  }
}

/* ───────────── switching look ───────────── */
export async function setUiMode(mode) {
  const next = mode === 'modern' ? 'modern' : 'classic';
  try { await api('/prefs/ui_mode', { method: 'PUT', body: JSON.stringify({ value: next }) }); } catch { /* still switch for this session */ }
  ctx.setPref?.('ui_mode', next);
  await applyMode(next, { fresh: true });
}

/** Turn the look on or off for the signed-in person. */
export async function applyMode(mode, { fresh = false } = {}) {
  const on = mode === 'modern';
  document.body.classList.toggle('ui-modern', on);
  document.documentElement.dataset.theme = on ? theme() : 'dark';
  if (on) {
    await buildBar(); paintUser();
    paintToggles();
    go(fresh || current === 'library' && false ? 'home' : (ctx.state().view === 'library' ? (current === 'home' ? 'home' : 'library') : ctx.state().view));
  } else {
    hideHome();
    delete document.body.dataset.mview;
    ctx.setView(ctx.state().view === 'home' ? 'library' : ctx.state().view);
  }
}
