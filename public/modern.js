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
  { view: 'library', icon: 'Library', label: 'ROM Library' },
  { view: 'digital', icon: 'digital-library', label: 'Digital Library' },
  { view: 'physical', icon: 'physical-shelf', label: 'Physical Library' },
  { view: 'collections', icon: 'collection-new', label: 'Collections' },
  { view: 'sources', icon: 'sources', label: 'Sources', admin: true },
  { view: 'upload', icon: 'add-roms', label: 'Add ROMs', admin: true },
  { view: 'emulators', icon: 'emulators-2', label: 'Emulators' },
  { view: 'messages', icon: 'messages', label: 'Messages' },
  { view: 'settings', icon: 'settings', label: 'Settings' }
];

let api = null, ctx = null, built = false, building = null, tickerTimer = null;
export const isModern = () => document.body.classList.contains('ui-modern');

/** Called once by app.js with the few things Modern needs from it (the API helper and navigation). */
export function initModern(c) { ctx = c; api = c.api; window.addEventListener('gs:filters', () => { if (isModern()) { syncTools(); renderChips(); } }); }

/* ───────────── light / dark ───────────── */
export function applyTheme(mode) {
  const m = mode === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = isModern() ? m : 'dark';
  try { localStorage.setItem('gamesauce_theme', m); } catch { /* private mode */ }
  paintToggles();
}
/* ───────────── retro monospace font (a per-device switch in the avatar menu) ───────────── */
// On unless the person turned it off ('0'): the retro look is the default.
const retro = () => { try { return localStorage.getItem('gamesauce_retro') !== '0'; } catch { return true; } };
export function applyRetro(on) {
  document.body.classList.toggle('ui-retro', Boolean(on) && isModern());
  try { localStorage.setItem('gamesauce_retro', on ? '1' : '0'); } catch { /* private mode */ }
  const b = $('#mb-retro'); if (b) { b.setAttribute('aria-checked', String(Boolean(on))); b.classList.toggle('on', Boolean(on)); }
}
/* ───────────── deeper black (a per-device switch in the avatar menu; dark mode only) ───────────── */
const deep = () => { try { return localStorage.getItem('gamesauce_deep') === '1'; } catch { return false; } };
export function applyDeep(on) {
  document.body.classList.toggle('ui-deep', Boolean(on) && isModern());
  try { localStorage.setItem('gamesauce_deep', on ? '1' : '0'); } catch { /* private mode */ }
  const b = $('#mb-deep'); if (b) { b.setAttribute('aria-checked', String(Boolean(on))); b.classList.toggle('on', Boolean(on)); }
}
const theme = () => { try { return localStorage.getItem('gamesauce_theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } };

/* ───────────── the bar ───────────── */
// Built once. Two callers can ask at nearly the same moment (sign-in and the look switch), and a second build would attach a
// second click handler, so every button would run twice and undo itself.
let builtFor = null;   // 'id:role:playonly' the bar on screen was built for
const whoKey = () => { const u = ctx?.user?.(); return u ? `${u.id}:${u.role}:${u.play_only ? 1 : 0}` : ''; };
function buildBar() {
  const key = whoKey();
  if (building && builtFor === key) return building;
  // A different person (or the same person with a changed role or screen): build their bar from scratch, and forget the last one's state.
  builtFor = key;
  document.body.classList.remove('mb-tools');
  for (const id of ['mb-menu']) $('#' + id)?.classList.add('hidden');
  return (building = doBuildBar());
}
async function doBuildBar() {
  const bar = $('#modern-bar'); if (!bar) return;
  const ic = Object.fromEntries(await Promise.all(['home', 'Library', 'collection-new', 'sources', 'add-roms', 'digital-library', 'physical-shelf', 'emulators-2', 'messages', 'settings', 'light-mode', 'dark-mode', 'gui-toggle', 'sign-out', 'my-account', 'search', 'sort', 'favourite', 'hidden', 'visible', 'select-2', 'no-covers-2', 'fetch-metadata-3', '3-dot-spinner', 'more-actions', 'system', 'orphans', 'issue', 'lock', 'clear-reset-2', 'filter', 'grid', 'grid-condensed', 'back-to-top', 'pin'].map(async (n) => [n, await icon(n)])));
  const isAdmin = ctx.user()?.role === 'admin';
  const playOnly = Boolean(ctx.user()?.play_only);
  const items = NAV.filter((n) => (!n.admin || isAdmin) && !(playOnly && ['collections', 'sources', 'upload', 'emulators', 'digital', 'physical'].includes(n.view)));
  bar.innerHTML = `
    <a class="mb-brand" href="#" data-mview="home" title="game-sauce: Home" aria-label="game-sauce, Home"><img src="/logo.svg" alt="" width="40" height="40" /></a>
    <nav class="mb-nav" aria-label="Main">${items.map((n) => `<button class="mb-btn mb-navbtn" data-mview="${n.view}" title="${n.label}" aria-label="${n.label}">${ic[n.icon] || n.label}</button>`).join('')}</nav>
    <div class="mb-slot" id="mb-slot">
      <div class="mh-ticker" id="mh-ticker" aria-live="polite"><div class="mh-track" id="mh-track"></div></div>
      <div class="mb-library-tools" id="mb-library-tools"></div>
    </div>
    <div class="mb-right">
      <button class="mb-btn" id="mb-theme" title="" aria-label="Light or dark">${ic['dark-mode']}${ic['light-mode']}</button>
      <button class="mb-btn mb-gui is-on" id="mb-gui" title="Modern look (click for Classic)" aria-label="Switch look" aria-pressed="true">${ic['gui-toggle']}</button>
      <div class="mb-acct">
        <button class="mb-avatar-btn" id="mb-acct-btn" aria-haspopup="menu" aria-expanded="false" title="Account"><span class="mb-avatar" id="mb-avatar"></span></button>
        <div class="mb-menu hidden" id="mb-menu" role="menu">
          <div class="mb-menu-head"><b id="mb-uname"></b><small id="mb-urole"></small></div>
          <button class="mb-menu-item" role="menuitem" data-mview="settings" data-acct="account">${ic['my-account']}<span>My account</span></button>
          <button class="mb-menu-item hidden" role="menuitemcheckbox" id="mb-preview" aria-checked="false" title="Admins only: see the screen a play-only person gets. Only this tab; it ends when the tab is closed."><span class="mb-retro-mark">▶</span><span id="mb-preview-label">Preview play-only</span></button>
          <button class="mb-menu-item" role="menuitemcheckbox" id="mb-deep" aria-checked="false" title="Make dark mode a deeper black (suits OLED screens). Has no effect in light mode."><span class="mb-retro-mark">●</span><span>Deeper black</span></button>
          <button class="mb-menu-item" role="menuitemcheckbox" id="mb-retro" aria-checked="false" title="Use a monospace (typewriter-style) font everywhere in Modern"><span class="mb-retro-mark">Aa</span><span>Retro font</span></button>
          <button class="mb-menu-item" role="menuitem" id="mb-signout">${ic['sign-out']}<span>Sign out</span></button>
        </div>
      </div>
    </div>`;
  built = true;
  buildLibraryTools(ic);
  buildAzBar(ic);
  usePinIcon(ic.pin);
  trackBarHeight();
  paintUser();
  refreshTicker(true);
  if (!buildBar.timer) buildBar.timer = setInterval(() => { if (isModern()) refreshTicker(true); }, 60000);
  if (!bar.dataset.wired) { bar.dataset.wired = '1'; bar.addEventListener('click', onBarClick); }   // once: the bar is rebuilt for each person, the listener must not stack
  paintToggles();
}

function paintUser() {
  const u = ctx.user(); if (!u) return;
  const label = u.display_name || u.username;
  const name = $('#mb-uname'); if (name) name.textContent = label;
  const role = $('#mb-urole'); if (role) role.textContent = u.role === 'admin' ? 'admin' : (u.play_only ? 'player' : 'member');
  const av = $('#mb-avatar'); if (av) { av.id = 'mb-avatar'; ctx.paintAvatar(av, u.id, label, u.avatar_v); }
  const pv = $('#mb-preview');   // admins only
  if (pv) { pv.classList.toggle('hidden', u.role !== 'admin'); pv.classList.toggle('on', Boolean(u.previewing)); pv.setAttribute('aria-checked', String(Boolean(u.previewing))); const pl = $('#mb-preview-label'); if (pl) pl.textContent = u.previewing ? 'Previewing play-only: click to exit' : 'Preview play-only'; }
}

function paintToggles() {
  const t = $('#mb-theme'); if (t) { const light = theme() === 'light'; t.dataset.mode = light ? 'light' : 'dark'; t.title = light ? 'Light (click for dark)' : 'Dark (click for light)'; }
  const g = $('#mb-gui'); if (g) { g.classList.toggle('is-on', isModern()); g.setAttribute('aria-pressed', String(isModern())); g.title = isModern() ? 'Modern look (click for Classic)' : 'Classic look (click for Modern)'; }
}

function closeMenu() { $('#mb-menu')?.classList.add('hidden'); $('#mb-acct-btn')?.setAttribute('aria-expanded', 'false'); closePop(); }
document.addEventListener('click', (e) => { if (!e.target.closest('.mb-acct')) { $('#mb-menu')?.classList.add('hidden'); $('#mb-acct-btn')?.setAttribute('aria-expanded', 'false'); } if (!e.target.closest('.mb-pop, #tl-sort, #tl-more')) closePop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

function onBarClick(e) {
  if (toolClick(e)) return;
  if (e.target.closest('#mb-acct-btn')) { const m = $('#mb-menu'); const open = m.classList.toggle('hidden') === false; $('#mb-acct-btn').setAttribute('aria-expanded', String(open)); return; }
  if (e.target.closest('#mb-retro')) { applyRetro(!retro()); return; }
  if (e.target.closest('#mb-deep')) { applyDeep(!deep()); return; }
  if (e.target.closest('#mb-preview')) { try { const on = sessionStorage.getItem('gamesauce_preview_play') === '1'; if (on) sessionStorage.removeItem('gamesauce_preview_play'); else sessionStorage.setItem('gamesauce_preview_play', '1'); } catch { /* private mode */ } location.reload(); return; }
  if (e.target.closest('[data-acct="account"]')) { closeMenu(); go('settings'); setTimeout(() => ctx.openAccount?.(), 60); return; }
  // Only the bar's own buttons: <body> also carries data-mview (the current page), and closest() would find it for every click.
  const nav = e.target.closest('[data-mview]');
  if (nav && e.currentTarget.contains(nav)) {
    e.preventDefault();
    const v = nav.dataset.mview;
    // Choosing Home or Library means "start fresh": the search box, platform picks and every filter are cleared first. (Other pages keep theirs.)
    if (v === 'home' || v === 'library') { chipFamily = null; ctx.resetDigital?.(); ctx.resetPhysical?.(); ctx.resetFilters?.().then(() => { renderChips(); syncTools(); }); }
    go(v); return;
  }
  if (e.target.closest('#mb-theme')) { applyTheme(theme() === 'light' ? 'dark' : 'light'); return; }
  if (e.target.closest('#mb-gui')) { setUiMode('classic'); return; }
  if (e.target.closest('#mb-signout')) { closeMenu(); $('#logout')?.click(); }
}

/* ───────────── pages ───────────── */
let current = 'home';
export function go(view) {
  if (!isModern()) return;
  current = view;
  closePop();
  // Choosing a page releases the details window, unless it is pinned beside the games.
  // The details window can stay pinned beside the games, but only in the Library: any other page (Home, Collections, Sources...) releases it.
  // The pin itself is remembered, so it is there again when a game is opened in the Library.
  const keepPinned = view === 'library' && document.body.classList.contains('details-pinned');
  if (!keepPinned && !$('#drawer')?.classList.contains('hidden')) ctx.closeDrawer?.();
  if (view === 'library') { setTimeout(syncTools, 120); setTimeout(renderChips, 250); setTimeout(syncAz, 400); }
  refreshTicker(view === 'library');   // home: rebuild so the ticker starts again from the name
  document.body.dataset.mview = view;
  try { sessionStorage.setItem('gamesauce_mview', view); } catch { /* storage unavailable */ }
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
  const hi = { search: await icon('search'), 'arrow-right': await icon('arrow-right') };
  host.innerHTML = `
    <form class="mh-search" id="mh-search" role="search" autocomplete="off">
      <select id="mh-plat" aria-label="Platform to search" title="Search one platform, or all"><option value="all">All platforms</option></select>
      <label class="mh-q">${hi.search}<input id="mh-q" type="search" placeholder="Search your games" aria-label="Search your games" autocomplete="off" /></label>
      <button type="submit" class="mb-btn" id="mh-go" title="Search" aria-label="Search">${hi['arrow-right']}</button>
    </form>
    <div class="strips mh-strips">
      <div class="strip" data-strip="played"><button type="button" class="strip-head" data-strip-toggle="played" aria-expanded="true" title="Show or hide this row"><span class="strip-caret">▾</span><span class="section-label" style="margin:0">Continue playing</span></button><div class="recent-row" id="mh-played"></div></div>
      <div class="strip" data-strip="recent"><button type="button" class="strip-head" data-strip-toggle="recent" aria-expanded="true" title="Show or hide this row"><span class="strip-caret">▾</span><span class="section-label" style="margin:0">Recently added</span></button><div class="recent-row" id="mh-recent"></div></div>
    </div>`;
  ctx.applyStrips?.(host, false);
  fillHomePlatforms();
  $('#mh-search')?.addEventListener('submit', (e) => { e.preventDefault(); submitHomeSearch(); });
  try {
    const [stats, played] = await Promise.all([api('/stats'), api('/roms/recently-played?limit=24').catch(() => ({ items: [] }))]);
    fillRow('#mh-recent', stats.recent || []);
    fillRow('#mh-played', played.items || [], 'Nothing played yet');
  } catch { /* the home page degrades to empty rows */ }
}

/** The Home search box's platform list: every platform that has games, with its count (same list the Library chips use). */
async function fillHomePlatforms() {
  const sel = $('#mh-plat'); if (!sel) return;
  try {
    const items = (await api('/platforms')).items.filter((p) => p.count > 0);
    const by = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
    items.sort((a, b) => by(a.family || '', b.family || '') || by(a.name, b.name));
    const fams = [...new Set(items.map((p) => p.family || 'Others'))];
    const esc2 = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    sel.innerHTML = '<option value="all">All platforms</option>' + fams.map((f) => `<optgroup label="${esc2(f)}">${items.filter((p) => (p.family || 'Others') === f).map((p) => `<option value="${esc2(p.slug)}">${esc2(p.name)} (${p.count.toLocaleString()})</option>`).join('')}</optgroup>`).join('');
  } catch { /* the box still searches everything */ }
}

/** Search from Home: set the Library's search text and platform, then show the Library with the results. */
function submitHomeSearch() {
  const text = ($('#mh-q')?.value || '').trim(), plat = $('#mh-plat')?.value || 'all';
  const st = ctx.state();
  Object.assign(st, { platform: plat, extraPlatforms: [], q: text });
  const real = document.querySelector('#search'); if (real) real.value = text;
  const tq = $('#tl-q'); if (tq) tq.value = text;
  go('library');
  ctx.loadLibrary?.();
  ctx.loadPlatforms?.();
  window.dispatchEvent(new Event('gs:filters'));
}

function fillRow(sel, items, empty = '') {
  const el = $(sel); if (!el) return;
  if (!items.length) { el.innerHTML = empty ? `<div class="side-empty" style="grid-column:1/-1">${empty}</div>` : ''; return; }
  // The same tiles as the library grid (cover, platform badge, play button), so they behave the same.
  el.innerHTML = items.slice(0, 24).map(ctx.cardHtml).join('');
  ctx.bindCards(el);
}

/** Fetch what the ticker says (cheap: it reuses /stats). It sits in the bar on every page except Library, where the library tools take its place. */
let lastTicker = 0;
const bytesText = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; n = Number(n) || 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`; };
async function refreshTicker(force = false) {
  if (!force && Date.now() - lastTicker < 20000) return;
  lastTicker = Date.now();
  try { await fillTicker(await api('/stats')); } catch { /* the bar just stays without a ticker */ }
}

/** The ticker: one line at a time, rolling upwards. Synopsis facts plus anything the system wants to say. */
async function fillTicker(stats) {
  const lib = stats.library || {};
  // The game-sauce name with its shimmer, as one of the rolling lines.
  const brand = '<span class="brand-name mh-brand" data-text="game-sauce">game<span class="saucy">-sauce</span></span>';
  const lines = [];   // the name always goes first, whatever else is added in front of the facts below
  const top = stats.topDownloaded;
  const cache = window.__platformsCache || [];
  const shown = cache.reduce((n, p) => n + pc(p), 0), all = cache.reduce((n, p) => n + (p.count || 0), 0);
  if (cache.length && shown) {
    lines.push(`<b>${shown.toLocaleString()}</b> games across <b>${cache.filter((p) => pc(p) > 0).length}</b> platforms`);
    if (all > shown) lines.push(`<b>${(all - shown).toLocaleString()}</b> more are System entries or hidden`);
  } else lines.push(`<b>${Number(lib.roms || 0).toLocaleString()}</b> games across <b>${lib.platforms || 0}</b> platforms`);
  if (lib.bytes) lines.push(`<b>${bytesText(lib.bytes)}</b> of ROMs stored`);
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
      const up = await api('/admin/update-check').catch(() => null);
      if (up?.newer) lines.unshift(`Update available: game-sauce <b>${String(up.latest).replace(/^v/i, '').replace(/</g, '&lt;')}</b> (you have <b>${String(up.current).replace(/</g, '&lt;')}</b>)`);
      const h = await api('/admin/health').catch(() => null);
      if (h && h.status && h.status !== 'ok') lines.unshift(`System health: <b>${h.status === 'bad' ? 'needs a look' : 'a few notes to read'}</b>`);
    }
  } catch { /* optional */ }
  lines.unshift(brand);
  const track = $('#mh-track'); if (!track) return;
  track.innerHTML = lines.map((l) => `<div class="mh-line">${l}</div>`).join('');
  // The rolling position belongs to the OLD set of lines: start again from the first, or the box can sit past the end (blank).
  track.style.transition = 'none'; track.style.transform = 'translateY(0)'; void track.offsetHeight; track.style.transition = '';
  clearInterval(tickerTimer);
  const rows = $$('.mh-line', track);
  if (rows.length > 1) {
    let i = 0;
    tickerTimer = setInterval(() => { i = (i + 1) % rows.length; track.style.transform = `translateY(-${i * rows[0].offsetHeight}px)`; }, 3500);
  }
}


/* ───────────── Library tools in the bar ─────────────
   The Classic toolbar (search, sort, filter pills, fetch metadata) stays where it is, hidden in Modern, and keeps all the logic.
   These icon buttons drive it: they click the same buttons and set the same fields, so Classic and Modern cannot drift apart. */
const q = (s) => document.querySelector(s);
let pop = null;
function closePop() { pop?.remove(); pop = null; }
function openPop(anchor, html, onPick) {
  closePop();
  pop = document.createElement('div'); pop.className = 'mb-pop'; pop.setAttribute('role', 'menu'); pop.innerHTML = html;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left)) + 'px';
  pop.addEventListener('click', (e) => { const it = e.target.closest('[data-pick]'); if (it) { onPick(it.dataset.pick); closePop(); } });
}
const proxy = (sel) => { q(sel)?.click(); setTimeout(syncTools, 60); };

function buildLibraryTools(ic) {
  const host = $('#mb-library-tools'); if (!host) return;
  const u = ctx.user(); const admin = u?.role === 'admin'; const po = Boolean(u?.play_only);
  host.innerHTML = `
    <label class="tl-search">${ic.search}<input id="tl-q" type="search" placeholder="Search" autocomplete="off" aria-label="Search the library" title="Search titles, developers, genres and platforms" /></label>
    <button class="mb-btn" id="tl-reset" title="Reset: clear the search, platforms and filters" aria-label="Reset search and filters">${ic['clear-reset-2']}</button>
    ${po ? '' : `<button class="mb-btn" id="tl-sort" title="Sort" aria-label="Sort" aria-haspopup="menu">${ic.sort}</button>`}
    <button class="mb-btn" id="tl-fav" title="Favourites only" aria-label="Favourites only">${ic.favourite}</button>
    ${po ? '' : `<button class="mb-btn" id="tl-hidden" title="Hidden games" aria-label="Hidden games">${ic.hidden}</button>
    <button class="mb-btn" id="tl-nocover" title="Games with no cover yet" aria-label="Games with no cover yet">${ic['no-covers-2']}</button>
    <button class="mb-btn" id="tl-select" title="Select several games" aria-label="Select several games">${ic['select-2']}</button>`}
    ${admin ? `<button class="mb-btn" id="tl-fetch" title="Fetch metadata" aria-label="Fetch metadata"><span class="tl-ic">${ic['fetch-metadata-3']}</span><span class="tl-sp">${ic['3-dot-spinner']}</span></button>` : ''}
    ${po ? '' : `<button class="mb-btn" id="tl-more" title="More filters" aria-label="More filters" aria-haspopup="menu">${ic['more-actions']}</button>`}`;
  host.dataset.icons = JSON.stringify({ system: ic.system, orphans: ic.orphans, issue: ic.issue, lock: ic.lock });
  document.body.classList.add('mb-tools');
  $('#tl-q')?.addEventListener('input', (e) => { const s = q('#search'); if (s) { s.value = e.target.value; s.dispatchEvent(new Event('input', { bubbles: true })); } });
  if (!buildLibraryTools.timer) buildLibraryTools.timer = setInterval(() => { if (isModern() && document.body.dataset.mview === 'library') { syncTools(); syncAz(); } }, 700);
}

/** Handle a click on one of the tool buttons. Returns true when it was one. */
function toolClick(e) {
  const b = e.target.closest('#tl-reset, #tl-fav, #tl-hidden, #tl-nocover, #tl-select, #tl-fetch, #tl-sort, #tl-more');
  if (!b) return false;
  if (b.id === 'tl-reset') { chipFamily = null; ctx.resetFilters?.().then(() => { renderChips(); syncTools(); }); }
  else if (b.id === 'tl-fav') proxy('[data-toggle="favorite"]');
  else if (b.id === 'tl-hidden') proxy('[data-toggle="hidden"]');
  else if (b.id === 'tl-nocover') proxy('[data-toggle="nocover"]');
  else if (b.id === 'tl-select') proxy('#select-toggle');
  else if (b.id === 'tl-fetch') proxy('#bulk-enrich');
  else if (b.id === 'tl-sort') {
    const sel = q('#sort'); if (!sel) return true;
    openPop(b, [...sel.options].map((o) => `<button class="mb-menu-item${o.value === sel.value ? ' on' : ''}" role="menuitemradio" aria-checked="${o.value === sel.value}" data-pick="${o.value}"><span>${o.textContent}</span></button>`).join(''),
      (v) => { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); });
  } else if (b.id === 'tl-more') {
    const ic = JSON.parse($('#mb-library-tools').dataset.icons || '{}');
    const items = [['locked', 'Locked games', ic.lock, 'protected from deletion; unlock to delete'], ['system', 'System items', ic.system, 'BIOS and devices'], ['orphan', 'No source', ic.orphans, 'a scan of their folder reconnects them'], ['unmatched', 'Needs a match', ic.issue, 'no provider matched']]
      .filter(([k]) => { const t = q(`[data-toggle="${k}"]`); return t && !t.classList.contains('hidden'); });
    if (!items.length) return true;
    openPop(b, items.map(([k, label, svg, sub]) => `<button class="mb-menu-item${q(`[data-toggle="${k}"]`)?.classList.contains('is-active') ? ' on' : ''}" role="menuitemcheckbox" data-pick="${k}">${svg}<span>${label}<small>${sub}</small></span></button>`).join(''),
      (k) => proxy(`[data-toggle="${k}"]`));
  }
  e.stopPropagation();
  return true;
}

/** Make the icons reflect the real filters, and the fetch button show a spinner while a metadata run is going. */
function syncTools() {
  { const r = $('#tl-reset'); if (r) { const act = Boolean(ctx.filtersActive?.() || chipFamily); /* an open family row (the platform pills) counts too, even with nothing picked in it */ r.classList.toggle('is-dim', !act); r.disabled = !act; } }
  const on = (sel) => Boolean(q(sel)?.classList.contains('is-active'));
  $('#tl-fav')?.classList.toggle('is-on', on('[data-toggle="favorite"]'));
  $('#tl-hidden')?.classList.toggle('is-on', on('[data-toggle="hidden"]'));
  $('#tl-nocover')?.classList.toggle('is-on', on('[data-toggle="nocover"]'));
  $('#tl-select')?.classList.toggle('is-on', on('#select-toggle'));
  const more = $('#tl-more'); if (more) more.classList.toggle('is-on', ['system', 'orphan', 'locked', 'unmatched'].some((k) => on(`[data-toggle="${k}"]`)));
  const sort = $('#tl-sort'); if (sort) { const s = q('#sort'); sort.classList.toggle('is-on', Boolean(s && s.value !== 'title')); sort.title = 'Sort: ' + (s?.selectedOptions?.[0]?.textContent || ''); }
  const search = $('#tl-q'), real = q('#search'); if (search && real && document.activeElement !== search && search.value !== real.value) search.value = real.value;
  const f = $('#tl-fetch');
  if (f) { const txt = q('#bulk-enrich')?.textContent || ''; const busy = /Fetching/.test(txt); f.classList.toggle('is-busy', busy); f.classList.toggle('is-on', busy); f.title = busy ? txt.replace('✦', '').trim() + ' (click to stop)' : 'Fetch metadata'; }
}


/* ───────────── Platform chips ─────────────
   Row 1: All, then a chip per family. Row 2 (only after a family is opened): that family's platforms as icon chips with counts.
   Click a platform to pick it; click more to add them (several platforms at once); click a lit chip to drop it.
   The state is the app's own (state.platform + state.extraPlatforms), so the sidebar, heading and fetch scope all agree. */
let chipFamily = null;
const chipSort = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
const chosen = () => { const s = ctx.state(); return s.platform === 'all' ? [] : [s.platform, ...(s.extraPlatforms || [])]; };

// What the chips count is what the list shows: no System entries and nothing this person has hidden (the total above the grid then matches).
const pc = (p) => (p.visible_count ?? p.count) || 0;
const allPlats = () => (window.__platformsCache || []).filter((p) => pc(p) > 0);
const familyOfSlug = (slug) => allPlats().find((p) => p.slug === slug)?.family || 'Others';
const familySlugs = (f) => allPlats().filter((p) => (p.family || 'Others') === f).sort((a, b) => chipSort(a.name, b.name)).map((p) => p.slug);

export function renderChips() {
  const host = $('#chip-rows'); if (!host) return;
  const items = (window.__platformsCache || []).filter((p) => pc(p) > 0);
  if (!items.length) { host.innerHTML = ''; return; }
  const fams = new Map();
  for (const p of items) { const f = p.family || 'Others'; if (!fams.has(f)) fams.set(f, []); fams.get(f).push(p); }
  const order = [...fams.keys()].sort(chipSort);
  const picked = new Set(chosen());
  // A whole family selected = the family chip is lit and its platform chips are NOT (they light only when picked one by one).
  const wholeNow = chipFamily && familySlugs(chipFamily).length > 1 && familySlugs(chipFamily).every((s) => picked.has(s)) && picked.size === familySlugs(chipFamily).length;
  const famOf = (slug) => items.find((p) => p.slug === slug)?.family || 'Others';
  const total = items.reduce((n, p) => n + pc(p), 0);
  const famCount = (f) => fams.get(f).reduce((n, p) => n + pc(p), 0);
  const famColour = (f) => { const c = fams.get(f)?.[0]?.family_colour; return /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#6b7280'; };
  const litFam = (f) => [...picked].some((s) => famOf(s) === f);
  // 'whole' = every platform of that family is on, so the family chip is solid; 'part' = just some, so it is outlined
  const famState = (f) => { const sl = fams.get(f).map((p) => p.slug); const n = sl.filter((s) => picked.has(s)).length; return n === 0 ? '' : n === sl.length ? ' on whole' : ' on part'; };
  if (chipFamily && !fams.has(chipFamily)) chipFamily = null;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  host.innerHTML = `
    <div class="chip-row chip-fams" role="tablist">
      <button class="chip${picked.size === 0 ? ' on' : ''}" data-chip-all title="All platforms">All <small>${total.toLocaleString()}</small></button>
      ${order.map((f) => `<button class="chip${chipFamily === f ? ' open' : ''}${famState(f)}" data-chip-fam="${esc(f)}" style="--chip-c:${esc(famColour(f))}" aria-expanded="${chipFamily === f}" title="${esc(f)}: show its platforms">${esc(f)} <small>${famCount(f).toLocaleString()}</small></button>`).join('')}
    </div>
    ${chipFamily ? `<div class="chip-row chip-plats">${fams.get(chipFamily).sort((a, b) => chipSort(a.name, b.name)).map((p) => `<button class="chip plat${picked.has(p.slug) && !wholeNow ? ' on' : ''}" data-chip-plat="${esc(p.slug)}" style="--chip-c:${esc(/^#[0-9a-f]{6}$/i.test(p.accent || '') ? p.accent : (p.family_colour || '#6b7280'))}" title="${esc(p.name)}: click to ${picked.has(p.slug) && !wholeNow ? 'turn off' : 'turn on'}"><span>${esc(String(p.short_name || p.name).toUpperCase())}</span> <small>${pc(p).toLocaleString()}</small></button>`).join('')}</div>` : ''}`;
}

async function chipChanged() {
  renderChips();
  // A different list starts at the top. Without this the grid kept the old scroll position (say 5,000 px down All), which is
  // beyond the end of a short list such as CPS 1, so the tiles were there but off the top of the screen.
  const g = $('#grid'); if (g) g.scrollTop = 0;
  await ctx.loadLibrary();
  if (g) { g.scrollTop = 0; requestAnimationFrame(() => { g.scrollTop = 0; }); }
  ctx.loadPlatforms();   // keeps the sidebar-side bookkeeping (counts, heading) in step
}
function setPlatforms(list) {
  const s = ctx.state();
  s.platform = list[0] || 'all';
  s.extraPlatforms = list.slice(1);
  s.libKey = null;
}
function chipClick(e) {
  const all = e.target.closest('[data-chip-all]'), fam = e.target.closest('[data-chip-fam]'), pl = e.target.closest('[data-chip-plat]');
  if (!all && !fam && !pl) return false;
  if (all) { chipFamily = null; setPlatforms([]); chipChanged(); }
  else if (fam) {
    // A family chip selects the whole family (All goes off) and shows its platforms. Clicking it again clears the selection.
    const f = fam.dataset.chipFam, slugs = familySlugs(f), cur = chosen();
    const whole = slugs.length && cur.length === slugs.length && slugs.every((s) => cur.includes(s));
    if (whole) { chipFamily = null; setPlatforms([]); }
    else { chipFamily = f; setPlatforms(slugs); }
    chipChanged();
  }
  else {
    const slug = pl.dataset.chipPlat; const cur = chosen();
    // With a whole family selected, a click narrows to that one platform; after that, clicks add and remove platforms.
    const fs = familySlugs(familyOfSlug(slug));
    const wholeFamily = fs.length > 1 && cur.length === fs.length && fs.every((s) => cur.includes(s));
    if (wholeFamily) setPlatforms([slug]);
    else setPlatforms(cur.includes(slug) ? cur.filter((x) => x !== slug) : [...cur, slug]);
    chipChanged();
  }
  return true;
}
document.addEventListener('click', (e) => { if (isModern() && e.target.closest('#chip-rows') && chipClick(e)) e.stopPropagation(); });


/* ───────────── A-Z jump, grid size, back to top ─────────────
   The grid pages in 200 at a time, so a letter is reached by loading pages until its first game exists, then scrolling to it.
   Only offered while the list is sorted by title (either way); other sorts have no alphabet to jump along. */
const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
let azKey = null, azCounts = null, azBusy = false;

function buildAzBar(ic) {
  const bar = $('#az-bar'); if (!bar) return;
  bar.innerHTML = `
    <div class="az-letters" id="az-letters" role="toolbar" aria-label="Jump to a letter"></div>
    <div class="az-right">
      <button class="mb-btn" data-density="comfortable" title="Comfortable grid" aria-label="Comfortable grid">${ic.grid}</button>
      <button class="mb-btn" data-density="compact" title="Condensed grid" aria-label="Condensed grid">${ic['grid-condensed']}</button>
      <button class="mb-btn" id="az-top" title="Back to the top" aria-label="Back to the top">${ic['back-to-top']}</button>
    </div>`;
  if (bar.dataset.wired) return;   // the markup above is rebuilt each time; the click handler is attached only once
  bar.dataset.wired = '1';
  bar.addEventListener('click', (e) => {
    const d = e.target.closest('[data-density]');
    if (d) { document.querySelector(`#density [data-density="${d.dataset.density}"]`)?.click(); setTimeout(syncAz, 60); return; }
    if (e.target.closest('#az-top')) { const g = $('#grid'); g?.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const l = e.target.closest('[data-letter]');
    if (l && !l.disabled) jumpTo(l.dataset.letter);
  });
}

const sortDir = () => { const s = ctx.state().sort; return s === 'title' ? 1 : s === '-title' ? -1 : 0; };

async function refreshLetters() {
  const s = ctx.state(), dir = sortDir();
  const box = $('#az-letters'); if (!box) return;
  box.classList.toggle('off', !dir);
  if (!dir) { azKey = null; azCounts = null; box.innerHTML = ''; return; }
  const key = (s.libKey || '') + '|' + dir;
  if (key === azKey && azCounts) { document.querySelectorAll('.az-l').forEach((x) => x.classList.toggle('on', x.dataset.letter === litLetter())); return; }
  azKey = key;
  try {
    const qs = new URLSearchParams(s.libQuery || ''); qs.set('letters', '1');
    const r = await api('/roms?' + qs);
    if (key !== azKey) return;   // the list changed while we were asking
    azCounts = Object.fromEntries(r.letters.map((x) => [x.letter, x.n]));
    paintLetters();
  } catch { azCounts = null; }
}

function litLetter() { const s = ctx.state(); return s.azLetter && s.azFor === (s.libQuery?.toString() || '') + '|' + s.sort ? s.azLetter : ''; }
function paintLetters() {
  const box = $('#az-letters'); if (!box || !azCounts) return;
  box.innerHTML = LETTERS.map((l) => `<button class="az-l${litLetter() === l ? ' on' : ''}" data-letter="${l}"${azCounts[l] ? '' : ' disabled'} title="${azCounts[l] ? l + ': ' + azCounts[l].toLocaleString() + ' games' : 'No games under ' + l}" aria-label="Jump to ${l}">${l}</button>`).join('');
}

/** Offset of the first game under a letter in the current order. */
function offsetOf(letter) {
  const order = sortDir() === 1 ? LETTERS : [...LETTERS].reverse();
  let off = 0;
  for (const l of order) { if (l === letter) return off; off += azCounts[l] || 0; }
  return 0;
}

async function jumpTo(letter) {
  if (azBusy || !azCounts) return;
  azBusy = true;
  const btn = document.querySelector(`[data-letter="${letter}"]`);
  btn?.classList.add('busy');
  try {
    const s = ctx.state(), grid = $('#grid');
    const same = s.azLetter === letter && s.azFor === (s.libQuery?.toString() || '') + '|' + s.sort;   // the lit letter again: back to the beginning
    s.azOffset = same ? 0 : offsetOf(letter);
    s.azLetter = same ? null : letter;
    s.azFor = (s.libQuery?.toString() || '') + '|' + s.sort;
    await ctx.loadLibrary();          // one request that starts at the letter's first game
    grid.scrollTop = 0;
    document.querySelectorAll('.az-l.on').forEach((x) => x.classList.remove('on'));
    if (!same) {
      btn?.classList.add('on');
      const card = grid.querySelector('.card');
      if (card) { grid.querySelectorAll('.card.az-hit').forEach((x) => x.classList.remove('az-hit')); card.classList.add('az-hit'); setTimeout(() => card.classList.remove('az-hit'), 2400); }
    }
  } finally { btn?.classList.remove('busy'); azBusy = false; }
}

function syncAz() {
  document.querySelectorAll('#az-bar [data-density]').forEach((b) => b.classList.toggle('is-on', b.dataset.density === (ctx.state().density || 'comfortable')));
  refreshLetters();
}


/* ───────────── Details window: under the bar, with your pin icon ───────────── */
let classicPin = null;
/** Swap the drawer's pin for the supplied icon while Modern is on (and put Classic's back when it is off). */
function usePinIcon(svg) {
  const b = $('#drawer-pin'); if (!b) return;
  if (classicPin === null) classicPin = b.innerHTML;
  if (svg) b.innerHTML = svg;
}
function restorePinIcon() { const b = $('#drawer-pin'); if (b && classicPin !== null) b.innerHTML = classicPin; }
/** The window starts under the fixed bar, so the bar (and the library tools in it) stay reachable while a game is open. */
function trackBarHeight() {
  const bar = $('#modern-bar'); if (!bar || typeof ResizeObserver === 'undefined') return;
  const set = () => document.documentElement.style.setProperty('--mb-h', bar.offsetHeight + 'px');
  new ResizeObserver(set).observe(bar); set();
}


/* ───────────── Icons instead of words (pages other than Library) ─────────────
   Buttons that an icon can carry on its own are tagged data-mi="<icon>". CSS (modern.css + one generated rule per icon) hides the
   words and draws the SVG in their place; the words stay as the hover text and the screen-reader label. Nothing is rewritten, so
   Classic is untouched and turning Modern off puts every word back. Buttons whose meaning an icon cannot carry keep their text. */
const ICON_MAP = [
  // Physical: the page's own buttons (Classic keeps the words; here the words are the hover text)
  ['#view-physical [data-ph-toggle="fav"]', 'favourite'], ['#view-physical [data-ph-toggle="nocover"]', 'no-covers-2'], ['#view-physical [data-ph-toggle="unmatched"]', 'issue'], ['#view-physical [data-ph-toggle="spine"]', 'covers'],
  ['#view-physical #ph-reset', 'clear-reset-2'], ['#view-physical [data-ph-act="lookup"]', 'fetch-metadata-3'], ['#view-physical [data-ph-act="import"]', 'csv-import'], ['#view-physical [data-ph-act="add"]', 'game-add'],
  ['#view-digital [data-dg-toggle="fav"]', 'favourite'], ['#view-digital [data-dg-toggle="nocover"]', 'no-covers-2'], ['#view-digital [data-dg-toggle="installed"]', 'gamepad'], ['#view-digital [data-dg-toggle="hidden"]', 'hidden'],
  ['#view-digital #dg-reset', 'clear-reset-2'], ['#view-digital [data-dg-act="import"]', 'csv-import'], ['#view-digital [data-dg-act="add"]', 'game-add'],
  ['#dg-id-go', 'search'], ['#dg-edit button[type="submit"]', 'save'], ['#dg-add button[type="submit"]', 'tick'], ['#dg-add-more', 'game-add'], ['#dg-imp-preview', 'preview-2'], ['#dg-imp-apply', 'csv-import'],
  ['#view-messages [data-msg-act="new"]', 'edit'], ['#msg-send', 'arrow-right'], ['#msg-share', 'game-cartridge'], ['#msg-notice-toggle', 'issue'], ['#msg-notice-send', 'tick'],
  ['#ph-id-go', 'search'], ['#ph-edit button[type="submit"]', 'save'], ['#ph-add button[type="submit"]', 'tick'], ['#ph-add-more', 'game-add'], ['#ph-imp-preview', 'preview-2'], ['#ph-imp-apply', 'csv-import'],
  // Details window: the row (the More menu keeps its words)
  ['.detail-actions a[download]', 'download'], ['.detail-actions [data-act="play"]', 'play'], ['.detail-actions [data-act="favorite"]', 'favourite'],
  ['.detail-actions #more-btn', 'more-actions'], ['.detail-actions [data-act="delete"]', 'delete'],
  ['.detail-actions [data-promo="addcoll"]', 'collection-new'], ['.detail-actions [data-promo="hide"]', 'hidden'], ['.detail-actions [data-promo="refresh"]', 'scan-again'],
  ['label.btn:has(#cover-input)', 'upload-cover'], ['#drawer-prev', 'arrow-left'], ['#drawer-next', 'arrow-right'], ['#identify-search', 'search'], ['#edit-form button[type="submit"]', 'save'],
  // Settings leftovers found by the 1 Nov audit
  ['#names-apply', 'tick'], ['#export-csv', 'game-csv'], ['#covers-preview', 'preview-2'], ['#dgc-preview', 'preview-2'], ['#dgc-apply', 'csv-import'], ['#covers-apply', 'tick'], ['#export-covers', 'covers'], ['#backup-download', 'database-download'], ['a.btn[download]', 'download'], ['[data-act="lb-update"]', 'database-download'],
  ['[data-pact="edit"], [data-fam-rename]', 'edit'], ['[data-fam-save]', 'tick'], ['#view-settings [data-pact="save"]', 'save-platform'], ['[data-fam-colour-reset]', 'clear-reset'], ['[data-logo-pick], [data-famlogo-pick]', 'upload-cover'], ['[data-logo-remove], [data-famlogo-remove]', 'delete'], ['[data-pact="delete"], [data-bk-del], [data-save-del], [data-act="delete-user"]', 'delete'],
  ['[data-act="toggle-user"][data-disabled="0"]', 'user-disable'], ['[data-act="toggle-user"][data-disabled="1"]', 'user-enable'],
  ['#view-settings form button.btn-primary[type="submit"]', 'save-settings'], ['#password-form button[type="submit"]', 'save-password'],   /* after the general form rule above, so it wins */ ['#dup-hide-all, [data-dup-hide]', 'hidden'],
  // Dismiss / accept / copy / clear / more (icons you added on 1 Nov)
  ['#platform-add-cancel, #browser-cancel, #cancel-source, #collection-cancel, #modal-cancel, #pf-cancel, [data-pact="cancel"], #restore-cancel, #wz-bcancel', 'close'],
  ['#addcoll-cancel, #browser-use, #pf-use, #wz-buse, #collection-create', 'tick'], ['#addcoll-new', 'collection-new'], ['#dg-sync, #steam-sync', 'fetch-games'], ['.detail-actions [data-act="dgplay"]', 'gamepad'], ['.detail-actions [data-act="dghide"]', 'hidden'], ['#dg-setup', 'steam'], ['#steam-save', 'game-save'], ['#steam-remove', 'game-remove'], ['#health-copy', 'copy'], ['#bulk-clear, #audit-clear', 'clear-reset-2'],
  ['[data-act="hidegames"][data-hidden="0"]', 'hidden'], ['[data-act="hidegames"][data-hidden="1"]', 'visible'], ['[data-act="toggle"][data-enabled="1"]', 'folder-disable'], ['[data-act="toggle"][data-enabled="0"]', 'folder-enable'],
  ['#dup-more, #hw-more', 'show-more-down-arrow'], ['#bulk-selectall', 'select-2'], ['#pf-retry, #sources-retry, #browser-retry', 'recheck'],
  // Sources
  ['#scan-all', 'scan-again'], ['#add-source, #empty-add-source', 'source-add-2'], ['#create-source', 'source-add-and-scan-2'], ['#browse-source, #wz-browse', 'sources'], ['[data-act="scan"]', 'scan-again'],
  ['[data-act="add-folder"]', 'source-add-2'], ['[data-act="drop-folder"]', 'cancel'], ['[data-act="have-want"]', 'have-want'], ['[data-act="remove"]', 'delete'],
  // Add ROMs / Emulators
  ['#view-upload form button[type="submit"]', 'add-roms'], ['#emu-refresh-latest', 'emulators-refresh'], ['#emu-upload-form button[type="submit"]', 'save-to-vault-2'],
  ['[data-save-release]:not(.emu-save-alt)', 'save-to-vault'], ['.emu-dl', 'download'], ['[data-save-release].emu-save-alt', 'arrow-up'], ['[data-vault-del]', 'delete'],
  // Collections
  ['#new-collection', 'add-collection'], ['[data-act="delete-collection"]', 'delete'], ['[data-rom-remove]', 'cancel'], ['[data-rom-play]', 'play'],
  // Library selection bar
  ['#bulk-addcoll', 'collection-new'], ['#bulk-delete-btn', 'delete'], ['#bulk-system-btn', 'system'], ['#bulk-clearmatch-btn', 'clear-reset'], ['#bulk-lock-btn', 'lock'], ['#bulk-cancel', 'done'],
  // Settings: account
  ['#profile-upload', 'upload-cover'], ['#profile-remove', 'delete'], ['#welcome-again', 'welcome-tour-2'], ['#revoke-others', 'sign-out-devices'],
  // Settings: health, tools, maintenance
  ['#health-refresh, #dup-refresh', 'scan-again'], ['#health-repair-covers', 'recheck'], ['#enrich-missing-covers', 'fetch'], ['#check-ss-systems', 'recheck'], ['[data-pid-use], #pid-apply-all', 'tick'],
  ['#db-health-refresh', 'database-check'], ['#db-show-orphans', 'show-orphans'], ['#db-purge-orphans', 'delete'], ['#db-clear-covers', 'clear-covers'],
  ['#audit-apply', 'filter'], ['#backup-run', 'database-backup-save'], ['#backup-save', 'save-settings-2'], ['#restore-inspect', 'database-backup-check'],
  ['[data-bk-del]', 'database-backup-delete'], ['[data-bk-restore]', 'restore'], ['#names-preview', 'preview-2'],
  ['#dat-upload', 'import-media'], ['#dat-rematch', 'rematch'], ['#dat-rematch-force', 'replace-text'], ['[data-act="delete-dat"]', 'delete'],
  // Settings: setup
  ['#platform-add-toggle', 'add-platform-2'], ['#new-user-form button[type="submit"]', 'add-user'], ['[data-act="test-provider"]', 'test-connection'],
  ['[data-act="save-provider"]', 'save'], ['[data-act="reset-password"]', 'password-reset'], ['[data-act="delete-user"]', 'delete']
];
const miKnown = new Set();
let miStyle = null;
function miRule(name) {
  if (miKnown.has(name)) return;
  miKnown.add(name);
  // An icon stays invisible until its picture has arrived. Before that, the mask is missing and the icon would draw as a solid block
  // (the black square on a first visit or a hard refresh). Space is kept, so nothing moves when it appears.
  const add = () => {
    if (!miStyle) { miStyle = document.createElement('style'); miStyle.id = 'modern-icon-rules'; document.head.appendChild(miStyle); }
    miStyle.appendChild(document.createTextNode(`body.ui-modern [data-mi="${name}"]::before { -webkit-mask-image: url(${ICON_BASE}${name}.svg); mask-image: url(${ICON_BASE}${name}.svg); visibility: visible; }\n`));
  };
  const img = new Image(); img.onload = add; img.onerror = add; img.src = `${ICON_BASE}${name}.svg`;
}
const plainText = (el) => (el.getAttribute('data-mi-label') || el.querySelector?.('b')?.textContent || el.getAttribute('data-tip') || el.getAttribute('aria-label') || el.textContent || '').replace(/^[^A-Za-z0-9]+/, '').replace(/…$/, '').trim();
/** Details-window buttons: copy three of the More menu's actions onto the icon row. Each copy just clicks the original. */
function promoteDetailActions(root = document) {
  const row = root.querySelector?.('.detail-actions') || (root.matches?.('.detail-actions') ? root : null);
  const bar = row || document.querySelector('.detail-actions'); if (!bar || bar.querySelector('[data-promo]')) return;
  const more = bar.querySelector('.more-wrap'); if (!more) return;
  for (const k of ['addcoll', 'hide', 'refresh']) {
    const orig = bar.querySelector(`.more-menu [data-act="${k}"]`); if (!orig) continue;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ibtn'; b.dataset.promo = k;
    b.title = orig.querySelector('b')?.textContent || k; b.setAttribute('aria-label', b.title);
    b.addEventListener('click', (e) => { e.stopPropagation(); orig.click(); });
    bar.insertBefore(b, more);
  }
}
/**
 * Details window header ("hero"): the cover sits in front of a blurred, enlarged copy of itself, with the genre pills at the top and the
 * action icons along the bottom, instead of a small cover floating in an empty wide panel. Modern only; built from the elements Classic
 * already renders (nothing is duplicated, so the buttons keep their handlers). A game with no cover gets a backdrop in its platform colour.
 */
function buildDetailHero(root = document) {
  const body = document.querySelector('#drawer-body'); if (!body || body.querySelector('.detail-hero')) return;
  const cover = body.querySelector(':scope > .detail-cover'), actions = body.querySelector(':scope > .detail-actions');
  if (!cover || !actions) return;                               // a collection or another view uses the same window: leave it alone
  const pills = body.querySelector(':scope > .genre-pills');
  const img = cover.querySelector('img');
  const src = img?.getAttribute('src') || '';
  const accent = (/#[0-9a-f]{6}/i.exec(cover.getAttribute('style') || '') || [])[0] || '#6b7280';
  const hero = document.createElement('div'); hero.className = 'detail-hero';
  const back = document.createElement('div'); back.className = 'hero-back';
  const coverBack = () => { if (src) { back.style.backgroundImage = `url("${src.replace(/"/g, '%22')}")`; back.style.background = ''; back.style.backgroundImage = `url("${src.replace(/"/g, '%22')}")`; } else back.style.background = `linear-gradient(160deg, ${accent}66, #12141a)`; };
  coverBack();
  // A real wide picture (the game's stored screenshot) makes a better backdrop than a blurred box cover: use it when it loads, and keep the cover's blur otherwise.
  const shot = cover.dataset.shot;
  if (shot) {
    const probe = new Image();
    probe.onload = () => { if (probe.naturalWidth >= 200 && hero.isConnected) { back.style.backgroundImage = `url("${shot}")`; hero.classList.add('has-shot'); } };
    probe.src = shot;
  }
  const fade = document.createElement('div'); fade.className = 'hero-fade';
  body.insertBefore(hero, body.firstChild);
  hero.append(back, fade);
  if (pills) hero.append(pills);
  hero.append(cover, actions);
  // if the cover fails to load, fall back to the colour backdrop so the header is never a black hole
  img?.addEventListener('error', () => { back.style.backgroundImage = ''; back.style.background = `linear-gradient(160deg, ${accent}66, #12141a)`; });
}
// The details strip is see-through at the top and picks up a soft back once the window has scrolled (so its buttons never sit on top of text).
document.addEventListener('scroll', (e) => { const d = e.target; if (d && d.id === 'drawer') document.querySelector('#drawer .drawer-bar')?.classList.toggle('is-scrolled', d.scrollTop > 8); }, true);
/** Settings: the row of settings inside a group starts directly under that group's icon (kept inside the screen on narrow windows). */
function alignSubtiles() {
  const row = $('#settings-subtiles'), act = $('#settings-tiles .tile.is-active');
  if (!row || !act || row.classList.contains('hidden') || !row.offsetWidth) return;
  const kids = [...row.children]; if (!kids.length) return;
  const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
  const need = kids.reduce((n, k) => n + k.offsetWidth, 0) + gap * (kids.length - 1);
  const want = act.getBoundingClientRect().left - row.getBoundingClientRect().left + (act.offsetWidth - kids[0].offsetWidth) / 2;
  const left = Math.max(0, Math.min(want, row.clientWidth - need));
  row.style.paddingLeft = `${Math.round(left)}px`;
}
window.addEventListener('resize', () => { if (isModern()) alignSubtiles(); });
export function iconize(root = document) {
  if (!isModern()) return;
  alignSubtiles();
  promoteDetailActions(root);
  buildDetailHero(root);
  for (const t of $$('.detail-actions [data-tip]', root)) { const tip = t.getAttribute('data-tip'); if (tip && t.title !== tip) t.title = tip; }
  for (const [sel, name] of ICON_MAP) {
    const hits = $$(sel, root);
    try { if (root.matches && root.matches(sel)) hits.push(root); } catch { /* not an element */ }
    for (const el of hits) {
      if (el.dataset.mi === name) continue;
      const label = el.getAttribute('title') || plainText(el);
      el.dataset.mi = name;
      if (!el.dataset.miLabel) el.dataset.miLabel = label;
      if (!el.getAttribute('title') && !el.getAttribute('data-tip')) el.setAttribute('title', label);
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', label);
      miRule(name);
    }
  }
  const hb = $('#bulk-hide-btn');   // Hide shows the hidden icon; Unhide (when looking at hidden games) shows the visible one
  if (hb) { const want = /unhide/i.test(hb.textContent) ? 'visible' : 'hidden'; if (hb.dataset.mi !== want) { if (!hb.dataset.miLabel) hb.dataset.miLabel = hb.getAttribute('title') || 'Hide selected'; hb.dataset.mi = want; if (!hb.getAttribute('aria-label')) hb.setAttribute('aria-label', hb.title || hb.dataset.miLabel); miRule(want); } }
  for (const el of $$('[data-mi]', root)) miRule(el.dataset.mi);   // icons named in templates (the Settings tiles)
}
/* ───────────── hover words in the app's font ───────────── */
function tipify(root = document) {
  if (!isModern()) return;
  const els = root.nodeType === 1 && root.hasAttribute?.('title') ? [root, ...$$('[title]', root)] : $$('[title]', root);
  for (const el of els) {
    if (el.closest?.('svg') || el.tagName === 'SVG' || el.tagName === 'IFRAME' || el.tagName === 'TITLE') continue;
    const t = el.getAttribute('title'); if (!t) continue;
    if (!el.hasAttribute('aria-label') && !(el.textContent || '').trim() && !el.querySelector?.('img[alt]:not([alt=""])')) el.setAttribute('aria-label', t);
    el.dataset.mtip = t; el.removeAttribute('title');
  }
}
/** Leaving Modern: put every title back, so Classic shows the browser's own tooltips as before. */
function untipify() { for (const el of $$('[data-mtip]')) { el.setAttribute('title', el.dataset.mtip); delete el.dataset.mtip; } $('#mb-tip')?.classList.remove('show'); }
let tipEl = null, tipTimer = null, tipFor = null;
function tipHide() { clearTimeout(tipTimer); tipFor = null; tipEl?.classList.remove('show'); }
function tipShow(el) {
  if (!isModern() || !el?.isConnected) return;
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.id = 'mb-tip'; tipEl.setAttribute('role', 'tooltip'); document.body.appendChild(tipEl); }
  tipEl.textContent = el.dataset.mtip || '';
  const r = el.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight, pad = 8;
  let left = r.left + r.width / 2 - w / 2; left = Math.max(pad, Math.min(left, innerWidth - w - pad));
  let top = r.bottom + 8; if (top + h > innerHeight - pad) top = Math.max(pad, r.top - h - 8);
  tipEl.style.left = Math.round(left) + 'px'; tipEl.style.top = Math.round(top) + 'px';
  tipEl.classList.add('show');
}
document.addEventListener('mouseover', (e) => {
  if (!isModern()) return;
  const el = e.target.closest?.('[data-mtip]'); if (el === tipFor) return;
  tipHide(); if (!el) return;
  tipFor = el; tipTimer = setTimeout(() => tipShow(el), 350);
});
document.addEventListener('focusin', (e) => { const el = e.target.closest?.('[data-mtip]'); if (el && isModern() && el.matches(':focus-visible')) { tipFor = el; tipShow(el); } });
for (const ev of ['mousedown', 'focusout', 'scroll', 'keydown', 'touchstart']) document.addEventListener(ev, tipHide, true);

let miTimer = null;
function watchIcons() {
  if (watchIcons.on) return; watchIcons.on = true;
  // Fetch every icon the page can use now, in the background, so they are ready before they are needed.
  for (const [, n] of ICON_MAP) miRule(n);
  for (const n of ['favourite', 'upload-cover', 'clear-reset', 'arrow-up', 'folder-enable', 'folder-disable']) miRule(n);
  // Runs in the same tick as the redraw (a microtask), before the browser paints, so the old word buttons are never seen.
  // Only the parts that were just added are checked, so a big redraw stays cheap.
  new MutationObserver((list) => {
    const roots = new Set();
    for (const r of list) for (const n of r.addedNodes) { const el = n.nodeType === 1 ? n : n.parentElement; if (el) roots.add(el); }
    for (const n of roots) if (n.isConnected) { iconize(n); tipify(n); }
    clearTimeout(miTimer); miTimer = setTimeout(() => { iconize(); tipify(); }, 250);   // safety net for anything missed
  }).observe(document.body, { childList: true, subtree: true });
  // A title set later by the app (a toggle's state, a count) is moved into the bubble too.
  new MutationObserver((list) => { for (const r of list) if (r.target.isConnected && r.target.hasAttribute('title')) tipify(r.target); })
    .observe(document.body, { attributes: true, attributeFilter: ['title'], subtree: true });
}

/* ───────────── switching look ───────────── */
export async function setUiMode(mode) {
  const next = mode === 'modern' ? 'modern' : 'classic';
  try { await api('/prefs/ui_mode', { method: 'PUT', body: JSON.stringify({ value: next }) }); } catch { /* still switch for this session */ }
  ctx.setPref?.('ui_mode', next);
  try { localStorage.setItem('gamesauce_last_look', next); } catch { /* private mode */ }
  await applyMode(next, { fresh: true });
}

/** Turn the look on or off for the signed-in person. */
export async function applyMode(mode, { fresh = false } = {}) {
  const on = mode === 'modern';
  document.body.classList.toggle('ui-modern', on);
  document.documentElement.dataset.theme = on ? theme() : 'dark';
  document.body.classList.toggle('ui-retro', on && retro());
  document.body.classList.toggle('ui-deep', on && deep());
  if (on) {
    await buildBar(); paintUser(); usePinIcon();
    applyRetro(retro()); applyDeep(deep());
    watchIcons(); iconize(); tipify();
    paintToggles();
    // A page refresh keeps you where you were: Library stays Library, Home stays Home. A fresh sign-in or a look switch starts at Home.
    let was = null; try { was = sessionStorage.getItem('gamesauce_mview'); } catch { /* storage unavailable */ }
    go(fresh ? 'home' : (ctx.state().view === 'library' ? (was === 'library' ? 'library' : 'home') : ctx.state().view));
  } else {
    untipify();
    restorePinIcon();
    hideHome();
    delete document.body.dataset.mview;
    ctx.setView(ctx.state().view === 'home' ? 'library' : ctx.state().view);
  }
}
