import { platformIconSvg, PLATFORM_ICON_TYPES, iconTypeFor } from './platform-icons.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

import * as modern from './modern.js';
import * as physical from './physical.js';
import * as digital from './digital.js';
import './video.js';   // the video in a game's details window
import * as carousel from './carousel.js';
import * as messages from './messages.js';
import './pwreveal.js';   // the eye in password boxes

const state = {
  view: 'library',
  platform: 'all',
  extraPlatforms: [],   // Modern chip row: more platforms picked alongside state.platform
  q: '',
  sort: 'title',
  density: 'comfortable',
  tag: null,
  genre: null,
  favorite: false,
  source: null,
  missing: false,
  hidden: false,
  system: false,
  orphan: false,
  locked: false,   // admin: only games locked with Keep
  unmatched: false,
  datStatus: null,
  cover: null,     // 'with' | 'none': from the Stats totals
  matched: null,   // 'yes' | 'no': from the Stats totals
  incl: null,      // 'all' (hidden and System games too) | 'hidden' (hidden games too): the Stats page counts them, so its links must
  selectMode: false,
  selected: new Set(),
  collections: [],
  openRomId: null,
  families: {},
  browsePath: null
};

/* Remember where the user is (view, platform, search, filters, sort, density, settings tile)
 * for this browser TAB, so a refresh puts them back instead of on the Library home.
 * sessionStorage: survives reload, not a new tab/browser; cleared on sign-in and sign-out. */
let activeSettingsModule = null; // which Settings tile is open (declared early: saveNav reads it)
const NAV_KEY = 'gamesauce_nav';
const NAV_FIELDS = ['platform', 'extraPlatforms', 'q', 'sort', 'density', 'tag', 'genre', 'favorite', 'source', 'sourceName',
  'missing', 'hidden', 'orphan', 'locked', 'unmatched', 'datStatus', 'cover', 'matched', 'incl'];
function saveNav() {
  try {
    const snap = { view: state.view, settingsModule: activeSettingsModule };
    for (const k of NAV_FIELDS) snap[k] = state[k];
    sessionStorage.setItem(NAV_KEY, JSON.stringify(snap));
  } catch { /* storage unavailable: refresh just starts at the Library */ }
}
function clearNav() { try { sessionStorage.removeItem(NAV_KEY); sessionStorage.removeItem('gamesauce_mview'); } catch { /* ignore */ } }
function readNav() {
  try { return JSON.parse(sessionStorage.getItem(NAV_KEY) || 'null'); } catch { return null; }
}

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** { busy: true } keeps the message on screen with a spinner until the next toast() replaces it. */
function toast(msg, bad = false, { busy = false } = {}) {
  const el = $('#toast');
  el.textContent = '';
  if (busy) { const sp = document.createElement('span'); sp.className = 'spin'; sp.setAttribute('aria-hidden', 'true'); el.append(sp); }
  el.append(document.createTextNode(msg));
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  clearTimeout(toast._t);
  if (!busy) toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * In-app confirm dialog — same look as the rest of the UI (no native popup).
 * Resolves true on Confirm, false on Cancel / scrim click / Escape.
 *
 *   const ok = await confirmDialog({ title, body, okLabel, danger });
 *   const ok = await confirmDialog({ title, body, checkLabel }); // resolves { ok, checked }
 */
function confirmDialog({ title = 'Are you sure?', body = '', okLabel = 'Confirm', danger = false, checkLabel = null } = {}) {
  const scrim = $('#modal-scrim');
  const titleEl = $('#modal-title');
  const bodyEl = $('#modal-body');
  const okBtn = $('#modal-ok');
  const cancelBtn = $('#modal-cancel');
  const checkWrap = $('#modal-check-wrap');
  const check = $('#modal-check');
  const checkLabelEl = $('#modal-check-label');

  titleEl.textContent = title;
  bodyEl.textContent = body;
  okBtn.textContent = okLabel;
  okBtn.classList.toggle('btn-danger', Boolean(danger));
  okBtn.classList.toggle('btn-primary', !danger);
  const withCheck = Boolean(checkLabel);
  checkWrap.classList.toggle('hidden', !withCheck);
  if (withCheck) { check.checked = false; checkLabelEl.textContent = checkLabel; }

  return new Promise((resolve) => {
    const done = (value) => {
      scrim.classList.add('hidden');
      okBtn.onclick = cancelBtn.onclick = scrim.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(withCheck ? { ok: value, checked: check.checked } : value);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    okBtn.onclick = () => done(true);
    cancelBtn.onclick = () => done(false);
    scrim.onclick = (e) => { if (e.target === scrim) done(false); };
    document.addEventListener('keydown', onKey);
    scrim.classList.remove('hidden');
    okBtn.focus();
  });
}

/**
 * In-app "set a password" dialog for an admin resetting someone else's. Shows the password in plain text
 * on purpose (the admin has to pass it on), with Generate and Copy. Resolves the password or null.
 */
function passwordDialog({ username }) {
  const scrim = $('#modal-scrim'), okBtn = $('#modal-ok'), cancelBtn = $('#modal-cancel');
  const wrap = $('#modal-input-wrap'), input = $('#modal-input'), hint = $('#modal-input-hint');
  $('#modal-title').textContent = 'Reset password';
  $('#modal-body').textContent = `Set a new password for ${username}. They are signed out everywhere and any sign-in lockout is cleared. Tell them the new password; they can change it under Settings → Change password.`;
  $('#modal-check-wrap').classList.add('hidden');
  wrap.classList.remove('hidden');
  input.value = ''; hint.textContent = 'At least 10 characters, with a letter and a number.'; hint.classList.add('pw-rule');
  okBtn.textContent = 'Set password'; okBtn.classList.add('btn-primary'); okBtn.classList.remove('btn-danger');
  const generate = () => {
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint32Array(14));
    input.value = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('') + '7';
  };
  return new Promise((resolve) => {
    const done = (value) => {
      scrim.classList.add('hidden'); wrap.classList.add('hidden'); input.value = '';
      okBtn.onclick = cancelBtn.onclick = scrim.onclick = input.onkeydown = null;
      $('#modal-input-gen').onclick = $('#modal-input-copy').onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const submit = () => {
      const v = input.value;
      if (v.length < 10 || !/[a-zA-Z]/.test(v) || !/[0-9]/.test(v)) { hint.textContent = 'Needs at least 10 characters, with a letter and a number.'; input.focus(); return; }
      done(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    okBtn.onclick = submit; cancelBtn.onclick = () => done(null);
    scrim.onclick = (e) => { if (e.target === scrim) done(null); };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
    $('#modal-input-gen').onclick = () => { generate(); hint.textContent = 'Generated. Copy it before you set it.'; };
    $('#modal-input-copy').onclick = async () => {
      if (!input.value) return;
      try { await navigator.clipboard.writeText(input.value); hint.textContent = 'Copied.'; } catch { input.select(); hint.textContent = 'Press Ctrl+C to copy.'; }
    };
    document.addEventListener('keydown', onKey);
    scrim.classList.remove('hidden');
    input.focus();
  });
}

/**
 * In-app choice dialog: same chrome as confirmDialog, but N named buttons
 * instead of OK/Cancel. Resolves the chosen id, or null on Cancel/scrim/Esc.
 * Used where a native confirm() abused "OK vs Cancel" to mean two different
 * destructive actions (e.g. remove-source keep-vs-purge).
 */
function confirmChoice({ title = 'Choose', body = '', choices = [] } = {}) {
  const scrim = $('#modal-scrim');
  const titleEl = $('#modal-title');
  const bodyEl = $('#modal-body');
  const okBtn = $('#modal-ok');
  const cancelBtn = $('#modal-cancel');
  const checkWrap = $('#modal-check-wrap');
  // Scoped to this dialog: other popups (collections) have their own .modal-actions earlier in the page.
  const actions = $('.modal-actions', scrim);

  titleEl.textContent = title;
  bodyEl.textContent = body;
  checkWrap.classList.add('hidden');

  // Swap the stock OK/Cancel for one button per choice + a cancel.
  const original = [...actions.children];
  actions.innerHTML = '';
  // onKey must live out here: cleanup() uses it, and a variable declared inside the Promise below is
  // not visible to it. (That scope slip made cleanup throw, so the popup never closed or answered.)
  let onKey = null;
  const cleanup = () => {
    scrim.classList.add('hidden'); // close first, so a failure below can never leave the popup stuck
    scrim.onclick = null;
    if (onKey) document.removeEventListener('keydown', onKey);
    actions.innerHTML = '';
    for (const el of original) actions.appendChild(el);
  };
  return new Promise((resolve) => {
    onKey = (e) => { if (e.key === 'Escape') { cleanup(); resolve(null); } };
    for (const c of choices) {
      const b = document.createElement('button');
      b.className = `btn${c.danger ? ' btn-danger' : ''}`;
      b.textContent = c.hint ? `${c.label} — ${c.hint}` : c.label;
      b.onclick = () => { cleanup(); resolve(c.id); };
      actions.appendChild(b);
    }
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-ghost';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => { cleanup(); resolve(null); };
    actions.appendChild(cancel);
    scrim.onclick = (e) => { if (e.target === scrim) { cleanup(); resolve(null); } };
    document.addEventListener('keydown', onKey);
    scrim.classList.remove('hidden');
    actions.querySelector('button')?.focus();
  });
}

function authHeader() {
  const token = sessionStorage.getItem('gamesauce_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: options.body instanceof FormData
      ? authHeader()
      : { 'Content-Type': 'application/json', ...authHeader() },
    ...options
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);

  // A dead session anywhere in the app drops straight back to the sign-in card
  // instead of leaving every panel showing a generic error.
  if (res.status === 401 && !path.startsWith('/auth/')) {
    showLogin();   // the sign-in card itself says it; no extra message
    throw new ApiError('Sign in required', 401);
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  return data;
}

/* ─────────────────────────── navigation ─────────────────────────── */

// Phone layout: the sidebar is a slide-in panel. Open with the menu button; closes on picking a page/platform, tapping outside, or Escape.
function setSidebar(open) {
  $('.sidebar')?.classList.toggle('open', open);
  $('#side-scrim')?.classList.toggle('show', open);
  $('#mobile-menu')?.setAttribute('aria-expanded', String(open));
}
document.addEventListener('click', (e) => {
  if (e.target.closest('#mobile-menu')) { setSidebar(!$('.sidebar').classList.contains('open')); return; }
  if (e.target.closest('#side-scrim')) { setSidebar(false); return; }
  if ($('.sidebar')?.classList.contains('open') && e.target.closest('.sidebar .nav-item, .sidebar .plat-item[data-platform], .sidebar #settings-gear')) setSidebar(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('.sidebar')?.classList.contains('open')) setSidebar(false); });

function setView(view) {
  // A pinned details window stays beside the games, but only the games it belongs to: a Steam game's details do not follow you
  // out of Digital, and a ROM's details do not follow you into it.
  // Physical is the same: its games' details stay in Physical, and a ROM's or a Steam game's do not follow you into it.
  if (!$('#drawer')?.classList.contains('hidden')) {
    const own = state.openDigital ? 'digital' : state.openPhysical != null ? 'physical' : 'library';
    if (own === 'library' ? (view === 'digital' || view === 'physical' || view === 'messages') : view !== own) closeDrawer();
  }
  state.view = view;
  saveNav();
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${view}`).classList.remove('hidden');

  if (view === 'library') loadLibrary();
  if (view === 'collections') loadCollections();
  if (view === 'upload') loadUploadPlatforms();
  if (view === 'sources') loadSources();
  if (view === 'settings') loadSettings();
  if (view === 'emulators') loadEmulators();
  if (view === 'digital') digital.load();
  if (view === 'physical') physical.load();
  if (view === 'messages') messages.load();
}

document.addEventListener('click', (e) => {
  const navBtn = e.target.closest('[data-view]');
  if (navBtn) {
    // The sidebar LIBRARY entry always means the whole library: drop any platform selection.
    if (navBtn.classList.contains('nav-item') && navBtn.dataset.view === 'library' && state.platform !== 'all') {
      state.platform = 'all';
      loadPlatforms();
    }
    if (navBtn.classList.contains('nav-item') && navBtn.dataset.view === 'library') state.libKey = null; // always start from the top
    setView(navBtn.dataset.view);
    // Clicking LIBRARY also goes back to the top of the grid (it scrolls itself, and so can the page around it).
    if (navBtn.classList.contains('nav-item') && navBtn.dataset.view === 'library') {
      const top = () => { const g = $('#grid'); if (g) g.scrollTop = 0; const v = $('#view-library'); if (v) v.scrollTop = 0; };
      top();
      setTimeout(top, 350); // again once the reload has re-rendered the tiles
    }
  }
});

// The cover carousel (full screen): opened from the Library bar, in Classic and in Modern.
// It starts where you are: the platform the Library shows, or the Steam games when you come from Digital.
function openCarouselView() {
  const start = state.view === 'digital' ? 'steam:installed' : (state.platform !== 'all' ? state.platform : null);
  carousel.openCarousel({ api, toast, platforms: () => window.__platformsCache || [], user: () => authState.user, openPlayer, platformIcon: platformIconSvg, start: { platform: start } });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#open-carousel, [data-open="carousel"]')) return;
  openCarouselView();
});

/* ─────────────────────────── sidebar ─────────────────────────── */

async function loadPlatforms() {
  const [{ items: all }, stats] = await Promise.all([api('/platforms'), api('/stats')]);
  // A play-only person only ever sees games that can be played in the browser, so the platform list (families and pills) shows only
  // platforms that have some, with counts of just those. Everyone else sees every platform, as before.
  const items = authState.user?.play_only
    ? all.map((p) => ({ ...p, count: p.playable_count || 0, visible_count: p.playable_count || 0 }))
    : all;
  window.__platformsCache = items; // names and colours for the heading above the tiles
  try { modern.renderChips(); } catch { /* Modern chips are optional */ }
  refreshSourcePlatformPicker(items);
  renderLibHeading();
  const list = $('#platform-list') || document.createElement('div');   // Classic no longer has a platform list down the left (the chips above the games do that job): this keeps the code below harmless
  const total = authState.user?.play_only ? items.reduce((n, p) => n + (p.count || 0), 0) : (stats.library.roms || 0);

  // Group the platforms that actually have ROMs under their family, so a
  // 50-platform catalogue stays readable instead of one long flat list.
  // Families and platforms both render A→Z regardless of seed order, so the
  // sidebar matches the dropdowns instead of wandering (Nintendo before
  // Microsoft, Others before Arcade…).
  const sorter = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
  const families = new Map();
  for (const p of items.filter((x) => x.count > 0)) {
    const fam = p.family || 'Others';
    if (!families.has(fam)) families.set(fam, []);
    families.get(fam).push(p);
  }
  for (const plats of families.values()) plats.sort((a, b) => sorter(a.name, b.name));
  const orderedFamilies = [...families.entries()].sort(([a], [b]) => sorter(a, b));

  // Family rows use the same visual weight as "All platforms" so the groups
  // read as headings you can click, not as faint captions.
  let html = `
    <button class="plat-item plat-all ${state.platform === 'all' ? 'is-active' : ''}" data-platform="all">
      <span class="plat-dot" style="background:linear-gradient(135deg,#7c5cff,#4f2fd6)"></span>
      <span class="plat-name">ALL PLATFORMS</span>
      <span class="plat-count">${total}</span>
    </button>`;

  for (const [family, plats] of orderedFamilies) {
    const collapsed = state.families[family] === false;
    const familyCount = plats.reduce((n, p) => n + p.count, 0);
    html += `
      <button class="plat-item family-head ${collapsed ? 'is-collapsed' : ''}" data-family="${esc(family)}" title="Show/hide ${esc(family)}">
        <span class="chev">${collapsed ? '▸' : '▾'}</span>
        <span class="plat-name">${esc(String(family).toUpperCase())}</span>
        <span class="plat-count">${familyCount}</span>
      </button>
      <div class="family-group ${collapsed ? 'collapsed' : ''}" data-family-group="${esc(family)}">
        ${plats.map((p) => `
          <button class="plat-item ${state.platform === p.slug ? 'is-active' : ''}" data-platform="${p.slug}" title="${esc(p.name)}">
            <span class="plat-ico-wrap">${platformIconSvg(p, 16)}</span>
            <span class="plat-name">${esc(String(p.short_name).toUpperCase())}</span>
            <span class="plat-count">${p.count}</span>
          </button>`).join('')}
      </div>`;
  }

  list.innerHTML = html;

  $$('.plat-item', list).forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.family) {
      // Collapse/expand a family, no filtering.
      const fam = btn.dataset.family;
      state.families[fam] = state.families[fam] === false;
      loadPlatforms();
      return;
    }
    state.platform = btn.dataset.platform;
    state.extraPlatforms = [];   // the sidebar picks one platform; clear any chip-row extras
    loadPlatforms();
    if (state.view !== 'library') setView('library'); else loadLibrary();
  }));

  const usage = $('#storage-usage');
  if (usage) {
    const missing = stats.library.missing || 0;
    const orphaned = stats.library.orphaned || 0;
    const neverEnriched = stats.library.never_enriched || 0;
    window.__orphanCount = orphaned;
    window.__unmatchedCount = neverEnriched;
    usage.innerHTML = `${fmtBytes(stats.library.bytes)} across ${stats.library.roms} ROMs
      ${missing ? `<span class="pill warn" style="margin-left:6px">${missing} missing</span>` : ''}
      ${orphaned ? `<span class="pill bad" style="margin-left:6px" title="ROMs with no valid source folder">${orphaned} orphaned</span>` : ''}
      ${neverEnriched ? `<span class="pill warn" style="margin-left:6px" title="ROMs no provider has ever matched">${neverEnriched} need match</span>` : ''}
      <div class="usage-bar"><i style="width:${Math.min(100, (stats.library.bytes / (50 * 1024 ** 3)) * 100)}%"></i></div>`;
  }
  syncOrphanToggle();
  syncUnmatchedToggle();
  document.querySelector('[data-toggle="locked"]')?.classList.toggle('hidden', authState.user?.role !== 'admin');
}

/* ─────────────────────────── library ─────────────────────────── */

/** "Nintendo Entertainment System" heading above the tiles when one platform is selected. */
function renderLibHeading() {
  const box = $('#lib-heading');
  if (!box) return;
  const total = ($('#result-count')?.textContent || '').trim();
  // Modern: the heading line above the grid always shows, with the filtered total beside the platform name (Classic keeps its own layout).
  if (document.body.classList.contains('ui-modern') && (state.platform === 'all' || state.orphan || state.unmatched || state.locked)) {
    box.classList.remove('hidden');
    box.innerHTML = `<h2>${state.platform === 'all' ? 'All platforms' : 'Games'}</h2><span class="lib-total">${esc(total)}</span>`;
    return;
  }
  if (state.platform === 'all' || state.orphan || state.unmatched) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const p = (window.__platformsCache || []).find((x) => x.slug === state.platform);
  const cache = window.__platformsCache || [];
  const picked = [state.platform, ...(state.extraPlatforms || [])];
  // One platform picked and it has a logo: show it in a fixed-size box, so the heading never changes height or width with the picture.
  const logoOf = picked.length === 1 && p?.logo_v ? `<span class="lib-logo${p.logo_plate ? ' on-plate' : ''}"><img src="/api/platforms/${encodeURIComponent(p.slug)}/logo?v=${p.logo_v}" alt="" onerror="this.remove()" /></span>` : '';
  const fam = cache.find((x) => x.slug === picked[0])?.family;
  const sameFam = picked.length > 1 && picked.every((s) => cache.find((x) => x.slug === s)?.family === fam);
  const famRow = cache.find((x) => x.slug === picked[0]);
  const famLogo = sameFam && famRow?.family_logo_v ? `<span class="lib-logo${famRow.family_logo_plate ? ' on-plate' : ''}"><img src="/api/platforms/families/logo?family=${encodeURIComponent(fam)}&v=${famRow.family_logo_v}" alt="" onerror="this.remove()" /></span>` : '';
  // Several platforms: the family's logo if the picks are all one family and it has one; otherwise a dot in the family's colour (not the first platform's).
  const dotColour = picked.length > 1 && sameFam ? (famRow?.family_colour || 'var(--accent)') : (p?.accent || 'var(--accent)');
  const famAll = fam ? cache.filter((x) => x.count > 0 && x.family === fam).map((x) => x.slug) : [];
  const wholeFam = picked.length > 1 && famAll.length === picked.length && famAll.every((s) => picked.includes(s));
  const names = picked.map((s) => cache.find((x) => x.slug === s)?.name || s);
  const name = wholeFam ? `${fam} (all platforms)` : names.length > 3 ? `${names.length} platforms` : names.join(' + ');
  box.classList.remove('hidden');
  box.innerHTML = `
    ${logoOf || famLogo || `<span class="lib-dot" style="background:${esc(dotColour)}"></span>`}
    <h2>${esc(name)}</h2>
    <span class="lib-total">${esc(total)}</span>
    <button class="btn btn-sm btn-ghost lib-clear" id="lib-clear-platform" title="Show every platform again">✕ All platforms</button>`;
  $('#lib-clear-platform').onclick = () => { state.platform = 'all'; state.extraPlatforms = []; loadPlatforms(); loadLibrary(); };
}

/** Is anything narrowing the Library right now (a search, a platform, a filter)? Sort and density are looks, not filters. */
function filtersActive() {
  return Boolean(state.q || state.platform !== 'all' || (state.extraPlatforms || []).length || state.tag || state.genre || state.favorite
    || state.source || state.missing || state.hidden || state.system || state.orphan || state.locked || state.unmatched
    || state.datStatus || state.cover || state.matched || state.incl);
}
/** Back to the whole library: search cleared, every platform and filter off. Sort and tile size stay as the person set them. */
async function resetFilters() {
  state.azOffset = 0; state.azLetter = null; state.azFor = null;   // the list starts at its beginning again
  Object.assign(state, { platform: 'all', extraPlatforms: [], q: '', tag: null, genre: null, favorite: false, source: null, sourceName: null,
    missing: false, hidden: false, system: false, orphan: false, locked: false, unmatched: false, datStatus: null, cover: null, matched: null, incl: null, libKey: null });
  const sb = $('#search'); if (sb) sb.value = '';
  const tq = $('#tl-q'); if (tq) tq.value = '';
  const g = $('#grid'); if (g) g.scrollTop = 0;
  await Promise.all([loadLibrary(), loadPlatforms()]);
  window.dispatchEvent(new Event('gs:filters'));
}

function activeFilterChips() {
  renderLibHeading();
  document.querySelector('#reset-filters')?.classList.toggle('hidden', !filtersActive());
  setTimeout(() => window.dispatchEvent(new Event('gs:filters')), 0);
  const chips = [];
  if (state.tag) chips.push({ label: `Tag: ${state.tag}`, clear: () => { state.tag = null; } });
  if (state.genre) chips.push({ label: `Genre: ${state.genre}`, clear: () => { state.genre = null; } });
  if (state.favorite) chips.push({ label: 'Favorites only', clear: () => { state.favorite = false; } });
  if (state.source) chips.push({ label: `Source: ${state.sourceName || state.source}`, clear: () => { state.source = null; state.sourceName = null; } });
  if (state.missing) chips.push({ label: 'Missing files', clear: () => { state.missing = false; } });
  if (state.datStatus) chips.push({ label: `DAT: ${state.datStatus}`, clear: () => { state.datStatus = null; } });
  if (state.incl) chips.push({ label: state.incl === 'all' ? 'Including hidden and System games' : 'Including hidden games', clear: () => { state.incl = null; } });
  if (state.cover) chips.push({ label: state.cover === 'none' ? 'No cover' : 'With a cover', clear: () => { state.cover = null; } });
  if (state.matched) chips.push({ label: state.matched === 'yes' ? 'Matched by a provider or DAT' : 'Name from the file only', clear: () => { state.matched = null; } });
  if (state.hidden) chips.push({ label: 'Hidden only', clear: () => { state.hidden = false; } });
  if (state.system) chips.push({ label: 'System entries', clear: () => { state.system = false; } });
  if (state.unmatched) chips.push({ label: 'Needs match', clear: () => { state.unmatched = false; loadLibrary(); } });
  if (state.locked) chips.push({ label: 'Locked games', clear: () => { state.locked = false; loadLibrary(); } });
  if (state.orphan) chips.push({ label: 'Not in any source', clear: () => { state.orphan = false; loadLibrary(); } });

  const wrap = $('#active-filters');
  wrap.innerHTML = chips.map((c, i) => `<span class="chip">${esc(c.label)}<button data-chip="${i}">✕</button></span>`).join('');
  $$('[data-chip]', wrap).forEach((b) => b.addEventListener('click', () => {
    chips[Number(b.dataset.chip)].clear();
    loadPlatforms();
    loadLibrary();
  }));
}

function cardHtml(rom) {
  const initials = rom.title.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  // Only real files get an <img>. A failed load leaves the initials fallback
  // underneath rather than an empty box.
  const cover = rom.cover_url
    ? `<img loading="lazy" src="${esc(rom.cover_url)}" alt="" onload="this.previousElementSibling?.classList.add('has-cover')" onerror="this.style.display='none'" />`
    : '';
  return `
    <div class="card" data-rom="${rom.id}" role="button" tabindex="0">
      <div class="card-cover" style="background:linear-gradient(160deg,${rom.platform_accent}22,#12141a)">
        <div class="card-fallback">${esc(initials)}</div>
        ${cover}
        <span class="card-select" data-select="${rom.id}" role="checkbox" title="Select for bulk delete"></span>
        <span class="card-badge" style="background:${rom.platform_accent}cc">${esc(rom.platform_badge ? String(rom.platform_badge).toUpperCase() : rom.platform_short)}</span>
        ${rom.playable ? `<span class="card-play" title="Playable in the browser" aria-label="Playable in the browser">${ICON.gamepad}</span>` : ''}
        ${rom.playable && !rom.missing ? `<button type="button" class="card-playbtn" tabindex="-1" data-play="${rom.id}" title="Play in browser" aria-label="Play ${esc(rom.title)} in browser">▶</button>` : ''}
        ${rom.missing ? '<span class="card-missing">missing</span>' : ''}
        ${rom.dat_status && rom.dat_status !== 'not-in-dat' ? `<span class="badge-dat ${rom.dat_status === 'verified' ? '' : rom.dat_status}" title="DAT: ${rom.dat_status}">${rom.dat_status}</span>` : ''}
        ${rom.keep_override === 1 ? `<span class="card-lock" title="Locked: protected from deletion" aria-label="Locked">${ICON.keepOn}</span>` : ''}
        <button type="button" class="card-fav ${rom.favorite ? 'on' : ''}" data-fav="${rom.id}" tabindex="-1" title="${rom.favorite ? 'Remove from favourites' : 'Add to favourites'}" aria-label="Favourite">${rom.favorite ? ICON.starFill : ICON.star}</button>
        <button type="button" class="card-hide" data-hide="${rom.id}" tabindex="-1" title="${rom.hidden ? 'Unhide' : (authState.user?.role === 'admin' ? 'Hide (members will not see it either)' : 'Hide from your view')}" aria-label="${rom.hidden ? 'Unhide' : 'Hide'}">${rom.hidden ? ICON.eye : ICON.eyeOff}</button>
        ${rom.hidden ? '<span class="card-hidden-veil">hidden</span>' : ''}
      </div>
      <div class="card-title">${esc(rom.title)}</div>
      <div class="card-sub">
        ${rom.release_year ? `<span>${rom.release_year}</span>` : ''}
        ${rom.region ? `<span>·</span><span>${esc(rom.region)}</span>` : ''}
      </div>
    </div>
  `;
}

async function loadLibrary() {
  saveNav();
  // Orphan-only and unmatched-only modes from the Database tools buttons take
  // over the grid without touching the user's filters — deliberate detours, so
  // normal browsing state is preserved underneath.
  const orphanOnly = state.orphan === true;
  const lockedOnly = state.locked === true && authState.user?.role === 'admin';
  const unmatchedOnly = state.unmatched === true;
  const grid = $('#grid');
  if (!grid.dataset.primed) {
    grid.innerHTML = Array.from({ length: 12 }, () => '<div class="skel skel-card"></div>').join('');
  }

  // The overview strip + recent row only make sense on the unfiltered library
  // home (no search, no filters). Any active filter hides them so the grid
  // owns the full height.
  if (state.platform === 'all') state.extraPlatforms = [];
  const isHome = !state.q && state.platform === 'all' && !state.tag && !state.genre &&
    !state.favorite && !state.source && !state.missing && !state.datStatus && !state.cover && !state.matched && !state.incl &&
    !state.hidden && !state.system && !orphanOnly && !unmatchedOnly && !lockedOnly;
  $('#lib-overview')?.classList.toggle('hidden', !isHome);
  $('#lib-recent-wrap')?.classList.toggle('hidden', !isHome);
  if (!isHome) $('#lib-played-wrap')?.classList.add('hidden');
  else renderPlayedRow();
  const statsP = isHome ? renderOverview().catch(() => {}) : Promise.resolve();

  const PAGE = 200; // server caps at 500; further pages load on scroll (see below)
  const params = new URLSearchParams({ sort: state.sort, limit: String(PAGE) });
  if (state.q && !orphanOnly && !unmatchedOnly) params.set('q', state.q);
  if (state.platform !== 'all' && !orphanOnly && !unmatchedOnly) params.set('platform', [state.platform, ...(state.extraPlatforms || [])].join(','));
  if (state.tag) params.set('tag', state.tag);
  if (state.genre) params.set('genre', state.genre);
  if (state.favorite) params.set('favorite', '1');
  if (authState.user?.play_only) params.set('playable', '1'); // a play-only account only ever sees games it can play
  if (state.source && !orphanOnly && !unmatchedOnly) params.set('source', state.source);
  if (state.missing) params.set('missing', '1');
  if (state.datStatus) params.set('dat_status', state.datStatus);
  if (state.incl && !orphanOnly && !unmatchedOnly && !state.system && !state.hidden) { params.set('hidden', 'all'); if (state.incl === 'all') params.set('system', 'all'); }
  if (state.cover) params.set('cover', state.cover === 'none' ? '0' : '1');
  if (state.matched) params.set('matched', state.matched === 'yes' ? '1' : '0');
  if (unmatchedOnly) { params.set('unmatched', 'only'); params.set('hidden', 'all'); }
  else if (orphanOnly) { params.set('orphan', 'only'); params.set('hidden', 'all'); }
  else if (lockedOnly) { params.set('locked', '1'); params.set('hidden', 'all'); params.set('system', 'all'); }
  else if (state.system) params.set('system', 'only');
  else if (state.hidden) params.set('hidden', 'only');

  // Remember the active query (minus paging) so Select all can walk the whole result set.
  state.libQuery = new URLSearchParams(params);
  state.libQuery.delete('limit'); state.libQuery.delete('offset');
  // A-Z jump: when a letter was picked for exactly this list, the grid starts at that letter's first game (one request, no scrolling through
  // everything before it). Any other change of search, filter or sort puts the list back at its beginning.
  if (state.azFor !== state.libQuery.toString() + '|' + state.sort) state.azOffset = 0;
  const azBase = state.azOffset || 0;
  if (azBase) params.set('offset', String(azBase));

  // Same filters as the last render (hide, refresh, favourite…): keep the reader's place by reloading
  // as many tiles as were showing and restoring the scroll position afterwards.
  const libKey = state.libQuery.toString() + '|' + azBase;
  const keepPlace = grid.dataset.primed && state.libKey === libKey && (state.libLoadedCount?.() || 0) > 0;
  const wantLoaded = keepPlace ? state.libLoadedCount() : 0;
  if (keepPlace) params.set('limit', String(Math.min(500, Math.max(PAGE, wantLoaded))));
  state.libKey = libKey;

  let data;
  try {
    data = await api(`/roms?${params}`);
  } catch (err) {
    grid.innerHTML = '';
    toast(err.message, true);
    return;
  }

  const keepTop = keepPlace ? grid.scrollTop : 0;
  if (!keepPlace) grid.scrollTop = 0;
  grid.dataset.primed = '1';
  grid.className = `grid ${state.density === 'compact' ? 'compact' : ''}${state.selectMode ? ' selecting' : ''}`;
  grid.innerHTML = data.items.map(cardHtml).join('');

  // Grid interactions are wired per id, so factor the binding out: both the
  // main grid and the recent row reuse it for identical tile behaviour.
  bindCards(grid);

  // Infinite scroll: the old fixed 400-tile request silently hid everything past it.
  // A full-width sentinel at the end loads the next page when it scrolls into view.
  const token = (state.libToken = (state.libToken || 0) + 1);
  state.libObserver?.disconnect();
  state.libObserver = null;
  state.libLoadMore = null;
  let loaded = data.items.length;
  state.libTotal = data.total;
  state.libLoadedCount = () => loaded;
  if (azBase + loaded < data.total) {
    const sentinel = document.createElement('div');
    sentinel.style.cssText = 'grid-column:1/-1;height:1px';
    grid.appendChild(sentinel);
    let busy = false;
    let obs = null;
    // Also used by the detail drawer's "next" arrow when it runs off the end of the loaded tiles.
    const loadMore = async () => {
      if (busy || token !== state.libToken) return false;
      busy = true;
      try {
        params.set('offset', String(azBase + loaded));
        const more = await api(`/roms?${params}`);
        if (token !== state.libToken) return false; // a newer load replaced this grid
        const tmp = document.createElement('div');
        tmp.innerHTML = more.items.map(cardHtml).join('');
        bindCards(tmp);
        sentinel.before(...tmp.children);
        loaded += more.items.length;
        syncSelectUI();
        if (!more.items.length || azBase + loaded >= more.total) {
          obs?.disconnect(); sentinel.remove();
          if (state.libLoadMore === loadMore) state.libLoadMore = null;
        }
        return more.items.length > 0;
      } catch (err) { toast(err.message, true); return false; }
      finally { busy = false; }
    };
    obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    }, { rootMargin: '600px' });
    obs.observe(sentinel);
    state.libObserver = obs;
    state.libLoadMore = loadMore;
  }
  // Past the server's 500-per-request cap: fetch the remaining pages so the old scroll position exists again.
  if (keepPlace) {
    while (state.libLoadMore && loaded < wantLoaded && token === state.libToken) { if (!(await state.libLoadMore())) break; }
    grid.scrollTop = keepTop;
    requestAnimationFrame(() => { grid.scrollTop = keepTop; });
  }
  try { await statsP; } catch { /* overview is decorative */ }

  $('#result-count').textContent = lockedOnly
    ? `${data.total} locked game${data.total === 1 ? '' : 's'}${state.q ? ` matching “${state.q}”` : ''}`
    : state.orphan
    ? `${data.total} orphaned ROM${data.total === 1 ? '' : 's'} (no valid source)`
    : state.unmatched
      ? `${data.total} unmatched ROM${data.total === 1 ? '' : 's'} (no provider hit yet)`
      : `${data.total} ${data.total === 1 ? 'ROM' : 'ROMs'}${state.q ? ` matching “${state.q}”` : ''}`;
  $('#empty').classList.toggle('hidden', data.items.length > 0);

  activeFilterChips();
  syncFilterToggles();
  syncSelectUI();
}

/**
 * Overview banner (library home only): games, platforms, my favourites, total
 * downloads, most-downloaded game (system-wide), and an emulator-update alert,
 * shown ONE AT A TIME in a bordered rounded box that rolls up every few
 * seconds. Favourites/downloads are per-user; most-downloaded is system-wide.
 * The alert names no build — just a nudge to the Emulators view.
 */
let emuUpdatesCache = null;
let overviewTimer = null;

async function renderOverview() {
  const box = $('#lib-overview');
  if (!box) return;
  const stats = await api('/stats');
  const lib = stats.library || {};
  const mine = stats.mine || { favorites: 0 };
  const top = stats.topDownloaded || null;

  // Classic has no rolling strip any more (Modern has its own ticker in the top bar): only the Recently added row is drawn.
  if (!document.body.classList.contains('ui-modern')) { clearInterval(overviewTimer); box.innerHTML = ''; box.classList.add('hidden'); paintRecentRow(stats); return; }

  let emuAlert = '';
  try {
    if (!emuUpdatesCache) emuUpdatesCache = api('/emulators/updates').catch(() => ({ updates: [] }));
    const { updates = [] } = await emuUpdatesCache;
    if (updates.length) {
      const n = updates.length;
      const newer = updates.filter((u) => u.kind === 'newer').length;
      emuAlert = `
        <button class="overview-card" data-slide data-view="emulators" title="Head to Emulators to see which builds">
          <span class="ov-ico">🎮</span>
          <span><b>${n}</b> emulator update${n === 1 ? '' : 's'}${newer ? ` · <span class="ov-sub">${newer} newer than vault</span>` : ''}</span>
        </button>`;
    }
  } catch { /* GitHub flakiness never breaks the library home */ }

  // Every slide uses the SAME structure/style (the "my favourites" one):
  // icon + bold number + plain label. No per-slide colours or badges.
  const slides = [
    `<div class="overview-card" data-slide><span class="ov-ico">🕹</span><span><b>${lib.roms || 0}</b> games</span></div>`,
    `<div class="overview-card" data-slide><span class="ov-ico">▦</span><span><b>${lib.platforms || 0}</b> platforms</span></div>`,
    `<button class="overview-card" data-slide data-ov-favs title="Show my favourites"><span class="ov-ico">★</span><span><b>${mine.favorites || 0}</b> my favourites</span></button>`,
    top ? `<button class="overview-card" data-slide data-open-rom="${top.id}" title="Most downloaded game — open it"><span class="ov-ico">⤓</span><span><b>${Number(top.dl_count).toLocaleString()}×</b> ${esc(top.title)} <span class="ov-sub">(${esc(top.platform_short)})</span></span></button>` : '',
    emuAlert
  ].filter(Boolean);

  // One-at-a-time: show only the first slide, then rotate the rest under it.
  box.innerHTML = `
    <div class="overview-trackbox">
      <div class="overview-track" id="ov-track">
        ${slides.join('')}
      </div>
    </div>`;
  box.classList.remove('hidden');

  // Wire slide actions (favs / most-downloaded / emulators nudge).
  $('[data-ov-favs]', box)?.addEventListener('click', () => {
    state.platform = 'all'; state.q = '';
    $('#search').value = '';
    state.favorite = true;
    loadPlatforms(); loadLibrary();
  });
  $('[data-open-rom]', box)?.addEventListener('click', () => openDetail(Number($('[data-open-rom]', box).dataset.openRom)));
  $('[data-view="emulators"]', box)?.addEventListener('click', () => setView('emulators'));

  // Rolling rotation: translate the track up by one slide-height per step and
  // loop. The frame box clips to a single slide (height 40px in styles.css —
  // keep SLIDE_H in sync with that box height).
  const track = $('#ov-track');
  // Measured, not hard-coded: the root font size is fluid (rem), so the slide
  // height changes with the window.
  const cards = $$('.overview-card', track);
  clearInterval(overviewTimer);
  if (cards.length > 1) {
    let i = 0;
    overviewTimer = setInterval(() => {
      i = (i + 1) % cards.length;
      track.style.transform = `translateY(-${i * (cards[0].offsetHeight + parseFloat(getComputedStyle(cards[0]).marginBottom || 0))}px)`;
    }, 3500);
  }

  paintRecentRow(stats);
}

/** The recent-12 row: same tiles as the grid, same behaviour via bindCards. */
function paintRecentRow(stats) {
  const recent = stats.recent || [];
  const wrap = $('#lib-recent-wrap');
  const row = $('#recent-row');
  if (wrap && row) {
    if (!recent.length) wrap.classList.add('hidden');
    else {
      wrap.classList.remove('hidden');
      row.innerHTML = recent.map(cardHtml).join('');
      bindCards(row);
    }
  }
}

/* Collapsible home rows. The open/closed choice is remembered per browser. */
const STRIP_KEY = 'gamesauce_strips';
function stripState(shortWindowDefault = true) {
  let st = {};
  try { st = JSON.parse(localStorage.getItem(STRIP_KEY) || '{}'); } catch { /* ignore */ }
  // Until the user chooses, start collapsed on short windows so the main grid keeps its room.
  if (shortWindowDefault && window.innerHeight < 860) for (const k of ['played', 'recent']) if (!st[k]) st[k] = 'closed';
  return st;
}
// `scope` limits it to one container; on Modern Home there is no grid below to save room for, so a short window does not collapse them.
function applyStrips(scope = document, shortWindowDefault = true) {
  const st = stripState(shortWindowDefault);
  $$('.strip', scope).forEach((el) => {
    const closed = st[el.dataset.strip] === 'closed';
    el.classList.toggle('collapsed', closed);
    $('[data-strip-toggle]', el)?.setAttribute('aria-expanded', closed ? 'false' : 'true');
  });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-strip-toggle]');
  if (!b) return;
  const onModernHome = Boolean(b.closest('.modern-home'));
  const st = stripState(!onModernHome);
  const key = b.dataset.stripToggle;
  st[key] = st[key] === 'closed' ? 'open' : 'closed';
  try { localStorage.setItem(STRIP_KEY, JSON.stringify(st)); } catch { /* private mode: still toggles for this page */ }
  applyStrips();
  if (onModernHome) applyStrips(b.closest('.modern-home'), false);
});
applyStrips();

/** "Continue playing": this user's recently played games, newest first. */
async function renderPlayedRow() {
  const wrap = $('#lib-played-wrap');
  const row = $('#played-row');
  if (!wrap || !row) return;
  try {
    const { items } = await api('/roms/recently-played?limit=12');
    if (!items.length) { wrap.classList.add('hidden'); row.innerHTML = ''; return; }
    wrap.classList.remove('hidden');
    row.innerHTML = items.map(cardHtml).join('');
    bindCards(row);
  } catch { wrap.classList.add('hidden'); /* decorative: never break the home page */ }
}

/** Shared tile wiring for the main grid and the recent row. */
function bindCards(root) {
  $$('.card', root).forEach((card) => card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      state.navSnap = null; state.nav = { el: card.closest('#grid, #recent-row, #played-row') || root };
      openDetail(Number(card.dataset.rom));
    }
  }));

  $$('.card', root).forEach((card) => card.addEventListener('click', (e) => {
    const id = Number(card.dataset.rom);
    // The recent row is browse-only: no bulk-select checkboxes there.
    const inRecent = root.id === 'recent-row' || root.id === 'played-row';
    // In select mode a tile tap toggles selection instead of opening detail.
    const selectBox = e.target.closest('[data-select]');
    if ((state.selectMode || selectBox) && !inRecent) {
      e.stopPropagation();
      toggleSelect(id);
      return;
    }
    const play = e.target.closest('[data-play]');
    if (play) {
      e.stopPropagation();
      // Fullscreen must be requested inside the click gesture, so open the
      // overlay first; openPlayer needs the full row (platform name etc.).
      api(`/roms/${id}`).then(openPlayer).catch((err) => toast(err.message, true));
      return;
    }
    const fav = e.target.closest('[data-fav]');
    if (fav) {
      e.stopPropagation();
      toggleFavorite(Number(fav.dataset.fav), fav);
      return;
    }
    const hide = e.target.closest('[data-hide]');
    if (hide) {
      e.stopPropagation();
      toggleHidden(Number(hide.dataset.hide));
      return;
    }
    const openBtn = e.target.closest('[data-open-rom]');
    if (openBtn) return; // handled by its own listener, don't double-open
    // Prev/next walks the list this tile lives in (main grid or the recently-added row).
    state.navSnap = null; state.nav = { el: card.closest('#grid, #recent-row, #played-row') || root };
    openDetail(id);
  }));

  // Most-downloaded overview tile carries its own id (it lives outside .card).
  $$('[data-open-rom]', root).forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.navSnap = null; state.nav = null;
    openDetail(Number(btn.dataset.openRom));
  }));
}

/* ─────────────────────────── in-browser play (EmulatorJS) ─────────────────────────── */

/**
 * Optional extra: stream the ROM to the browser and run it in EmulatorJS
 * (libretro cores as WebAssembly). Only offered for BIOS-free platforms.
 *
 * Architecture notes (both learned the hard way):
 *  - EJS_core is the SYSTEM id ('segaMD', 'nes', …), not a core filename.
 *  - EJS_gameUrl must end in the real filename: EmulatorJS sniffs the system
 *    from the URL extension.
 *  - The player lives in a same-origin IFRAME (ejs-player.html), not the main
 *    page. Upstream cannot unload a WASM instance without a page reload, so
 *    closing the overlay only has to drop the frame: the emulator, its audio
 *    context and its cores die with it. No ghost audio, no stale globals.
 *  - 'latest' CDN channel, not 'stable': carries the upstream gamepad-index
 *    fix (Chrome/Brave leaving slot 0 empty broke all pad input on stable).
 */
let playerFrame = null;

/* Per-user save states + battery saves (stored server-side, scoped to the
 * signed-in user). Shown in the ROM drawer for browser-playable games. */
async function renderSavesSection(rom, drawer) {
  let items = [];
  try { items = (await api(`/roms/${rom.id}/saves`)).items; } catch { return; }
  if (state.openRomId !== rom.id) return;
  const host = document.createElement('div');
  host.className = 'saves-section';
  const fmt = (t) => new Date(t.replace(' ', 'T') + 'Z').toLocaleString();
  host.innerHTML = `
    <div class="section-label">My saves (browser play)</div>
    ${items.length ? items.map((s) => `
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:6px">
        ${s.has_screenshot ? `<img alt="" style="width:64px;height:48px;object-fit:cover;border-radius:4px" src="/api/roms/${rom.id}/saves/${s.id}/screenshot">` : '<div style="width:64px;height:48px;background:#000;border-radius:4px"></div>'}
        <div style="flex:1;font-size:12.5px"><b>${s.kind === 'battery' ? 'In-game save' : 'Save state'}</b><br><span class="note">${esc(fmt(s.updated_at))} · ${Math.round(s.size_bytes / 1024)} KB${s.core ? ` · ${esc(s.core)}` : ''}</span></div>
        <button class="btn btn-sm" data-save-del="${s.id}">Delete</button>
      </div>`).join('') : '<div class="side-empty">No saves yet — use Save state inside the player.</div>'}`;
  const anchor = $('.detail-actions', drawer);
  // In Modern the action icons live inside the header block (.detail-hero); the saves go after the title that follows it, not inside the header.
  const hero = anchor?.closest('.detail-hero');
  if (hero) (hero.nextElementSibling || hero).insertAdjacentElement(hero.nextElementSibling ? 'afterend' : 'afterend', host);
  else anchor?.insertAdjacentElement('afterend', host);
  $$('[data-save-del]', host).forEach((b) => b.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Delete this save?', body: 'This cannot be undone.', okLabel: 'Delete', danger: true });
    if (!ok) return;
    await api(`/roms/${rom.id}/saves/${b.dataset.saveDel}`, { method: 'DELETE' });
    host.remove();
    renderSavesSection(rom, drawer);
  }));
}
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'saves-changed') return;
  if (state.openRomId === e.data.rom) {
    const d = $('#drawer');
    $('.saves-section', d)?.remove();
    api(`/roms/${e.data.rom}`).then((r) => renderSavesSection(r, d)).catch(() => {});
  }
});

function closePlayer() {
  // Dropping the frame is the whole teardown: WASM memory, the audio
  // context, the polling loop and the loader globals live inside it.
  // innerHTML='' alone leaves the frame alive — that was the ghost audio.
  if (playerFrame) {
    try { playerFrame.src = 'about:blank'; } catch { /* already gone */ }
    playerFrame.remove();
    playerFrame = null;
  }
  const host = $('#player-game');
  if (host) host.innerHTML = '';
  $('#player-scrim')?.classList.add('hidden');
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  // The game just played moves to the front of "Continue playing".
  if (state.view === 'library' && !$('#lib-played-wrap')?.closest('.hidden')) renderPlayedRow?.();
}

async function openPlayer(rom) {
  if (!rom.playable) {
    toast('In-browser play is not available for this platform — use a vault emulator instead', true);
    return;
  }
  const scrim = $('#player-scrim');
  scrim?.classList.remove('hidden');
  // Real fullscreen needs a user gesture; the Play click that got us here is
  // one, so ask now (before any await). Refusal is fine: the overlay already
  // fills the window via CSS.
  // (Not on Linux: the web view there can stop the whole app when a page goes fullscreen; the overlay fills the window anyway.)
  const linuxView = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
  try { if (!linuxView) scrim?.requestFullscreen?.().catch(() => {}); } catch { /* unsupported */ }
  $('#player-title').textContent = `${rom.title} — ${rom.platform_name}`;
  // MAME runs on an old browser core: be upfront that some games won't start.
  const hint = $('#player-hint');
  if (hint) {
    hint.dataset.base ??= hint.innerHTML;
    hint.innerHTML = '<b>Controller:</b> hold <b>Select + Start</b> for a second to close the game. ' + (rom.platform === 'mame' ? '<b>Best effort:</b> browser MAME uses an old core, so some games may not start (a RetroArch menu appears instead) — use desktop MAME for those. ' : '') + hint.dataset.base;
  }
  const host = $('#player-game');
  host.innerHTML = '<div class="side-empty">Loading emulator…</div>';

  // Same-origin iframe: the ROM fetch inside carries the session cookie, so
  // no token in any URL and nothing to leak. Wait for load before clearing
  // the placeholder so a blocked frame still shows a useful message.
  const frame = document.createElement('iframe');
  frame.title = `Play ${rom.title} in browser`;
  frame.allow = 'gamepad; fullscreen; autoplay';
  frame.style.cssText = 'border:0;width:100%;min-height:0;height:100%;background:#000;border-radius:8px';
  const params = new URLSearchParams({
    id: String(rom.id),
    rom: `/api/roms/${rom.id}/play/${encodeURIComponent(rom.filename)}`,
    title: rom.title,
    core: rom.playable_core || rom.playable
  });
  frame.src = `/ejs-player.html?${params}`;
  playerFrame = frame;

  await new Promise((resolve) => {
    const done = () => { frame.removeEventListener('load', done); resolve(); };
    frame.addEventListener('load', done);
    // A blocked frame (offline CDN aside — the frame itself is same-origin)
    // still resolves: the loader inside reports its own errors.
    setTimeout(resolve, 5000);
  });
  if (playerFrame !== frame) return; // user closed while loading
  host.innerHTML = '';
  host.appendChild(frame);
}

$('#player-close')?.addEventListener('click', closePlayer);
$('#player-scrim')?.addEventListener('click', (e) => {
  if (e.target.id === 'player-scrim') closePlayer();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#player-scrim')?.classList.contains('hidden')) closePlayer();
});

/* Page Up / Page Down / Home / End. The page itself never scrolls here (the games grid and each view scroll inside it), and a browser
   only sends those keys to a panel that has been clicked. So scroll the panel under the pointer, else the one you are looking at. */
let lastPointer = { x: -1, y: -1 };
document.addEventListener('pointermove', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, { passive: true });
function keyScroller() {
  const canScroll = (el) => { const o = getComputedStyle(el).overflowY; return (o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 1; };
  const up = (el) => { for (; el && el !== document.body; el = el.parentElement) if (canScroll(el)) return el; return null; };
  const under = lastPointer.x >= 0 ? document.elementFromPoint(lastPointer.x, lastPointer.y) : null;
  const hit = up(under);
  if (hit) return hit;
  if (!$('#drawer')?.classList.contains('hidden') && !document.body.classList.contains('details-pinned') ) return up($('#drawer-body')) || $('#drawer');
  const view = $$('.view').find((v) => !v.classList.contains('hidden'));
  if (!view) return null;
  if (view.id === 'view-library') return canScroll($('#grid')) ? $('#grid') : (canScroll(view) ? view : null);
  if (view.id === 'view-digital') return canScroll($('#dg-grid')) ? $('#dg-grid') : (canScroll(view) ? view : null);
  return up(view.firstElementChild) && canScroll(view) ? view : (canScroll(view) ? view : null);
}
document.addEventListener('keydown', (e) => {
  if (!['PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (!$('#player-scrim')?.classList.contains('hidden')) return; // a game is running: the keys belong to it
  if ($('.modal-scrim:not(.hidden)')) return;
  if (!$('#auth-screen')?.classList.contains('hidden')) return;
  const el = keyScroller();
  if (!el) return;
  e.preventDefault();
  const page = Math.max(80, el.clientHeight * 0.9);
  if (e.key === 'Home') el.scrollTo({ top: 0, behavior: 'smooth' });
  else if (e.key === 'End') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  else el.scrollBy({ top: e.key === 'PageDown' ? page : -page, behavior: 'smooth' });
});

/* ─────────────────────────── scan progress bar ─────────────────────────── */

let scanPollTimer = null;
const PHASE_LABEL = { finding: 'Finding files…', importing: 'Importing', enriching: 'Fetching metadata', done: 'Finishing…' };

function renderScanProgress(items) {
  const byId = new Map(items.map((p) => [p.source_id, p]));
  $$('[data-progress]').forEach((el) => {
    const p = byId.get(Number(el.dataset.progress));
    if (!p || p.phase === 'idle') { el.classList.add('hidden'); el.innerHTML = ''; return; }
    const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="scan-bar"><i style="width:${p.phase === 'finding' ? 4 : pct}%"></i></div>
      <div class="scan-meta">
        <b>${esc(PHASE_LABEL[p.phase] || p.phase)}</b>
        ${p.total ? `<span>${p.done} / ${p.total} (${pct}%)</span>` : ''}
        <span>${p.added || 0} added</span><span>${p.skipped || 0} unchanged</span>
        ${p.failed ? `<span style="color:var(--warn)">${p.failed} failed</span>` : ''}
        ${p.file && p.phase === 'importing' ? `<span class="scan-file">${esc(p.file)}</span>` : ''}
      </div>`;
  });
}

function startScanPolling() {
  if (scanPollTimer) return;
  const tick = async () => {
    let items = [];
    try { items = (await api('/sources/scan/progress')).items || []; } catch { /* transient */ }
    renderScanProgress(items);
    const running = items.some((p) => p.phase !== 'done');
    if (!running && !scanClicksPending()) { clearInterval(scanPollTimer); scanPollTimer = null; renderScanProgress([]); }
  };
  scanPollTimer = setInterval(tick, 800);
  tick();
}
// A scan POST may not have registered progress yet in the first poll; keep polling
// while any Scan button still shows its busy label.
function scanClicksPending() {
  return $$('[data-act="scan"]').some((b) => b.disabled) || $('#scan-all')?.disabled;
}

/* ─────────────────────────── bulk select + delete ─────────────────────────── */

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  syncSelectUI();
}

function setSelectMode(on) {
  state.selectMode = on;
  if (!on) state.selected.clear();
  syncSelectUI();
  // Re-render so tiles show/hide their checkboxes.
  loadLibrary();
}

function syncSelectUI() {
  const n = state.selected.size;
  const on = state.selectMode;
  $('#bulk-bar')?.classList.toggle('hidden', !on);
  // These two live in the selection bar (not the top row), so the Sort / Fetch / grid controls never move.
  $('#bulk-system-btn')?.classList.toggle('hidden', n === 0 || authState.user?.role !== 'admin');
  $('#bulk-clearmatch-btn')?.classList.toggle('hidden', n === 0 || authState.user?.role !== 'admin');
  $('#bulk-lock-btn')?.classList.toggle('hidden', n === 0 || authState.user?.role !== 'admin');
  $$('.bl-label').forEach((l) => { l.textContent = state.locked ? 'Unlock' : 'Lock'; });
  $$('.bs-label').forEach((l) => { l.textContent = state.system ? 'Back to library' : 'Mark as System'; });
  $('#bulk-hide-btn')?.classList.toggle('hidden', n === 0);
  $$('.bh-label').forEach((l) => { l.textContent = state.hidden ? 'Unhide' : 'Hide'; });
  $('#bulk-addcoll')?.classList.toggle('hidden', n === 0);
  $('#select-toggle')?.classList.toggle('is-active', on);
  const count = $('#bulk-count');
  if (count) count.textContent = `${n} selected`;
  $$('#grid .card').forEach((card) => {
    const selected = state.selected.has(Number(card.dataset.rom));
    card.classList.toggle('selected', selected);
    const box = card.querySelector('[data-select]');
    if (box) box.setAttribute('aria-checked', selected ? 'true' : 'false');
  });
}

// Clear the metadata match (wrong cover / details) so a game starts fresh. Asks first; nothing on disk is touched.
async function clearMatchFor(ids, { fromDetail = false } = {}) {
  if (!ids.length) return toast('Select some tiles first', true);
  const ok = await confirmDialog({ title: ids.length === 1 ? 'Clear this game\'s match?' : `Clear the match on ${ids.length} games?`,
    body: 'Removes the cover and details a metadata provider gave them (including a wrong match) and goes back to the plain name. A cover you uploaded yourself is kept. Your files are not touched. You can then Fetch metadata or Identify again.', okLabel: 'Clear match' });
  if (!ok) return;
  try {
    const r = await api('/roms/bulk/clear-match', { method: 'POST', body: JSON.stringify({ ids }) });
    toast(`Cleared ${r.cleared} match${r.cleared === 1 ? '' : 'es'}`);
    state.selected.clear();
    await Promise.all([loadLibrary(), loadPlatforms()]);
    syncSelectUI();
    if (fromDetail) openDetail(ids[0]);
  } catch (err) { toast(err.message, true); }
}

// Move the selected games to System (BIOS, devices, computers), or back to the library when viewing the System filter.
async function bulkSystemSelected() {
  const ids = [...state.selected];
  if (!ids.length) return toast('Select some tiles first', true);
  const back = !!state.system;
  try {
    await api('/roms/bulk/system', { method: 'POST', body: JSON.stringify({ ids, system: !back }) });
    toast(back ? `${ids.length} game${ids.length === 1 ? '' : 's'} back in the library` : `${ids.length} game${ids.length === 1 ? '' : 's'} marked as System`);
    state.selected.clear();
    await Promise.all([loadLibrary(), loadPlatforms()]);
    syncSelectUI();
  } catch (err) { toast(err.message, true); }
}

// Hide (or, when looking at the Hidden filter, bring back) every selected game. Nothing is deleted.
async function bulkHideSelected() {
  const ids = [...state.selected];
  if (!ids.length) return toast('Select some tiles first', true);
  const unhide = !!state.hidden;
  try {
    await api('/roms/bulk/hide', { method: 'POST', body: JSON.stringify({ ids, hidden: !unhide }) });
    toast(unhide ? `${ids.length} game${ids.length === 1 ? '' : 's'} back in the library` : `Hid ${ids.length} game${ids.length === 1 ? '' : 's'}`);
    state.selected.clear();
    await Promise.all([loadLibrary(), loadPlatforms()]);
    syncSelectUI();
  } catch (err) { toast(err.message, true); }
}

async function bulkLockSelected() {
  const ids = [...state.selected];
  if (!ids.length) return toast('Select some tiles first', true);
  const unlock = !!state.locked;
  try {
    const r = await api('/roms/bulk/lock', { method: 'POST', body: JSON.stringify({ ids, locked: !unlock }) });
    toast(unlock ? `Unlocked ${r.changed} game${r.changed === 1 ? '' : 's'}: they can be deleted now` : `Locked ${r.changed} game${r.changed === 1 ? '' : 's'}: protected from deletion`);
    state.selected.clear();
    await Promise.all([loadLibrary(), loadPlatforms()]);
    syncSelectUI();
  } catch (err) { toast(err.message, true); }
}

async function bulkDeleteSelected() {
  const ids = [...state.selected];
  if (!ids.length) return toast('Select some tiles first', true);
  const ok = await confirmDialog({
    title: ids.length === 1 ? 'Delete 1 ROM?' : `Delete ${ids.length} ROMs?`,
    body: 'Removes the catalogue entries. Imported copies in storage/roms go too.\nFiles in your own scanned folders are never touched.',
    okLabel: 'Delete',
    danger: true
  });
  if (!ok) return;
  try {
    let r;
    try { r = await api('/roms/bulk/delete', { method: 'POST', body: JSON.stringify({ ids }) }); }
    catch (err) {
      if (err.status === 409 && err.message.includes('favourites of')) {
        const sure = await confirmDialog({ title: 'Some are favourites', body: `${err.message}\nDelete them anyway?`, okLabel: 'Delete anyway', danger: true });
        if (!sure) return;
        r = await api('/roms/bulk/delete', { method: 'POST', body: JSON.stringify({ ids, confirm_favorites: true }) });
      } else throw err;
    }
    toast(`Deleted ${r.deleted} ROM${r.deleted === 1 ? '' : 's'}${r.protected ? `. ${r.protected} locked game${r.protected === 1 ? ' was' : 's were'} not deleted` : ''}`);
    state.selected.clear();
    setSelectMode(false);
    await Promise.all([loadLibrary(), loadPlatforms()]);
  } catch (err) {
    toast(err.message, true);
  }
}

async function toggleHidden(id) {
  try {
    const { hidden } = await api(`/roms/${id}/hide`, { method: 'POST' });
    toast(hidden ? (authState.user?.role === 'admin' ? 'Hidden (members will not see it either)' : 'Hidden from your view (others still see it)') : 'Back in your library');
    await loadLibrary();
    loadPlatforms();
  } catch (err) {
    toast(err.message, true);
  }
}

function syncFilterToggles() {
  $$('[data-toggle]').forEach((btn) => {
    const key = btn.dataset.toggle;
    const on = key === 'favorite' ? state.favorite
      : key === 'hidden' ? state.hidden
      : key === 'system' ? state.system
      : key === 'nocover' ? state.cover === 'none'
      : key === 'orphan' ? state.orphan
      : key === 'locked' ? state.locked
      : key === 'unmatched' ? state.unmatched : false;
    btn.classList.toggle('is-active', Boolean(on));
  });
  syncOrphanToggle();
  syncUnmatchedToggle();
}

// The orphan + unmatched filters are troubleshooting views, not everyday
// filters — keep them tucked away unless there's something to see. But they
// must ALWAYS be discoverable: a user who just imported ROMs with no metadata
// yet may never have tripped the count logic, and asking "where is Needs
// match?" should never depend on a pill that only renders when non-zero.
// So: hidden only while the library stats are still loading (counts
// undefined), visible otherwise.
function syncOrphanToggle() {
  const btn = $('#orphan-toggle');
  if (!btn) return;
  const known = typeof window.__orphanCount === 'number';
  const show = state.orphan || !known || (window.__orphanCount > 0);
  btn.classList.toggle('hidden', !show);
  if (known && !show) btn.title = 'No orphaned ROMs right now — the filter appears when there is something to show';
}

function syncUnmatchedToggle() {
  const btn = document.querySelector('[data-toggle="unmatched"]');
  if (!btn) return;
  const known = typeof window.__unmatchedCount === 'number';
  const show = state.unmatched || !known || (window.__unmatchedCount > 0);
  btn.classList.toggle('hidden', !show);
  if (!show) btn.title = 'Every ROM has a metadata match — the filter appears when something needs matching';
}

$$('[data-toggle]').forEach((btn) => btn.addEventListener('click', () => {
  if (btn.dataset.toggle === 'favorite') state.favorite = !state.favorite;
  else if (btn.dataset.toggle === 'hidden') { state.hidden = !state.hidden; if (state.hidden) state.system = false; }
  else if (btn.dataset.toggle === 'system') { state.system = !state.system; if (state.system) state.hidden = false; }
  else if (btn.dataset.toggle === 'nocover') state.cover = state.cover === 'none' ? null : 'none';
  else if (btn.dataset.toggle === 'orphan') state.orphan = !state.orphan;
  else if (btn.dataset.toggle === 'locked') state.locked = !state.locked;
  else if (btn.dataset.toggle === 'unmatched') state.unmatched = !state.unmatched;
  if (state.orphan || state.unmatched || state.locked) state.hidden = false;
  if (state.locked && btn.dataset.toggle === 'locked') { state.orphan = false; state.unmatched = false; state.system = false; }
  else if (state.locked && (btn.dataset.toggle === 'orphan' || btn.dataset.toggle === 'unmatched' || btn.dataset.toggle === 'system')) state.locked = false;
  if (state.orphan && state.unmatched) {
    // One troubleshooting lens at a time — the newer click wins.
    if (btn.dataset.toggle === 'orphan') state.unmatched = false;
    else state.orphan = false;
  }
  loadLibrary();
}));

async function toggleFavorite(id, el) {
  try {
    const { favorite } = await api(`/roms/${id}/favorite`, { method: 'POST' });
    el.classList.toggle('on', Boolean(favorite));
    el.innerHTML = favorite ? ICON.starFill : ICON.star;
    el.title = favorite ? 'Remove from favourites' : 'Add to favourites';
    if (state.favorite) loadLibrary();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ─────────────────────────── detail ─────────────────────────── */

/* Pinned details window: stays open beside the games, with no dark overlay, and clicking another game swaps what it shows.
 * Remembered on this device. */
const pinned = () => localStorage.getItem('gamesauce_pin_details') === '1';
function syncPin() {
  const on = pinned();
  document.body.classList.toggle('details-pinned', on);
  // The grid only makes room while a window is actually open.
  document.body.classList.toggle('details-open', on && !$('#drawer')?.classList.contains('hidden'));
  const b = $('#drawer-pin');
  if (b) { b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); b.title = on ? 'Unpin: the window closes when you click away' : 'Keep this window open beside the games'; }
  // Pinned: no overlay at all, so the games behind stay clickable.
  if (on) $('#scrim')?.classList.add('hidden');
  else if (state.openRomId != null) $('#scrim')?.classList.remove('hidden');
}
$('#drawer-pin')?.addEventListener('click', () => { localStorage.setItem('gamesauce_pin_details', pinned() ? '0' : '1'); syncPin(); });
syncPin();

function closeDrawer() {
  state.detailToken = (state.detailToken || 0) + 1;
  $('#drawer-nav')?.classList.add('hidden');
  $$('.card.nav-current').forEach((c) => c.classList.remove('nav-current'));
  $('#drawer').classList.add('hidden');
  $('#scrim').classList.add('hidden');
  state.openRomId = null; state.openDigital = null; state.openPhysical = null; physical.forgetOpen(); digital.forgetOpen();
  document.body.classList.remove('details-open');
}

/* ── previous / next inside the detail drawer ──
 * The list is whatever the game was opened from: the live tiles of the grid or recent row
 * (state.nav.el, so pages added by scrolling count), or a fixed id list (a collection). */
function navIds() {
  const n = state.nav;
  if (!n) return [];
  if (n.ids) return n.ids;
  return n.el ? [...n.el.querySelectorAll('.card[data-rom]')].map((c) => Number(c.dataset.rom)) : [];
}
// The previous/next bar is pinned to the top of the window by CSS (sticky), so it no longer depends on the genre pills.
function placeDrawerNav() { $('#drawer-nav')?.style.removeProperty('top'); }
window.addEventListener('resize', placeDrawerNav);

function updateDrawerNav(id) {
  const box = $('#drawer-nav');
  if (!box) return;
  let ids = navIds();
  let i = ids.indexOf(id);
  // The list can change under an open game: a match gives it a cover, so it leaves "No cover"; hiding it removes it from the
  // library; unfavouriting leaves Favourites. Keep the list it was opened from, so the previous / next row stays and still works.
  if (i >= 0) state.navSnap = ids.slice();
  else if (state.navSnap && state.navSnap.includes(id)) { state.nav = { ids: state.navSnap }; ids = state.navSnap; i = ids.indexOf(id); }
  const canLoadMore = !!(state.nav?.el && state.nav.el.id === 'grid' && state.libLoadMore);
  box.classList.toggle('hidden', i < 0 || ids.length < 2);
  $('#drawer-prev').disabled = i <= 0;
  $('#drawer-next').disabled = i < 0 || (i >= ids.length - 1 && !canLoadMore);
  const total = state.nav?.el?.id === 'grid' ? (state.libTotal || ids.length) : ids.length;
  $('#drawer-pos').textContent = i < 0 ? '' : `${i + 1} / ${total}`;
  // Keep the matching tile in view behind the drawer, and mark it.
  $$('.card.nav-current').forEach((c) => c.classList.remove('nav-current'));
  const tile = state.nav?.el?.querySelector(`.card[data-rom="${id}"]`);
  if (tile) { tile.classList.add('nav-current'); tile.scrollIntoView({ block: 'nearest' }); }
}
async function stepDetail(dir) {
  if (state.openRomId == null && state.openDigital && !$('#drawer').classList.contains('hidden')) return digital.step(dir);
  if (state.openRomId == null && state.openPhysical && !$('#drawer').classList.contains('hidden')) return physical.step(dir);
  const id = state.openRomId;
  if (id == null) return;
  let ids = navIds();
  let i = ids.indexOf(id);
  if (i < 0) return;
  if (dir > 0 && i >= ids.length - 1 && state.libLoadMore && state.nav?.el?.id === 'grid') {
    await state.libLoadMore(); // fetch the next page of tiles, then carry on
    ids = navIds();
    i = ids.indexOf(id);
  }
  const target = ids[i + dir];
  if (target != null) openDetail(target);
}
$('#drawer-prev')?.addEventListener('click', () => stepDetail(-1));
$('#drawer-next')?.addEventListener('click', () => stepDetail(1));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if ($('#drawer')?.classList.contains('hidden') || (state.openRomId == null && !state.openDigital && !state.openPhysical)) return;
  if (!$('#player-scrim')?.classList.contains('hidden')) return; // game is running: keys belong to it
  if ($('.modal-scrim:not(.hidden)')) return; // a dialog is open: leave the keys alone
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  e.preventDefault();
  stepDetail(e.key === 'ArrowRight' ? 1 : -1);
});

/* Detail-window action icons (24px grid, 1.8 stroke). */
const _ic = (p, fill) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const _star = 'M12 3.5l2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.3 9.9l6-.9z';
const ICON = {
  download: _ic('<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>'),
  play: _ic('<path d="M7 4.5v15l12-7.5z"/>', true),
  desktop: _ic('<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/><path d="M10.5 8.2v4.6l3.8-2.3z"/>'),
  star: _ic(`<path d="${_star}"/>`),
  starFill: _ic(`<path d="${_star}"/>`, true),
  collection: _ic('<rect x="3.5" y="6" width="13" height="13" rx="2.5"/><path d="M8 3.5h10.5A2 2 0 0 1 20.5 5.5V16"/><path d="M10 9.5v6M7 12.5h6"/>'),
  gamepad: _ic('<path d="M7 7h10a4.5 4.5 0 0 1 4.4 5.4l-.8 4a2.6 2.6 0 0 1-4.4 1.2L14 15.5h-4l-2.2 2.1a2.6 2.6 0 0 1-4.4-1.2l-.8-4A4.5 4.5 0 0 1 7 7z"/><path d="M8 10v3M6.5 11.5h3"/><circle cx="15.5" cy="10.5" r=".6" fill="currentColor"/><circle cx="17.5" cy="12.5" r=".6" fill="currentColor"/>'),
  gamepadOff: _ic('<path d="M7 7h10a4.5 4.5 0 0 1 4.4 5.4l-.8 4a2.6 2.6 0 0 1-4.4 1.2L14 15.5h-4l-2.2 2.1a2.6 2.6 0 0 1-4.4-1.2l-.8-4A4.5 4.5 0 0 1 7 7z" opacity=".55"/><path d="M3 3l18 18"/>'),
  eye: _ic('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: _ic('<path d="M10.6 5.7A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.8M6.5 7.2A15.7 15.7 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/>'),
  refresh: _ic('<path d="M20 11a8 8 0 0 0-14.3-4.5L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.5L20 15.5"/><path d="M20 20v-4.5h-4.5"/>'),
  image: _ic('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4.5 4"/>'),
  undo: _ic('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  keep: _ic('<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
  keepOn: _ic('<rect x="5" y="10.5" width="14" height="10" rx="2.2" fill="currentColor"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><circle cx="12" cy="15.5" r="1.4" fill="#0b0c10" stroke="none"/>'),
  more: _ic('<circle cx="5.5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor"/>'),
  trash: _ic('<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v5.5M14 11v5.5"/>')
};

async function openDetail(id) {
  const myOpen = (state.detailToken = (state.detailToken || 0) + 1);
  state.openRomId = id; state.openDigital = null; state.openPhysical = null;
  // Per-user prefs (default match provider). Cached after first fetch; failure is harmless.
  if (!state.prefs) { try { state.prefs = await api('/prefs'); } catch { state.prefs = {}; } }
  const drawer = $('#drawer');
  drawer.classList.remove('hidden');
  syncPin();
  $('#scrim').classList.toggle('hidden', pinned());
  $('#drawer-body').innerHTML = '<div class="skel" style="height:300px"></div>';

  $('#drawer').scrollTop = 0;
  updateDrawerNav(id);

  let rom;
  try {
    rom = await api(`/roms/${id}`);
  } catch (err) {
    if (myOpen !== state.detailToken) return; // user already moved on
    toast(err.message, true);
    return closeDrawer();
  }
  if (myOpen !== state.detailToken) return; // a newer game was opened while this one loaded

  const initials = rom.title.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const rows = [
    ['Platform', `${esc(rom.platform_name)}`],
    ['Source', rom.source_name ? `${esc(rom.source_name)}` : (rom.in_place ? 'in place' : 'imported')],
    ['Year', rom.release_year || '—'],
    ['Developer', rom.developer ? esc(rom.developer) : '—'],
    ['Publisher', rom.publisher ? esc(rom.publisher) : '—'],
    ['Genre', rom.genre ? esc(rom.genre) : '—'],
    ['Players', rom.players || '—'],
    ['Region', rom.region || '—'],
    ['Revision', rom.revision || '—'],
    ['Rating', rom.rating ? `${Number(rom.rating).toFixed(1)} / 5` : '—'],
    ['File', `<span class="mono">${esc(rom.filename)}</span>`],
    ['Location', rom.source_path ? `<span class="mono">${esc(rom.source_path)}</span>` : '—'],
    ['Size', fmtBytes(rom.size_bytes)],
    ['CRC32', `<span class="mono">${esc(rom.crc32 || '—')}</span>`],
    ['MD5', `<span class="mono">${esc(rom.md5 || '—')}</span>`],
    ['SHA1', `<span class="mono">${esc(rom.sha1 || '—')}</span>`],
    ['Metadata', rom.meta_source ? esc(rom.meta_source) : 'filename only'],
    ['DAT check', rom.dat_status
      ? `<span class="badge-dat ${rom.dat_status === 'verified' ? '' : rom.dat_status}" style="position:static;display:inline-block">${esc(rom.dat_status)}</span>`
      : '—'],
    ...(rom.dat_title ? [['Canonical title', esc(rom.dat_title)]] : [])
  ];

  $('#drawer-body').innerHTML = `
    ${genrePills(rom.genre)}
    <div class="detail-cover" style="background:linear-gradient(160deg,${rom.platform_accent}22,#12141a)"${rom.media?.screenshot ? ` data-shot="/api/roms/${rom.id}/media/screenshot"` : ''}>
      <div class="card-fallback">${esc(initials)}</div>
      ${rom.cover_url ? `<img src="${esc(rom.cover_url)}" alt="" onload="this.previousElementSibling?.classList.add('has-cover')" onerror="this.style.display='none'" />` : ''}
    </div>

    <div class="detail-head">
      <div style="flex:1">
        <h2 class="detail-title">${esc(rom.title)}</h2>
        <div class="detail-plat"><i style="background:${rom.platform_accent}"></i>${esc(rom.platform_name)}${rom.release_year ? ` · ${rom.release_year}` : ''}</div>
      </div>
    </div>

    <div class="detail-actions">
      ${authState.user?.can_download === false ? '' : `<a class="ibtn ibtn-primary" href="/api/roms/${rom.id}/download" download data-tip="Download ROM" aria-label="Download ROM">${ICON.download}</a>`}
      ${authState.user?.can_download === false ? '' : `<button class="ibtn" data-act="launch-local" data-tip="Play with the emulator installed on this PC" aria-label="Play locally">${ICON.desktop}</button>`}
      ${rom.playable ? `<button class="ibtn ibtn-play" data-act="play" data-tip="Play in browser${rom.platform === 'mame' ? ' (best effort)' : ''}" aria-label="Play in browser">${ICON.play}</button>` : ''}
      <button class="ibtn${rom.favorite ? ' is-on fav' : ''}" data-act="favorite" data-tip="${rom.favorite ? 'Remove from favourites' : 'Add to favourites'}" aria-label="Favourite">${rom.favorite ? ICON.starFill : ICON.star}</button>
      <div class="more-wrap">
        <button class="ibtn ibtn-more" id="more-btn" aria-haspopup="true" aria-expanded="false" aria-label="More actions" data-tip="More actions">${ICON.more}</button>
        <div class="more-menu hidden" id="more-menu" role="menu">
          ${authState.user?.role === 'admin' ? `<button class="mi${rom.keep_override === 1 ? ' on' : ''}" role="menuitem" data-act="keep" aria-pressed="${rom.keep_override === 1}">${rom.keep_override === 1 ? ICON.keepOn : ICON.keep}<span><b>${rom.keep_override === 1 ? 'Locked: click to unlock' : 'Lock this game'}</b><small>Protects it from deletion and prefers it in the duplicate finder</small></span></button>` : ''}
          <button class="mi" role="menuitem" data-act="addcoll">${ICON.collection}<span><b>Add to a collection</b></span></button>
          ${rom.play_capable && authState.user?.role === 'admin' ? `<button class="mi${rom.playable ? ' on' : ''}" role="menuitem" data-act="playtoggle">${rom.playable ? ICON.gamepad : ICON.gamepadOff}<span><b>Browser play: ${rom.playable ? 'on' : 'off'}</b><small>Click to switch for this game${rom.play_override !== null && rom.play_override !== undefined ? ' (overrides the default)' : ''}</small></span></button>` : ''}
          <button class="mi" role="menuitem" data-act="hide">${rom.hidden ? ICON.eye : ICON.eyeOff}<span><b>${rom.hidden ? (authState.user?.role === 'admin' && rom.hidden_all ? 'Show this game again' : 'Unhide for me') : 'Hide this game'}</b>${rom.hidden ? (authState.user?.role === 'admin' && rom.hidden_all ? '<small>Hidden from members too</small>' : '') : (authState.user?.role === 'admin' ? '<small>Members will not see it either; you find it under Hidden</small>' : '<small>Only from your view; others still see it</small>')}</span></button>
          <button class="mi" role="menuitem" data-act="refresh">${ICON.refresh}<span><b>Refresh metadata</b><small>Look the game up again</small></span></button>
          ${authState.user?.role === 'admin' ? `<button class="mi" role="menuitem" data-act="clearmatch">${ICON.undo}<span><b>Clear match</b><small>Remove a wrong cover and details</small></span></button>` : ''}
          <button class="mi" role="menuitem" data-act="cover-upload">${ICON.image}<span><b>${rom.cover_locked ? 'Change your cover' : 'Upload your own cover'}</b><small>JPEG, PNG or WebP, up to 8 MB</small></span></button>
          ${rom.cover_locked ? `<button class="mi" role="menuitem" data-act="cover-reset">${ICON.undo}<span><b>Back to automatic cover</b></span></button>` : ''}
        </div>
      </div>
      <input type="file" id="cover-file" accept="image/jpeg,image/png,image/webp" class="hidden" />
      <button class="ibtn ibtn-danger${rom.keep_override === 1 ? ' is-locked' : ''}" data-act="delete" data-tip="${rom.keep_override === 1 ? 'Locked: unlock this game first (⋯ More)' : 'Delete from library'}" aria-label="Delete" aria-disabled="${rom.keep_override === 1}">${ICON.trash}</button>
    </div>

    <div class="section-label">Identify this game</div>
    <div class="panel" style="padding:12px">
      <p class="hint" style="margin:0 0 10px">No match, wrong game, or missing art? Search and pick the right entry — cover included.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="identify-q" class="search" style="flex:1;min-width:180px" type="search"
          placeholder="Title to search…" value="${esc(rom.title)}" autocomplete="off" />
        <div class="provpick" id="identify-provider" data-value="${esc(state.prefs?.identify_provider || 'thegamesdb')}" title="Which catalogue to search — click ☆ to make one your default"></div>
        <select id="identify-platform" class="select" style="max-width:190px"></select>
        <button class="btn" id="identify-search">Search</button>
      </div>
      <div id="identify-list" class="results" style="margin-top:10px"></div>
    </div>
      <div id="identify-list" class="results" style="margin-top:10px"></div>
    </div>

    ${rom.missing ? `<p class="hint" style="color:var(--warn)">This file is not reachable — its drive may be offline. The catalogue entry is kept.</p>` : ''}

    ${rom.description ? `<p class="detail-desc">${esc(rom.description)}</p>` : ''}

    ${(rom.media && Object.keys(rom.media).length) ? `
      <div class="section-label">Artwork</div>
      <div class="media-strip">
        ${Object.entries(rom.media).map(([kind, m]) => `
          <a href="/api/roms/${rom.id}/media/${kind}" target="_blank" rel="noreferrer" title="${esc(kind)}">
            <img loading="lazy" src="/api/roms/${rom.id}/media/${kind}" alt="${esc(kind)}" onerror="this.parentElement.remove()" />
          </a>`).join('')}
      </div>` : ''}

    ${rom.tags?.length ? `<div class="tags">${rom.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}

    <div class="vid-slot" data-kind="rom" data-id="${rom.id}"></div>

    <div class="section-label">Details</div>
    <dl class="meta-table">
      ${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
    </dl>

    ${rom.variants?.length ? `
      <div class="section-label">Other regions / revisions</div>
      <div class="results">
        ${rom.variants.map((v) => `
          <button class="result-row ok" data-variant="${v.id}">
            <span class="status"></span>
            <span class="name">${esc(v.title)}</span>
            <span class="note">${esc(v.region || '')} ${esc(v.revision ? `Rev ${v.revision}` : '')}</span>
          </button>`).join('')}
      </div>` : ''}

    <div class="section-label">Edit</div>
    <form class="edit-form" id="edit-form">
      <label class="field"><span>Title</span><input name="title" value="${esc(rom.title)}" /></label>
      <div class="field-row">
        <label class="field"><span>Developer</span><input name="developer" value="${esc(rom.developer || '')}" /></label>
        <label class="field"><span>Publisher</span><input name="publisher" value="${esc(rom.publisher || '')}" /></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Genre</span><input name="genre" value="${esc(rom.genre || '')}" /></label>
        <label class="field"><span>Year</span><input name="release_year" type="number" min="1950" max="2100" value="${rom.release_year || ''}" /></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Players</span><input name="players" type="number" min="1" max="16" value="${rom.players || ''}" /></label>
        <label class="field"><span>Rating (0–5)</span><input name="rating" type="number" step="0.1" min="0" max="5" value="${rom.rating || ''}" /></label>
      </div>
      <label class="field"><span>Region</span><input name="region" value="${esc(rom.region || '')}" /></label>
      <label class="field"><span>Tags (comma separated)</span><input name="tags" value="${esc((rom.tags || []).join(', '))}" /></label>
      <label class="field"><span>Description</span><textarea name="description">${esc(rom.description || '')}</textarea></label>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" type="submit">Save changes</button>
        <label class="btn" style="margin-left:auto">Upload cover<input type="file" accept="image/*" id="cover-input" hidden /></label>
      </div>
    </form>
  `;
  // Cover images and the pills' wrapping change heights after layout: place the nav now and again once images settle.
  placeDrawerNav();
  requestAnimationFrame(placeDrawerNav);
  $('.detail-cover img', drawer)?.addEventListener('load', placeDrawerNav);

    const refresh = async () => { await loadLibrary(); await loadPlatforms(); openDetail(id); };

  // ▶ Play in browser (BIOS-free platforms only). Opens the EmulatorJS
  // overlay; the ROM itself never leaves your server except to your browser.
  $('[data-act="play"]', drawer)?.addEventListener('click', () => openPlayer(rom));
  // 🖥 Play locally: ask the server for a one-time token, then hand it to the game-sauce launcher on this PC through a
  // gamesauce:// link (the browser asks once whether to open it). The emulator and its paths live only in the launcher's own
  // config, never here. See docs/LOCAL-LAUNCH.md.
  $('[data-act="launch-local"]', drawer)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const j = await api(`/roms/${rom.id}/launch`, { method: 'POST' });
      const q = new URLSearchParams({ server: location.origin, token: j.token, platform: j.platform, ext: j.ext, title: j.title });
      toast('Opening your local emulator… this needs the game-sauce launcher installed on this PC (docs/LOCAL-LAUNCH.md).');
      location.href = `gamesauce://launch?${q}`;
    } catch (err) {
      toast(err.message || 'Could not start a local launch', true);
    } finally {
      setTimeout(() => { btn.disabled = false; }, 2000);
    }
  });
  $('[data-act="playtoggle"]', drawer)?.addEventListener('click', async () => {
    const want = !rom.playable;
    // Going back to what the default already gives clears the override.
    const value = want === rom.play_default ? null : want;
    try {
      await api(`/roms/${id}/play-override`, { method: 'POST', body: JSON.stringify({ value }) });
      toast(want ? 'Play in browser enabled for this game' : 'Play in browser disabled for this game');
      await loadLibrary();
      openDetail(id);
    } catch (err) { toast(err.message, true); }
  });
  if (rom.playable) renderSavesSection(rom, drawer);

  $('[data-act="favorite"]', drawer).addEventListener('click', async () => {
    await api(`/roms/${id}/favorite`, { method: 'POST' });
    await loadLibrary();
    openDetail(id);
  });

  // "More" menu: open/close, close on outside click / Escape / choosing an item.
  {
    const mb = $('#more-btn', drawer), mm = $('#more-menu', drawer);
    const setOpen = (on) => { mm.classList.toggle('hidden', !on); mb.setAttribute('aria-expanded', String(on)); mb.classList.toggle('is-on', on); };
    mb.addEventListener('click', (e) => { e.stopPropagation(); setOpen(mm.classList.contains('hidden')); });
    mm.addEventListener('click', (e) => { if (e.target.closest('.mi') && !e.target.closest('[data-act="refresh"]')) setOpen(false); });
    drawer.addEventListener('click', (e) => { if (!e.target.closest('.more-wrap')) setOpen(false); });
    drawer.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mm.classList.contains('hidden')) { e.stopPropagation(); setOpen(false); mb.focus(); } });
  }

  $('[data-act="clearmatch"]', drawer)?.addEventListener('click', () => clearMatchFor([id], { fromDetail: true }));

  $('[data-act="keep"]', drawer)?.addEventListener('click', async () => {
    try {
      const on = rom.keep_override !== 1;
      await api('/admin/duplicates/keep', { method: 'POST', body: JSON.stringify({ id, value: on ? 1 : null }) });
      toast(on ? 'Locked: protected from deletion' : 'Unlocked');
      openDetail(id);
    } catch (err) { toast(err.message, true); }
  });

  $('[data-act="addcoll"]', drawer)?.addEventListener('click', () => {
    openAddToCollection([id], rom.title);
  });

  $('[data-act="hide"]', drawer).addEventListener('click', async () => {
    await api(`/roms/${id}/hide`, { method: 'POST' });
    closeDrawer();
    await loadLibrary();
    loadPlatforms();
  });

  $('[data-act="cover-upload"]', drawer)?.addEventListener('click', () => $('#cover-file', drawer).click());
  $('#cover-file', drawer)?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return toast('That image is over 8 MB', true);
    const fd = new FormData(); fd.append('cover', file);
    try {
      const res = await fetch(`/api/roms/${id}/cover`, {
        method: 'POST', credentials: 'same-origin',
        headers: { Authorization: `Bearer ${sessionStorage.getItem('gamesauce_token') || ''}` }, body: fd
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      toast('Cover updated');
      await loadLibrary();
      openDetail(id);
    } catch (err) { toast(err.message, true); }
  });
  $('[data-act="cover-reset"]', drawer)?.addEventListener('click', async () => {
    try {
      await api(`/roms/${id}/cover`, { method: 'DELETE' });
      toast('Back to automatic covers. Use Refresh metadata to fetch one.');
      await loadLibrary();
      openDetail(id);
    } catch (err) { toast(err.message, true); }
  });

  $('[data-act="refresh"]', drawer).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.classList.add('spin');
    try {
      const r = await api(`/metadata/${id}/refresh`, { method: 'POST' });
      toast(r.updated ? `Metadata updated from ${r.source}` : `No match: ${r.reason}`, !r.updated);
      if (r.updated) await refresh();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.classList.remove('spin');
    }
  });

  $('[data-act="delete"]', drawer).addEventListener('click', async () => {
    if (rom.keep_override === 1) return toast('This game is locked. Unlock it first (⋯ More → Locked) if you want to delete it.', true);
    const ok = await confirmDialog({
      title: `Delete “${rom.title}”?`,
      body: rom.in_place
        ? 'Removes the catalogue entry only.\nIts file stays on disk — this ROM came from a scanned folder.'
        : 'Removes the catalogue entry and its imported copy in storage/roms.',
      okLabel: 'Delete',
      danger: true
    });
    if (!ok) return;
    try {
      try { await api(`/roms/${id}`, { method: 'DELETE' }); }
      catch (err) {
        // Someone has this as a favourite: tell the admin who, and let them go ahead on purpose.
        if (err.status === 409 && err.message.includes('favourite of')) {
          const sure = await confirmDialog({ title: 'Someone loves this game', body: `${err.message}\nDelete it anyway?`, okLabel: 'Delete anyway', danger: true });
          if (!sure) return;
          await api(`/roms/${id}?confirm_favorites=1`, { method: 'DELETE' });
        } else throw err;
      }
      closeDrawer();
      toast('ROM deleted');
      await loadLibrary();
      await loadPlatforms();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ── manual identify: search providers, preview candidates, apply one ──
  const identifyQ = $('#identify-q', drawer);
  const identifyPlatform = $('#identify-platform', drawer);
  const identifyProvider = $('#identify-provider', drawer);
  const IDENT_PROVIDERS = [['thegamesdb', 'TheGamesDB'], ['igdb', 'IGDB'], ['launchbox', 'LaunchBox']];
  // Custom dropdown: a native <select> can't hold a clickable star per option.
  // ★ = your default provider (saved per user, pre-selected on every game).
  if (identifyProvider) {
    const fav = () => state.prefs?.identify_provider || null;
    identifyProvider.value = identifyProvider.dataset.value;
    const draw = (open) => {
      const cur = IDENT_PROVIDERS.find(([id]) => id === identifyProvider.value) || IDENT_PROVIDERS[0];
      identifyProvider.innerHTML = `
        <button type="button" class="select provpick-btn" aria-haspopup="listbox" aria-expanded="${open}">${esc(cur[1])}${fav() === cur[0] ? ' ★' : ''} ▾</button>
        ${open ? `<div class="provpick-menu" role="listbox">${IDENT_PROVIDERS.map(([id, label]) => `
          <div class="provpick-opt ${id === identifyProvider.value ? 'is-cur' : ''}" role="option" data-pick="${id}">
            <span class="provpick-name">${esc(label)}</span>
            <button type="button" class="provpick-star ${fav() === id ? 'on' : ''}" data-star="${id}" title="${fav() === id ? 'Default provider — click to clear' : 'Make this my default provider'}" aria-label="Toggle default">${fav() === id ? '★' : '☆'}</button>
          </div>`).join('')}</div>` : ''}`;
      $('.provpick-btn', identifyProvider).onclick = (e) => { e.stopPropagation(); draw(!open); };
      $$('[data-pick]', identifyProvider).forEach((row) => row.addEventListener('click', (e) => {
        if (e.target.closest('[data-star]')) return;
        identifyProvider.value = row.dataset.pick; draw(false);
      }));
      $$('[data-star]', identifyProvider).forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = b.dataset.star;
        const next = fav() === id ? null : id;
        try {
          await api('/prefs/identify_provider', { method: 'PUT', body: JSON.stringify({ value: next }) });
          state.prefs = { ...(state.prefs || {}), identify_provider: next };
          if (!next) delete state.prefs.identify_provider;
          if (next) identifyProvider.value = next;
          toast(next ? `${IDENT_PROVIDERS.find(([x]) => x === next)[1]} is now your default provider` : 'Default provider cleared');
          draw(true);
        } catch (err) { toast(err.message, true); }
      }));
    };
    draw(false);
    const closeMenu = (e) => { if (!drawer.contains(e.target) || !identifyProvider.contains(e.target)) { if ($('.provpick-menu', identifyProvider)) draw(false); } };
    document.addEventListener('click', closeMenu);
    new MutationObserver(() => { if (!document.body.contains(identifyProvider)) document.removeEventListener('click', closeMenu); }).observe(document.body, { childList: true, subtree: true });
  }
  const identifyList = $('#identify-list', drawer);

  if (identifyPlatform && !identifyPlatform.dataset.filled) {
    identifyPlatform.dataset.filled = '1';
    try {
      identifyPlatform.innerHTML =
        `<option value="all">Any platform</option>` +
        platformOptions({ selected: rom.platform, excludeOther: true });
    } catch { /* platform list is a nicety, not required */ }
  }

  const runIdentifySearch = async () => {
    const q = identifyQ.value.trim();
    if (!q) return toast('Type a title to search for', true);
    const provider = identifyProvider?.value || 'thegamesdb';
    const label = provider === 'igdb' ? 'IGDB' : provider === 'launchbox' ? 'LaunchBox' : 'TheGamesDB';
    identifyList.innerHTML = `<div class="side-empty">Searching ${label}…</div>`;
    try {
      const data = await api('/metadata/search', {
        method: 'POST',
        body: JSON.stringify({ q, platform: identifyPlatform?.value || 'all', provider })
      });
      if (!data.items?.length) {
        identifyList.innerHTML = `<div class="side-empty">${esc(data.error || 'No matches — try fewer words, another platform, or the other provider.')}</div>`;
        return;
      }
      identifyList.innerHTML = data.items.map((c, i) => `
        <button class="result-row ${c.has_cover ? 'ok' : 'skip'}" data-candidate="${i}">
          <span class="status"></span>
          ${c.cover_url ? `<img class="candidate-cover" loading="lazy" src="${esc(c.cover_url)}" alt="" onerror="this.remove()" />` : ''}
          <span class="name">${esc(c.title)}${c.release_year ? ` <span class="note">(${c.release_year})</span>` : ''}<span class="note"> · ${esc(c.source === 'igdb' ? 'IGDB' : c.source === 'launchbox' ? 'LaunchBox' : 'TGDB')}</span></span>
          <span class="note">${c.has_cover ? 'art ✓' : 'no art'}</span>
        </button>`).join('');
      $$('[data-candidate]', identifyList).forEach((btn) => btn.addEventListener('click', async () => {
        const cand = data.items[Number(btn.dataset.candidate)];
        btn.disabled = true;
        btn.innerHTML = '<span class="status"></span><span class="name">Applying… downloading cover…</span>';
        try {
          await api(`/metadata/${id}/apply`, { method: 'POST', body: JSON.stringify({ candidate: cand }) });
          toast(`Matched as “${cand.title}”`);
          closeDrawer();
          await Promise.all([loadLibrary(), loadPlatforms()]);
          openDetail(id);
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
          runIdentifySearch();
        }
      }));
    } catch (err) {
      identifyList.innerHTML = `<div class="side-empty">${esc(err.message)}</div>`;
    }
  };

  $('#identify-search', drawer)?.addEventListener('click', runIdentifySearch);
  identifyQ?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runIdentifySearch(); }
  });

  $$('[data-variant]', drawer).forEach((b) => b.addEventListener('click', () => openDetail(Number(b.dataset.variant))));

  $('#cover-input', drawer).addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('cover', file);
    try {
      await fetch(`/api/roms/${id}/cover`, { method: 'POST', body: fd });
      toast('Cover updated');
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#edit-form', drawer).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {};
    for (const [k, v] of fd.entries()) {
      if (k === 'tags') body.tags = String(v).split(',').map((s) => s.trim()).filter(Boolean);
      else if (k === 'release_year' || k === 'players') body[k] = v ? Number(v) : null;
      else if (k === 'rating') body[k] = v ? Number(v) : null;
      else body[k] = v;
    }
    try {
      await api(`/roms/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      toast('Saved');
      await loadLibrary();
      await loadPlatforms();
      openDetail(id);
    } catch (err) {
      toast(err.message, true);
    }
  });
}

$('#drawer-close').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    e.preventDefault();
    $('#search').focus();
  }
});

/* ─────────────────────────── sources ─────────────────────────── */

/* Platform dropdowns, shared. The backend now returns platforms sorted by
 * family then name, but the UI re-sorts defensively so seed order or a future
 * API change can never resurrect the "Nintendo before Microsoft" jumble.
 * Group headers render as <optgroup> (family) + flat options (name). */
function platformOptions({ selected = null, excludeOther = false, flatten = false } = {}) {
  const list = (window.__platformsCache || []).filter((p) => !(excludeOther && p.slug === 'other'));
  const sorter = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
  if (flatten) {
    return [...list]
      .sort((a, b) => sorter(a.name, b.name))
      .map((p) => `<option value="${escAttr(p.slug)}" ${p.slug === selected ? 'selected' : ''}>${esc(p.name)}</option>`)
      .join('');
  }
  const ordered = [...list].sort((a, b) =>
    sorter(a.family || 'Others', b.family || 'Others') || sorter(a.name, b.name));
  const groups = new Map();
  for (const p of ordered) {
    const fam = p.family || 'Others';
    if (!groups.has(fam)) groups.set(fam, []);
    groups.get(fam).push(p);
  }
  return [...groups.entries()].map(([fam, plats]) => `
    <optgroup label="${escAttr(fam)}">
      ${plats.map((p) => `<option value="${escAttr(p.slug)}" ${p.slug === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
    </optgroup>`).join('');
}

/** Rebuild the Sources platform picker when the platform list changed (a platform was added, renamed or removed),
 *  keeping the choice the person already made. Cheap to call: it only touches the page when something differs. */
function refreshSourcePlatformPicker(platforms) {
  const sel = $('#source-platform');
  if (!sel || !Array.isArray(platforms)) return;
  const sig = platforms.map((p) => `${p.slug}|${p.name}|${p.family || ''}`).sort().join(';');
  if (sel.dataset.sig === sig && sel.options.length > 1) return;
  const keep = sel.value;
  window.__platformsCache = platforms;
  sel.innerHTML = platformOptions({ selected: keep });
  sel.dataset.sig = sig;
  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  else if (sel.options.length) sel.selectedIndex = 0;
}

/** A small dialog to pick a folder on the server (the same listing the Add-a-folder panel uses). Resolves to the path, or null. */
function pickFolderDialog({ title = 'Choose a folder', start = '' } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'modal-scrim';
    el.innerHTML = `<div class="modal pf" role="dialog" aria-modal="true">
      <h3 class="modal-title">${esc(title)}</h3>
      <div class="wz-bpath mono" id="pf-path"></div>
      <div class="wz-bdirs" id="pf-dirs"><div class="side-empty"><span class="spin" aria-hidden="true"></span>Reading the folder…</div></div>
      <div class="wz-row"><button class="btn btn-sm" type="button" id="pf-up" disabled>↑ Up</button><span class="wz-spacer"></span>
        <button class="btn btn-ghost" type="button" id="pf-cancel">Cancel</button><button class="btn btn-primary" type="button" id="pf-use" disabled>Use this folder</button></div></div>`;
    document.body.append(el);
    let here = null, parent = null, seq = 0;
    const done = (v) => { seq++; document.removeEventListener('keydown', onKey); el.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    el.onclick = (e) => { if (e.target === el) done(null); };
    const browse = async (p) => {
      const mine = ++seq;
      $('#pf-dirs', el).innerHTML = '<div class="side-empty"><span class="spin" aria-hidden="true"></span>Reading the folder…</div>';
      $('#pf-use', el).disabled = true; $('#pf-up', el).disabled = true;
      try {
        const data = await api(`/sources/browse${p ? `?path=${encodeURIComponent(p)}` : ''}`);
        if (mine !== seq) return;
        here = data.path; parent = data.parent;
        $('#pf-path', el).textContent = data.path;
        $('#pf-dirs', el).innerHTML = data.dirs.length
          ? data.dirs.map((d) => `<button type="button" class="browser-dir" data-dir="${esc(d.path)}"><span aria-hidden="true">🗀</span><span class="browser-dir-name">${esc(d.name)}</span><span class="browser-dir-go">›</span></button>`).join('')
          : '<div class="side-empty">No subfolders here: use this folder as it is.</div>';
        $$('#pf-dirs .browser-dir', el).forEach((b) => { b.onclick = () => browse(b.dataset.dir); });
        $('#pf-up', el).disabled = !parent; $('#pf-use', el).disabled = false;
      } catch (err) {
        if (mine !== seq) return;
        $('#pf-dirs', el).innerHTML = `<div class="side-empty">Could not read that folder (${esc(err.message)}). <button class="btn btn-sm" id="pf-retry" type="button">Try again</button></div>`;
        $('#pf-retry', el).onclick = () => browse(p);
        $('#pf-up', el).disabled = !here;
      }
    };
    $('#pf-up', el).onclick = () => { if (parent) browse(parent); };
    $('#pf-cancel', el).onclick = () => done(null);
    $('#pf-use', el).onclick = () => done(here);
    browse(start ? start.replace(/[\\/][^\\/]*$/, '') || start : null);
  });
}

/** Sources page: never leaves the list blank. If the server is busy or the connection drops, say so and offer a retry. */
async function loadSources() {
  const wrap = $('#sources-list');
  if (!wrap) return;
  if (!wrap.children.length) wrap.innerHTML = '<div class="side-empty"><span class="spin" aria-hidden="true"></span>Loading your folders…</div>';
  try {
    await loadSourcesNow();
  } catch (err) {
    if (err?.status === 401) return; // the sign-in card is already showing
    wrap.innerHTML = `<div class="empty" style="padding:30px 0"><h2>Could not load your folders</h2>
      <p>${esc(err?.message || 'The connection failed')}. The server may be busy with something else; give it a moment.</p>
      <button class="btn btn-primary" id="sources-retry" type="button">Try again</button></div>`;
    $('#sources-retry').onclick = () => loadSources();
  }
}

/* Fold a flat list that is "heading, rows, heading, rows...": a chevron on each heading hides the rows up to the next heading.
 * The folded headings are remembered per list (this browser), so a long list stays as the person left it. */
function makeFoldable(container, headSelector, scope, nameOf) {
  if (!container) return;
  const key = 'gamesauce_fold_' + scope;
  let folded; try { folded = new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { folded = new Set(); }
  const heads = [...container.querySelectorAll(headSelector)];
  const apply = (head, fold) => {
    head.classList.toggle('is-folded', fold);
    head.querySelector('.fold-btn')?.setAttribute('aria-expanded', fold ? 'false' : 'true');
    for (let el = head.nextElementSibling; el && !el.matches(headSelector); el = el.nextElementSibling) el.classList.toggle('fold-hidden', fold);
  };
  for (const head of heads) {
    const name = nameOf(head);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'fold-btn'; btn.title = 'Fold or unfold this group'; btn.setAttribute('aria-label', 'Fold or unfold ' + name);
    head.prepend(btn);
    const toggle = () => {
      const fold = !head.classList.contains('is-folded');
      apply(head, fold); fold ? folded.add(name) : folded.delete(name);
      try { localStorage.setItem(key, JSON.stringify([...folded])); } catch { /* private mode */ }
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    head.querySelector('.fam-name')?.addEventListener('click', toggle);
    if (head.matches('.source-family')) head.addEventListener('click', toggle);
    apply(head, folded.has(name));
  }
}

async function loadSourcesNow() {
  const [{ items }, roots, plats] = await Promise.all([api('/sources'), api('/sources/roots'), api('/platforms')]);
  const wrap = $('#sources-list');

  // Populate the platform picker once, grouped by family — families and
  // platforms both A→Z, same as the sidebar and the Identify picker. The first
  // platform is pre-selected: platform is REQUIRED at creation (no auto), so
  // the form can never submit an unhinted source by accident.
  refreshSourcePlatformPicker(plats.items);

  if (!items.length) {
    wrap.innerHTML = `
      <div class="empty" style="padding:40px 0">
        <div class="empty-ico">🗀</div>
        <h2>No folders yet</h2>
        <p>Add the folder where your ROMs live. Nothing is copied — they stay exactly where they are.</p>
        <button class="btn btn-primary" id="empty-add-source">Add folder</button>
      </div>`;
    $('#empty-add-source').addEventListener('click', () => showAddSource(roots.roots[0] || ''));
    return;
  }

  // Grouped by the platform family (A to Z), sources A to Z inside each family: the same order as the platform picker.
  const famOf = (s) => (plats.items.find((p) => p.slug === s.platform_hint)?.family) || 'Others';
  const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
  const ordered = [...items].sort((a, b) => byName(famOf(a), famOf(b)) || byName(a.name, b.name));
  let lastFam = null;
  const famHead = (s) => { const f = famOf(s); if (f === lastFam) return ''; lastFam = f; return `<h3 class="source-family">${esc(f)}</h3>`; };

  wrap.innerHTML = ordered.map((s) => famHead(s) + `
    <div class="source-card ${s.enabled ? '' : 'is-off'} ${s.exists ? '' : 'is-gone'}" data-source="${s.id}">
      <div class="source-top">
        <span class="source-name">${esc(s.name)}</span>
        ${s.exists ? '' : '<span class="pill bad">folder not reachable</span>'}
        ${s.platform_hint ? `<span class="pill accent plat-pill">${platformIconSvg((window.__platformsCache || []).find((x) => x.slug === s.platform_hint) || { slug: s.platform_hint }, 14)}${esc(s.platform_hint)}</span>` : ''}
        ${s.enabled ? '' : '<span class="pill" title="Scanning is paused for this source (its games are still in the library)">scanning paused</span>'}
        ${s.hide_games ? '<span class="pill warn" title="Its games are left out of the library, search and counts until you show them again">games hidden</span>' : ''}
        ${s.last_scan_error ? `<span class="pill warn">${esc(s.last_scan_error)}</span>` : ''}
        <div class="source-actions">
          <button class="btn btn-sm" data-act="scan">↻ Scan</button>
          <button class="btn btn-sm" data-act="toggle" data-enabled="${s.enabled ? 1 : 0}" title="${s.enabled ? 'Pause scanning this source (its games stay in the library)' : 'Resume scanning this source'}">${s.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-sm" data-act="hidegames" data-hidden="${s.hide_games ? 1 : 0}" title="${s.hide_games ? 'Show this source\'s games in the library again' : 'Hide this source\'s games from the library, search and counts (nothing is deleted; show them again any time)'}">${s.hide_games ? 'Show games' : 'Hide games'}</button>
          <button class="btn btn-sm btn-danger" data-act="remove">Remove</button>
        </div>
      </div>
      <div class="source-path">${esc(s.path)}</div>
      ${(s.extra_paths || []).map((x) => `<div class="source-path source-extra${x.exists ? '' : ' is-gone'}" data-extra="${x.id}"><span>${esc(x.path)}${x.exists ? '' : ' <em>(not reachable)</em>'}</span><button class="btn btn-sm btn-ghost" data-act="drop-folder" title="Stop scanning this folder (its games stay in the library)" aria-label="Remove this folder">✕</button></div>`).join('')}
      <div class="source-addfolder"><button class="btn btn-sm btn-ghost" data-act="relocate" title="Folder renamed or moved? Point this source at its new place: every game keeps its details, covers and saves">Folder renamed or moved?</button> <button class="btn btn-sm btn-ghost" data-act="add-folder" title="Part of this collection lives on another drive or in another folder? Add it here: same name, same platform.">＋ Add another folder</button></div>
      <div class="scan-progress hidden" data-progress="${s.id}"></div>
      <div class="source-stats">
        <span><b>${s.rom_count}</b> ROMs</span>
        <span><b>${fmtBytes(s.total_bytes)}</b></span>
        ${s.missing_count ? `<span><b style="color:var(--warn)">${s.missing_count}</b> missing</span>` : ''}
        <span>${s.recursive ? 'recursive' : 'top level only'}</span>
        <span>${s.last_scan_at ? `last scan ${s.last_scan_at} UTC${s.last_scan_ms ? ` · ${(s.last_scan_ms / 1000).toFixed(1)}s` : ''}` : 'never scanned'}</span>
      </div>
    </div>
  `).join('');
  makeFoldable(wrap, '.source-family', 'sources', (h) => h.textContent.trim());

  startScanPolling(); // picks up a scan already running (e.g. after a page refresh)

  $$('[data-source]', wrap).forEach((card) => {
    const id = Number(card.dataset.source);
    $('[data-act="scan"]', card).addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = '↻ Scanning…';
      startScanPolling();
      try {
        // enrich=true: freshly added ROMs get metadata immediately.
        const r = await api(`/sources/${id}/scan`, {
          method: 'POST',
          body: JSON.stringify({ enrich: true })
        });
        toast(`${r.added} added, ${r.updated} updated, ${r.missing} missing, ${r.skipped} unchanged${r.enriched ? `, ${r.enriched} enriched` : ''}`);
        await Promise.all([loadSources(), loadPlatforms()]);
        loadLibrary();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        btn.textContent = '↻ Scan';
      }
    });

    $('[data-act="relocate"]', card).addEventListener('click', async () => {
      const name = card.querySelector('.source-name').textContent;
      const chosen = await pickFolderDialog({ title: `Where is “${name}” now?`, start: card.querySelector('.source-path').textContent.trim() });
      if (!chosen) return;
      const ok = await confirmDialog({ title: 'Point this source at the new folder?', body: `${name} will look in ${chosen} from now on. Its games keep their details, covers and saves; nothing on disk is touched.`, okLabel: 'Use this folder' });
      if (!ok) return;
      try {
        const r = await api(`/sources/${id}/relocate`, { method: 'POST', body: JSON.stringify({ path: chosen }) });
        toast(`Done: ${r.found.toLocaleString()} of ${r.moved.toLocaleString()} games found in the new folder${r.not_found ? ` (${r.not_found.toLocaleString()} not there: they show as missing)` : ''}`);
        await Promise.all([loadSources(), loadPlatforms()]);
        loadLibrary();
      } catch (err) { toast(err.message, true); }
    });

    $('[data-act="add-folder"]', card).addEventListener('click', async () => {
      const chosen = await pickFolderDialog({ title: `Add another folder to “${card.querySelector('.source-name').textContent}”`, start: card.querySelector('.source-path').textContent.trim() });
      if (!chosen) return;
      try {
        const added = await api(`/sources/${id}/paths`, { method: 'POST', body: JSON.stringify({ path: chosen }) });
        toast(`Folder added. Scanning ${added.name}…`, false, { busy: true });
        await loadSources();
        startScanPolling();
        const r = await api(`/sources/${id}/scan`, { method: 'POST', body: JSON.stringify({ enrich: true }) });
        toast(`${r.added} added, ${r.skipped} unchanged${r.enriched ? `, ${r.enriched} enriched` : ''}`);
        await Promise.all([loadSources(), loadPlatforms()]);
        loadLibrary();
      } catch (err) { toast(err.message, true); loadSources(); }
    });
    $$('[data-act="drop-folder"]', card).forEach((b) => b.addEventListener('click', async () => {
      const row = b.closest('[data-extra]');
      const ok = await confirmDialog({ title: 'Stop scanning this folder?', body: 'Its games stay in the library and nothing on disk is touched. They show as missing after the next scan unless you add the folder back.', okLabel: 'Stop scanning it' });
      if (!ok) return;
      try { await api(`/sources/${id}/paths/${row.dataset.extra}`, { method: 'DELETE' }); toast('Folder removed from this source'); loadSources(); }
      catch (err) { toast(err.message, true); }
    }));

    $('[data-act="toggle"]', card).addEventListener('click', async () => {
      // `card` IS the .source-card, so look at its own class (searching inside it finds nothing).
      const isOff = card.classList.contains('is-off');
      try {
        await api(`/sources/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: isOff }) });
        toast(isOff ? 'Source enabled' : 'Source disabled');
        loadSources();
      } catch (err) { toast(err.message, true); }
    });

    $('[data-act="hidegames"]', card).addEventListener('click', async (e) => {
      const hiding = e.currentTarget.dataset.hidden !== '1';
      try {
        await api(`/sources/${id}`, { method: 'PATCH', body: JSON.stringify({ hide_games: hiding }) });
        toast(hiding ? 'This source\'s games are hidden from the library' : 'This source\'s games are showing again');
        loadSources(); loadPlatforms(); loadLibrary();
      } catch (err) { toast(err.message, true); }
    });

    $('[data-act="remove"]', card).addEventListener('click', async () => {
      const name = card.querySelector('.source-name').textContent;
      // One dialog, two explicit choices — no double-popup, no "OK means what?".
      const choice = await confirmChoice({
        title: `Remove “${name}”?`,
        body: 'Stop watching this folder. Your files on disk are never deleted. What should happen to its ROMs in the library?',
        choices: [
          { id: 'keep', label: 'Remove source, keep ROMs', hint: 'rows stay as orphans' },
          { id: 'purge', label: 'Remove source + ROMs', hint: 'catalogue rows go too', danger: true }
        ]
      });
      if (!choice) return;
      const removeRoms = choice === 'purge';
      try {
        await api(`/sources/${id}?remove_roms=${removeRoms ? 1 : 0}`, { method: 'DELETE' });
        toast(removeRoms ? 'Source and its ROMs removed from the library' : 'Source removed, ROMs kept');
        await Promise.all([loadSources(), loadPlatforms()]);
        loadLibrary();
      } catch (err) { toast(err.message, true); }
    });

    $('.source-path', card).addEventListener('click', () => {
      state.source = id;
      state.sourceName = card.querySelector('.source-name').textContent;
      setView('library');
    });
  });
}

// Pre-select the platform whose name matches the folder's own name (".../roms/fbneo" -> FinalBurn Neo).
// Exact matches only (after dropping punctuation and case): a folder called "games" or "misc" selects nothing,
// and the person always sees the choice and can change it. Extra spellings people use for folders are listed here.
const FOLDER_ALIASES = {
  fba: ['fbneo', 'fba', 'finalburn', 'finalburnneo', 'finalburnalpha', 'fbalpha'],
  mame: ['mame', 'mamearcade'], neogeo: ['neogeo', 'neogeoaes', 'neogeomvs', 'mvs', 'aes'],
  cps1: ['cps1', 'cpsone', 'capcomcps1'], cps2: ['cps2', 'cpstwo', 'capcomcps2'], cps3: ['cps3', 'cpsthree', 'capcomcps3'],
  ps1: ['psx', 'psone', 'ps1', 'playstation', 'playstation1'], ps2: ['ps2', 'playstation2'], ps3: ['ps3', 'playstation3'], psp: ['psp', 'playstationportable'],
  snes: ['snes', 'sfc', 'supernintendo', 'supernes', 'superfamicom'], nes: ['nes', 'famicom', 'nintendo'], n64: ['n64', 'nintendo64'],
  gb: ['gb', 'gameboy'], gbc: ['gbc', 'gameboycolor'], gba: ['gba', 'gameboyadvance'], nds: ['nds', 'nintendods'],
  genesis: ['genesis', 'megadrive', 'md', 'segagenesis'], sega32x: ['32x', 'sega32x'], saturn: ['saturn', 'segasaturn'], dreamcast: ['dreamcast', 'dc'],
  mastersystem: ['mastersystem', 'sms'], gamegear: ['gamegear', 'gg'], xbox: ['xbox', 'xboxoriginal', 'xboxclassic'], xbox360: ['xbox360', 'x360'],
  wii: ['wii'], wiiu: ['wiiu'], gamecube: ['gamecube', 'gc', 'ngc', 'gcn'], '3do': ['3do'], atomiswave: ['atomiswave', 'aws'], naomi: ['naomi']
};
const folderKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function platformForFolder(path) {
  const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
  const name = folderKey(parts[parts.length - 1]);
  if (!name) return null;
  const list = window.__platformsCache || [];
  // 1) a platform whose slug, short name or full name IS the folder name; 2) a known alias (only if that platform exists here)
  const direct = list.filter((p) => [p.slug, p.short_name, p.name].map(folderKey).includes(name));
  if (direct.length === 1) return direct[0].slug;
  if (direct.length > 1) return null; // ambiguous: don't guess
  for (const [slug, aliases] of Object.entries(FOLDER_ALIASES)) {
    if (aliases.map(folderKey).includes(name) && list.some((p) => p.slug === slug)) return slug;
  }
  return null;
}
function suggestPlatformFromPath() {
  const sel = $('#source-platform');
  if (!sel) return;
  if (sel.dataset.auto !== '1' && sel.dataset.touched === '1') return; // the person chose by hand: leave it alone
  const slug = platformForFolder($('#source-path').value);
  const note = $('#source-platform-note');
  if (slug && [...sel.options].some((o) => o.value === slug)) {
    sel.value = slug;
    if (note) note.textContent = `Picked from the folder name (${sel.options[sel.selectedIndex].text}). Change it if that's wrong.`;
    sel.dataset.auto = '1';
  } else {
    if (note) note.textContent = '';
    // A suggestion made for an earlier folder must not linger: back to the first entry, as when the form opens.
    if (sel.dataset.auto === '1' && sel.options.length) sel.selectedIndex = 0;
    sel.dataset.auto = '';
  }
}

function showAddSource(initialPath) {
  const panel = $('#add-source-panel');
  panel.classList.remove('hidden');
  const input = $('#source-path');
  if (initialPath) input.value = initialPath;
  suggestPlatformFromPath();
  input.focus();
  // Bring the panel into view BELOW the pinned header (scrollIntoView alone slid its title underneath it).
  const view = $('#view-settings'), anchor = $('.settings-anchor');
  if (view && anchor) {
    const gap = 12;
    const top = panel.getBoundingClientRect().top - anchor.getBoundingClientRect().bottom - gap;
    if (top < 0 || top > view.clientHeight * 0.5) view.scrollBy({ top, behavior: 'smooth' });
  }
}

$('#source-platform')?.addEventListener('change', (e) => { if (e.isTrusted) { e.target.dataset.touched = '1'; e.target.dataset.auto = ''; $('#source-platform-note').textContent = ''; } });
$('#add-source').addEventListener('click', () => showAddSource(''));
// A path typed or pasted by hand also suggests its platform (on leaving the field, so half-typed names don't flicker).
$('#source-path')?.addEventListener('change', suggestPlatformFromPath);
$('#cancel-source').addEventListener('click', () => {
  $('#add-source-panel').classList.add('hidden');
  $('#browser').classList.add('hidden');
  $('#browse-source').classList.remove('is-on');
  const ps = $('#source-platform'); if (ps) { ps.dataset.touched = ''; ps.dataset.auto = ''; }
});

$('#create-source').addEventListener('click', async () => {
  const path = $('#source-path').value.trim();
  if (!path) return toast('Enter a folder path', true);
  const platform = $('#source-platform').value;
  if (!platform) return toast('Pick the platform for this folder', true);
  try {
    // An active folder browser shows its chosen path in the Path field; when
    // the field was filled directly the browser starts hidden — both work.
    toast('Adding folder…', false, { busy: true });
    const created = await api('/sources', {
      method: 'POST',
      body: JSON.stringify({
        path,
        name: $('#source-name').value.trim() || undefined,
        platform_hint: platform,
        recursive: $('#source-recursive').checked
      })
    });
    toast(`Added ${created.name} — scanning…`, false, { busy: true });
    $('#add-source-panel').classList.add('hidden');
    $('#browser').classList.add('hidden');
    $('#source-path').value = '';
    $('#source-name').value = '';
    if ($('#source-platform').options.length) $('#source-platform').selectedIndex = 0;
    $('#source-platform').dataset.touched = ''; $('#source-platform').dataset.auto = ''; $('#source-platform-note').textContent = '';

    startScanPolling();
    const r = await api(`/sources/${created.id}/scan`, {
      method: 'POST',
      body: JSON.stringify({ enrich: true })
    });
    toast(`${r.added} ROMs found in ${created.name}${r.enriched ? `, ${r.enriched} enriched` : ''}`);
    await Promise.all([loadSources(), loadPlatforms()]);
    loadLibrary();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#scan-all').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '↻ Scanning…';
  startScanPolling();
  try {
    const r = await api('/sources/scan', { method: 'POST', body: JSON.stringify({ enrich: true }) });
    const added = r.sources.reduce((n, s) => n + s.added, 0);
    const enriched = r.sources.reduce((n, s) => n + (s.enriched || 0), 0);
    toast(`Scanned ${r.sources.length} source(s): ${added} new ROMs${enriched ? `, ${enriched} enriched` : ''}`);
    await Promise.all([loadSources(), loadPlatforms()]);
    loadLibrary();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Scan all';
  }
});

$('#browse-source').addEventListener('click', async () => {
  // Toggle; the button keeps its label so the Path row never changes width.
  const br = $('#browser');
  if (!br.classList.contains('hidden')) { state.browseSeq = (state.browseSeq || 0) + 1; br.classList.add('hidden'); $('#browse-source').classList.remove('is-on'); return; }
  $('#browse-source').classList.add('is-on');
  await browseTo($('#source-path').value.trim() || null);
});

async function browseTo(path, { selectOnOpen = false } = {}) {
  const browser = $('#browser');
  browser.classList.remove('hidden');
  // Say so while the server reads the folder (a busy NAS or network share can take a few seconds), and ignore an
  // answer that arrives after a newer request or after the panel was closed.
  const seq = state.browseSeq = (state.browseSeq || 0) + 1;
  $('#browser-dirs').innerHTML = '<div class="side-empty"><span class="spin" aria-hidden="true"></span>Reading the folder…</div>';
  $('#browser-up').disabled = true;
  $('#browser-use').disabled = true;
  // The browser opens below the Add-folder form: bring it into view so the
  // folder list is never silently off-screen with no scrollbar in sight.
  requestAnimationFrame(() => browser.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  try {
    const data = await api(`/sources/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`);
    if (seq !== state.browseSeq) return; // a newer click, or the panel was closed
    $('#browser-use').disabled = false;
    $('#browser-up').disabled = !data.parent;
    state.browsePath = data.path;
    $('#browser-path').textContent = data.path;
    // A folder row both navigates INTO it (double-click / chevron) and selects it
    // (single click highlights + fills the Path field). The explicit button
    // confirms without needing to discover the path-breadcrumb click target.
    $('#browser-dirs').innerHTML = (data.dirs.length
      ? data.dirs.map((d) => `<button class="browser-dir" data-dir="${esc(d.path)}"><span aria-hidden="true">🗀</span><span class="browser-dir-name">${esc(d.name)}</span><span class="browser-dir-go" title="Open">›</span></button>`).join('')
      : '<div class="side-empty">No subfolders — use this folder as-is.</div>');

    $$('.browser-dir', $('#browser-dirs')).forEach((b) => {
      // Single click: select (highlight + fill the Path field immediately).
      b.addEventListener('click', (e) => {
        if (e.target.closest('.browser-dir-go')) return; // handled below
        $$('.browser-dir.is-current', $('#browser-dirs')).forEach((x) => x.classList.remove('is-current'));
        b.classList.add('is-current');
        $('#source-path').value = b.dataset.dir;
        suggestPlatformFromPath();
      });
      // Chevron / double-click: drill in without changing the selection.
      const open = (e) => { e.stopPropagation(); browseTo(b.dataset.dir); };
      $('.browser-dir-go', b)?.addEventListener('click', open);
      b.addEventListener('dblclick', () => browseTo(b.dataset.dir));
    });

    if (selectOnOpen) { $('#source-path').value = data.path; suggestPlatformFromPath(); }

    $('#browser-up').onclick = () => {
      if (data.parent) browseTo(data.parent);
    };

    // Confirm + cancel live under the list so they can't scroll off-screen.
    $('#browser-use').onclick = () => {
      const chosen = $('#source-path').value.trim() || data.path;
      $('#source-path').value = chosen;
      suggestPlatformFromPath();
      browser.classList.add('hidden');
      $('#browse-source').classList.remove('is-on');
      toast(`Path selected: ${chosen}`);
      $('#source-name')?.focus();
    };
    $('#browser-cancel').onclick = () => {
      browser.classList.add('hidden');
      $('#browse-source').classList.remove('is-on');
    };

    // Keep the legacy affordance too: clicking the current path selects it.
    $('#browser-path').onclick = () => {
      $('#source-path').value = data.path;
      suggestPlatformFromPath();
      toast('Path selected');
    };
  } catch (err) {
    if (seq !== state.browseSeq) return;
    // Never leave an empty panel: say what went wrong and offer another try.
    $('#browser-dirs').innerHTML = `<div class="side-empty">Could not read that folder (${esc(err.message)}). <button class="btn btn-sm" id="browser-retry" type="button">Try again</button></div>`;
    $('#browser-retry').onclick = () => browseTo(path, { selectOnOpen });
    $('#browser-up').disabled = !state.browsePath;
    $('#browser-use').disabled = true;
  }
}

/* ─────────────────────────── metadata settings ─────────────────────────── */

/* LaunchBox: a free local database. No key: the admin downloads it once, the server indexes it, lookups are local. */
let lbTimer = null;
async function renderLaunchBox() {
  const box = $('#launchbox-card');
  if (!box) return;
  const canEdit = authState.user?.role === 'admin';
  const s = await api('/metadata/launchbox');
  const running = s.job.state === 'downloading' || s.job.state === 'importing';
  const when = s.imported_at ? new Date(s.imported_at).toLocaleString() : null;
  box.innerHTML = `
    <div class="provider-head">
      <span class="pill ${s.available ? 'ok' : ''}">${s.available ? 'active' : 'not downloaded'}</span>
      <span class="name">LaunchBox</span>
      <a class="docs" href="https://gamesdb.launchbox-app.com/" target="_blank" rel="noreferrer">about ↗</a>
    </div>
    <p class="provider-note">A free game database that lives on this server: no key, no limit, and lookups are instant. It matches by exact name, so it fills in games the other providers cannot find. It is tried after IGDB. Download it once (about 110 MB), then update it whenever you like.</p>
    ${s.available ? `<p class="hint">${esc(s.games.toLocaleString())} games indexed (${esc(s.covers.toLocaleString())} with covers${s.has_spines ? `, ${esc(s.spines.toLocaleString())} with spine art` : ''}${s.has_discs ? `, ${esc(s.discs.toLocaleString())} with disc art` : ''}${s.has_backs ? `, ${esc(s.backs.toLocaleString())} with box backs` : ''}) · ${esc(fmtBytes(s.bytes))} on disk · updated ${esc(when)}</p>${s.has_spines && s.has_discs && s.has_backs ? '' : `<p class="hint">This copy was made before ${s.has_spines && s.has_discs ? 'box backs' : s.has_spines ? 'disc and back' : 'spine, disc and back'} art was kept. Press Update database to get ${s.has_spines && s.has_discs ? 'the backs you can turn the cases over to see' : s.has_spines ? 'the disc and back pictures for the open cases' : 'spine, disc and back pictures'} on the Physical shelf.</p>`}` : ''}
    ${running ? `
      <div class="lb-progress"><span class="spin" aria-hidden="true"></span><span class="lb-msg">${esc(s.job.message || 'Working…')}</span>
        <div class="lb-bar"><i style="width:${Number(s.job.pct) || 0}%"></i></div><b>${Number(s.job.pct) || 0}%</b></div>`
      : s.job.state === 'error' ? `<p class="provider-banner is-warn">${esc(s.job.message)}</p>`
      : s.job.state === 'done' ? `<p class="provider-banner is-ok">${esc(s.job.message)}</p>` : ''}
    <div class="provider-actions">
      ${canEdit ? `<button class="btn btn-sm btn-primary" data-act="lb-update" ${running ? 'disabled' : ''}>${s.available ? 'Update database' : 'Download database'}</button>` : ''}
      <span class="provider-result"></span>
    </div>`;
  $('[data-act="lb-update"]', box)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin" aria-hidden="true"></span>Starting…';
    try { await api('/metadata/launchbox/update', { method: 'POST' }); } catch (err) { toast(err.message, true); }
    renderLaunchBox().catch(() => {});
  });
  clearTimeout(lbTimer);
  if (running) lbTimer = setTimeout(() => { if ($('#launchbox-card')) renderLaunchBox().catch(() => {}); }, 2000);
}

/**
 * Credential forms. Secrets are never echoed back — a field shows "set" or
 * "not set", and typing in it replaces the stored value.
 */
function renderProviderForms(config, status = []) {
  const wrap = $('#provider-forms');
  if (!config) return;
  // Server-wide credentials are admin-only end to end — the module itself is
  // hidden for members, and the API enforces requireAdmin on writes/tests.
  const canEdit = authState.user?.role === 'admin';

  wrap.innerHTML = config.providers.map((p) => {
    const isEnabled = status.find((s) => s.id === p.id)?.enabled;
    // ScreenScraper banner depends on BOTH halves of the picture: the shared
    // default flag (server-wide) and which dev/login halves are actually set.
    const fieldByKey = (k) => p.fields.find((f) => f.key === k) || {};
    const isSet = (f) => Boolean(f.set);
    const ssDevId = fieldByKey('SS_DEV_ID');
    const ssDevPw = fieldByKey('SS_DEV_PASSWORD');
    const ssUser = fieldByKey('SS_USER');
    const ssPass = fieldByKey('SS_PASSWORD');
    const usingSharedDev = ssDevId.source === 'shared' || ssDevPw.source === 'shared';
    const hasOwnDev = (isSet(ssDevId) && !usingSharedDev) || (isSet(ssDevPw) && !usingSharedDev);
    const hasLogin = isSet(ssUser) && isSet(ssPass);
    const ssBanner = p.id === 'screenscraper' ? (
      !config.sharedDevDefault && !hasOwnDev
        ? `<p class="provider-banner is-warn">No shared developer credentials on this server — all four fields are required. Leaving the Developer fields blank <em>cannot</em> work here. Get a free dev pair via “get credentials ↗” (forum request), or ask whoever runs this server to set <code>SS_DEV_ID_SHARED</code> / <code>SS_DEV_PASSWORD_SHARED</code>.</p>`
        : usingSharedDev && !hasLogin
          ? `<p class="provider-banner">Shared developer credentials are active — now just add <em>your own</em> screenscraper.fr account username + password below and Save. (A shared dev pair has a slower shared quota; your own pair later gets your own faster quota.)</p>`
          : usingSharedDev
            ? `<p class="provider-banner is-ok">Running on shared developer credentials + your login. Paste your own dev pair any time for your own faster quota.</p>`
            : ''
    ) : '';
    return `
    <div class="provider-block" data-provider="${esc(p.id)}">
      <div class="provider-head">
        <span class="pill ${isEnabled ? 'ok' : ''}">${isEnabled ? 'active' : 'not configured'}</span>
        <span class="name">${esc(p.label)}</span>
        <a class="docs" href="${esc(p.docs)}" target="_blank" rel="noreferrer">get credentials ↗</a>
      </div>
      <p class="provider-note">${esc(p.note)}</p>
      ${ssBanner}
      <div class="provider-fields">
        ${p.fields.map((f) => {
          const sharedActive = f.shared && f.source === 'shared';
          return `
          <div class="provider-field">
            <span>${esc(f.label)}${f.required && !f.shared ? ' *' : ''}</span>
            <input
              type="${f.secret ? 'password' : 'text'}"
              name="${esc(f.key)}"
              data-secret="${f.secret ? '1' : '0'}"
              placeholder="${
                f.locked_by_env ? 'set by an environment variable'
                : f.set && !sharedActive ? '•••••••• (stored — type to replace)'
                : sharedActive ? 'shared default in use — type yours to override'
                : p.id === 'screenscraper' && f.shared ? 'required — blank only works with a shared pair'
                : (f.required ? 'required' : 'optional')
              }"
              autocomplete="off"
              ${f.locked_by_env || !canEdit ? 'disabled title="Only an admin can change server credentials"' : ''}
            />
            <span class="state">${
              f.locked_by_env ? 'set by environment'
              : sharedActive ? 'shared default'
              : (f.set ? 'stored (yours)' : 'not set')
            }</span>
          </div>`;
        }).join('')}
      </div>
      <div class="provider-actions">
        ${canEdit ? '<button class="btn btn-sm btn-primary" data-act="save-provider">Save</button>' : ''}
        ${canEdit ? '<button class="btn btn-sm" data-act="test-provider">Test connection</button>' : ''}
        <span class="provider-result"></span>
      </div>
      ${canEdit && p.id === 'screenscraper' && (config.sharedDevDefault || p.fields.some((f) => f.source === 'database' && (f.key === 'SS_DEV_ID' || f.key === 'SS_DEV_PASSWORD')))
        ? `<div class="provider-actions" style="margin-top:8px">
             <button class="btn btn-sm btn-ghost" data-act="clear-own-dev">Use shared dev credentials</button>
           </div>`
        : ''}
    </div>`;
  }).join('');

  renderLaunchBox().catch(() => {});
  $('#encryption-note').innerHTML = config.encryption.key_source === 'env'
    ? 'Credentials are encrypted at rest (AES-256-GCM) with the key from <code>GAMESAUCE_SECRET_KEY</code>.'
    : `Credentials are encrypted at rest (AES-256-GCM). <strong>The key is currently kept in
       <code>data/secret.key</code> next to the database</strong> — that protects against someone
       reading a copy of the database, not against someone with access to the whole data folder.
       Set <code>GAMESAUCE_SECRET_KEY</code> to move the key out.`;

  $$('.provider-block', wrap).forEach((block) => {
    const providerId = block.dataset.provider;

    $('[data-act="save-provider"]', block)?.addEventListener('click', async (e) => {
      const fields = {};
      for (const input of $$('input', block)) {
        // Blank means "leave as it was" unless the user is clearing on purpose,
        // so we only send what was typed.
        if (input.disabled || input.value === '') continue;
        fields[input.name] = input.value;
      }
      if (!Object.keys(fields).length) return toast('Nothing to save — type a value first', true);

      const btn = e.target;
      btn.disabled = true;
      try {
        const res = await api('/metadata/providers', { method: 'PUT', body: JSON.stringify({ fields }) });
        renderProviderForms({ ...res, encryption: res.encryption }, res.status);
        toast(res.rejected?.length ? `Saved, ${res.rejected.length} field(s) refused` : 'Credentials saved', Boolean(res.rejected?.length));
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    });

    $('[data-act="clear-own-dev"]', block)?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Use shared dev credentials?',
        body: 'Forgets your own dev ID/password and falls back to the shared default. Your site login is untouched.',
        okLabel: 'Use shared',
        danger: true
      });
      if (!ok) return;
      try {
        const res = await api('/metadata/providers', {
          method: 'PUT',
          body: JSON.stringify({ fields: { SS_DEV_ID: '', SS_DEV_PASSWORD: '' } })
        });
        renderProviderForms({ ...res, encryption: res.encryption }, res.status);
        toast('Back on the shared dev credentials');
      } catch (err) {
        toast(err.message, true);
      }
    });

           $('[data-act="test-provider"]', block)?.addEventListener('click', async (e) => {
      const out = $('.provider-result', block);
      out.textContent = 'testing…';
      out.className = 'provider-result';
      try {
        const res = await api('/metadata/providers/test', {
          method: 'POST', body: JSON.stringify({ provider: providerId })
        });
        if (res.ok) {
          out.textContent = providerId === 'screenscraper' && res.detail?.today != null
            ? `works — ${res.detail.today}/${res.detail.max} requests used today`
            : `works${res.detail?.sample ? ` — “${res.detail.sample}”` : ''}${res.detail?.cover === false ? ' (no cover art returned — key valid, art missing for this title)' : ''}`;
          out.classList.add('ok');
        } else {
          out.textContent = res.hint ? `${res.error} — ${res.hint}` : (res.error || 'failed');
          out.classList.add('bad');
          out.style.maxWidth = '420px';
        }
      } catch (err) {
        out.textContent = err.message;
        out.classList.add('bad');
      }
    });
  });
}

/* ─────────────────────────── DAT files ─────────────────────────── */

const DAT_STATUS_META = {
  verified: { label: 'Verified', color: '#34d399' },
  bad: { label: 'Bad dump', color: '#f87171' },
  variant: { label: 'Variant', color: '#fbbf24' },
  'not-in-dat': { label: 'Not in DAT', color: '#64748b' },
  unchecked: { label: 'Unchecked', color: '#334155' }
};

async function loadDats() {
  const data = await api('/dats');
  const { coverage } = data;

  // Platform picker, grouped by family.
  const sel = $('#dat-platform');
  if (sel.options.length <= 1) {
    const groups = new Map();
    for (const p of data.platforms) {
      const fam = p.family || 'Others';
      if (!groups.has(fam)) groups.set(fam, []);
      groups.get(fam).push(p);
    }
    sel.innerHTML = '<option value="auto">Detect platform from the DAT name</option>' +
      [...groups.entries()].map(([fam, plats]) => `
        <optgroup label="${esc(fam)}">
          ${plats.map((p) => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join('')}
        </optgroup>`).join('');
  }

  const total = coverage.total || 0;
  const counts = coverage.status || {};
  const order = ['verified', 'variant', 'bad', 'not-in-dat', 'unchecked'];

  $('#dat-coverage').innerHTML = total ? `
    <div class="coverage-bar">
      ${order.map((k) => {
        const n = counts[k] || 0;
        if (!n) return '';
        return `<i style="width:${(n / total) * 100}%;background:${DAT_STATUS_META[k].color}" title="${DAT_STATUS_META[k].label}: ${n}"></i>`;
      }).join('')}
    </div>
    <div class="coverage-legend">
      ${order.filter((k) => counts[k]).map((k) =>
        `<span><b style="background:${DAT_STATUS_META[k].color}"></b>${DAT_STATUS_META[k].label} ${counts[k]}</span>`).join('')}
      <span style="margin-left:auto">${total} ROMs</span>
    </div>
  ` : '<div class="side-empty">No ROMs yet.</div>';

  $('#dat-list').innerHTML = data.items.length ? data.items.map((d) => {
    const have = d.roms_matched || 0;
    const want = d.missing_count ?? Math.max(0, (d.entries || 0) - have);
    return `
    <div class="source-card" data-dat="${d.id}">
      <div class="source-top">
        <span class="source-name">${esc(d.name)}</span>
        ${d.source ? `<span class="pill accent">${esc(d.source)}</span>` : ''}
        ${d.platform_short ? `<span class="pill">${esc(d.platform_short)}</span>` : ''}
        <div class="source-actions">
          <button class="btn btn-sm" data-act="have-want">Have/want</button>
          <button class="btn btn-sm btn-danger" data-act="delete-dat">Remove</button>
        </div>
      </div>
      <div class="source-stats">
        <span><b>${d.entries.toLocaleString()}</b> entries</span>
        <span><b style="color:var(--good)">${have.toLocaleString()}</b> have</span>
        <span><b style="color:var(--warn)">${want.toLocaleString()}</b> missing</span>
        ${d.version ? `<span>version ${esc(d.version)}</span>` : ''}
        <span>imported ${esc(d.imported_at)} UTC</span>
      </div>
    </div>
  `}).join('') : '<div class="side-empty">No DAT files imported yet.</div>';

  $$('[data-dat]').forEach((card) => {
    $('[data-act="delete-dat"]', card).addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Remove this DAT?',
        body: 'ROMs keep their titles but lose its verification.',
        okLabel: 'Remove',
        danger: true
      });
      if (!ok) return;
      try {
        await api(`/dats/${card.dataset.dat}`, { method: 'DELETE' });
        toast('DAT removed');
        await loadDats();
        loadLibrary();
      } catch (err) { toast(err.message, true); }
    });

    $('[data-act="have-want"]', card).addEventListener('click', () => openHaveWant(Number(card.dataset.dat)));
  });
}

/**
 * Have/want: what one DAT lists vs what this library holds. Missing means the
 * DAT knows the dump but nothing in the library matched it.
 */
const hwState = { datId: null, want: 'missing', q: '', offset: 0, total: 0 };

async function openHaveWant(datId) {
  hwState.datId = datId;
  hwState.want = 'missing';
  hwState.q = '';
  hwState.offset = 0;
  $('#hw-search').value = '';
  $$('#hw-tabs button').forEach((b) => b.classList.toggle('is-active', b.dataset.hw === 'missing'));
  $('#have-want').classList.remove('hidden');
  await loadHaveWant(true);
  $('#have-want').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadHaveWant(reset = false) {
  if (hwState.datId == null) return;
  if (reset) hwState.offset = 0;

  const params = new URLSearchParams({
    want: hwState.want,
    limit: '100',
    offset: String(hwState.offset)
  });
  if (hwState.q) params.set('q', hwState.q);

  const data = await api(`/dats/${hwState.datId}/have-want?${params}`);
  hwState.total = data.total;

  const have = data.datfile.roms_matched || 0;
  const want = data.datfile.missing_count ?? Math.max(0, (data.datfile.entries || 0) - have);

  $('#hw-title').textContent = `Have / want — ${data.datfile.name}`;
  $('#hw-summary').textContent =
    `${data.datfile.entries.toLocaleString()} in DAT · ${have.toLocaleString()} have · ${want.toLocaleString()} missing. ` +
    (hwState.want === 'missing'
      ? '“Missing” = in the DAT but matched by nothing in your library.'
      : hwState.want === 'have'
        ? '“Have” = DAT entries matched by a ROM in your library.'
        : 'Everything this DAT lists, flagged by whether you hold it.');

  const items = data.items.map((e) => `
    <div class="result-row ${e.have ? 'ok' : 'err'}">
      <span class="status"></span>
      <span class="name">${esc(e.title)}${e.rom_name && e.rom_name !== e.title ? ` <span class="note">(${esc(e.rom_name)})</span>` : ''}</span>
      <span class="note">${e.have ? 'have' : 'missing'}</span>
    </div>
  `).join('');

  $('#hw-list').innerHTML = (reset ? '' : $('#hw-list').innerHTML) + (items || '');
  if (!$('#hw-list').innerHTML) {
    $('#hw-list').innerHTML = hwState.want === 'missing'
      ? '<div class="side-empty">Nothing missing — you hold every entry in this DAT.</div>'
      : '<div class="side-empty">No entries match.</div>';
  }
  hwState.offset += data.items.length;
  $('#hw-more').classList.toggle('hidden', hwState.offset >= hwState.total);
}

let hwSearchTimer;
$('#hw-search').addEventListener('input', (e) => {
  clearTimeout(hwSearchTimer);
  hwSearchTimer = setTimeout(() => {
    hwState.q = e.target.value.trim();
    loadHaveWant(true);
  }, 200);
});

$$('#hw-tabs button').forEach((b) => b.addEventListener('click', () => {
  hwState.want = b.dataset.hw;
  $$('#hw-tabs button').forEach((x) => x.classList.toggle('is-active', x === b));
  loadHaveWant(true);
}));

$('#hw-more').addEventListener('click', () => loadHaveWant(false));
$('#hw-close').addEventListener('click', () => $('#have-want').classList.add('hidden'));

async function rematchDats({ force = false } = {}) {
  try {
    const r = await api('/dats/rematch', { method: 'POST', body: JSON.stringify({ force }) });
    toast(`${r.matched} of ${r.checked} matched${r.mame_titled ? `, ${r.mame_titled} MAME titled from name list` : ''}${r.renamed ? `, ${r.renamed} retitled` : ''}${r.bad ? `, ${r.bad} bad dump(s)` : ''}`);
    await loadDats();
    loadLibrary();
  } catch (err) {
    toast(err.message, true);
  }
}

$('#dat-upload').addEventListener('click', async (e) => {
  const file = $('#dat-file').files?.[0];
  if (!file) return toast('Choose a .dat file first', true);

  const btn = e.target;
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const fd = new FormData();
    fd.append('dat', file);
    fd.append('platform', $('#dat-platform').value);

    const res = await fetch('/api/dats', {
      method: 'POST', credentials: 'same-origin',
      headers: { Authorization: `Bearer ${sessionStorage.getItem('gamesauce_token') || ''}` },
      body: fd
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Import failed');

    toast(data.kind === 'mame-names'
      ? `MAME name list: ${data.names.toLocaleString()} names loaded, ${data.matched} of your ${data.mame_roms} MAME ROMs titled`
      : `${data.entries.toLocaleString()} entries imported (${data.platform_name})`);
    $('#dat-file').value = '';
    await loadDats();
    // A MAME name list is applied server-side already; the checksum re-match would
    // only replace the toast with a misleading "0 matched".
    if (data.kind === 'mame-names') loadLibrary();
    else await rematchDats();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import';
  }
});

$('#dat-rematch').addEventListener('click', () => rematchDats());
$('#dat-rematch-force').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Overwrite hand-edited titles?',
    body: 'Replaces titles you edited by hand with the DAT canonical titles.',
    okLabel: 'Overwrite',
    danger: true
  });
  if (!ok) return;
  rematchDats({ force: true });
});

/* ─────────────────────────── database tools (admin) ─────────────────────────── */

function renderDbTools(facets) {
  const panel = $('#db-tools');
  const box = $('#db-health');
  if (!panel || !box) return;

  // Only admins ever see the Settings view, and only admins can call the purge
  // endpoint — but double-check the role anyway so a stale session can't render
  // a button that will just 403.
  const isAdmin = authState.user?.role === 'admin';
  panel.classList.toggle('hidden', !isAdmin);
  if (!isAdmin) return;

  const stats = facets.stats || {};
  const orphaned = stats.orphaned || 0;
  const missingSourced = stats.missing_sourced || 0;
  const neverEnriched = stats.never_enriched || 0;
  const importedSeed = stats.imported_or_seed || 0;

  box.innerHTML = `
    <div><span>Library ROMs (visible)</span><b>${stats.roms || 0}</b></div>
    <div><span>Hidden</span><b>${stats.hidden || 0}</b></div>
    <div><span>Missing files (drive offline)</span><b>${missingSourced}</b></div>
    <div><span>Orphaned (no valid source)</span><b>${orphaned}</b></div>
    <div><span>Never enriched</span><b>${neverEnriched}</b></div>
    <div><span>Imported copies / seed rows</span><b>${importedSeed}</b></div>
  `;

  $('#db-show-orphans').onclick = () => {
    setView('library');
    state.platform = 'all';
    state.q = '';
    state.orphan = true;
    $('#search').value = '';
    window.__orphanOnly = true;
    loadLibrary();
  };
}

/**
 * Orphan-only view. Now just flips the orphan flag and reuses the normal
 * library loader (same grid, filters, selection, chips) instead of a bespoke
 * renderer that could drift out of sync.
 */
async function loadLibraryOrphans(options = {}) {
  const keepSelection = options.keepSelection === true;
  const selectedBefore = keepSelection ? [...state.selected] : [];
  state.orphan = true;
  state.platform = 'all';
  if (!keepSelection) { state.q = ''; $('#search').value = ''; }
  if (keepSelection) state.selected = new Set(selectedBefore);
  await loadLibrary();
  window.__orphanOnly = false;
}

$('#db-health-refresh')?.addEventListener('click', async () => {
  try {
    const facets = await api('/roms/facets');
    renderDbTools(facets);
    toast('Counts refreshed');
  } catch (err) {
    toast(err.message, true);
  }
});

$('#db-show-orphans')?.addEventListener('click', () => {
  // Wired in renderDbTools too; this covers the first paint.
  setView('library');
  state.platform = 'all';
  state.q = '';
  $('#search').value = '';
  state.orphan = true;
  window.__orphanOnly = true;
  loadLibrary();
});

// Clear cover art for one chosen platform (counts first, then confirms).
async function fillClearCoversPlatforms() {
  const sel = $('#db-clear-covers-platform');
  if (!sel || sel.dataset.filled) return;
  if (!(window.__platformsCache || []).length) {
    try { window.__platformsCache = (await api('/platforms')).items; } catch { return; }
  }
  sel.dataset.filled = '1';
  sel.innerHTML = platformOptions({ selected: 'mame', excludeOther: false });
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-mod="db"], [data-group], #settings-tiles')) setTimeout(fillClearCoversPlatforms, 50); });
$('#db-clear-covers-platform')?.addEventListener('focus', fillClearCoversPlatforms);

$('#db-clear-covers')?.addEventListener('click', async () => {
  await fillClearCoversPlatforms();
  const slug = $('#db-clear-covers-platform')?.value || 'mame';
  const pname = $('#db-clear-covers-platform')?.selectedOptions?.[0]?.textContent || slug;
  try {
    const info = await api('/roms/clear-covers', { method: 'POST', body: JSON.stringify({ platform: slug }) });
    if (!info.would_clear) return toast(`No ${pname} covers to clear`);
    const ok = await confirmDialog({
      title: `Clear covers on ${info.would_clear} ${pname} ROM${info.would_clear === 1 ? '' : 's'}?`,
      body: 'Removes the cover art only. Titles, other metadata and the ROM files are not touched.',
      okLabel: 'Clear covers',
      danger: true
    });
    if (!ok) return;
    const r = await api('/roms/clear-covers', { method: 'POST', body: JSON.stringify({ platform: slug, dry_run: false }) });
    toast(`Cleared covers on ${r.cleared} ${pname} ROM${r.cleared === 1 ? '' : 's'}`);
    loadLibrary();
  } catch (err) { toast(err.message, true); }
});

$('#db-purge-orphans')?.addEventListener('click', async () => {
  let info;
  try {
    info = await api('/roms?orphan=only&limit=1');
  } catch (err) {
    return toast(err.message, true);
  }
  if (!info.total) return toast('No orphaned ROMs — nothing to purge');
  const first = await confirmDialog({
    title: `Purge ${info.total} orphaned ROM${info.total === 1 ? '' : 's'}?`,
    body: 'Catalogue rows are always removed. Imported copies in storage/roms are removed too.\nFiles in your own folders are NEVER touched.',
    okLabel: 'Purge',
    danger: true
  });
  if (!first) return;
  // Deleting imported copies from disk is the destructive half — confirm separately.
  const { checked: deleteFiles } = await confirmDialog({
    title: 'Also delete imported copies?',
    body: 'Tick the box to remove imported files from storage/roms as well.\nUnticked = catalogue rows only, every file stays on disk.',
    okLabel: 'Purge',
    danger: true,
    checkLabel: 'Also delete the imported copies from storage'
  });
  if (deleteFiles === undefined) return;
  try {
    const r = await api(`/roms?dry_run=0${deleteFiles ? '&delete_file=1' : ''}`, { method: 'DELETE' });
    toast(`Purged ${r.deleted} orphaned ROM${r.deleted === 1 ? '' : 's'}${r.files_deleted ? ` (${r.files_deleted} files removed)` : ''}`);
    const facets = await api('/roms/facets');
    renderDbTools(facets);
    await Promise.all([loadLibrary(), loadPlatforms()]);
  } catch (err) {
    toast(err.message, true);
  }
});

async function loadSettingsOld() {
  const [meta, facets] = await Promise.all([api('/metadata'), api('/roms/facets')]);
  const stats = facets.stats;

  renderProviderForms(meta.config, meta.providers);
  renderDbTools(facets);
  loadPlatformAdmin().catch((err) => toast(err.message, true));

  const counts = new Map(meta.counts.map((c) => [c.source, c.count]));
  const total = stats.roms || 0;
  const enriched = stats.enriched || 0;

  loadStatsPanel().catch(() => {});

  loadDats().catch((err) => toast(err.message, true));

  const ss = meta.providers.find((p) => p.id === 'screenscraper');
  $('#ss-quota').textContent = ss?.enabled
    ? (ss.quota?.today != null
        ? `ScreenScraper quota used today: ${ss.quota.today} / ${ss.quota.max}.`
        : 'ScreenScraper configured. Quota is reported after the first request.')
    : 'ScreenScraper is not configured yet — covers fall back to filename initials until credentials are set.';
}

// Metadata fetch runs as a SERVER job: it survives page refreshes and closing the tab.
// The UI just starts/stops it and polls; a floating pill shows progress in every view.
let enrichPollTimer = null;
let enrichWasRunning = false;
function renderEnrichJob(j) {
  const btn = $('#bulk-enrich');
  let pill = $('#enrich-pill');
  if (j?.running) {
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'enrich-pill';
      pill.className = 'enrich-pill';
      pill.innerHTML = '<div class="ep-text"></div><div class="ep-bar"><i></i></div><button class="btn btn-sm" id="enrich-stop">Stop</button>';
      document.body.appendChild(pill);
      $('#enrich-stop', pill).addEventListener('click', stopEnrichJob);
    }
    const pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : 0;
    $('.ep-text', pill).textContent = `${j.stop ? 'Stopping… ' : j.onlyMissingCovers ? 'Fetching missing covers ' : 'Fetching metadata '}${j.platform ? `(${String(j.platform).toUpperCase()}) ` : ''}${j.done} / ${j.total} · ${j.updated} updated${j.failed ? ` · ${j.failed} failed` : ''}`;
    $('.ep-bar i', pill).style.width = pct + '%';
    if (btn) btn.textContent = `✦ Fetching… ${j.done}/${j.total}`;
  } else {
    pill?.remove();
    if (btn) btn.textContent = '✦ Fetch metadata';
  }
}
async function pollEnrichJob() {
  let j = null;
  try { j = await api('/roms/bulk/enrich-job'); } catch { return; }
  renderEnrichJob(j);
  if (j.running) { enrichWasRunning = true; return; }
  clearInterval(enrichPollTimer); enrichPollTimer = null;
  if (enrichWasRunning) {
    enrichWasRunning = false;
    toast(`${j.stop ? 'Stopped: ' : 'Done: '}${j.updated} updated, ${j.skipped} no match/skipped, ${j.failed} failed${j.lastError && j.failed ? ` (e.g. ${String(j.lastError).slice(0, 80)})` : ''}`, !j.updated && j.failed > 0);
    await Promise.all([loadLibrary(), loadPlatforms()]);
  }
}
function startEnrichPolling() {
  if (enrichPollTimer) return;
  enrichPollTimer = setInterval(pollEnrichJob, 1500);
  pollEnrichJob();
}
async function stopEnrichJob() {
  try { renderEnrichJob(await api('/roms/bulk/enrich-job', { method: 'DELETE' })); } catch (err) { toast(err.message, true); }
}
async function bulkEnrich({ onlyMissingCovers = false } = {}) {
  try {
    // With a platform selected in the Library, only that platform's games are looked up.
    const picked = state.view === 'library' && state.platform && state.platform !== 'all' ? [state.platform, ...(state.extraPlatforms || [])] : [];
    // The server looks up one platform per run. With several chips picked, ask which scope to use rather than quietly doing only the first.
    let platform = picked[0] || '';
    if (picked.length > 1) {
      const choice = await confirmChoice({ title: 'Fetch metadata for which games?', body: `You have ${picked.length} platforms selected (${picked.map((s) => s.toUpperCase()).join(', ')}). A metadata run covers one platform or the whole library.`, choices: [{ id: 'first', label: `Just ${picked[0].toUpperCase()}` }, { id: 'all', label: 'The whole library' }] });
      if (!choice) return;
      platform = choice === 'all' ? '' : picked[0];
    }
    const j = await api('/roms/bulk/enrich-job', { method: 'POST', body: JSON.stringify({ only_missing_covers: onlyMissingCovers, platform }) });
    enrichWasRunning = true;
    renderEnrichJob(j);
    startEnrichPolling();
  } catch (err) {
    if (/already in progress/i.test(err.message)) { startEnrichPolling(); toast('A metadata run is already in progress'); }
    else toast(err.message, true);
  }
}

$('#bulk-enrich').addEventListener('click', () => { if (enrichPollTimer && $('#enrich-pill')) stopEnrichJob(); else bulkEnrich(); });
$('#enrich-missing-covers').addEventListener('click', () => bulkEnrich({ onlyMissingCovers: true }));

/** Platform ids: check ours against each provider's list, show what is missing or wrong, and let the admin accept the suggested number. */
async function verifyPlatformIds() {
  const box = $('#pid-report'); if (!box) return;
  const PROV = { screenscraper: 'ScreenScraper', thegamesdb: 'TheGamesDB' };
  box.classList.remove('hidden'); box.innerHTML = '<p class="hint">Checking against the providers…</p>';
  let r;
  try { r = await api('/metadata/platform-ids'); } catch (err) { box.innerHTML = `<p class="hint">${esc(err.message)}</p>`; return; }
  const sum = Object.entries(r.counts).map(([k, c]) => `<b>${PROV[k] || k}</b>: ${c.ok} of ${c.checked} fine${c.missing ? `, ${c.missing} with no number` : ''}${c.unresolved ? `, ${c.unresolved} not on its list` : ''}${c.suspicious ? `, ${c.suspicious} that look like the wrong console` : ''}`).join('<br>');
  const label = { missing: 'no number', unresolved: 'number not on the provider\'s list', suspicious: 'number is a different console' };
  const rows = r.rows.map((x, i) => {
    const sug = x.suggestion;
    return `<div class="pid-row" data-i="${i}">
      <div class="pid-what"><b>${esc(x.name)}</b> <span class="note">(${esc(x.slug)}) · ${esc(PROV[x.provider] || x.provider)} · ${label[x.status]}${x.current ? `: ${x.current.id}${x.current.name ? ` = ${esc(x.current.name)}` : ''}` : ''}</span></div>
      <div class="pid-fix">${sug ? `<span class="note">Likely: <b>${sug.id}</b> ${esc(sug.name)} (${sug.score}% alike)</span> <button class="btn btn-sm${x.confident ? ' btn-primary' : ''}" data-pid-use="${i}" title="Save ${sug.id} as this platform's ${esc(PROV[x.provider] || x.provider)} number">Use ${sug.id}</button>${x.candidates.length > 1 ? `<span class="note"> Others: ${x.candidates.slice(1).map((c) => `${c.id} ${esc(c.name)}`).join(' · ')}</span>` : ''}` : '<span class="note">No close match by name: look it up on the provider\'s site and type it into the platform\'s edit form.</span>'}</div>
    </div>`;
  }).join('');
  const sure = r.rows.filter((x) => x.confident && x.suggestion);
  box.innerHTML = `<p class="hint" style="margin-top:10px">${sum}${r.notes?.length ? `<br><span class="note">${r.notes.map(esc).join(' ')}</span>` : ''}</p>
    ${rows ? `${sure.length ? `<div style="margin:6px 0"><button class="btn btn-sm btn-primary" id="pid-apply-all" title="Save every suggestion that is a close name match">Use the ${sure.length} close match${sure.length === 1 ? '' : 'es'}</button></div>` : ''}<div class="pid-list">${rows}</div>` : '<p class="hint"><b>Everything checks out.</b></p>'}`;
  const save = async (x) => api(`/platforms/${encodeURIComponent(x.slug)}`, { method: 'PATCH', body: JSON.stringify({ [x.field]: x.suggestion.id }) });
  $$('[data-pid-use]', box).forEach((b) => b.addEventListener('click', async () => {
    const x = r.rows[Number(b.dataset.pidUse)];
    try { await save(x); toast(`${x.name}: ${PROV[x.provider]} number set to ${x.suggestion.id}`); b.closest('.pid-row').classList.add('pid-done'); b.disabled = true; loadPlatformAdmin?.(); loadPlatforms?.(); } catch (err) { toast(err.message, true); }
  }));
  $('#pid-apply-all', box)?.addEventListener('click', async () => {
    let n = 0;
    for (const x of sure) { try { await save(x); n++; } catch { /* the rest still go */ } }
    toast(`Saved ${n} platform number${n === 1 ? '' : 's'}`); loadPlatformAdmin?.(); loadPlatforms?.(); verifyPlatformIds();
  });
}
$('#check-ss-systems').addEventListener('click', verifyPlatformIds);

/* ─────────────────────────── platforms (admin) ─────────────────────────── */

async function loadPlatformAdmin() {
  const list = $('#platform-admin-list');
  const form = $('#platform-add-form');
  const msg = $('#platform-admin-msg');
  if (!list || !form) return;
  if (authState.user?.role !== 'admin') return;

  // Hide the details form until "Add platform" is clicked; the add button
  // sits uppermost, form next, listing last (order requested).
  form.classList.add('hidden');
  $('#platform-add-toggle')?.addEventListener('click', () => {
    form.classList.remove('hidden');
    // The Settings header is pinned to the top, so leave room for it or the form's first fields sit underneath it.
    const pinned = document.querySelector('.settings-anchor');
    const addBar = document.querySelector('.platform-add-bar'); // the sticky "Add platform" bar sits under the header too
    form.style.scrollMarginTop = ((pinned ? pinned.offsetHeight : 0) + (addBar ? addBar.offsetHeight : 0) + 12) + 'px';
    requestAnimationFrame(() => form.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    form.querySelector('input')?.focus({ preventScroll: true });
  });
  $('#platform-add-cancel')?.addEventListener('click', () => form.classList.add('hidden'));
  // Slug: suggested from the name (lowercase letters and digits) until the person types their own.
  {
    const nameIn = form.querySelector('[name="name"]'), slugIn = form.querySelector('[name="slug"]');
    if (nameIn && slugIn && !nameIn.dataset.slugWired) {
      nameIn.dataset.slugWired = '1';
      slugIn.addEventListener('input', () => { slugIn.dataset.own = slugIn.value ? '1' : ''; });
      nameIn.addEventListener('input', () => { if (!slugIn.dataset.own) slugIn.value = nameIn.value.toLowerCase().replace(/[^a-z0-9]+/g, ''); });
    }
  }

  let items = [];
  try {
    const data = await api('/platforms/all');
    items = data.items || [];
  } catch (err) {
    list.innerHTML = `<div class="side-empty">${esc(err.message || 'Could not load platforms')}</div>`;
    return;
  }
  if (!items.length) {
    list.innerHTML = '<div class="side-empty">No platforms in the catalogue.</div>';
    return;
  }

  const byFamily = new Map();
  for (const p of items) {
    const fam = p.family || 'Others';
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam).push(p);
  }

  // What each platform looks like, shown on its row without opening Edit: its colour (the swatch, with the code as the hover text and in the line below) and its logo.
  const hexOk = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
  const logoHtml = (slug, v, plate) => (v ? `<span class="lib-logo plat-logo${plate ? ' on-plate' : ''}"><img src="/api/platforms/${encodeURIComponent(slug)}/logo?v=${v}" alt="" loading="lazy" /></span>` : '<span class="lib-logo plat-logo plat-nologo" title="No logo yet: add one under Edit">no logo</span>');
  const platId = (p) => `<span class="plat-id" data-plat-id>${hexOk(p.accent) ? `<i class="plat-swatch" style="background:${esc(p.accent)}" title="Colour ${esc(p.accent)}" aria-label="Colour ${esc(p.accent)}"></i>` : '<i class="plat-swatch none" title="No colour set" aria-label="No colour set"></i>'}${logoHtml(p.slug, p.logo_v, p.logo_plate)}</span>`;
  list.innerHTML = [...byFamily.entries()].map(([fam, plats]) => `
    <div class="section-label fam-head" style="margin-top:10px" data-fam="${esc(fam)}"><span class="fam-name">${esc(fam)}</span> <input type="color" class="fam-colour" data-fam-colour="${esc(fam)}" value="${esc(/^#[0-9a-f]{6}$/i.test(plats[0]?.family_colour || '') ? plats[0].family_colour : '#6b7280')}" title="The colour of the ${esc(fam)} chip (the platform chips keep their own colours)" aria-label="Colour of the ${esc(fam)} family" /> <button class="btn btn-sm btn-ghost" data-fam-colour-reset="${esc(fam)}" title="Back to the default colour for this family">Reset colour</button> <span class="lib-logo fam-logo-box" data-famlogo-box="${esc(fam)}">${plats[0]?.family_logo_v ? `<img src="/api/platforms/families/logo?family=${encodeURIComponent(fam)}&v=${plats[0].family_logo_v}" alt="" />` : ''}</span> <label class="btn btn-sm btn-ghost" data-famlogo-pick="${esc(fam)}" title="A logo for the ${esc(fam)} family, shown in the Library when several of its platforms are picked (optional; the system supplies none)">Logo<input type="file" accept="image/jpeg,image/png,image/webp,image/svg+xml,.svg" hidden data-famlogo-file="${esc(fam)}" /></label> <button class="btn btn-sm btn-ghost" data-famlogo-remove="${esc(fam)}" ${plats[0]?.family_logo_v ? '' : 'hidden'} title="Remove the family logo">Remove logo</button> <label class="policy-row fam-plate" ${plats[0]?.family_logo_v ? '' : 'hidden'} title="For a logo drawn in black that vanishes on the dark theme: show it on a light plate when the theme is dark" style="margin:0"><input type="checkbox" data-famlogo-plate="${esc(fam)}" ${plats[0]?.family_logo_plate ? 'checked' : ''} /> <span>Light backing in dark mode</span></label> <button class="btn btn-sm btn-ghost" data-fam-rename="${esc(fam)}" title="Rename this family for all ${plats.length} of its platforms (use an existing family's name to merge them)">Rename</button></div>
    ${plats.map((p) => `
      <div class="result-row ok" data-platform="${esc(p.slug)}" style="align-items:flex-start">
        <span class="status"></span>
        ${platId(p)}
        <span class="name">${esc(p.name)}<br /><span class="note">slug: ${esc(p.slug)} · colour: ${esc(hexOk(p.accent) ? p.accent : '—')} · ext: ${esc((p.extensions || []).join(', ') || '—')} · SS: ${p.screenscraper_id ?? '—'} · TGDB: ${p.tgdb_id ?? '—'}</span></span>
        <span class="note">
          <button class="btn btn-sm" data-pact="edit">Edit</button>
          <button class="btn btn-sm btn-danger" data-pact="delete">Delete</button>
        </span>
      </div>
      <div class="plat-edit hidden" data-pedit="${esc(p.slug)}" style="margin:6px 0 10px 18px;display:grid;gap:8px;grid-template-columns:1fr 1fr">
      </div>`).join('')}
  `).join('');

  makeFoldable(list, '.fam-head', 'platforms', (h) => h.dataset.fam);

  // Existing families, offered as suggestions in the Add and Edit forms (typing a new name still works).
  { const dl = $('#family-list'); if (dl) dl.innerHTML = [...byFamily.keys()].map((f) => `<option value="${esc(f)}"></option>`).join(''); }

  // Family colour: pick one and it saves when the picker closes; a colour that could not be seen on both themes is refused with the reason.
  $$('[data-fam-colour]', list).forEach((inp) => inp.addEventListener('change', async () => {
    try { await api('/platforms/families/colour', { method: 'PUT', body: JSON.stringify({ family: inp.dataset.famColour, colour: inp.value }) }); toast(`${inp.dataset.famColour} colour saved`); loadPlatforms(); }
    catch (err) { toast(err.message, true); loadPlatformAdmin(); }
  }));
  $$('[data-fam-colour-reset]', list).forEach((b) => b.addEventListener('click', async () => {
    try { await api('/platforms/families/colour', { method: 'PUT', body: JSON.stringify({ family: b.dataset.famColourReset, colour: '' }) }); toast('Back to the default colour'); loadPlatformAdmin(); loadPlatforms(); }
    catch (err) { toast(err.message, true); }
  }));

  // Family logo: uploads at once; the server's reason is shown if it is refused.
  $$('[data-famlogo-file]', list).forEach((inp) => inp.addEventListener('change', async () => {
    const f = inp.files?.[0]; if (!f) return;
    const fd = new FormData(); fd.append('logo', f); fd.append('family', inp.dataset.famlogoFile);
    try { await api('/platforms/families/logo', { method: 'POST', body: fd }); toast('Family logo saved'); loadPlatformAdmin(); loadPlatforms(); }
    catch (err) { toast(err.message, true); }
    inp.value = '';
  }));
  $$('[data-famlogo-plate]', list).forEach((inp) => inp.addEventListener('change', async () => {
    try { await api('/platforms/families/logo/plate', { method: 'PUT', body: JSON.stringify({ family: inp.dataset.famlogoPlate, plate: inp.checked }) }); toast(inp.checked ? 'Light backing on in dark mode' : 'Light backing off'); loadPlatforms(); }
    catch (err) { inp.checked = !inp.checked; toast(err.message, true); }
  }));
  $$('[data-famlogo-remove]', list).forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/platforms/families/logo?family=${encodeURIComponent(b.dataset.famlogoRemove)}`, { method: 'DELETE' }); toast('Family logo removed'); loadPlatformAdmin(); loadPlatforms(); }
    catch (err) { toast(err.message, true); }
  }));

  // Rename a whole family: the heading turns into a box. Enter saves, Escape cancels.
  $$('[data-fam-rename]', list).forEach((btn) => btn.addEventListener('click', () => {
    const from = btn.dataset.famRename, head = btn.closest('.fam-head');
    head.innerHTML = `<input class="search fam-input" value="${esc(from)}" maxlength="40" aria-label="New name for the ${esc(from)} family" style="max-width:260px" /> <button class="btn btn-sm btn-primary" data-fam-save>Save</button> <button class="btn btn-sm btn-ghost" data-fam-cancel>Cancel</button>`;
    const inp = $('.fam-input', head); inp.focus(); inp.select();
    const done = async () => {
      const to = inp.value.trim();
      if (!to || to === from) { loadPlatformAdmin(); return; }
      try {
        const r = await api('/platforms/families/rename', { method: 'POST', body: JSON.stringify({ from, to }) });
        toast(`${r.changed} platform${r.changed === 1 ? '' : 's'} moved to ${r.to}${r.merged ? ' (joined the existing family)' : ''}`);
        loadPlatformAdmin(); loadPlatforms(); loadSources?.();
      } catch (err) { toast(err.message, true); }
    };
    $('[data-fam-save]', head).onclick = done;
    $('[data-fam-cancel]', head).onclick = () => loadPlatformAdmin();
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } else if (e.key === 'Escape') loadPlatformAdmin(); });
  }));

  const fillEdit = (slug) => {
    const p = items.find((x) => x.slug === slug);
    if (!p) return;
    const host = list.querySelector(`[data-pedit="${CSS.escape(slug)}"]`);
    host.classList.remove('hidden');
    host.innerHTML = `
      <label class="field"><span>Name</span><input data-pf="name" value="${esc(p.name)}" /></label>
      <label class="field"><span>Short name</span><input data-pf="short_name" value="${esc(p.short_name)}" /></label>
      <label class="field"><span>Badge text <span class="note">(optional: the text on this platform's cover badges and chips, in capitals. Empty = the default, up to 12 characters)</span></span><input data-pf="badge" maxlength="12" placeholder="${esc(String(p.short_name).toUpperCase())}" value="${esc(p.badge || '')}" /></label>
      <label class="field"><span>Family</span><input data-pf="family" value="${esc(p.family || '')}" list="family-list" autocomplete="off" /></label>
      <label class="field"><span>Manufacturer</span><input data-pf="manufacturer" value="${esc(p.manufacturer || '')}" /></label>
      <label class="field"><span>Extensions (comma separated)</span><input data-pf="extensions" value="${esc((p.extensions || []).join(', '))}" /></label>
      <label class="field"><span>Generation</span><input data-pf="generation" value="${p.generation ?? ''}" /></label>
      <label class="field"><span>ScreenScraper id</span><input data-pf="screenscraper_id" value="${p.screenscraper_id ?? ''}" /></label>
      <label class="field"><span>TheGamesDB id</span><input data-pf="tgdb_id" value="${p.tgdb_id ?? ''}" /></label>
      <label class="field"><span>Accent colour</span><input data-pf="accent" value="${esc(p.accent || '')}" /></label>
      <div class="field" style="grid-column:1/-1"><span>Logo <span class="note">(optional: your own picture, shown beside the platform name in the Library. JPEG, PNG, WebP or SVG, up to 512 KB. The system supplies none.)</span></span>
        <div class="logo-edit" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span class="lib-logo" data-logo-box>${p.logo_v ? `<img src="/api/platforms/${encodeURIComponent(p.slug)}/logo?v=${p.logo_v}" alt="" />` : '<i class="note">none</i>'}</span>
          <label class="btn btn-sm" data-logo-pick title="Choose a logo picture">Choose logo<input type="file" accept="image/jpeg,image/png,image/webp,image/svg+xml,.svg" data-logo-file hidden /></label>
          <button type="button" class="btn btn-sm btn-ghost" data-logo-remove ${p.logo_v ? '' : 'hidden'} title="Remove this platform's logo">Remove logo</button>
          <label class="policy-row" style="margin:0" ${p.logo_v ? '' : 'hidden'} data-logo-plate-row title="For a logo drawn in black that vanishes on the dark theme: show it on a light plate when the theme is dark"><input type="checkbox" data-logo-plate ${p.logo_plate ? 'checked' : ''} /> <span>Light backing in dark mode</span></label>
        </div>
      </div>
      <div class="field" style="grid-column:1/-1"><span>Icon</span>
        <div class="icon-pick" data-iconpick>${PLATFORM_ICON_TYPES.map((t) => `<button type="button" class="icon-opt${iconTypeFor(p) === t.id ? ' is-on' : ''}" data-icon="${t.id}" title="${esc(t.label)}" aria-label="${esc(t.label)}">${platformIconSvg({ ...p, icon: t.id }, 22)}<small>${esc(t.label)}</small></button>`).join('')}</div>
        <input type="hidden" data-pf="icon" value="${esc(p.icon || '')}" />
      </div>
      <div style="grid-column:1/-1;display:flex;gap:8px">
        <button class="btn btn-sm btn-primary" data-pact="save">Save</button>
        <button class="btn btn-sm btn-ghost" data-pact="cancel">Cancel</button>
      </div>`;
    host.querySelectorAll('[data-icon]').forEach((b) => b.addEventListener('click', () => {
      host.querySelectorAll('[data-icon]').forEach((x) => x.classList.toggle('is-on', x === b));
      host.querySelector('[data-pf="icon"]').value = b.dataset.icon;
    }));
    // Logo: uploads at once (it is not part of the Save button), with the server's reason if it is refused.
    const logoFile = host.querySelector('[data-logo-file]'), logoBox = host.querySelector('[data-logo-box]'), logoRm = host.querySelector('[data-logo-remove]');
    const repaintRowLogo = (v, plate) => { const t = list.querySelector(`[data-platform="${CSS.escape(slug)}"] .plat-logo`); if (t) t.outerHTML = logoHtml(slug, v, plate); };
    logoFile?.addEventListener('change', async () => {
      const f = logoFile.files?.[0]; if (!f) return;
      const fd = new FormData(); fd.append('logo', f);
      try {
        const j = await api(`/platforms/${encodeURIComponent(slug)}/logo`, { method: 'POST', body: fd });
        logoBox.innerHTML = `<img src="/api/platforms/${encodeURIComponent(slug)}/logo?v=${j.logo_v}" alt="" />`; logoRm.hidden = false; host.querySelector('[data-logo-plate-row]').hidden = false;
        repaintRowLogo(j.logo_v, host.querySelector('[data-logo-plate]')?.checked); toast('Logo saved'); loadPlatforms();
      } catch (err) { toast(err.message, true); }
      logoFile.value = '';
    });
    host.querySelector('[data-logo-plate]')?.addEventListener('change', async (e) => {
      try { await api(`/platforms/${encodeURIComponent(slug)}/logo/plate`, { method: 'PUT', body: JSON.stringify({ plate: e.target.checked }) }); list.querySelector(`[data-platform="${CSS.escape(slug)}"] .plat-logo`)?.classList.toggle('on-plate', e.target.checked); toast(e.target.checked ? 'Light backing on in dark mode' : 'Light backing off'); loadPlatforms(); }
      catch (err) { e.target.checked = !e.target.checked; toast(err.message, true); }
    });
    logoRm?.addEventListener('click', async () => {
      try { await api(`/platforms/${encodeURIComponent(slug)}/logo`, { method: 'DELETE' }); logoBox.innerHTML = '<i class="note">none</i>'; logoRm.hidden = true; host.querySelector('[data-logo-plate-row]').hidden = true; repaintRowLogo(null, false); toast('Logo removed'); loadPlatforms(); }
      catch (err) { toast(err.message, true); }
    });
    host.querySelector('[data-pact="save"]').onclick = async () => {
      const body = {};
      host.querySelectorAll('[data-pf]').forEach((inp) => { body[inp.dataset.pf] = inp.value.trim(); });
      try {
        await api(`/platforms/${slug}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast('Platform updated');
        await loadPlatformAdmin();
        loadPlatforms();
      } catch (err) { toast(err.message, true); }
    };
    host.querySelector('[data-pact="cancel"]').onclick = () => { host.classList.add('hidden'); host.innerHTML = ''; };
  };

  list.querySelectorAll('[data-platform]').forEach((row) => {
    const slug = row.dataset.platform;
    row.querySelector('[data-pact="edit"]').onclick = () => fillEdit(slug);
    row.querySelector('[data-pact="delete"]').onclick = async () => {
      const ok = await confirmDialog({
        title: `Delete platform “${slug}”?`,
        body: 'ROMs on it move to Other unless you purge them first.',
        okLabel: 'Delete',
        danger: true
      });
      if (!ok) return;
      try {
        const r = await api(`/platforms/${slug}?reassign=other`, { method: 'DELETE' });
        toast(r.reassigned ? `Deleted; ${r.reassigned} ROM(s) moved to Other` : 'Platform deleted');
        await loadPlatformAdmin();
        loadPlatforms();
        loadLibrary();
      } catch (err) {
        // Most likely still has ROMs and the caller must decide explicitly.
        if (String(err.message).includes('still has')) {
          const again = await confirmDialog({
            title: 'Platform still has ROMs',
            body: `${err.message}\n\nDelete anyway and move them to Other?`,
            okLabel: 'Move to Other',
            danger: true
          });
          if (!again) return;
          try {
            const r2 = await api(`/platforms/${slug}?reassign=other`, { method: 'DELETE' });
            toast(`Deleted; ${r2.reassigned} ROM(s) moved to Other`);
            await loadPlatformAdmin();
            loadPlatforms();
            loadLibrary();
          } catch (e2) { toast(e2.message, true); }
          return;
        }
        toast(err.message, true);
      }
    };
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {};
    for (const [k, v] of fd.entries()) body[k] = String(v).trim();
    if (msg) msg.textContent = 'Adding…';
    try {
      await api('/platforms', { method: 'POST', body: JSON.stringify(body) });
      form.reset();
      form.classList.add('hidden');
      if (msg) msg.textContent = 'Added. It is live in the sidebar now.';
      await loadPlatformAdmin();
      loadPlatforms();
    } catch (err) {
      if (msg) msg.textContent = '';
      toast(err.message, true);
    }
  };
}

/* ─────────────────────────── collections ─────────────────────────── */

/* ─────────────────────────── Digital Library: see public/digital.js ─────────────────────────── */

async function initSteamPanel() {
  const status = $('#steam-status'), id = $('#steam-id'), key = $('#steam-key');
  const paint = (s) => {
    id.value = s.steam_id || '';
    key.value = ''; key.placeholder = s.connected ? 'Saved (leave empty to keep it)' : '32 letters and numbers';
    $('#steam-sync').classList.toggle('hidden', !s.connected); $('#steam-remove').classList.toggle('hidden', !s.connected);
    status.textContent = s.connected
      ? `Connected.${s.last_sync ? ` Last fetched ${s.last_sync} UTC (${s.games.toLocaleString()} games).` : ' Press Fetch my games.'}${s.last_error ? ' Problem: ' + s.last_error : ''}`
      : 'Not connected.';
  };
  try { paint((await api('/digital')).steam); } catch (err) { status.textContent = err.message; }
  $('#steam-form').onsubmit = async (e) => {
    e.preventDefault();
    try { paint(await api('/digital/steam', { method: 'PUT', body: JSON.stringify({ steam_id: id.value, key: key.value }) })); toast('Steam details saved'); }
    catch (err) { toast(err.message, true); }
  };
  $('#steam-sync').onclick = async () => {
    const b = $('#steam-sync'); b.disabled = true;
    try { const r = await api('/digital/steam/sync', { method: 'POST' }); paint(r); toast(`${r.count.toLocaleString()} Steam games fetched`); }
    catch (err) { toast(err.message, true); try { paint((await api('/digital')).steam); } catch { /* keep the message */ } }
    b.disabled = false;
  };
  $('#steam-remove').onclick = async () => {
    if (!(await confirmDialog({ title: 'Remove Steam?', body: 'This removes your Steam key, your games list, and your favourites, hidden games and play-button choices from game-sauce. Nothing changes on Steam.', okLabel: 'Remove', danger: true }))) return;
    try { paint(await api('/digital/steam', { method: 'DELETE' })); toast('Steam removed'); } catch (err) { toast(err.message, true); }
  };
}

async function loadCollections() {
  const { items } = await api('/collections');
  const wrap = $('#collections');
  wrap.innerHTML = items.length ? items.map((c) => `
    <div class="collection-card" data-collection="${c.id}">
      <div class="collection-covers">${[0, 1, 2, 3].map((i) => (c.covers || [])[i] ? `<img loading="lazy" src="${esc(c.covers[i])}" alt="" />` : '<i></i>').join('')}</div>
      <div class="collection-name">${esc(c.name)}</div>
      <div class="collection-desc">${esc(c.description || 'No description')}</div>
      <div class="collection-count">${c.count ? `${c.count} ${c.count === 1 ? 'game' : 'games'} →` : 'No games yet →'}</div>
    </div>
  `).join('') : '<div class="empty"><h2>No collections yet</h2><p>Group ROMs into sets like “Co-op nights”.</p></div>';

  $$('[data-collection]', wrap).forEach((el) => el.addEventListener('click', () => openCollection(Number(el.dataset.collection))));
}

async function openCollection(id) {
  const c = await api(`/collections/${id}`);
  state.openRomId = null;
  $('#scrim').classList.remove('hidden');
  const drawer = $('#drawer');
  drawer.classList.remove('hidden');

  $('#drawer-body').innerHTML = `
    <h2 class="detail-title">${esc(c.name)}</h2>
    <p class="detail-desc">${esc(c.description || '')}</p>
    <div class="section-label">${c.items.length} ${c.items.length === 1 ? 'game' : 'games'}</div>
    <div class="results">
      ${c.items.map((r) => `
        <div style="display:flex;gap:6px;align-items:stretch;margin-bottom:4px">
          <button class="result-row ok" style="flex:1;margin:0" data-rom-open="${r.id}">
            <span class="status"></span>
            <span class="name">${esc(r.title)}</span>
            <span class="note">${esc(r.platform_short)}${r.release_year ? ` · ${r.release_year}` : ''}</span>
          </button>
          ${r.playable ? `<button class="btn btn-sm btn-play" data-rom-play="${r.id}" title="Play ${esc(r.title)} in the browser" aria-label="Play ${esc(r.title)} in the browser">▶ Play</button>` : ''}
          <button class="btn btn-sm" data-rom-remove="${r.id}" title="Remove from this collection (game stays in library)">✕ Remove</button>
        </div>`).join('') || '<div class="side-empty">Empty collection</div>'}
    </div>
    <div style="margin-top:16px">
      <button class="btn btn-danger btn-sm" data-act="delete-collection">Delete collection</button>
    </div>
  `;

  $('#drawer-nav')?.classList.add('hidden');
  $$('[data-rom-open]', drawer).forEach((b) => b.addEventListener('click', () => {
    state.navSnap = null; state.nav = { ids: c.items.map((r) => r.id) };
    openDetail(Number(b.dataset.romOpen));
  }));
  // Play straight from the collection. Fullscreen must be asked for inside this click, so the player opens first (as on a tile).
  $$('[data-rom-play]', drawer).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    api(`/roms/${b.dataset.romPlay}`).then(openPlayer).catch((err) => toast(err.message, true));
  }));
  $$('[data-rom-remove]', drawer).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api(`/collections/${id}/roms/${b.dataset.romRemove}`, { method: 'DELETE' });
      toast('Removed from collection');
      loadCollections();
      openCollection(id);
    } catch (err) { toast(err.message, true); b.disabled = false; }
  }));
  $('[data-act="delete-collection"]', drawer).addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: `Delete collection “${c.name}”?`,
      body: 'ROMs stay in the library.',
      okLabel: 'Delete',
      danger: true
    });
    if (!ok) return;
    await api(`/collections/${id}`, { method: 'DELETE' });
    closeDrawer();
    loadCollections();
    toast('Collection deleted');
  });
}

/* ─────────────────────────── add-to-collection ─────────────────────────── */

/**
 * In-app dialog listing every collection (plus a "new" shortcut) to drop the
 * given ROM ids into. Reuses the collection-create dialog for the ＋ button.
 */
async function openAddToCollection(romIds, label) {
  const scrim = $('#addcoll-scrim');
  const list = $('#addcoll-list');
  $('#addcoll-sub').textContent = romIds.length === 1
    ? `Pick a collection for ${label ? `“${label}”` : 'this game'}:`
    : `Pick a collection for these ${romIds.length} games:`;

  const close = () => {
    scrim.classList.add('hidden');
    scrim.onclick = null;
    $('#addcoll-cancel').onclick = null;
    $('#addcoll-new').onclick = null;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  scrim.onclick = (e) => { if (e.target === scrim) close(); };
  $('#addcoll-cancel').onclick = close;
  document.addEventListener('keydown', onKey);

  const render = async () => {
    const { items } = await api('/collections');
    let member = new Set();
    if (romIds.length === 1) {
      const d = await api(`/roms/${romIds[0]}`);
      member = new Set((d.collections || []).map((c) => c.id));
    }
    list.innerHTML = items.length ? items.map((c) => `
      <button class="result-row ok" data-addcoll="${c.id}" data-in="${member.has(c.id) ? 1 : 0}" title="${member.has(c.id) ? 'Already in this collection: click to remove it' : 'Add to this collection'}">
        <span class="status"></span>
        <span class="name">${esc(c.name)} <span class="note">· ${c.count} ${c.count === 1 ? 'game' : 'games'}</span></span>
        <span class="note">${member.has(c.id) ? '✓ in · remove' : 'add'}</span>
      </button>`).join('')
      : '<div class="side-empty">No collections yet — create one with the button below.</div>';
    $$('[data-addcoll]', list).forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const name = items.find((c) => String(c.id) === btn.dataset.addcoll)?.name;
        if (btn.dataset.in === '1') {
          await api(`/collections/${btn.dataset.addcoll}/roms/${romIds[0]}`, { method: 'DELETE' });
          toast(`Removed from “${name}”`);
        } else {
          const r = await api(`/collections/${btn.dataset.addcoll}/roms`, {
            method: 'POST', body: JSON.stringify({ rom_ids: romIds })
          });
          toast(r.added ? `Added to “${name}”` : 'Already in that collection');
        }
        loadCollections();
        await render();
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    }));
  };

  $('#addcoll-new').onclick = async () => {
    const created = await openCollectionDialog();
    if (!created) return;
    try {
      await api(`/collections/${created.id}/roms`, { method: 'POST', body: JSON.stringify({ rom_ids: romIds }) });
      toast(`Created “${created.name}” and added ${romIds.length} game${romIds.length === 1 ? '' : 's'}`);
      loadCollections();
      close();
    } catch (err) { toast(err.message, true); }
  };

  scrim.classList.remove('hidden');
  await render();
}

/* ─────────────────────────── new collection ─────────────────────────── */

/**
 * In-app dialog instead of prompt(): two stacked native prompts were both
 * ugly and lost the description on a cancel. Resolves the created row, or
 * null when dismissed. Esc / scrim / Cancel close it; empty name blocks.
 */
function openCollectionDialog() {
  const scrim = $('#collection-scrim');
  const form = $('#collection-form');
  const nameEl = $('#collection-name');
  const descEl = $('#collection-desc');

  form.reset();
  scrim.classList.remove('hidden');
  nameEl.focus();

  return new Promise((resolve) => {
    const done = (value) => {
      scrim.classList.add('hidden');
      document.removeEventListener('keydown', onKey);
      scrim.onclick = null;
      $('#collection-cancel').onclick = null;
      form.onsubmit = null;
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    const submit = async (e) => {
      e.preventDefault();
      const name = nameEl.value.trim();
      if (!name) { nameEl.focus(); return; }
      const btn = $('#collection-create');
      btn.disabled = true;
      btn.textContent = 'Creating…';
      try {
        const created = await api('/collections', {
          method: 'POST',
          body: JSON.stringify({ name, description: descEl.value.trim() || null })
        });
        done(created);
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        btn.textContent = 'Create';
      }
    };
    $('#collection-cancel').onclick = () => done(null);
    scrim.onclick = (e) => { if (e.target === scrim) done(null); };
    form.onsubmit = submit;
    document.addEventListener('keydown', onKey);
  });
}

$('#new-collection').addEventListener('click', async () => {
  const created = await openCollectionDialog();
  if (!created) return;
  loadCollections();
  toast('Collection created');
});

/* ─────────────────────────── upload ─────────────────────────── */

async function loadUploadPlatforms() {
  const { items } = await api('/platforms');
  window.__platformsCache = items;
  const sel = $('#upload-platform');
  if (sel.options.length > 1) return;
  // No "Detect from extension": platform choice is MANDATORY for Add ROMs.
  sel.innerHTML = '<option value="">— pick a platform —</option>' +
    platformOptions({ flatten: true });
}

async function uploadFiles(files) {
  if (!files?.length) return;
  // A folder pick brings along junk (macOS resource forks, desktop files) — drop
  // those before the upload so they never become library entries.
  files = files.filter((f) => {
    const name = (f.webkitRelativePath || f.name || '').split('/').pop();
    return name && !name.startsWith('._') && !/^(thumbs\.db|desktop\.ini|\.ds_store)$/i.test(name);
  });
  if (!files.length) return toast('Nothing uploadable in that selection', true);
  const results = $('#upload-results');
  const progress = $('#upload-progress');
  results.innerHTML = '';
  progress.innerHTML = files.map((f) => `
    <div class="progress-item" data-file="${esc(f.name)}">
      <span class="name" style="flex:0 0 auto;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</span>
      <span class="bar"><i></i></span>
      <span class="note">${fmtBytes(f.size)}</span>
    </div>`).join('');

  const fd = new FormData();
  for (const f of files) fd.append('roms', f);
  // Platform is MANDATORY for Add ROMs (no auto-detect now).
  const platform = $('#upload-platform').value;
  if (!platform) {
    progress.innerHTML = '';
    return toast('Pick a platform for these ROMs first', true);
  }
  fd.append('platform', platform);
  fd.append('enrich', $('#upload-enrich').checked ? 'true' : 'false');

  $$('.progress-item .bar i', progress).forEach((bar) => { bar.style.width = '15%'; });

  try {
    const res = await fetch('/api/roms/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    $$('.progress-item .bar i', progress).forEach((bar) => { bar.style.width = '100%'; });
    setTimeout(() => { progress.innerHTML = ''; }, 900);

    const rows = [
      ...data.created.map((r) => `<div class="result-row ok"><span class="status"></span><span class="name">${esc(r.title)}</span><span class="note">${esc(r.platform_short)} · added</span></div>`),
      ...data.skipped.map((s) => `<div class="result-row skip"><span class="status"></span><span class="name">${esc(s.filename)}</span><span class="note">duplicate of “${esc(s.existing_title)}”</span></div>`),
      ...data.errors.map((e) => `<div class="result-row err"><span class="status"></span><span class="name">${esc(e.filename)}</span><span class="note">${esc(e.error)}</span></div>`)
    ];
    results.innerHTML = rows.join('') || '<div class="side-empty">Nothing to add</div>';
    toast(`${data.created.length} added, ${data.skipped.length} duplicate(s)`);
    await loadPlatforms();
  } catch (err) {
    progress.innerHTML = '';
    toast(err.message, true);
  }
}

const dz = $('#dropzone');
const fileInput = $('#file-input');
const folderInput = $('#folder-input');
$('#browse').addEventListener('click', () => fileInput.click());
$('#browse-folder').addEventListener('click', () => folderInput.click());
dz.addEventListener('click', (e) => { if (e.target === dz || e.target.classList.contains('dz-ico') || e.target.classList.contains('dz-title')) fileInput.click(); });
fileInput.addEventListener('change', () => { uploadFiles([...fileInput.files]); fileInput.value = ''; });
folderInput.addEventListener('change', () => {
  const files = [...folderInput.files].filter((f) => !/(^|\/)\./.test(f.webkitRelativePath || f.name));
  uploadFiles(files);
  folderInput.value = '';
  if (!files.length) toast('That folder had no files to upload', true);
});
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
dz.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files]));

/* ─────────────────────────── controls ─────────────────────────── */

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    loadLibrary();
  }, 180);
});

$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; loadLibrary(); });

$$('#density button').forEach((b) => b.addEventListener('click', () => {
  state.density = b.dataset.density;
  $$('#density button').forEach((x) => x.classList.toggle('is-active', x === b));
  $('#grid').classList.toggle('compact', state.density === 'compact');
}));

/* ─────────────────────────── bulk select mode ─────────────────────────── */

$('#select-toggle')?.addEventListener('click', () => setSelectMode(!state.selectMode));
$('#bulk-cancel')?.addEventListener('click', () => setSelectMode(false));
// Select every ROM matching the current filters/search (not just loaded tiles):
// pages through the same query 500 at a time, collecting ids.
$('#bulk-selectall')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const q = state.libQuery;
  if (!q) return;
  btn.disabled = true;
  const label = btn.textContent;
  try {
    let offset = 0, total = Infinity;
    while (offset < total) {
      btn.textContent = `Selecting… ${state.selected.size}`;
      const p = new URLSearchParams(q);
      p.set('limit', '500'); p.set('offset', String(offset));
      const page = await api(`/roms?${p}`);
      total = page.total;
      page.items.forEach((r) => state.selected.add(r.id));
      if (!page.items.length) break;
      offset += page.items.length;
    }
    syncSelectUI();
    toast(`Selected all ${state.selected.size} ROM${state.selected.size === 1 ? '' : 's'}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$('#bulk-clear')?.addEventListener('click', () => { state.selected.clear(); syncSelectUI(); });
$('#bulk-delete-btn')?.addEventListener('click', bulkDeleteSelected);
$('#bulk-hide-btn')?.addEventListener('click', bulkHideSelected);
$('#reset-filters')?.addEventListener('click', resetFilters);
$('#bulk-lock-btn')?.addEventListener('click', bulkLockSelected);
$('#bulk-system-btn')?.addEventListener('click', bulkSystemSelected);
$('#bulk-clearmatch-btn')?.addEventListener('click', () => clearMatchFor([...state.selected]));
$('#bulk-addcoll')?.addEventListener('click', () => openAddToCollection([...state.selected]));

/* ─────────────────────────── auth ─────────────────────────── */

const authState = { user: null };

// The sign-in screen follows the look this browser last used (Classic or Modern), so a returning person sees what they know.
function paintLoginLook() {
  try {
    const m = localStorage.getItem('gamesauce_last_look') === 'classic' ? 'classic' : 'modern';
    document.body.classList.toggle('login-modern', m === 'modern');
    document.documentElement.dataset.theme = m === 'modern' && localStorage.getItem('gamesauce_theme') === 'light' ? 'light' : 'dark';
  } catch { /* private mode */ }
}
paintLoginLook();

function showLogin(message = '') {
  paintLoginLook();
  // Remember the last choice of the "keep me signed in" box on this browser.
  try { const r = $('#login-remember'); if (r) r.checked = localStorage.getItem('gamesauce_remember') !== '0'; } catch { /* private mode */ }
  authState.user = null;
  $('#app').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
  // Start the backdrop only now that the screen is visible: a canvas inside a hidden (display:none)
  // element measures 0x0, which left the sign-out screen blank until the page was refreshed.
  window.neonBg?.start();
  const err = $('#login-error');
  if (message) { err.textContent = message; err.classList.remove('hidden'); }
  else err.classList.add('hidden');
  setTimeout(() => $('#login-username')?.focus(), 30);
}

/* ── Profile pictures ── */
// Fills an .avatar element with the person's picture, or their initial when they have none.
function paintAvatar(el, userId, label, v) {
  if (!el) return;
  el.textContent = String(label || '?').slice(0, 1);
  el.style.backgroundImage = v ? `url(/api/auth/avatar/${userId}?v=${v})` : '';
  el.classList.toggle('has-pic', !!v);
}
async function shrinkImage(file, size = 256) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas'); c.width = c.height = size;
  c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not read that image'))), 'image/jpeg', 0.9));
}
function initProfilePanel() {
  const u = authState.user; if (!u) return;
  const prev = $('#profile-preview');
  paintAvatar(prev, u.id, u.display_name || u.username, u.avatar_v);
  $('#profile-remove').disabled = !u.avatar_v;
  $('#profile-upload').onclick = () => $('#profile-file').click();
  $('#profile-file').onchange = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    try {
      const blob = await shrinkImage(file);
      const fd = new FormData(); fd.append('avatar', blob, 'avatar.jpg');
      const data = await api('/auth/avatar', { method: 'POST', body: fd });
      u.avatar_v = data.avatar_v; toast('Profile picture updated');
      paintAvatar($('#user-avatar'), u.id, u.display_name || u.username, u.avatar_v); initProfilePanel();
    } catch (err) { toast(err.message || 'Could not use that image', true); }
  };
  $('#profile-remove').onclick = async () => {
    try {
      await api('/auth/avatar', { method: 'DELETE' });
      u.avatar_v = null; toast('Profile picture removed');
      paintAvatar($('#user-avatar'), u.id, u.display_name || u.username, null); initProfilePanel();
    } catch (err) { toast(err.message, true); }
  };
}

// One pill per genre. The stored field holds them as text ("Shooter, Racing, Arcade"); commas separate genres,
// and a slash inside one name ("Hack and slash/Beat 'em up") is a single genre, so it is kept whole.
function genreList(genre) {
  return [...new Set(String(genre || '').split(',').map((g) => g.trim()).filter(Boolean))];
}
function genrePills(genre) {
  const gs = genreList(genre);
  if (!gs.length) return '';
  return `<div class="genre-pills" aria-label="Genres">${gs.map((g) => `<button type="button" class="genre-pill" data-genre-pill="${esc(g)}" title="Show all ${esc(g)} games">${esc(g)}</button>`).join('')}</div>`;
}
document.addEventListener('click', (e) => {
  const gp = e.target.closest('[data-genre-pill]');
  if (!gp) return;
  Object.assign(state, { genre: gp.dataset.genrePill, q: '', favorite: false, tag: null });
  const s = $('#search'); if (s) s.value = '';
  closeDrawer();
  setView('library');
  loadLibrary();
});

/* Play-only accounts have no sidebar: a slim bar along the top carries the logo, the person and Library. The bar is the same markup
 * as the sidebar's pieces, moved, so every button keeps working. */
function syncTopbar() {
  const on = document.body.classList.contains('play-only');
  const bar = $('#play-topbar');
  if (!bar) return;
  const side = $('.sidebar');
  // Look the pieces up wherever they are right now (the top bar OR the sidebar) and remember them the first time:
  // once they have moved into the bar they are no longer inside the sidebar, and a failed lookup used to put the
  // word "null" on the screen when the account changed from play-only back to the full screen without a refresh.
  const parts = (syncTopbar.parts ||= {
    brand: $('.brand', side), userRow: $('.side-footer .user-row', side), nav: $('#nav'), footer: $('.side-footer', side)
  });
  const { brand, userRow, nav, footer } = parts;
  if (!side || !brand || !userRow || !nav || !footer) { bar.classList.toggle('hidden', !on); return; }
  if (on && !bar.dataset.filled) {
    bar.dataset.filled = '1';
    bar.append(brand, userRow, nav);
  } else if (!on && bar.dataset.filled) {
    delete bar.dataset.filled;
    side.prepend(brand);
    footer.prepend(userRow);
    side.insertBefore(nav, side.querySelector('.side-section'));
  }
  bar.classList.toggle('hidden', !on);
}

function showApp(user, { restore = false } = {}) {
  window.neonBg?.stop();
  // An admin can preview what a play-only person sees. It only changes this tab's screen (the server still treats them as the admin),
  // and it ends when the tab is closed, so it can never lock anyone out.
  try { if (user.role === 'admin' && sessionStorage.getItem('gamesauce_preview_play') === '1') user = { ...user, play_only: true, previewing: true }; } catch { /* private mode */ }
  authState.user = user;
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');

  // display_name is a friendly label; the username is what was actually typed at
  // the login prompt, so prefer it when there is no separate display name.
  const label = user.display_name || user.username;
  $('#user-name').textContent = label;
  $('#user-role').textContent = user.role === 'admin' ? 'admin' : 'member';
  paintAvatar($('#user-avatar'), user.id, label, user.avatar_v);

  // A play-only account gets the cut-down screen: just games you can play, search and favourites.
  const playOnly = Boolean(user.play_only);
  document.body.classList.toggle('play-only', playOnly);
  if (playOnly) { state.favorite = false; state.hidden = false; state.system = false; state.platform = 'all'; }
  syncTopbar();
  // The look: Classic (default) or Modern, chosen per person. Modern is a preview: it is only used when asked for.
  state.prefs = state.prefs || {};
  physical.initPhysical({ api, toast, confirmDialog, closeDrawer, syncPin, pinned, state, ICON });
  messages.initMessages({ api, toast, confirmDialog, state, ICON, user: () => authState.user, openRom: (id) => openDetail(id) });
  digital.initDigital({ api, toast, confirmDialog, closeDrawer, syncPin, pinned, state, ICON, setView, showSettingsModule, user: () => authState.user });
  modern.initModern({ closeDrawer, resetDigital: digital.reset, resetPhysical: physical.reset, api, user: () => authState.user, state: () => state, setView, openDetail, cardHtml, bindCards, paintAvatar, applyStrips, loadLibrary, loadPlatforms, platformIconSvg, openAccount: () => showSettingsModule('profile'), setPref: (k, v) => { state.prefs = { ...(state.prefs || {}), [k]: v }; }, resetFilters, filtersActive, openCarousel: openCarouselView });
  api('/prefs').then((p) => { state.prefs = p || {}; try { localStorage.setItem('gamesauce_last_look', p?.ui_mode === 'modern' ? 'modern' : 'classic'); } catch { /* private mode */ } document.body.classList.remove('login-modern'); return modern.applyMode(p?.ui_mode === 'modern' ? 'modern' : 'classic', { fresh: !restore }); }).catch(() => {});
  $('#user-role').textContent = user.role === 'admin' ? 'admin' : (playOnly ? 'player' : 'member');

  // Settings/sources nav hidden for members (admin-only on server). The cog
  // in the footer opens Settings; admin-only modules inside stay hidden for
  // members and re-render per role in loadSettings().
  const isAdmin = user.role === 'admin';
  $$('[data-view="sources"]').forEach((b) => b.classList.toggle('hidden', !isAdmin));
  $('#bulk-enrich')?.classList.toggle('hidden', !isAdmin);
  if (isAdmin) startEnrichPolling(); // picks up a metadata run that kept going across a refresh
  // Settings is for everyone (cog in the footer), but admin-only module pills
  // and tiles stay hidden for members; renderSettingsTiles filters by role.
  $$('#view-settings .admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin));

  // First sign-in of a new account: the welcome tour (once; "Run the welcome tour again" in My account brings it back).
  if (user.welcomed === false && !restore) setTimeout(() => startWelcome(), 350);

  // Every sign-in starts on the Library home. Signing out only hides the app, so without
  // this you would land back on whatever view (e.g. Settings) was open before.
  try { closeDrawer(); } catch { /* drawer not open */ }
  closePlayer?.();
  // Page refresh with a live session: put the user back where they were. A fresh sign-in
  // (restore=false) always starts on the Library home.
  const saved = restore ? readNav() : null;
  if (saved && $(`#view-${saved.view}`)) {
    for (const k of NAV_FIELDS) if (saved[k] !== undefined) state[k] = saved[k];
    if (!['library', 'collections', 'sources', 'upload', 'emulators', 'settings', 'digital', 'physical', 'messages'].includes(saved.view)) saved.view = 'library';
    if (playOnly && saved.view !== 'settings') saved.view = 'library'; // a play-only account lives on the Play screen
    if (state.sort) $('#sort').value = state.sort;
    $('#search').value = state.q || '';
    $$('#density button').forEach((x) => x.classList.toggle('is-active', x.dataset.density === state.density));
    activeSettingsModule = saved.settingsModule || null;
    // Members cannot open admin-only views; fall back to the Library.
    const target = ((saved.view === 'sources' || saved.view === 'upload') && !isAdmin) ? 'library' : saved.view;
    setView(target);
  } else {
    // Fresh start: forget filters from any earlier session in this tab.
    clearNav();
    Object.assign(state, { platform: 'all', q: '', sort: 'title', tag: null, genre: null, favorite: false,
      source: null, sourceName: null, missing: false, hidden: false, system: false, orphan: false, locked: false, unmatched: false, datStatus: null, cover: null, matched: null, incl: null });
    $('#search').value = '';
    $('#sort').value = 'title';
    activeSettingsModule = null;
    setView('library');
  }
  loadPlatforms();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-submit');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('#login-username').value.trim(),
        password: $('#login-password').value,
        remember: $('#login-remember')?.checked !== false
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Sign in failed');
    $('#login-password').value = '';
    try { localStorage.setItem('gamesauce_remember', $('#login-remember')?.checked === false ? '0' : '1'); } catch { /* private mode */ }
    if (data.token) sessionStorage.setItem('gamesauce_token', data.token);
    clearNav();
    showApp(data.user);
  } catch (err) {
    const box = $('#login-error');
    box.textContent = err.message;
    box.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

$('#logout').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Sign out?',
    body: 'You will need to sign in again to manage the library.',
    okLabel: 'Sign out',
    danger: true
  });
  if (!ok) return;
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* ignore */ }
  sessionStorage.removeItem('gamesauce_token');
  clearNav();
  try { closeDrawer(); } catch { /* drawer not open */ }
  closePlayer?.();
  activeSettingsModule = null;
  showLogin();
});

// Cog in the footer: the only path to Settings now (nav item removed).
$('#settings-gear')?.addEventListener('click', () => setView('settings'));
$('#ui-modern-try')?.addEventListener('click', () => modern.setUiMode('modern'));

// Play-only screen: the logo is the way back to the whole library (the Library button is gone from the top bar), and the arrow
// beside the count scrolls the games back to the top.
$('#play-topbar')?.addEventListener('click', (e) => {
  if (!e.target.closest('.brand')) return;
  $('#nav .nav-item[data-view="library"]')?.click();
});
$('#play-topbar .brand')?.setAttribute('title', 'Back to the library');
$('#to-top')?.addEventListener('click', () => {
  const g = $('#grid'); if (g) g.scrollTo({ top: 0, behavior: 'smooth' });
  const v = $('#view-library'); if (v) v.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ─────────────────────────── settings hub ─────────────────────────── */

/* Role-dependent tile grid. Modules render in a fixed order; admins get the
   fully list. Clicking a tile reveals ONLY its module below. */
const SETTINGS_MODULES = [
  { id: 'profile', label: 'Profile picture', mi: 'profile-pic', ico: '🖼', adminOnly: false },
  { id: 'welcome', label: 'Welcome tour', mi: 'welcome-tour', ico: '👋', adminOnly: false },
  { id: 'steam', label: 'Steam', mi: 'steam', ico: '🎮', adminOnly: false },
  { id: 'password', label: 'Change password', mi: 'password-reset', ico: '🔑', adminOnly: false },
  { id: 'sessions',  label: 'Active sessions', mi: 'active-sessions', ico: '💻', adminOnly: false },
  { id: 'controller', label: 'Controller', mi: 'gamepad', ico: '🎮', adminOnly: false },
  { id: 'playpc', label: 'Play on this PC', mi: 'emulators-2', ico: '🖥', adminOnly: false },
  { id: 'providers', label: 'Metadata providers', mi: 'providers-2', ico: '🔌', adminOnly: true },
  { id: 'users',     label: 'User accounts',   mi: 'users', ico: '👥', adminOnly: true },
  { id: 'platforms', label: 'Platforms',       mi: 'Library', ico: '🕹', adminOnly: true },
  { id: 'coverage',  label: 'Stats',           mi: 'stats', ico: '📊', adminOnly: true },
  { id: 'covers',    label: 'Covers & platform ids', mi: 'covers', ico: '🖼', adminOnly: true },
  { id: 'artfolders', label: 'Artwork folders', mi: 'folder-enable', ico: '📁', adminOnly: true },
  { id: 'db',        label: 'Database maintenance', mi: 'database-maintenance', ico: '🗄️', adminOnly: true },
  { id: 'audit',     label: 'Activity log',    mi: 'activity-log', ico: '📜', adminOnly: true },
  { id: 'names',     label: 'CSV tools', mi: 'game-csv', ico: '🏷', adminOnly: true },
  { id: 'dat',       label: 'DAT files',       mi: 'DAT-files', ico: '💾', adminOnly: true },
  { id: 'backup',    label: 'Backups',         mi: 'database-backup-save', ico: '🛟', adminOnly: true },
  { id: 'duplicates', label: 'Duplicate finder', mi: 'duplicate-finder', ico: '🧬', adminOnly: true },
  { id: 'health',    label: 'Health',          mi: 'heart', ico: '🩺', adminOnly: true }
];


// Two levels: a few group tiles on top, and under the selected group the individual settings.
const SETTINGS_GROUPS = [
  { id: 'account',  label: 'My account',          mi: 'my-account', ico: '👤', modules: ['profile', 'welcome', 'steam', 'password', 'controller', 'playpc'] },
  { id: 'tools',    label: 'Library tools',       mi: 'maintenance', ico: '🧰', modules: ['dat', 'names', 'duplicates', 'covers', 'artfolders'], adminOnly: true },
  { id: 'maint',    label: 'Maintenance',         mi: 'database-maintenance', ico: '🛠', modules: ['db', 'backup'], adminOnly: true },
  { id: 'status',   label: 'System health',       mi: 'health', ico: '🩺', modules: ['health', 'coverage'], adminOnly: true },
  { id: 'security', label: 'Security & activity', mi: 'security', ico: '🛡', modules: ['sessions', 'audit'] },
  { id: 'server',   label: 'System setup',        mi: 'system', ico: '⚙', modules: ['users', 'providers', 'platforms'], adminOnly: true }
];
const settingsLastInGroup = {};
const settingsIsAdmin = () => authState.user?.role === 'admin';
const settingsModuleOk = (m) => !m.adminOnly || settingsIsAdmin();
function settingsGroupMods(g) {
  return g.modules.map((id) => SETTINGS_MODULES.find((m) => m.id === id)).filter((m) => m && settingsModuleOk(m));
}
function settingsGroupOf(id) { return SETTINGS_GROUPS.find((g) => g.modules.includes(id)) || null; }
function settingsVisibleGroups() { return SETTINGS_GROUPS.filter((g) => (!g.adminOnly || settingsIsAdmin()) && settingsGroupMods(g).length); }

// The tile pictures are drawn from the same line icons as the Modern look, not from the emoji font: on Linux a newer colour emoji can make the web view stop.
function tileIco(x) { return x.mi ? `<span class="tile-mask" style="-webkit-mask-image:url(/modern/icons/${x.mi}.svg);mask-image:url(/modern/icons/${x.mi}.svg)"></span>` : x.ico; }
function renderSettingsTiles(activeId = activeSettingsModule) {
  const wrap = $('#settings-tiles'), sub = $('#settings-subtiles');
  if (!wrap) return;
  // The tiles are rebuilt on every choice; remember which one had the focus (controller / keyboard) so it can be given back.
  const ae = document.activeElement;
  const refocus = ae && wrap.contains(ae) ? `[data-group="${ae.dataset.group}"]` : (ae && sub.contains(ae) ? `[data-mod="${ae.dataset.mod}"]` : null);
  const groups = settingsVisibleGroups();
  if (!groups.length) return;
  const cur = settingsGroupOf(activeId) || groups[0];
  wrap.innerHTML = groups.map((g) => `
      <button class="tile group${g.id === cur.id ? ' is-active' : ''}"${g.mi ? ` data-mi="${g.mi}"` : ''} data-group="${g.id}" aria-label="${esc(g.label)}" title="${esc(g.label)}: ${esc(settingsGroupMods(g).map((m) => m.label).join(', '))}">
        <span class="tile-ico">${tileIco(g)}</span>
        <span class="tile-label">${esc(g.label)}</span>
      </button>`).join('');
  $$('[data-group]', wrap).forEach((t) => t.addEventListener('click', () => {
    const g = SETTINGS_GROUPS.find((x) => x.id === t.dataset.group);
    const mods = settingsGroupMods(g);
    showSettingsModule(mods.find((m) => m.id === settingsLastInGroup[g.id])?.id || mods[0].id);
  }));
  // The second row: the settings inside the chosen group (a group with a single setting needs no second row).
  const mods = settingsGroupMods(cur);
  sub.classList.toggle('hidden', mods.length < 2);
  sub.innerHTML = mods.map((m) => `<button class="subtile${m.id === activeId ? ' is-active' : ''}"${m.mi ? ` data-mi="${m.mi}"` : ''} data-mod="${m.id}" title="${esc(m.label)}"><span class="tile-ico">${tileIco(m)}</span>${esc(m.label)}</button>`).join('');
  $$('[data-mod]', sub).forEach((t) => t.addEventListener('click', () => showSettingsModule(t.dataset.mod)));
  if (refocus) {
    // Choosing a group swaps the row beneath it: keep the focus on the group tile; choosing a tab keeps it on that tab.
    const back = (refocus.startsWith('[data-group') ? $(refocus, wrap) : $(refocus, sub)) || $('.tile.is-active', wrap);
    back?.focus({ preventScroll: true });
  }
}

/* ── Backups module ── */
async function loadBackups() {
  const data = await api('/backup');
  const s = data.settings;
  $('#backup-interval').value = String(s.interval_hours);
  $('#backup-keep').value = s.keep;
  $('#backup-dir').value = s.dir;
  $('#backup-dir').placeholder = s.default_dir;
  $('#backup-hint').innerHTML = (s.dir ? '' : `Using the default folder <code>${esc(s.default_dir)}</code>. `)
    + 'Point the folder at a network share or a mounted disk so backups survive the machine itself. '
    + (s.key_in_env ? '<strong>The encryption key comes from <code>GAMESAUCE_SECRET_KEY</code> and is not in backups — keep it somewhere safe.</strong>' : '');
  $('#backup-status').innerHTML = [
    s.last_at ? `Last scheduled/server backup: ${esc(new Date(s.last_at).toLocaleString())}.` : 'No server backup has run yet.',
    s.last_error ? `<span style="color:var(--warn)">Last error: ${esc(s.last_error)}</span>` : ''
  ].filter(Boolean).join(' ');
  $('#backup-list').innerHTML = data.items.length ? data.items.map((b) => `
    <div class="result-row ok" style="gap:10px">
      <span class="status"></span>
      <span class="name">${esc(b.name)} <span class="note">· ${fmtBytes(b.size)}</span></span>
      <a class="btn btn-sm" href="/api/backup/files/${encodeURIComponent(b.name)}" download>Download</a>
      <button class="btn btn-sm" data-bk-restore="${esc(b.name)}" title="Check this backup and restore it">Restore…</button>
      <button class="btn btn-sm btn-danger" data-bk-del="${esc(b.name)}">Delete</button>
    </div>`).join('') : '<div class="side-empty">No backups in the server folder yet.</div>';
  $$('[data-bk-restore]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; const label = b.textContent; b.textContent = 'Checking…';
    try {
      const data = await api('/backup/restore/inspect-server', { method: 'POST', body: JSON.stringify({ name: b.dataset.bkRestore }) });
      showRestoreReview(data);
      $('#restore-result')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (err) { toast(err.message, true); }
    finally { b.disabled = false; b.textContent = label; }
  }));
  $$('[data-bk-del]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Delete this backup?', body: b.dataset.bkDel, okLabel: 'Delete', danger: true });
    if (!ok) return;
    await api(`/backup/files/${encodeURIComponent(b.dataset.bkDel)}`, { method: 'DELETE' });
    loadBackups();
  }));
}

$('#backup-save')?.addEventListener('click', async () => {
  try {
    await api('/backup/settings', { method: 'PUT', body: JSON.stringify({
      interval_hours: Number($('#backup-interval').value), keep: Number($('#backup-keep').value), dir: $('#backup-dir').value.trim()
    }) });
    toast('Backup settings saved');
    loadBackups();
  } catch (err) { toast(err.message, true); }
});
$('#backup-run')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget; btn.disabled = true; const label = btn.textContent; btn.textContent = 'Backing up…';
  try {
    const r = await api('/backup/run', { method: 'POST', body: '{}' });
    toast(`Saved ${r.name} (${fmtBytes(r.size)})${r.pruned?.length ? `, removed ${r.pruned.length} old` : ''}`);
    loadBackups();
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = label; }
});

/* ── Restore ── */
let restoreStaged = null;

async function loadRestoreStatus() {
  try {
    const s = await api('/backup/restore/status');
    const last = s.last;
    $('#restore-last').innerHTML = last
      ? `Last restore: ${esc(new Date(last.at).toLocaleString())}${last.backup_created_at ? ` (backup of ${esc(new Date(last.backup_created_at).toLocaleString())})` : ''}. The data it replaced is kept in <code>${esc(last.previous_data_kept_in)}</code>.`
      : '';
  } catch { /* status is informational */ }
}

$('#restore-inspect')?.addEventListener('click', async (e) => {
  const file = $('#restore-file').files?.[0];
  if (!file) return toast('Choose a backup file first', true);
  const btn = e.currentTarget; btn.disabled = true; const label = btn.textContent; btn.textContent = 'Checking…';
  const box = $('#restore-result');
  try {
    const fd = new FormData(); fd.append('backup', file);
    const res = await fetch('/api/backup/restore/inspect', {
      method: 'POST', credentials: 'same-origin',
      headers: { Authorization: `Bearer ${sessionStorage.getItem('gamesauce_token') || ''}` }, body: fd
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'That file could not be read');
    showRestoreReview(data);
  } catch (err) {
    box.classList.add('hidden');
    toast(err.message, true);
  } finally { btn.disabled = false; btn.textContent = label; }
});

/** Shows what is inside a checked (staged) backup and the confirm-to-restore controls. */
function showRestoreReview(data) {
  const box = $('#restore-result');
  restoreStaged = data;
  const c = data.counts, now = data.current_counts;
  const row = (name, a, b) => `<tr><td>${name}</td><td><b>${a ?? '—'}</b></td><td style="color:var(--dim)">${b ?? '—'}</td></tr>`;
  box.classList.remove('hidden');
  box.innerHTML = `
    <div style="font-weight:650;margin-bottom:6px">This backup is valid${data.source_name ? ` <span class="note" style="font-weight:400">· ${esc(data.source_name)}</span>` : ''}</div>
    <div class="hint" style="margin:0 0 8px">Made ${esc(data.manifest.created_at ? new Date(data.manifest.created_at).toLocaleString() : 'at an unknown time')} · game-sauce ${esc(data.manifest.app_version || '?')}</div>
    <table style="border-collapse:collapse;font-size:13px;margin-bottom:8px">
      <tr style="color:var(--dim)"><td></td><td style="padding-right:24px">In the backup</td><td>On the server now</td></tr>
      ${row('ROMs', c.roms, now.roms)}${row('Users', c.users, now.users)}${row('Collections', c.collections, now.collections)}${row('Saves', c.saves, now.saves)}
    </table>
    ${data.warnings.map((w) => `<p class="hint" style="color:var(--warn);margin:4px 0">⚠ ${esc(w)}</p>`).join('')}
    ${data.restart_supported ? '' : '<p class="hint" style="color:var(--warn);margin:4px 0">⚠ This server cannot restart itself (it is not running under systemd or Docker). After you confirm, restart game-sauce yourself to finish the restore.</p>'}
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
      <input id="restore-confirm" class="select" placeholder="Type RESTORE to confirm" autocomplete="off" style="width:220px" />
      <button class="btn btn-danger" id="restore-apply">Restore this backup</button>
      <button class="btn btn-ghost" id="restore-cancel">Cancel</button>
    </div>`;
  $('#restore-cancel').onclick = async () => { try { await api('/backup/restore/cancel', { method: 'POST', body: '{}' }); } catch { /* none */ } restoreStaged = null; box.classList.add('hidden'); box.innerHTML = ''; };
  $('#restore-apply').onclick = async () => {
    if ($('#restore-confirm').value.trim() !== 'RESTORE') return toast('Type RESTORE (capitals) to confirm', true);
    const ok = await confirmDialog({
      title: 'Replace the current data with this backup?',
      body: 'A safety backup of the current data is saved first, and the data being replaced is kept. The server will restart and everyone will need to sign in again.',
      okLabel: 'Restore', danger: true
    });
    if (!ok) return;
    try {
      const r = await api('/backup/restore/apply', { method: 'POST', body: JSON.stringify({ token: restoreStaged.token, confirm: 'RESTORE' }) });
      box.innerHTML = r.restarting
        ? `<div style="font-weight:650">Restoring…</div><p class="hint">Safety backup saved as <code>${esc(r.safety_backup)}</code>. The server is restarting; this page will reload when it is back.</p>`
        : `<div style="font-weight:650">Ready to finish</div><p class="hint">Safety backup saved as <code>${esc(r.safety_backup)}</code>. <strong>Restart game-sauce now</strong> (for example <code>systemctl restart game-sauce</code> or <code>docker compose restart</code>) to complete the restore.</p>`;
      if (r.restarting) waitForServerThenReload();
    } catch (err) { toast(err.message, true); }
  };
}

// After a restore the server goes away briefly; poll health, then reload to the sign-in page.
function waitForServerThenReload() {
  sessionStorage.removeItem('gamesauce_token');
  let tries = 0, wentDown = false;
  const t = setInterval(async () => {
    tries++;
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok && wentDown) { clearInterval(t); location.reload(); return; }
      if (r.ok && tries > 25) { clearInterval(t); location.reload(); }
    } catch { wentDown = true; }
    if (tries > 120) clearInterval(t);
  }, 1000);
}

// The pinned Settings header changes height as its tiles wrap; sticky bars inside a module
// (e.g. Platforms → Add platform) sit just beneath it using this measured offset.
(function trackSettingsAnchor() {
  const anchor = document.querySelector('.settings-anchor');
  if (!anchor || typeof ResizeObserver === 'undefined') return;
  const set = () => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
    document.documentElement.style.setProperty('--settings-anchor-h', `${Math.max(0, anchor.offsetHeight - rem * 1.4286)}px`);
  };
  new ResizeObserver(set).observe(anchor);
  set();
})();

function initExportBox() {
  const sel = $('#export-platform'), hid = $('#export-hidden'), sum = $('#export-summary');
  if (!sel || sel.dataset.ready) return; sel.dataset.ready = '1';
  sel.innerHTML = '<option value="">All platforms</option>' + (window.__platformsCache || []).filter((p) => p.count).map((p) => `<option value="${esc(p.slug)}">${esc(p.name)} (${p.count})</option>`).join('');
  const qs = () => new URLSearchParams({ ...(sel.value ? { platform: sel.value } : {}), ...(hid.checked ? { hidden: '1' } : {}) }).toString();
  const refresh = async () => { try { const c = await api('/roms/export/summary?' + qs()); sum.textContent = `${c.games.toLocaleString()} game${c.games === 1 ? '' : 's'}, ${c.covers.toLocaleString()} with a cover.`; } catch { sum.textContent = ''; } };
  sel.onchange = refresh; hid.onchange = refresh; refresh();
  // A plain download link: the browser's own downloader handles a big file, and the sign-in cookie goes with it.
  $('#export-csv').onclick = () => { location.href = '/api/roms/export/games.csv?' + qs(); };
  $('#export-covers').onclick = () => { location.href = '/api/roms/export/covers.zip?' + qs(); };
}

function initCoverImport() {
  const zip = $('#covers-zip'), out = $('#covers-result'), applyBtn = $('#covers-apply');
  if (!zip || zip.dataset.ready) return; zip.dataset.ready = '1';
  const cp = $('#covers-platform');
  if (cp.options.length <= 1) cp.innerHTML += (window.__platformsCache || []).filter((p) => p.count).map((p) => `<option value="${esc(p.slug)}">${esc(p.name)} (${p.count})</option>`).join('');
  cp.onchange = () => { applyBtn.disabled = true; };
  const run = async (apply) => {
    const f = zip.files?.[0];
    if (!f) return toast('Choose a zip file first', true);
    const fd = new FormData();
    fd.append('zip', f); fd.append('platform', $('#covers-platform')?.value || '');
    if ($('#covers-replace').checked) fd.append('replace', '1');
    if (apply) fd.append('apply', '1');
    out.textContent = apply ? 'Saving the pictures…' : 'Reading the zip…';
    applyBtn.disabled = true;
    try {
      const r = await api('/roms/bulk/import-covers', { method: 'POST', body: fd });
      const n = (v) => Number(v || 0).toLocaleString();
      out.innerHTML = apply
        ? `<b>Applied.</b> ${n(r.set)} cover${r.set === 1 ? '' : 's'} saved${r.not_image ? `, ${n(r.not_image)} skipped (not a JPEG, PNG or WebP picture)` : ''}${r.unreadable ? `, ${n(r.unreadable)} could not be read` : ''}.`
        : `${n(r.pictures)} picture${r.pictures === 1 ? '' : 's'} in the zip: ${n(r.matched)} match a game, ${n(r.will_set)} would be saved${r.already_have ? `, ${n(r.already_have)} games already have a cover (tick the box to replace them)` : ''}${r.not_image ? `, ${n(r.not_image)} cannot be used (only JPEG, PNG and WebP pictures are accepted: GIF and SVG are refused because they can carry scripts)` : ''}${r.other_platform ? `, ${n(r.other_platform)} left out (another platform's picture)` : ''}${r.unmatched ? `, ${n(r.unmatched)} match no game${r.unmatched_examples?.length ? ` (for example ${r.unmatched_examples.map(esc).join(', ')})` : ''}` : ''}.`;
      applyBtn.disabled = apply || !r.will_set;
      if (apply) { toast(`${r.set} cover${r.set === 1 ? '' : 's'} saved`); loadLibrary(); }
    } catch (err) { out.textContent = err.message; toast(err.message, true); }
  };
  $('#covers-preview').onclick = () => run(false);
  applyBtn.onclick = () => run(true);
  zip.onchange = () => { applyBtn.disabled = true; out.textContent = ''; };
  $('#covers-replace').onchange = () => { applyBtn.disabled = true; };
}

/* CSV tools › Import console games into Digital: PlayStation, Nintendo and Xbox games from a CSV into the signed-in person's own Digital list. */
function initConsoleImport() {
  const file = $('#dgc-file'), out = $('#dgc-result'), applyBtn = $('#dgc-apply');
  if (!file || file.dataset.ready) return;
  file.dataset.ready = '1';
  const n = (v) => Number(v || 0).toLocaleString();
  const dest = () => $('input[name="dgc-dest"]:checked')?.value === 'physical' ? 'physical' : 'digital';
  // The choice (Digital or Physical) decides where the games go and which help is shown; changing it starts over with a fresh preview.
  const paintDest = () => { $('#dgc-digital-row').style.display = dest() === 'physical' ? '' : 'none'; $('#dgc-physical-help').style.display = dest() === 'physical' ? '' : 'none'; $('#dgc-digital-help').style.display = dest() === 'digital' ? '' : 'none'; applyBtn.disabled = true; out.textContent = ''; };
  $$('input[name="dgc-dest"]').forEach((r) => r.addEventListener('change', paintDest));
  paintDest();
  const run = async (apply) => {
    const f = file.files?.[0];
    if (!f) return toast('Choose a CSV file first', true);
    let csv; try { csv = await f.text(); } catch { return toast('The file could not be read', true); }
    try {
      if (dest() === 'physical') {
        // Onto the Physical shelf: any Library platform, not only the consoles Digital knows.
        const r = await api('/physical/import', { method: 'POST', body: JSON.stringify({ csv, apply, replace: $('#dgc-replace').checked, digital: $('#dgc-digital').checked }) });
        out.innerHTML = physical.importSummary(r, (s) => (window.__platformsCache || []).find((p) => p.slug === s)?.name || s);
        applyBtn.disabled = apply || !(r.added || r.updated || r.removed);
        if (apply) toast(`${n(r.added)} games added to your Physical shelf`);
        return;
      }
      const r = await api('/digital/consoles/import', { method: 'POST', body: JSON.stringify({ csv, apply, replace: $('#dgc-replace').checked }) });
      const per = Object.entries(r.by_store || {}).map(([k, v]) => `${esc(digital.storeLabel(k))} ${n(v)}`).join(', ');
      const what = apply
        ? `<b>Imported.</b> ${n(r.added)} added, ${n(r.updated)} updated, ${n(r.unchanged)} already there${r.removed ? `, ${n(r.removed)} removed` : ''}.`
        : `${n(r.games)} games in the file (${per || 'none'}): ${n(r.added)} would be added, ${n(r.updated)} updated, ${n(r.unchanged)} ${r.unchanged === 1 ? 'is' : 'are'} already there${r.removed ? `, ${n(r.removed)} would be removed` : ''}.`;
      const notes = [r.physical_on ? `${n(r.physical_on)} marked as owned on disc or cartridge` : '', r.physical_off ? `${n(r.physical_off)} marked digital only` : '', r.duplicates ? `${n(r.duplicates)} repeated row${r.duplicates === 1 ? '' : 's'} counted once` : '', r.skipped ? `${n(r.skipped)} row${r.skipped === 1 ? '' : 's'} skipped` : ''].filter(Boolean).join('; ');
      out.innerHTML = what + (notes ? ` ${notes}.` : '')
        + (r.problems?.length ? '<br>' + r.problems.map((p) => `Line ${p.line}: ${esc(p.reason)}`).join('<br>') : '')
        + (apply && r.details_job?.running ? `<br>Details and covers are being looked up now (${n(r.details_job.total)} games). Open <b>Digital</b> to watch them arrive.` : '');
      applyBtn.disabled = apply || !(r.added || r.updated || r.removed || r.physical_on || r.physical_off);
      if (apply) toast(`${n(r.added)} console games added to Digital`);
    } catch (err) { out.textContent = err.message; toast(err.message, true); }
  };
  $('#dgc-preview').onclick = () => run(false);
  applyBtn.onclick = () => run(true);
  file.onchange = () => { applyBtn.disabled = true; out.textContent = ''; };
  $('#dgc-replace').onchange = $('#dgc-digital').onchange = () => { applyBtn.disabled = true; };
}

function initNamesPanel() {
  initExportBox();
  initCoverImport();
  initConsoleImport();
  const sel = $('#names-platform');
  if (!sel.options.length) sel.innerHTML = '<option value="">From the CSV\'s platform column</option>' + (window.__platformsCache || []).map((p) => `<option value="${esc(p.slug)}">${esc(p.name)}${p.count ? ` (${p.count})` : ''}</option>`).join('');
  const out = $('#names-result'); const applyBtn = $('#names-apply');
  const run = async (apply) => {
    const f = $('#names-file').files?.[0];
    if (!f) return toast('Choose a CSV file first', true);
    const fd = new FormData();
    fd.append('csv', f); fd.append('platform', sel.value);
    const zf = $('#names-covers-zip')?.files?.[0]; if (zf) { fd.append('zip', zf); if ($('#names-covers-replace')?.checked) fd.append('replace_covers', '1'); } fd.append('rom_col', $('#names-rom-col').value); fd.append('name_col', $('#names-name-col').value);
    if (apply) fd.append('apply', '1');
    if ($('#names-flag-system')?.checked) fd.append('flag_system', '1');
    try {
      const r = await api('/roms/bulk/import-names', { method: 'POST', body: fd });
      out.innerHTML = `${r.applied ? '<b>Applied.</b> ' : ''}${r.matched} of ${r.roms_on_platform} games ${r.platform_column || r.platforms > 1 ? `on ${r.platforms} platform${r.platforms === 1 ? '' : 's'}` : 'on this platform'} match the CSV (${r.unmatched} do not; the CSV has ${r.csv_rows} rows).${r.has_system_columns ? ` <b>${r.system_files}</b> of the matches are BIOS, device or non-arcade entries${r.applied && r.flagged ? ' and were marked as System' : $('#names-flag-system')?.checked ? ' and will be marked as System' : ''}.` : ''}${r.sample.length ? '<br>' + r.sample.map((s) => `<code>${esc(s.filename)}</code>: ${esc(s.from)} → <b>${esc(s.title)}</b>`).join('<br>') : ''}${r.applied && r.matched ? '<br>Next: go to the Library, select this platform and press <b>Fetch metadata</b>.' : ''}`;
      if (r.covers) {
        const c = r.covers, n = (v) => Number(v || 0).toLocaleString();
        out.innerHTML += `<br>${r.applied ? '<b>Covers:</b> ' : '<b>Covers:</b> '}${r.applied ? `${n(c.set)} saved${c.not_image ? `, ${n(c.not_image)} skipped (not a JPEG, PNG or WebP picture)` : ''}${c.unreadable ? `, ${n(c.unreadable)} could not be read` : ''}.` : `${c.by_column ? `${n(c.cover_rows)} row${c.cover_rows === 1 ? '' : 's'} name a cover; ` : 'No cover_file column, so the zip\'s pictures were matched by file name; '}${n(c.found)} found in the zip, ${n(c.will_set)} would be saved${c.already_have ? `, ${n(c.already_have)} games already have one (tick the box to replace them)` : ''}${c.not_in_zip ? `, ${n(c.not_in_zip)} not in the zip${c.missing_examples?.length ? ` (for example ${c.missing_examples.map(esc).join(', ')})` : ''}` : ''}.`}`;
      }
      applyBtn.disabled = apply || !(r.matched || r.covers?.will_set);
      if (apply) { toast(`Renamed ${r.matched} games${r.covers ? `, ${r.covers.set || 0} covers` : ''}`); loadLibrary(); }
    } catch (err) { out.textContent = err.message; toast(err.message, true); }
  };
  $('#names-preview').onclick = () => run(false);
  applyBtn.onclick = () => run(true);
  $('#names-file').onchange = () => { applyBtn.disabled = true; out.textContent = ''; };
  $('#names-covers-zip').onchange = () => { applyBtn.disabled = true; };
  $('#names-covers-replace').onchange = () => { applyBtn.disabled = true; };
}

function showSettingsModule(id) {
  // A saved or stale module the person may not open (e.g. an admin one after signing in as a member) falls back to the first allowed one.
  if (!SETTINGS_MODULES.some((m) => m.id === id && settingsModuleOk(m))) id = settingsGroupMods(settingsVisibleGroups()[0])[0].id;
  // Only one module at a time.
  $$('#view-settings .panel').forEach((p) => p.classList.add('hidden'));
  $('#view-settings #settings-tiles').classList.remove('hidden');
  activeSettingsModule = id;
  const grp = settingsGroupOf(id);
  if (grp) settingsLastInGroup[grp.id] = id;
  renderSettingsTiles(id);
  saveNav();
  const panel = $(`#mod-${id}`);
  if (!panel) return;
  if (id === 'playpc') {   // the launcher needs the ROM file: an account without downloads is told so, instead of getting a browser error
    const off = authState.user?.can_download === false;
    $('#playpc-download')?.classList.toggle('hidden', off);
    $('#playpc-dl-note')?.classList.toggle('hidden', !off);
  }
  panel.classList.remove('hidden');
  if (id === 'controller') initPadLayoutPanel();
  if (id === 'profile') initProfilePanel();
  if (id === 'steam') initSteamPanel();
  if (id === 'welcome') $('#welcome-again').onclick = () => startWelcome();
  if (id === 'names') initNamesPanel();
  if (id === 'health') loadHealth();
  if (id === 'duplicates') loadDuplicates(true);
  if (id === 'backup') { loadBackups().catch((err) => toast(err.message, true)); loadRestoreStatus(); }
  panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* Duplicate finder: groups of different versions of one game, with a suggested keeper. */
const dupState = { offset: 0, groups: [], total: 0, extra: 0, platformsLoaded: false };
async function loadDuplicates(reset = true, keepPlace = false) {
  const list = $('#dup-list'), summary = $('#dup-summary');
  // Refreshing after a click keeps the list and the scroll position: only a fresh look (platform change, Refresh) starts from the top.
  const scroller = (() => { for (let el = list.parentElement; el; el = el.parentElement) { const o = getComputedStyle(el).overflowY; if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) return el; } return document.scrollingElement; })();
  const keepTop = keepPlace ? scroller.scrollTop : 0;
  const keepCount = keepPlace ? Math.max(50, dupState.groups.length) : 50;
  if (reset && !keepPlace) { dupState.offset = 0; dupState.groups = []; list.innerHTML = '<div class="side-empty">Looking…</div>'; summary.textContent = ''; }
  try {
    if (!dupState.platformsLoaded) {
      const plats = await api('/platforms');
      const sel = $('#dup-platform');
      (plats.items || plats).filter((p) => (p.count ?? 0) > 0).forEach((p) => sel.insertAdjacentHTML('beforeend', `<option value="${esc(p.slug)}">${esc(p.name)}</option>`));
      dupState.platformsLoaded = true;
    }
    if (keepPlace) dupState.offset = 0;
    const q = new URLSearchParams({ limit: String(Math.min(keepCount, 200)), offset: String(dupState.offset) });
    if ($('#dup-platform').value) q.set('platform', $('#dup-platform').value);
    const r = await api('/admin/duplicates?' + q);
    dupState.total = r.total; dupState.extra = r.extra;
    dupState.groups = reset ? r.groups : dupState.groups.concat(r.groups);
    renderDuplicates();
    if (keepPlace) { scroller.scrollTop = keepTop; requestAnimationFrame(() => { scroller.scrollTop = keepTop; }); }
  } catch (err) { list.innerHTML = `<div class="side-empty">${esc(err.message)}</div>`; }
}
function renderDuplicates() {
  const list = $('#dup-list');
  const g = dupState.groups;
  $('#dup-summary').textContent = dupState.total ? `${dupState.total} game${dupState.total === 1 ? '' : 's'} with more than one version (${dupState.extra} extra cop${dupState.extra === 1 ? 'y' : 'ies'})` : '';
  $('#dup-hide-all').classList.toggle('hidden', !g.length);
  $('#dup-more').classList.toggle('hidden', g.length >= dupState.total);
  if (!g.length) { list.innerHTML = '<div class="side-empty">No duplicates found. Every game appears once.</div>'; return; }
  const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  list.innerHTML = g.map((grp, gi) => `
    <div class="dup-group" data-gi="${gi}">
      <div class="dup-head"><b>${esc(grp.title)}</b> <span class="pill">${esc(grp.platform_short || grp.platform)}</span>${grp.size_mismatch ? ' <span class="pill warn" title="Same title but very different file sizes: these may be two different games that were given one title">⚠ sizes differ a lot: probably not duplicates</span>' : ''}
        <span class="grow"></span>
        <button class="btn btn-sm" data-dup-hide="${gi}" title="Hide every copy except the suggested one (members will not see them either)">Hide the others</button></div>
      <div class="dup-items">${grp.items.map((it) => `
        <div class="dup-item ${it.keep ? 'keep' : ''}" data-dup-open="${it.id}" title="Open this game">
          <div class="dup-cover">${it.cover_url ? `<img loading="lazy" src="${esc(it.cover_url)}" alt="" />` : ''}</div>
          <button class="dup-keepbtn" data-dup-hide-one="${it.id}" title="Hide this copy (members will not see it either; you find it under Hidden in the Library)" aria-label="Hide this copy">${ICON.eyeOff}</button>
          <div class="dup-meta">
            <div class="dup-file">${esc(it.filename)}</div>
            ${it.path ? `<div class="dup-path" title="${esc(it.path)}">${esc(it.source_name ? it.source_name + ' · ' : '')}${esc(it.path)}</div>` : ''}
            <div class="sub">${[it.region, it.revision ? 'rev ' + it.revision : '', it.year, size(it.size_bytes), it.dat_status && it.dat_status !== 'not-in-dat' ? 'DAT: ' + it.dat_status : ''].filter(Boolean).map(esc).join(' · ')}</div>
            ${it.tie ? `<div class="dup-tie">⚖ No clear winner: check both</div>` : it.keep ? `<div class="dup-keep">✓ ${it.chosen === 'keep' ? 'Locked: you chose this copy' : 'Suggested to keep: ' + esc(it.why)}</div>` : (it.chosen === 'drop' ? '<div class="sub">Not kept (an older choice). Click the padlock to reset</div>' : '')}
          </div>
        </div>`).join('')}</div>
    </div>`).join('');
}
async function hideDuplicateExtras(groups) {
  const ids = groups.flatMap((grp) => grp.items.filter((i) => !i.keep).map((i) => i.id));
  if (!ids.length) return;
  const ok = await confirmDialog({ title: `Hide ${ids.length} extra cop${ids.length === 1 ? 'y' : 'ies'}?`, body: 'Only the suggested copy of each game stays visible; members will not see the others either. Nothing is deleted and no file is touched. You can bring them back any time from the Hidden filter in the Library.', okLabel: 'Hide them' });
  if (!ok) return;
  try { await api('/roms/bulk/hide', { method: 'POST', body: JSON.stringify({ ids, hidden: true }) }); toast(`Hid ${ids.length} extra cop${ids.length === 1 ? 'y' : 'ies'}`); loadDuplicates(true, true); loadPlatforms(); }
  catch (err) { toast(err.message, true); }
}
document.addEventListener('click', (e) => {
  const kb = e.target.closest('[data-dup-hide-one]');
  if (kb) {
    e.stopPropagation();
    api('/roms/bulk/hide', { method: 'POST', body: JSON.stringify({ ids: [Number(kb.dataset.dupHideOne)], hidden: true }) })
      .then(() => { toast('Hidden'); loadDuplicates(true, true); loadPlatforms(); }).catch((err) => toast(err.message, true));
    return;
  }
  const open = e.target.closest('[data-dup-open]');
  if (open) { state.navSnap = null; state.nav = null; openDetail(Number(open.dataset.dupOpen)); return; }
  const one = e.target.closest('[data-dup-hide]');
  if (one) { e.stopPropagation(); hideDuplicateExtras([dupState.groups[Number(one.dataset.dupHide)]]); return; }
  if (e.target.closest('#dup-hide-all')) hideDuplicateExtras(dupState.groups);
  if (e.target.closest('#dup-refresh')) loadDuplicates(true);
  if (e.target.closest('#dup-more')) { dupState.offset = dupState.groups.length; loadDuplicates(false); }
});
document.addEventListener('change', (e) => { if (e.target.id === 'dup-platform') loadDuplicates(true); });

// Requests that took over a second, newest first, with how many others were running when they began: finds why it felt slow.
async function renderSlowRequests() {
  const box = $('#health-slow'); if (!box) return;
  try {
    const r = await api('/admin/slow-requests');
    const sec = (ms) => (ms >= 10000 ? Math.round(ms / 1000) + ' s' : (ms / 1000).toFixed(1) + ' s');
    const clock = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
    const day = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) || d.toDateString() === new Date().toDateString() ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' '; };
    box.innerHTML = `<h4 style="margin:1.2rem 0 0.4rem">Slow requests <span class="note">(over ${sec(r.threshold_ms)}, since the server last started)</span></h4>` + (r.entries.length
      ? `<div class="slow-list">${r.entries.slice(0, 15).map((e) => `<div class="slow-row"><b>${sec(e.ms)}</b><span class="mono">${esc(e.method)} ${esc(e.path)}${e.query ? '?' + esc(e.query) : ''}</span><span class="note">${esc(day(e.started_at || e.at))}${esc(clock(e.started_at || e.at))} → ${esc(clock(e.ended_at || e.at))}${e.user ? ' · ' + esc(e.user) : ''}${e.others_running ? ' · ' + e.others_running + ' other request' + (e.others_running === 1 ? '' : 's') + ' running' : ''}</span></div>`).join('')}</div>`
      : '<div class="hint">None so far. If something feels slow, it will be listed here with what it was.</div>');
  } catch { box.innerHTML = ''; }
}

/* Settings > Stats: counted straight from the database (see src/lib/stats.js). */
async function loadStatsPanel() {
  const box = $('#meta-counts'); if (!box) return;
  const s = await api('/admin/stats');
  const num = (v) => Number(v || 0).toLocaleString();
  const src = (id) => (s.by_source.find((x) => x.source === id) || {}).count || 0;
  // A total that can be opened as a search is a link: it opens the Library with exactly that filter (the number matches the list).
  const row = (k, v, note = '', go = '') => go
    ? `<a class="stat-link" href="#" data-stat-go="${go}" title="Show these games in the Library"><span>${esc(k)}${note ? ` <small class="note">${esc(note)}</small>` : ''}</span><b>${v}</b></a>`
    : `<div><span>${esc(k)}${note ? ` <small class="note">${esc(note)}</small>` : ''}</span><b>${v}</b></div>`;
  const who = s.most_active_user ? `${esc(s.most_active_user.name)} (${num(s.most_active_user.plays)} plays)` : 'no plays yet';
  const game = s.most_played_game ? `${esc(s.most_played_game.title)} (${num(s.most_played_game.plays)})` : 'no plays yet';
  const by = s.by_source.filter((x) => !['none', 'filename', 'seed'].includes(x.source)).map((x) => `${esc(x.source)} ${num(x.count)}`).join(' · ') || 'none yet';
  box.innerHTML = `<div class="stats-grid">
    <div class="stats-col">
      <h4>Library</h4>
      ${row('Total games', num(s.roms), '', 'all')}${row('Platforms', num(s.platforms))}${row('Sources', num(s.sources))}${row('Users', num(s.users))}${row('System items', num(s.system_items), 'BIOS, devices', 'system')}${row('Favourites', num(s.favourites))}
    </div>
    <div class="stats-col">
      <h4>Metadata</h4>
      ${row('Matched by a provider or DAT', num(s.with_metadata), '', 'matched')}${row('Name from the file only', num(s.filename_only), '', 'unmatched-name')}${row('With covers', num(s.with_covers), '', 'cover')}${row('No cover', num(s.no_covers), 'excluding System', 'nocover')}
      <div class="stats-by"><span>Matched by</span><b>${by}</b></div>
    </div>
    <div class="stats-col">
      <h4>Housekeeping</h4>
      ${row('Orphans', num(s.orphans), 'no source folder', 'orphan')}${row('Missing files', num(s.missing_files), '', 'missing')}${row('Hidden', num(s.hidden), 'by anyone', 'hidden')}
    </div>
    <div class="stats-col">
      <h4>Activity</h4>
      ${row('Plays in the browser', num(s.plays))}${row('Most active user', who)}${row('Most played game', game)}
    </div>
  </div>`;
  $$('[data-stat-go]', box).forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); openLibraryFor(el.dataset.statGo); }));
}

/** Open the Library showing exactly the games behind a total on the Stats page. */
function openLibraryFor(kind) {
  closeDrawer();
  Object.assign(state, { platform: 'all', extraPlatforms: [], q: '', tag: null, genre: null, favorite: false, source: null, sourceName: null,
    missing: false, hidden: false, system: false, orphan: false, locked: false, unmatched: false, datStatus: null, cover: null, matched: null, incl: null });
  const sb = $('#search'); if (sb) sb.value = '';
  // The Stats page counts every game, so the lists these links open include hidden games (and System ones where the total does).
  if (kind === 'all' || kind === 'matched' || kind === 'unmatched-name' || kind === 'cover' || kind === 'missing') state.incl = 'all';
  else if (kind === 'nocover') state.incl = 'hidden';
  if (kind === 'system') state.system = true;
  else if (kind === 'hidden') state.hidden = true;
  else if (kind === 'orphan') state.orphan = true;
  else if (kind === 'missing') state.missing = true;
  else if (kind === 'matched') state.matched = 'yes';
  else if (kind === 'unmatched-name') state.matched = 'no';
  else if (kind === 'cover') state.cover = 'with';
  else if (kind === 'nocover') state.cover = 'none';
  state.libKey = null;
  setView('library');
  loadLibrary();
}

let healthText = '';
async function loadHealth() {
  const overall = $('#health-overall'), checks = $('#health-checks'), sum = $('#health-summary');
  overall.className = 'health-overall'; overall.textContent = 'Checking…'; checks.innerHTML = ''; sum.innerHTML = '';
  try {
    const h = await api('/admin/health');
    healthText = h.diagnostics || '';
    const words = { ok: 'Everything looks healthy', warn: 'Working, with things to look at', bad: 'Something needs attention' };
    overall.className = 'health-overall ' + h.status;
    overall.innerHTML = `<span class="dot"></span>${words[h.status] || h.status}`;
    const s = h.summary || {};
    const gb = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : Math.round(n / 1048576) + ' MB');
    const up = s.uptime_s >= 3600 ? Math.floor(s.uptime_s / 3600) + ' h ' + Math.floor((s.uptime_s % 3600) / 60) + ' min' : Math.floor(s.uptime_s / 60) + ' min';
    sum.innerHTML = [
      ['Version', s.version], ['Up for', up], ['ROMs', s.roms], ['With covers', s.with_covers],
      ['Missing files', s.missing_files], ['Sources', s.sources], ['Users', s.users],
      ['Imported storage', gb(s.storage_bytes || 0)], ['Memory', (s.memory_mb || 0) + ' MB'], ['Node', s.node]
    ].map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(String(v ?? '–'))}</b></div>`).join('');
    const icon = { ok: '✓', warn: '!', bad: '✕' };
    const order = { bad: 0, warn: 1, ok: 2 };
    checks.innerHTML = [...h.checks].sort((a, b) => order[a.status] - order[b.status]).map((c) => `
      <div class="health-row ${c.status}">
        <span class="health-ico">${icon[c.status]}</span>
        <div><b>${esc(c.label)}</b><div class="sub">${esc(c.detail)}</div></div>
        ${c.fixable === 'covers' ? '<button class="btn btn-sm" id="health-repair-covers" title="Repair: mark the games whose cover picture is missing as having no cover">Repair</button>' : ''}
      </div>`).join('');
    renderSlowRequests();
  } catch (err) {
    overall.className = 'health-overall bad';
    overall.textContent = 'Could not run the health check: ' + err.message;
  }
}
document.addEventListener('click', async (e) => {
  if (e.target.closest('#health-refresh')) loadHealth();
  if (e.target.closest('#health-repair-covers')) {
    try { const j = await api('/roms/bulk/repair-covers', { method: 'POST' }); toast(`${j.forgotten} game${j.forgotten === 1 ? '' : 's'} marked as having no cover. Run Fetch missing covers to download them again.`); loadHealth(); }
    catch (err) { toast(err.message, true); }
  }
  if (e.target.closest('#health-copy')) {
    if (!healthText) return;
    // navigator.clipboard only exists on HTTPS or localhost; a server reached by plain http:// on a LAN address has no such thing.
    // So: try it, then the older copy command, and if the browser refuses both, show the report in a box to select and copy.
    let ok = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(healthText); ok = true; } } catch { /* fall through */ }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = healthText; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    if (ok) toast('Health report copied');
    else {
      let box = $('#health-report-box');
      if (!box) { box = document.createElement('textarea'); box.id = 'health-report-box'; box.className = 'search'; box.readOnly = true; box.rows = 12; box.style.cssText = 'width:100%;margin-top:10px;font-family:monospace;'; $('#health-copy').closest('.panel, section, div')?.appendChild(box); }
      box.value = healthText; box.focus(); box.select();
      toast('Your browser would not copy automatically: the report is selected below, press Ctrl+C', true);
    }
  }
});

function initPadLayoutPanel() {
  const sel = $('#pad-layout'); if (!sel) return;
  try { sel.value = localStorage.getItem('gamesauce_pad_layout') || 'auto'; } catch { /* private mode */ }
  const now = () => {
    const nav = window.gamepadNav;
    const pad = (navigator.getGamepads ? [...navigator.getGamepads()] : []).find((p) => p && p.connected);
    const eff = nav ? nav.layoutFor(pad) : 'xbox';
    $('#pad-layout-now').textContent = (pad ? 'Detected: ' + pad.id.slice(0, 60) + '. ' : 'No controller detected yet (press a button on it). ')
      + 'Using the ' + (eff === 'nintendo' ? 'Nintendo' : 'Xbox') + ' layout.';
  };
  sel.onchange = () => { try { localStorage.setItem('gamesauce_pad_layout', sel.value); } catch { /* ignore */ } now(); toast('Controller layout saved'); };
  now();
}

async function loadSettings() {
  const isAdmin = authState.user?.role === 'admin';

  // Re-render tiles per role (members never get admin modules).
  renderSettingsTiles();

  // Always: password + sessions. Provider credentials are SYSTEM-WIDE and
  // admin-only (the API enforces it) — members never see a providers module.
  const [sessionsRes] = await Promise.all([api('/auth/sessions')]);
  $('#session-list').innerHTML = (sessionsRes.items || []).map((s) => `
    <div class="user-list-row">
      <div class="grow">
        <div>${esc((s.user_agent || 'unknown device').slice(0, 60))} ${s.id === sessionsRes.current ? '<span class="pill ok">this device</span>' : ''}</div>
        <div class="sub">${esc(s.ip || '')} · last seen ${esc(s.last_seen_at)} UTC</div>
      </div>
    </div>`).join('') || '<div class="side-empty">No active sessions</div>';

  // Admin-only modules (providers, users, platforms, coverage, DB, audit, DAT)
  // + the shared provider config only load for admins.
  if (isAdmin) {
    const [meta, facets] = await Promise.all([api('/metadata'), api('/roms/facets')]);
    renderProviderForms(meta.config, meta.providers);
    renderDbTools(facets);
    loadPlatformAdmin().catch((err) => toast(err.message, true));
    const counts = new Map(meta.counts.map((c) => [c.source, c.count]));
    const total = facets.stats.roms || 0;
    const enriched = facets.stats.enriched || 0;
    loadStatsPanel().catch(() => {});
    loadDats().catch((err) => toast(err.message, true));
    const ss = meta.providers.find((p) => p.id === 'screenscraper');
    $('#ss-quota').textContent = ss?.enabled
      ? (ss.quota?.today != null
          ? `ScreenScraper quota used today: ${ss.quota.today} / ${ss.quota.max}.`
          : 'ScreenScraper configured. Quota is reported after the first request.')
      : 'ScreenScraper is not configured yet — covers fall back to filename initials until credentials are set.';
    loadArtFolders().catch(() => {});
    await loadAuditForModule();
    await loadUsersForModule();
  } else {
    // Standard user: only password + sessions. (No providers — those are
    // system-wide and admin-only.)
  }

  // Re-show whichever module was open (default: first avail tile) to avoid a
  // flash of nothing after refresh.
  showSettingsModule(activeSettingsModule || 'profile');
}

/* Artwork folders (admin): the folders on the server that pictures and manuals can be imported from. */
async function loadArtFolders() {
  const { folders } = await api('/art/folders');
  $('#artfolders-text').value = folders.map((f) => f.path).join('\n');
  $('#artfolders-state').innerHTML = folders.length
    ? folders.map((f) => `${f.exists ? '✓' : '✕'} ${esc(f.path)}${f.exists ? '' : ' <b>(the server cannot see this folder)</b>'}`).join('<br>')
    : 'No folders yet.';
  try { $('#art-share').checked = (await api('/art/sharing')).on; } catch { /* the box stays as it is */ }
}
$('#art-share')?.addEventListener('change', async (e) => {
  try { await api('/art/sharing', { method: 'PUT', body: JSON.stringify({ on: e.target.checked }) }); toast(e.target.checked ? 'Pictures are shared between accounts' : 'Pictures are no longer shared between accounts'); }
  catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
});
// Play on this PC: the launcher's setup page, and "Check my PC" (the launcher reports which platforms have an emulator). Both are links that the launcher on this PC answers.
async function launcherLink(kind) {
  const state = $('#playpc-state');
  if (authState.user?.can_download === false) { state.textContent = 'This account cannot play on a local emulator (downloads are turned off for it).'; return; }
  const readAt = async () => { try { return JSON.parse((await api('/prefs')).launcher_platforms || 'null'); } catch { return null; } };
  try {
    const before = (await readAt())?.at || null;
    const { token } = await api('/launcher/sync-token', { method: 'POST' });
    state.textContent = kind === 'configure' ? 'Opening the setup page… (it needs the launcher on this PC: docs/LOCAL-LAUNCH.md)' : 'Asking the launcher on this PC…';
    location.href = `gamesauce://${kind}?${new URLSearchParams({ server: location.origin, token })}`;
    for (let i = 0; i < (kind === 'configure' ? 450 : 20); i++) {
      await new Promise((ok) => setTimeout(ok, 2000));
      if (!state.isConnected) return;
      const lp = await readAt();
      if (lp && lp.at !== before) { state.textContent = lp.platforms.length ? `This PC can start: ${lp.platforms.join(', ')}.` : 'No emulators are set up on this PC yet: only games that play in the browser are offered.'; return; }
    }
    state.textContent = kind === 'configure' ? '' : 'The launcher did not answer. Is it installed on this PC, and is this server listed in its launcher.json?';
  } catch (err) { state.textContent = err.message || 'Could not start'; }
}
$('#playpc-setup')?.addEventListener('click', () => launcherLink('configure'));
$('#playpc-check')?.addEventListener('click', () => launcherLink('sync'));

$('#artfolders-save')?.addEventListener('click', async () => {
  const list = $('#artfolders-text').value.split('\n').map((l) => l.trim()).filter(Boolean);
  try { await api('/art/folders', { method: 'PUT', body: JSON.stringify({ folders: list }) }); toast('Artwork folders saved'); await loadArtFolders(); }
  catch (err) { toast(err.message, true); }
});

async function loadUsersForModule() {
  if (authState.user?.role !== 'admin') return;
  try {
    const pol = await api('/auth/policy');
    const box = $('#policy-members-download');
    if (box) {
      box.checked = !!pol.members_can_download;
      box.onchange = async () => {
        try { const r = await api('/auth/policy', { method: 'PUT', body: JSON.stringify({ members_can_download: box.checked }) }); box.checked = r.members_can_download; toast(r.members_can_download ? 'Members can now download ROM files' : 'Members can no longer download ROM files'); }
        catch (err) { box.checked = !box.checked; toast(err.message, true); }
      };
    }
    const av = $('#policy-arcade-verified');
    if (av) {
      av.checked = !!pol.arcade_verified_only;
      av.onchange = async () => {
        try { const r = await api('/auth/policy', { method: 'PUT', body: JSON.stringify({ arcade_verified_only: av.checked }) }); av.checked = r.arcade_verified_only; toast(r.arcade_verified_only ? 'Arcade games are now offered for browser play only once verified' : 'Arcade browser play is back to the standard rules'); }
        catch (err) { av.checked = !av.checked; toast(err.message, true); }
      };
    }
  } catch { /* the list below still works */ }
  const { items: users, suggested } = await api('/auth/users');
  const newColour = $('#new-user-form [name="colour"]'); if (newColour && suggested) newColour.value = suggested;   // the first colour nobody has yet
  $('#user-list').innerHTML = users.map((u) => `
    <div class="user-list-row" data-user="${u.id}" data-name="${esc(u.username)}">
      <div class="grow">
        <div class="user-line"><span class="avatar avatar-sm${u.avatar_v ? ' has-pic' : ''}" style="${u.avatar_v ? `background-image:url(/api/auth/avatar/${u.id}?v=${u.avatar_v})` : ''}">${u.avatar_v ? '' : esc(u.username.slice(0, 1))}</span><span class="user-name">${esc(u.username)}</span>${u.role === 'admin' ? '<span class="pill accent user-badge">admin</span>' : ''}${u.disabled ? '<span class="pill bad user-badge">disabled</span>' : ''}</div>
        <div class="sub">${u.active_sessions} session(s) · last login ${u.last_login_at ? `${esc(u.last_login_at)} UTC` : 'never'}</div>
      </div>
      <label class="dl-pick" title="This person's colour in the chat: their picture, their row in the list and the messages you receive from them. It saves when you close the picker. Green is kept for your own messages."><span>Colour</span>
        <input type="color" class="user-colour" data-act="colour-setting" value="${esc(/^#[0-9a-f]{6}$/i.test(u.colour || '') ? u.colour : '#7c5cff')}" aria-label="Colour of ${esc(u.username)} in the chat" /></label>
      <label class="dl-pick" title="Admins manage the library, sources, providers and people. Members use the library. You cannot change your own role."><span>Role</span>
        <select class="select" data-act="role-setting" ${u.id === (authState.user?.id) ? 'disabled' : ''}><option value="user" ${u.role !== 'admin' ? 'selected' : ''}>Member</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></label>
      ${u.role === 'admin' ? '' : `<label class="dl-pick" title="What this person sees. Full: the whole app. Play only: a simple screen of games that can be played in the browser, with search and favourites."><span>Screen</span>
        <select class="select" data-act="mode-setting"><option value="full" ${u.mode === 'full' ? 'selected' : ''}>Full</option><option value="play" ${u.mode === 'play' ? 'selected' : ''}>Play only</option></select></label>`}
      ${u.role === 'admin' ? '' : `<label class="dl-pick" title="Whether this person can download ROM files. 'Default' follows the switch above."><span>Downloads</span>
        <select class="select" data-act="download-setting"><option value="default" ${u.download === 'default' ? 'selected' : ''}>Default</option><option value="allow" ${u.download === 'allow' ? 'selected' : ''}>Always allowed</option><option value="deny" ${u.download === 'deny' ? 'selected' : ''}>Never</option></select></label>`}
      <button class="btn btn-sm" data-act="reset-password" title="Set a new password for this user" ${u.id === (authState.user?.id) ? 'hidden' : ''}>Reset password</button>
      <button class="btn btn-sm" data-act="toggle-user" data-disabled="${u.disabled ? 1 : 0}">${u.disabled ? 'Enable' : 'Disable'}</button>
      <button class="btn btn-sm btn-danger" data-act="delete-user" ${u.id === (authState.user?.id) ? 'disabled' : ''}>Delete</button>
    </div>`).join('');
  $$('[data-user]').forEach((row) => {
    const id = Number(row.dataset.user);
    $('[data-act="toggle-user"]', row)?.addEventListener('click', async () => {
      const disabled = row.textContent.includes('disabled');
      try { await api(`/auth/users/${id}`, { method: 'PATCH', body: JSON.stringify({ disabled: !disabled }) }); loadUsersForModule(); }
      catch (err) { toast(err.message, true); }
    });
    $('[data-act="colour-setting"]', row)?.addEventListener('change', async (e) => {
      try { await api(`/auth/users/${id}`, { method: 'PATCH', body: JSON.stringify({ colour: e.target.value }) }); toast(`${row.dataset.name}'s colour saved`); }
      catch (err) { toast(err.message, true); loadUsersForModule(); }   // refused (too dark, too light or green): the reason is shown and the old colour comes back
    });
    $('[data-act="role-setting"]', row)?.addEventListener('change', async (e) => {
      const name = row.dataset.name, role = e.target.value;
      const ok = await confirmDialog({ title: role === 'admin' ? `Make ${name} an admin?` : `Make ${name} a member?`, body: role === 'admin' ? `${name} will be able to manage the library, sources, providers, backups and every other person. Only do this for someone you trust with the whole server.` : `${name} will lose access to Settings, Sources and the admin tools, and keep the normal library.`, okLabel: role === 'admin' ? 'Make admin' : 'Make member', danger: role !== 'admin' });
      if (!ok) { loadUsersForModule(); return; }
      try { await api(`/auth/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role }) }); toast(role === 'admin' ? `${name} is now an admin` : `${name} is now a member`); }
      catch (err) { toast(err.message, true); }
      loadUsersForModule();
    });
    $('[data-act="mode-setting"]', row)?.addEventListener('change', async (e) => {
      const name = row.dataset.name;
      try {
        await api(`/auth/users/${id}`, { method: 'PATCH', body: JSON.stringify({ mode: e.target.value }) });
        toast(e.target.value === 'play' ? `${name} now sees the play-only screen (from their next page load)` : `${name} has the full screen`);
      } catch (err) { toast(err.message, true); loadUsersForModule(); }
    });
    $('[data-act="download-setting"]', row)?.addEventListener('change', async (e) => {
      const name = row.dataset.name;
      try {
        await api(`/auth/users/${id}`, { method: 'PATCH', body: JSON.stringify({ download: e.target.value }) });
        toast(e.target.value === 'allow' ? `${name} can always download` : e.target.value === 'deny' ? `${name} can never download` : `${name} follows the default`);
      } catch (err) { toast(err.message, true); loadUsersForModule(); }
    });
    $('[data-act="reset-password"]', row)?.addEventListener('click', async () => {
      const name = row.dataset.name;
      const pw = await passwordDialog({ username: name });
      if (!pw) return;
      try { await api(`/auth/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password: pw }) }); toast(`Password reset for ${name}`); loadUsersForModule(); }
      catch (err) { toast(err.message, true); }
    });
    $('[data-act="delete-user"]', row)?.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Delete this user?', body: 'Their sessions end immediately.', okLabel: 'Delete', danger: true });
      if (!ok) return;
      try { await api(`/auth/users/${id}`, { method: 'DELETE' }); loadUsersForModule(); }
      catch (err) { toast(err.message, true); }
    });
  });
}

const auditState = { user: '', action: '', since: '', until: '' };
async function loadAuditForModule() {
  if (authState.user?.role !== 'admin') return;
  const q = new URLSearchParams({ limit: '200' });
  if (auditState.user) q.set('username', auditState.user);
  if (auditState.action.trim()) q.set('action', auditState.action.trim());
  if (auditState.since) q.set('since', auditState.since);
  if (auditState.until) q.set('until', auditState.until);
  let data;
  try { data = await api(`/auth/audit?${q}`); } catch (err) { $('#audit-list').innerHTML = `<div class="side-empty">${esc(err.message)}</div>`; return; }
  const sel = $('#audit-user');
  const current = auditState.user;
  const users = [...new Set([...(data.users || []), ...(current ? [current] : [])])].sort();
  sel.innerHTML = '<option value="">All users</option>' +
    users.map((u) => `<option value="${esc(u)}" ${u === current ? 'selected' : ''}>${esc(u)}</option>`).join('');
  const active = [auditState.user && `user ${auditState.user}`, auditState.action.trim() && `“${auditState.action.trim()}”`, auditState.since && `since ${auditState.since}`, auditState.until && `until ${auditState.until}`].filter(Boolean);
  $('#audit-count').textContent = active.length
    ? `${data.items.length} entr${data.items.length === 1 ? 'y' : 'ies'} matching ${active.join(' · ')}`
    : `${data.items.length} latest entries`;
  $('#audit-list').innerHTML = data.items.map((e) => `
    <div class="audit-row">
      <span class="audit-when">${esc(e.created_at)} UTC</span>
      <span class="audit-who">${esc(e.username || '—')}</span>
      <span class="audit-what">${esc(e.summary || e.action)}<span class="audit-raw">${esc(e.action)}${e.target ? ` · ${esc(e.target)}` : ''}${e.ip ? ` · ${esc(e.ip)}` : ''}</span></span>
    </div>`).join('') || '<div class="side-empty">Nothing recorded yet</div>';
}

$('#audit-apply')?.addEventListener('click', () => {
  auditState.user = $('#audit-user').value;
  auditState.action = $('#audit-action').value;
  auditState.since = $('#audit-since').value;
  auditState.until = $('#audit-until').value;
  loadAuditForModule();
});
$('#audit-clear')?.addEventListener('click', () => {
  auditState.user = auditState.action = auditState.since = auditState.until = '';
  $('#audit-user').value = '';
  $('#audit-action').value = '';
  $('#audit-since').value = '';
  $('#audit-until').value = '';
  loadAuditForModule();
});
for (const id of ['#audit-action']) {
  $(id)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#audit-apply').click(); });
}

/* ─────────────────────────── emulators ─────────────────────────── */

const emuState = { guide: [], vault: [], latest: {}, why: {}, latestFetchStarted: false };

async function loadEmulators() {
  const isAdmin = authState.user?.role === 'admin';
  $$('#view-emulators .admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin));
  try {
    const [guide, vault] = await Promise.all([api('/emulators/guide'), api('/emulators/vault')]);
    emuState.guide = guide.items || [];
    emuState.vault = vault.items || [];
  } catch (err) {
    $('#emu-guide').innerHTML = `<div class="side-empty">${esc(err.message)}</div>`;
    return;
  }

  // Auto-fetch latest releases on view load (once per page, not per visit) so
  // the version picker + download buttons are ready without a manual click.
  if (!emuState.latestFetchStarted) {
    emuState.latestFetchStarted = true;
    fetchEmuLatest().catch(() => { /* retried on manual click */ });
  }

  // Platform picker for vault upload (admin only) + source create + ROM upload:
  // one cache, three dropdowns. Vault + source REQUIRE a platform; ROM upload
  // keeps auto-detect (extensions disambiguate single files well).
  const platSel = $('#emu-upload-platform');
  const upSel = $('#upload-platform');
  if ((platSel && platSel.options.length <= 1) || (upSel && upSel.options.length <= 1)) {
    try {
      if (!window.__platformsCache?.length) {
        const { items } = await api('/platforms');
        window.__platformsCache = items;
      }
      const sorter = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
      const flat = [...window.__platformsCache].sort((a, b) => sorter(a.name, b.name));
      if (platSel && platSel.options.length <= 1) {
        platSel.innerHTML = '<option value="">— pick one —</option>' +
          flat.map((p) => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join('');
      }
      if (upSel && upSel.options.length <= 1) {
        upSel.innerHTML = '<option value="auto">Detect from extension</option>' +
          flat.map((p) => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join('');
      }
    } catch { /* pickers are a nicety */ }
  }

  renderEmuGuide();
  renderEmuVault();
}

function renderEmuGuide() {
  const wrap = $('#emu-guide');
  if (!emuState.guide.length) {
    wrap.innerHTML = '<div class="side-empty">No recommendations yet.</div>';
    return;
  }
  wrap.innerHTML = emuState.guide.map((e) => {
    // Multi-system picks (RetroArch) have no platform slug — they key off
    // their explicit slug instead.
    const key = e.platforms[0] || e.slug;
    const latest = emuState.latest[key];
    const vaulted = emuState.vault.filter((v) =>
      v.name === e.name || (v.platform_slug && e.platforms.includes(v.platform_slug)));
    return `
    <div class="emu-card" data-emu="${esc(key)}">
      <div class="emu-top">
        <span class="emu-name">${esc(e.name)}</span>
        <span class="emu-plat">${esc(e.platform_label)}</span>
        ${e.bios_needed === 'required' ? '<span class="emu-bios">needs BIOS and/or system files from your console</span>' : ''}
        ${e.bios_needed === 'optional' ? '<span class="emu-bios">BIOS optional — some cores need it</span>' : ''}
		${e.bios_needed === 'firmware' ? '<span class="emu-bios">Needs official Sony PS3 firmware installing</span>' : ''}
		${e.bios_needed === 'wiiu' ? '<span class="emu-bios">Needs title keys from your console</span>' : ''}
		${e.bios_needed === 'retroarch' ? '<span class="emu-bios">Some cores need BIOS files placing in system folder</span>' : ''}
		${e.bios_needed === 'bios' ? '<span class="emu-bios">BIOS files required from your console</span>' : ''}
      </div>
      <p class="emu-note">${esc(e.notes)}</p>
      <div class="emu-links">
        <a href="${esc(e.homepage)}" target="_blank" rel="noreferrer">Official site ↗</a>
        <a href="${esc(e.download)}" target="_blank" rel="noreferrer">Download page ↗</a>
        ${e.github ? `<a href="https://github.com/${esc(e.github)}" target="_blank" rel="noreferrer">GitHub ↗</a>` : ''}
      </div>
      <div class="emu-latest" data-latest="${esc(key)}">
        ${!e.github
          ? `<span class="hint">No GitHub release tracked — use the download page above (often nightly/rolling).</span>`
          : latest === undefined
          ? `<span class="hint">Latest release unknown — press “Check latest releases”.</span>`
          : latest
            ? `<span class="tag">${esc(latest.tag || latest.name || 'release')}</span>
               <span>${esc(latest.published_at ? `published ${latest.published_at.slice(0, 10)}` : '')}</span>
               <a class="emu-notes" href="${esc(latest.url)}" target="_blank" rel="noreferrer">📄 release notes ↗</a>
               ${latest.assets?.length ? `
                 <span class="emu-assets">
                   <select class="select" data-asset="${esc(key)}" title="Pick the installer for your OS">
                     ${latest.assets.map((a) => `<option value="${esc(a.url)}">${esc(a.name)} (${fmtBytes(a.size)})</option>`).join('')}
                   </select>
                   ${authState.user?.role === 'admin' ? `<button class="btn btn-sm" data-save-release="${esc(key)}">Save to vault</button><button class="btn btn-sm emu-save-alt" data-save-release="${esc(key)}" title="Save to vault">Save to vault</button>` : ''}
                 </span>` : `<span class="hint">${(e.github && !latest.assets?.length) ? 'Latest release has no downloadable assets — use the download page above.' : ''}</span>`}
               ${vaulted.length ? `<span class="pill ok">in vault: ${vaulted.map((v) => esc(v.version || v.filename)).join(', ')}</span>` : ''}`
            : `<span class="hint">${esc(emuState.why[key] ? (/nightly\/rolling/.test(emuState.why[key]) ? `This project publishes ${emuState.why[key].replace(/^no published latest release \(|\)$/g, '')}: use the download page above.` : `Could not get the latest release: ${emuState.why[key]}. Press “Check latest releases” to try again, or use the download page above.`) : 'No GitHub release tracked — use the download page above (often nightly/rolling).')}</span>`}
        ${latest && emuState.why[key] ? `<span class="hint">(showing the last answer GitHub gave: ${esc(emuState.why[key])})</span>` : ''}
      </div>
    </div>`;
  }).join('');

  $$('[data-save-release]', wrap).forEach((btn) => btn.addEventListener('click', async () => {
    const key = btn.dataset.saveRelease;
    const sel = wrap.querySelector(`[data-asset="${CSS.escape(key)}"]`);
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const r = await api('/emulators/vault/from-release', {
        method: 'POST',
        body: JSON.stringify({ platform: key, asset: sel?.value || undefined })
      });
      toast(`Saved ${r.name} ${r.version || ''} to the vault`);
      const vault = await api('/emulators/vault');
      emuState.vault = vault.items || [];
      renderEmuGuide();
      renderEmuVault();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = 'Save to vault';
    }
  }));

  // Asset dropdowns also offer direct download of that exact release file.
  $$('[data-asset]', wrap).forEach((sel) => {
    const opt = document.createElement('option');
    opt.value = '__direct__';
    opt.textContent = '↯ or download directly';
    sel.appendChild(opt);
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm emu-dl';
    btn.textContent = 'Download';
    btn.addEventListener('click', () => {
      if (sel.value === '__direct__') return toast('Pick an exact asset from the list first', true);
      window.open(sel.value, '_blank', 'noopener');
    });
    sel.insertAdjacentElement('afterend', btn);
  });
}

function renderEmuVault() {
  const wrap = $('#emu-vault');
  if (!emuState.vault.length) {
    wrap.innerHTML = '<div class="side-empty">Vault is empty — upload an installer or save an official release above.</div>';
    return;
  }
  // Client-side search over name/version/OS/filename/platform. The vault is
  // small (tens of rows), so no server round-trip is needed.
  const q = ($('#emu-vault-q')?.value || '').trim().toLowerCase();
  const shown = !q ? emuState.vault : emuState.vault.filter((v) =>
    [v.name, v.version, v.os, v.arch, v.filename, v.platform_slug, v.notes]
      .filter(Boolean).some((s) => String(s).toLowerCase().includes(q)));
  if (!shown.length) {
    wrap.innerHTML = `<div class="side-empty">No vault entries match “${esc($('#emu-vault-q').value.trim())}”. <button class="link" id="emu-vault-clear">Clear search</button></div>`;
    $('#emu-vault-clear')?.addEventListener('click', () => { $('#emu-vault-q').value = ''; renderEmuVault(); });
    return;
  }
  wrap.innerHTML = shown.map((v) => `
    <div class="result-row ok emu-vault-row" data-vault="${v.id}">
      <span class="status"></span>
      <span class="name">${esc(v.name)}${v.version ? ` <span class="note">${esc(v.version)}</span>` : ''}${v.os ? ` <span class="note">· ${esc(v.os)}</span>` : ''}
        <br /><span class="note">${esc(v.filename)} · ${fmtBytes(v.size_bytes)} · ${esc(v.source)}${v.downloaded_at ? ` · saved ${esc(v.downloaded_at.slice(0, 10))}` : ''}${v.platform_slug ? ` · ${esc(v.platform_slug)}` : ''}${v.notes ? ` — ${esc(v.notes)}` : ''}</span></span>
      <span class="emu-vault-actions">
        <a class="btn btn-sm btn-primary" href="${esc(v.download_url)}">⤓ Download</a>
        ${authState.user?.role === 'admin' ? '<button class="btn btn-sm btn-danger" data-vault-del>Remove</button>' : ''}
      </span>
    </div>`).join('');
  $$('[data-vault-del]', wrap).forEach((btn) => btn.addEventListener('click', async () => {
    const id = Number(btn.closest('[data-vault]').dataset.vault);
    const ok = await confirmDialog({
      title: 'Remove this installer?',
      body: 'Deletes the vault entry and its stored file. Your ROMs are untouched.',
      okLabel: 'Remove',
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/emulators/vault/${id}`, { method: 'DELETE' });
      emuState.vault = emuState.vault.filter((v) => v.id !== id);
      renderEmuGuide();
      renderEmuVault();
      toast('Removed from vault');
    } catch (err) { toast(err.message, true); }
  }));
}

async function fetchEmuLatest({ force = false } = {}) {
  if (!emuState.guide.length) {
    const { items } = await api('/emulators/guide');
    emuState.guide = items || [];
  }
  // Sequential, not parallel: unauthenticated GitHub API calls are
  // rate-limited (60/hr/IP) and a 20-way burst burns the budget.
  for (const g of emuState.guide) {
    // Multi-system picks key off their explicit slug (retroarch), same as
    // renderEmuGuide — /latest resolves either through emulatorFor().
    const key = g.platforms[0] || g.slug;
    if (!g.github || (!force && emuState.latest[key])) continue;
    try {
      const r = await api(`/emulators/latest/${encodeURIComponent(key)}${force ? '?refresh=1' : ''}`);
      // An empty answer never wipes a good one the page already holds: keep it and say why it could not be refreshed.
      if (r.latest) { emuState.latest[key] = r.latest; emuState.why[key] = r.stale || ''; }
      else { emuState.latest[key] = emuState.latest[key] || null; emuState.why[key] = r.reason || 'no answer from GitHub'; }
    } catch (err) {
      emuState.latest[key] = emuState.latest[key] || null;
      emuState.why[key] = err.message || 'could not ask GitHub';
    }
    renderEmuGuide();
  }
  return emuState.latest;
}

$('#emu-refresh-latest')?.addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '↻ Checking…';
  try {
    await fetchEmuLatest({ force: true });
    toast('Latest releases checked');
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Check latest releases';
  }
});

$('#emu-upload-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  if (!fd.get('file')?.size) return toast('Choose a file first', true);
  if (!String(fd.get('platform_slug') || '').trim()) return toast('Pick the platform for this installer', true);
  const msg = $('#emu-upload-msg');
  if (msg) msg.textContent = 'Uploading…';
  try {
    const res = await fetch('/api/emulators/vault/upload', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    e.target.reset();
    if (msg) msg.textContent = 'Saved to vault.';
    const vault = await api('/emulators/vault');
    emuState.vault = vault.items || [];
    renderEmuGuide();
    renderEmuVault();
    toast(`Saved ${data.name} to the vault`);
  } catch (err) {
    if (msg) msg.textContent = '';
    toast(err.message, true);
  }
});

$('#emu-vault-q')?.addEventListener('input', () => renderEmuVault());

/* ─────────────────────────── account (legacy, unused) ─────────────────────────── */

async function loadAccount() {
  // The Account view no longer exists — replaced by the Settings hub. Keep the
  // function (referenced by old callers) as a no-op that routes to Settings.
  setView('settings');
}

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const pw = await api('/auth/password', {
      method: 'POST',
      body: JSON.stringify({
        current_password: fd.get('current_password'),
        new_password: fd.get('new_password')
      })
    });
    if (pw?.token) sessionStorage.setItem('gamesauce_token', pw.token); // the old sign-in was replaced
    e.target.reset();
    toast('Password updated — other devices signed out');
    loadSettings();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#revoke-others').addEventListener('click', async () => {
  try {
    await api('/auth/sessions', { method: 'DELETE' });
    toast('Other devices signed out');
    loadSettings();
  } catch (err) { toast(err.message, true); }
});

$('#new-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  if (authState.user?.role !== 'admin') return;
  try {
    await api('/auth/users', {
      method: 'POST',
      body: JSON.stringify({
        username: String(fd.get('username')).trim(),
        password: fd.get('password'),
        role: fd.get('role'),
        colour: fd.get('colour')
      })
    });
    e.target.reset();
    toast('User added');
    loadUsersForModule();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ─────────────────────────── boot ─────────────────────────── */

/* ─────────────────────────── welcome tour ─────────────────────────── */

/* A short set of cards the first time someone signs in: members set a password and a picture; the admin also sets up
 * providers, downloads the LaunchBox database and adds a first folder. Everything in it is also available in Settings,
 * so any card can be skipped, and "Run the welcome tour again" in My account brings it back. */
const WELCOME = { step: 0, cards: [], open: false };

function welcomeCards(isAdmin) {
  const cards = [
    { id: 'hello', title: isAdmin ? 'Welcome to game-sauce' : 'Welcome', body: () => `
        <p>${isAdmin
          ? 'This quick tour gets your library ready: your password and picture, where game details come from, and your first folder of games.'
          : 'This takes a minute: set your own password and, if you like, a picture. Then you are ready to browse.'}</p>
        <p class="hint">You can skip any step and find everything later in Settings (the gear next to your name).</p>` },
    { id: 'password', title: 'Choose your own password', body: () => `
        <form class="edit-form" id="wz-password" autocomplete="off">
          <label class="field"><span>Current password</span><input type="password" name="current_password" autocomplete="current-password" required /></label>
          <label class="field"><span>New password</span><input type="password" name="new_password" autocomplete="new-password" required /></label>
          <p class="hint pw-rule">At least 10 characters, with a letter and a number.</p>
          <div class="wz-row"><button class="btn btn-primary" type="submit">Change password</button><span class="hint" id="wz-password-msg"></span></div>
        </form>` },
    { id: 'picture', title: 'Add a picture', body: () => `
        <div class="profile-row">
          <div class="avatar avatar-lg" id="wz-avatar">?</div>
          <div>
            <p class="hint" style="margin-top:0">Shown next to your name. A JPEG, PNG or WebP up to 1 MB; it is shrunk before saving.</p>
            <button class="btn btn-primary" id="wz-pic-btn" type="button">Choose a picture</button>
            <input type="file" id="wz-pic-file" accept="image/jpeg,image/png,image/webp" class="hidden" />
            <span class="hint" id="wz-pic-msg"></span>
          </div>
        </div>` },
    { id: 'steam', title: 'Show your Steam games (optional)', body: () => `
        <p>If you use Steam, your own library can appear on the <b>Digital</b> page with your hours played. Only you see it, and nothing changes on Steam. You can skip this and do it later in Settings &rarr; My account &rarr; Steam.</p>
        <ol class="note dg-steps">
          <li>Get a Web API key at <b>steamcommunity.com/dev/apikey</b> (any domain name will do, e.g. <i>localhost</i>).</li>
          <li>Your 17-digit Steam ID (steamid.io shows it), or paste your <b>steamcommunity.com/profiles/&hellip;</b> link.</li>
          <li>In Steam: Profile &rarr; Edit profile &rarr; Privacy settings &rarr; <b>Game details</b> set to <b>Public</b>.</li>
        </ol>
        <form class="edit-form" id="wz-steam" autocomplete="off">
          <label class="field"><span>Steam ID or profile link</span><input type="text" name="steam_id" placeholder="76561197960287930" required /></label>
          <label class="field"><span>Web API key</span><input type="password" name="key" placeholder="32 letters and numbers" autocomplete="new-password" required /></label>
          <div class="wz-row"><button class="btn btn-primary" type="submit">Save and fetch my games</button><span class="hint" id="wz-steam-msg"></span></div>
        </form>` }
  ];
  if (isAdmin) {
    cards.push(
      { id: 'providers', title: 'Where game details come from', body: () => `
        <p>game-sauce looks games up in several places. <b>IGDB</b> is free and the best starting point; the others add coverage.</p>
        <form class="edit-form" id="wz-providers" autocomplete="off">
          <div class="wz-prov"><b>IGDB</b> <a href="https://api-docs.igdb.com/#getting-started" target="_blank" rel="noreferrer">get keys ↗</a>
            <div class="wz-two"><input name="IGDB_CLIENT_ID" placeholder="Client ID" /><input name="IGDB_CLIENT_SECRET" type="password" placeholder="Client secret" /></div></div>
          <div class="wz-prov"><b>TheGamesDB</b> <a href="https://thegamesdb.net/" target="_blank" rel="noreferrer">get a key ↗</a>
            <div class="wz-two"><input name="TGDB_API_KEY" type="password" placeholder="API key" /></div></div>
          <div class="wz-prov"><b>SteamGridDB</b> <span class="hint">(extra covers)</span> <a href="https://www.steamgriddb.com/profile/preferences/api" target="_blank" rel="noreferrer">get a key ↗</a>
            <div class="wz-two"><input name="SGDB_API_KEY" type="password" placeholder="API key" /></div></div>
          <p class="hint">Leave any you do not have blank. ScreenScraper needs a developer account and is set up later in Settings.</p>
          <div class="wz-row"><button class="btn btn-primary" type="submit">Save</button><span class="hint" id="wz-prov-msg"></span></div>
        </form>` },
      { id: 'launchbox', title: 'Download the LaunchBox database', body: () => `
        <p>A free game database that lives on this server. It needs no key, matches by exact name and is very quick. It is the best first step for finding your games, and it takes about a minute. It carries on in the background if you move to the next step.</p>
        <div id="wz-lb"></div>` },
      { id: 'source', title: 'Add your first folder of games', body: () => `
        <p>Point game-sauce at a folder of games for <b>one</b> console. Your files stay exactly where they are.</p>
        <form class="edit-form" id="wz-source" autocomplete="off">
          <label class="field"><span>Folder path on this server</span>
            <div class="wz-path"><input name="path" placeholder="/mnt/games/roms/ps2" required /><button class="btn" type="button" id="wz-browse">Browse…</button></div></label>
          <div class="wz-browser hidden" id="wz-browser">
            <div class="wz-bpath" id="wz-bpath"></div>
            <div class="wz-bdirs" id="wz-bdirs"></div>
            <div class="wz-row"><button class="btn btn-sm" type="button" id="wz-bup">↑ Up</button><button class="btn btn-sm btn-primary" type="button" id="wz-buse">Use this folder</button><button class="btn btn-sm btn-ghost" type="button" id="wz-bcancel">Cancel</button></div>
          </div>
          <label class="field"><span>Platform</span><select name="platform" id="wz-platform"></select></label>
          <div class="wz-row"><button class="btn btn-primary" type="submit">Add and scan</button><span class="hint" id="wz-src-msg"></span></div>
        </form>` }
    );
  }
  cards.push({ id: 'done', title: 'You are all set', body: () => `
      <p>${isAdmin ? 'Your library will fill in as games are found.' : 'Have a look around.'} Settings (the gear next to your name) has everything this tour covered, and you can run the tour again from <b>My account</b>.</p>` });
  return cards;
}

function closeWelcome() {
  clearTimeout(WELCOME.lbTimer);
  $('#welcome')?.remove();
  WELCOME.open = false;
}

async function finishWelcome(done = true) {
  closeWelcome();
  try { await api('/auth/welcomed', { method: 'POST', body: JSON.stringify({ done }) }); if (authState.user) authState.user.welcomed = done; } catch { /* the tour just shows again next time */ }
}

function startWelcome() {
  if (WELCOME.open || !authState.user) return;
  const isAdmin = authState.user.role === 'admin';
  WELCOME.cards = welcomeCards(isAdmin);
  WELCOME.step = 0;
  WELCOME.open = true;
  const el = document.createElement('div');
  el.id = 'welcome';
  el.className = 'modal-scrim';
  el.innerHTML = `<div class="modal wz" role="dialog" aria-modal="true" aria-labelledby="wz-title">
    <div class="wz-dots" id="wz-dots"></div>
    <h3 class="modal-title" id="wz-title"></h3>
    <div id="wz-body"></div>
    <div class="wz-nav">
      <button class="btn btn-ghost" id="wz-skip" type="button">Skip tour</button>
      <span class="wz-spacer"></span>
      <button class="btn" id="wz-back" type="button">← Back</button>
      <button class="btn btn-primary" id="wz-next" type="button">Next →</button>
    </div></div>`;
  document.body.append(el);
  $('#wz-skip', el).onclick = () => finishWelcome(true);
  $('#wz-back', el).onclick = () => { if (WELCOME.step > 0) { WELCOME.step--; paintWelcome(); } };
  $('#wz-next', el).onclick = () => {
    if (WELCOME.step >= WELCOME.cards.length - 1) return finishWelcome(true);
    WELCOME.step++; paintWelcome();
  };
  paintWelcome();
}

function paintWelcome() {
  const card = WELCOME.cards[WELCOME.step];
  const last = WELCOME.step === WELCOME.cards.length - 1;
  clearTimeout(WELCOME.lbTimer);
  $('#wz-title').textContent = card.title;
  $('#wz-body').innerHTML = card.body();
  $('#wz-dots').innerHTML = WELCOME.cards.map((c, i) => `<i class="${i === WELCOME.step ? 'on' : i < WELCOME.step ? 'past' : ''}"></i>`).join('');
  $('#wz-back').classList.toggle('hidden', WELCOME.step === 0);
  $('#wz-skip').classList.toggle('hidden', last);
  $('#wz-next').textContent = last ? 'Finish' : (WELCOME.step === 0 ? 'Start →' : 'Next →');
  const wire = { password: wirePasswordCard, picture: wirePictureCard, steam: wireSteamCard, providers: wireProvidersCard, launchbox: wireLaunchBoxCard, source: wireSourceCard }[card.id];
  if (wire) wire();
}

/** While a card is saving, the person cannot move on: Back / Next / Skip are locked and the message shows a spinner,
 *  so a save is never left unconfirmed. Always call wzBusy(false) when done (use try / finally). */
function wzBusy(on) {
  for (const id of ['#wz-next', '#wz-back', '#wz-skip']) { const b = $(id); if (b) b.disabled = on; }
  $('.modal.wz')?.classList.toggle('is-busy', on);
}
const wzSaying = (el, text) => { if (el) el.innerHTML = `<span class="spin" aria-hidden="true"></span>${esc(text)}`; };

function wirePasswordCard() {
  const form = $('#wz-password'), msg = $('#wz-password-msg');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    wzSaying(msg, 'Saving… this takes a few seconds');
    wzBusy(true);
    try {
      const res = await api('/auth/password', { method: 'POST', body: JSON.stringify({ current_password: fd.get('current_password'), new_password: fd.get('new_password') }) });
      if (res?.token) sessionStorage.setItem('gamesauce_token', res.token); // the old sign-in was replaced
      form.reset();
      msg.textContent = '✓ Password changed.';
      toast('Password changed');
      wzBusy(false);
      if (WELCOME.step < WELCOME.cards.length - 1) { WELCOME.step++; paintWelcome(); }   // on to the next card, as if Next had been pressed (Enter in the box does this too)
      return;
    } catch (err) { msg.textContent = ''; toast(err.message, true); }
    finally { wzBusy(false); }
  };
}

function wireSteamCard() {
  const form = $('#wz-steam'), msg = $('#wz-steam-msg');
  form.onsubmit = async (e) => {
    e.preventDefault();
    wzSaying(msg, 'Saving…'); wzBusy(true);
    try {
      await api('/digital/steam', { method: 'PUT', body: JSON.stringify({ steam_id: form.steam_id.value, key: form.key.value }) });
      wzSaying(msg, 'Fetching your games…');
      const r = await api('/digital/steam/sync', { method: 'POST' });
      form.key.value = '';
      msg.textContent = `✓ ${r.count.toLocaleString()} games found. They are on the Digital page.`;
    } catch (err) { msg.textContent = ''; toast(err.message, true); }
    finally { wzBusy(false); }
  };
}

function wirePictureCard() {
  const u = authState.user;
  paintAvatar($('#wz-avatar'), u.id, u.display_name || u.username, u.avatar_v);
  const file = $('#wz-pic-file');
  $('#wz-pic-btn').onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    wzSaying($('#wz-pic-msg'), 'Uploading…');
    wzBusy(true);
    try {
      const fd = new FormData();
      fd.append('avatar', await shrinkImage(f), 'avatar.jpg');
      const data = await api('/auth/avatar', { method: 'POST', body: fd });
      u.avatar_v = data.avatar_v;
      paintAvatar($('#wz-avatar'), u.id, u.display_name || u.username, data.avatar_v);
      paintAvatar($('#user-avatar'), u.id, u.display_name || u.username, data.avatar_v);
      $('#wz-pic-msg').textContent = '✓ Saved.';
    } catch (err) { $('#wz-pic-msg').textContent = ''; toast(err.message, true); }
    finally { wzBusy(false); }
  };
}

function wireProvidersCard() {
  const form = $('#wz-providers'), msg = $('#wz-prov-msg');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fields = {};
    for (const [k, v] of new FormData(form).entries()) if (String(v).trim()) fields[k] = String(v).trim();
    if (!Object.keys(fields).length) { msg.textContent = 'Nothing to save: fill in at least one, or press Next to skip.'; return; }
    wzSaying(msg, 'Saving…');
    wzBusy(true);
    try {
      const res = await api('/metadata/providers', { method: 'PUT', body: JSON.stringify({ fields }) });
      form.reset();
      msg.textContent = res.rejected?.length ? `Saved; ${res.rejected.length} field(s) refused.` : '✓ Saved. You can test them later in Settings.';
    } catch (err) { msg.textContent = ''; toast(err.message, true); }
    finally { wzBusy(false); }
  };
}

async function wireLaunchBoxCard() {
  const box = $('#wz-lb');
  if (!box) return;
  let s;
  try { s = await api('/metadata/launchbox'); } catch (err) { box.innerHTML = `<p class="hint">${esc(err.message)}</p>`; return; }
  if (!$('#wz-lb')) return;
  const running = s.job.state === 'downloading' || s.job.state === 'importing';
  box.innerHTML = running
    ? `<div class="lb-progress"><span class="spin" aria-hidden="true"></span><span class="lb-msg">${esc(s.job.message || 'Working…')}</span><div class="lb-bar"><i style="width:${Number(s.job.pct) || 0}%"></i></div><b>${Number(s.job.pct) || 0}%</b></div>`
    : s.available
      ? `<p class="provider-banner is-ok">Ready: ${esc(s.games.toLocaleString())} games indexed. Nothing more to do here.</p>`
      : `${s.job.state === 'error' ? `<p class="provider-banner is-warn">${esc(s.job.message)}</p>` : ''}<button class="btn btn-primary" id="wz-lb-go" type="button">Download database (about 110 MB)</button>`;
  $('#wz-lb-go')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.innerHTML = '<span class="spin" aria-hidden="true"></span>Starting…';
    try { await api('/metadata/launchbox/update', { method: 'POST' }); } catch (err) { toast(err.message, true); }
    wireLaunchBoxCard();
  });
  if (running) WELCOME.lbTimer = setTimeout(() => { if ($('#wz-lb')) wireLaunchBoxCard(); }, 2000);
}

async function wireSourceCard() {
  const sel = $('#wz-platform');
  try {
    const { items } = await api('/platforms');
    window.__platformsCache = items;
    sel.innerHTML = platformOptions();
  } catch { /* the list stays empty; the message below says so */ }
  const form = $('#wz-source'), msg = $('#wz-src-msg'), browser = $('#wz-browser');
  const guess = () => { const slug = platformForFolder(form.path.value); if (slug && [...sel.options].some((o) => o.value === slug)) sel.value = slug; };
  form.path.addEventListener('input', guess);

  // Folder browser: the same server-side listing the Sources page uses, drawn inside the card.
  let here = null, parent = null;
  const browse = async (p) => {
    try {
      const data = await api(`/sources/browse${p ? `?path=${encodeURIComponent(p)}` : ''}`);
      here = data.path; parent = data.parent;
      $('#wz-bpath').textContent = data.path;
      $('#wz-bdirs').innerHTML = data.dirs.length
        ? data.dirs.map((d) => `<button type="button" class="browser-dir" data-dir="${esc(d.path)}"><span aria-hidden="true">🗀</span><span class="browser-dir-name">${esc(d.name)}</span><span class="browser-dir-go">›</span></button>`).join('')
        : '<div class="side-empty">No subfolders here: use this folder as it is.</div>';
      $$('#wz-bdirs .browser-dir').forEach((b) => { b.onclick = () => browse(b.dataset.dir); });
      $('#wz-bup').disabled = !parent;
      browser.classList.remove('hidden');
    } catch (err) { toast(err.message, true); }
  };
  $('#wz-browse').onclick = () => browse(form.path.value.trim() || null);
  $('#wz-bup').onclick = () => { if (parent) browse(parent); };
  $('#wz-bcancel').onclick = () => browser.classList.add('hidden');
  $('#wz-buse').onclick = () => { if (here) { form.path.value = here; guess(); } browser.classList.add('hidden'); };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const path = form.path.value.trim();
    if (!path || !sel.value) return;
    wzSaying(msg, 'Adding…');
    wzBusy(true);
    let created;
    try {
      created = await api('/sources', { method: 'POST', body: JSON.stringify({ path, platform_hint: sel.value, recursive: true }) });
    } catch (err) { msg.textContent = ''; toast(err.message, true); wzBusy(false); return; }
    // The folder is added; the scan can take minutes on a big collection, so it carries on in the background.
    wzBusy(false);
    msg.textContent = `✓ Added ${created.name}. Scanning in the background: you can carry on.`;
    form.reset();
    api(`/sources/${created.id}/scan`, { method: 'POST', body: JSON.stringify({ enrich: true }) })
      .then((r) => { toast(`${r.added} games found in ${created.name}`); loadPlatforms(); loadLibrary(); })
      .catch((err) => toast(err.message, true));
  };
}

(async function boot() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.authenticated) showApp(data.user, { restore: true });
    else { clearNav(); showLogin(); }
  } catch {
    showLogin('Cannot reach the server.');
  }
})();
