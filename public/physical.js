// Physical: the games on your shelf that have no ROM behind them (boxed discs and cartridges), kept by hand or from a CSV.
// Two ways to look at them: the Library's tiles, or a shelf with the games' spines showing. Platform chips, the details window and the
// metadata match all work like the Library's. Each person has their own shelf.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

import { platformSelect, identifyBlock, wireIdentify } from './identify.js';
import { platformBadge, familyName, familyLabel } from './platform-names.js';

let ctx = null;
const S = {
  platforms: [], picked: [], family: null, q: '', sort: 'title', fav: false, nocover: false, unmatched: false, spine: false, letter: '',
  view: 'tiles', density: 'comfortable', items: [], byId: new Map(), counts: { total: 0, favourites: 0, nocover: 0, unmatched: 0, spines: 0 },
  shapes: new Map(), openId: null, jobWas: false, jobTimer: null, tilesShown: 80, rows: [], rowsShown: 0, rowOf: new Map(), packW: 0, obs: null, token: 0
};
const store = {
  get(k, d) { try { return localStorage.getItem('gamesauce_ph_' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gamesauce_ph_' + k, v); } catch { /* storage unavailable */ } }
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Number(v || 0).toLocaleString();
const hex = (c, d = '#6b7280') => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d);
const chipSort = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const initials = (t) => String(t).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const platOf = (slug) => S.platforms.find((p) => p.slug === slug) || (window.__platformsCache || []).find((p) => p.slug === slug) || { slug, name: slug, short_name: slug };
const accentOf = (slug) => hex(platOf(slug).accent, hex(platOf(slug).family_colour));
const famColourOf = (family) => hex((window.__platformsCache || []).find((p) => (p.family || 'Others') === family)?.family_colour);

export function initPhysical(c) {
  ctx = c;
  S.view = store.get('view', 'tiles') === 'shelf' ? 'shelf' : 'tiles';
  S.density = store.get('density', 'comfortable') === 'compact' ? 'compact' : 'comfortable';
  const view = $('#view-physical'); if (!view || view.dataset.ready) return;
  view.dataset.ready = '1';
  view.addEventListener('click', onClick);
  for (const t of ['load', 'error']) $('#ph-shelf')?.addEventListener(t, onSpineLoad, true);   // load and error do not bubble: caught on the way down
  let t; $('#ph-q')?.addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value.trim(); S.letter = ''; load(); }, 200); });
  $('#ph-sort')?.addEventListener('change', (e) => { S.sort = e.target.value; S.letter = ''; load(); });
  let rt; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (S.view === 'shelf' && !view.classList.contains('hidden') && Math.abs(shelfWidth() - S.packW) > 8) renderShelf(); }, 160); }).observe($('#ph-scroll'));
}

export const isOpen = () => S.openId != null;
export const openIdNow = () => S.openId;
export function reset() { Object.assign(S, { picked: [], family: null, q: '', sort: 'title', fav: false, nocover: false, unmatched: false, spine: false, letter: '' }); const q = $('#ph-q'); if (q) q.value = ''; const s = $('#ph-sort'); if (s) s.value = 'title'; }
export function forgetOpen() { S.openId = null; $$('.ph-card.nav-current, .ph-spine.is-open').forEach((e) => e.classList.remove('nav-current', 'is-open')); slideShelfBack(); }

/* ───────────── loading ───────────── */

export async function load(keep = false) {
  const token = ++S.token;
  if (!keep) { S.tilesShown = 80; S.rowsShown = 0; }
  const msg = $('#ph-msg');
  let info;
  try { info = await ctx.api('/physical'); } catch (err) { msg.textContent = err.message; return; }
  if (token !== S.token) return;
  S.platforms = info.platforms; S.counts = info.counts;
  // A platform picked earlier that no longer has games (the last one was removed) is dropped from the picks.
  S.picked = S.picked.filter((s) => S.platforms.some((p) => p.slug === s));
  const params = new URLSearchParams({ sort: S.sort });
  if (S.picked.length) params.set('platforms', S.picked.join(','));
  if (S.q) params.set('q', S.q); if (S.fav) params.set('favourites', '1'); if (S.nocover) params.set('nocover', '1'); if (S.unmatched) params.set('unmatched', '1'); if (S.spine) params.set('spine', '1'); if (S.letter) params.set('letter', S.letter);
  let list;
  try { list = await ctx.api('/physical/games?' + params); } catch (err) { msg.textContent = err.message; return; }
  if (token !== S.token) return;
  S.items = list.items; S.byId = new Map(list.items.map((g) => [g.id, g]));
  renderChips(); paintLetters(list.letters); paintToolbar();
  const job = info.match_job || {};
  msg.innerHTML = job.running ? `<div class="dg-note">Looking up details and covers: ${n(job.done)} of ${n(job.total)} done. They appear as they are found.</div>` : '';
  watchJob(job);
  const empty = $('#ph-empty'), scroll = $('#ph-scroll');
  renderHeading(list.total);
  $('#ph-bar').classList.toggle('hidden', !S.counts.total);
  $('#ph-az').classList.toggle('hidden', !S.counts.total);
  if (!S.counts.total) {
    scroll.classList.add('hidden');
    empty.classList.remove('hidden');
    empty.innerHTML = `<div class="empty"><h2>Your shelf is empty</h2><p>Catalogue the games you own on disc or cartridge: add one by hand, or bring a whole list in from a CSV. Covers and details are looked up for you, and you can match any game by hand.</p>
      <div class="dg-actions"><button class="btn btn-primary" data-ph-act="add">Add a game</button><button class="btn" data-ph-act="import">Import a CSV</button></div></div>`;
    return;
  }
  scroll.classList.remove('hidden');
  if (!list.total) {
    empty.classList.remove('hidden');
    empty.innerHTML = '<div class="empty"><h2>No games match</h2><p>Try clearing the search or a filter.</p></div>';
    $('#ph-tiles').innerHTML = ''; $('#ph-shelf').innerHTML = ''; return;
  }
  empty.classList.add('hidden');
  const keepTop = keep ? scroll.scrollTop : 0;
  if (S.view === 'shelf') renderShelf(); else renderTiles(true);
  scroll.scrollTop = keepTop;
  if (S.openId != null) markCurrent(false);
}

/* While the background lookup runs the page only watches its progress; when it ends the list is drawn again so the covers show. */
function watchJob(job) {
  clearTimeout(S.jobTimer);
  if (job.running) {
    S.jobWas = true;
    S.jobTimer = setTimeout(async () => {
      if ($('#view-physical')?.classList.contains('hidden')) return;
      try {
        const info = await ctx.api('/physical'), j = info.match_job || {};
        if (j.running) { $('#ph-msg').innerHTML = `<div class="dg-note">Looking up details and covers: ${n(j.done)} of ${n(j.total)} done. They appear as they are found.</div>`; watchJob(j); }
        else load(true);
      } catch { /* the next visit loads again */ }
    }, 4000);
  } else if (S.jobWas) { S.jobWas = false; }
}

/* ───────────── the heading above the games: platform logo (or a dot), name, how many, and a way back to every platform (as in the Library) ───────────── */
function renderHeading(total) {
  const box = $('#ph-heading'); if (!box) return;
  if (!S.counts.total) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const cache = window.__platformsCache || [], count = `${n(total)} ${total === 1 ? 'game' : 'games'}`;
  box.classList.remove('hidden');
  if (!S.picked.length) { box.innerHTML = `<span class="lib-dot" style="background:var(--accent)"></span><h2>All platforms</h2><span class="lib-total">${count}</span>`; return; }
  const row = (s) => cache.find((x) => x.slug === s) || platOf(s);
  const first = row(S.picked[0]), fam = first.family;
  const sameFam = S.picked.length > 1 && S.picked.every((s) => row(s).family === fam);
  const famAll = S.platforms.filter((p) => p.family === fam).map((p) => p.slug);
  const wholeFam = S.picked.length > 1 && famAll.length === S.picked.length && famAll.every((s) => S.picked.includes(s));
  const logo = S.picked.length === 1 && first.logo_v ? `<span class="lib-logo${first.logo_plate ? ' on-plate' : ''}"><img src="/api/platforms/${encodeURIComponent(first.slug)}/logo?v=${first.logo_v}" alt="" onerror="this.remove()" /></span>`
    : sameFam && first.family_logo_v ? `<span class="lib-logo${first.family_logo_plate ? ' on-plate' : ''}"><img src="/api/platforms/families/logo?family=${encodeURIComponent(fam)}&v=${first.family_logo_v}" alt="" onerror="this.remove()" /></span>` : '';
  const dot = S.picked.length > 1 && sameFam ? (first.family_colour || 'var(--accent)') : accentOf(first.slug);
  const names = S.picked.map((s) => row(s).name || s);
  const name = wholeFam ? `${fam} (all platforms)` : names.length > 3 ? `${names.length} platforms` : names.join(' + ');
  box.innerHTML = `${logo || `<span class="lib-dot" style="background:${esc(dot)}"></span>`}<h2>${esc(name)}</h2><span class="lib-total">${count}</span>
    <button type="button" class="btn btn-sm btn-ghost lib-clear" data-ph-clear title="Show every platform again">✕ All platforms</button>`;
}

/* ───────────── toolbar, chips, letters ───────────── */

function paintToolbar() {
  const c = S.counts;
  $('#ph-toggles').innerHTML = `
    <button type="button" class="ph-pill${S.fav ? ' on' : ''}" data-ph-toggle="fav" title="Favourites: only your favourites (${n(c.favourites)})">★ Favourites <small>${n(c.favourites)}</small></button>
    <button type="button" class="ph-pill${S.nocover ? ' on' : ''}" data-ph-toggle="nocover" title="No cover: games with no cover picture yet (${n(c.nocover)})">▢ No cover <small>${n(c.nocover)}</small></button>
    <button type="button" class="ph-pill${S.unmatched ? ' on' : ''}" data-ph-toggle="unmatched" title="Needs match: games no provider has matched, the worklist for matching by hand (${n(c.unmatched)})">○ Needs match <small>${n(c.unmatched)}</small></button>
    <button type="button" class="ph-pill${S.spine ? ' on' : ''}" data-ph-toggle="spine" title="With spine art: games that have a real spine picture for the shelf (${n(c.spines)})">▯ With spine art <small>${n(c.spines)}</small></button>`;
  // The three look buttons beside the A-Z row: two grid sizes (tiles) and the shelf; the lit one is the look in use.
  $$('[data-ph-density]').forEach((b) => b.classList.toggle('is-on', S.view === 'tiles' && b.dataset.phDensity === S.density));
  $$('[data-ph-view="shelf"]').forEach((b) => b.classList.toggle('is-on', S.view === 'shelf'));
  const anyFilter = S.picked.length || S.q || S.fav || S.nocover || S.unmatched || S.spine || S.letter;
  $('#ph-reset')?.classList.toggle('hidden', !anyFilter);
}

const picked = () => new Set(S.picked);
function renderChips() {
  const host = $('#ph-chips'); if (!host) return;
  if (!S.platforms.length) { host.innerHTML = ''; return; }
  const fams = new Map();
  for (const p of S.platforms) { const f = p.family || 'Others'; if (!fams.has(f)) fams.set(f, []); fams.get(f).push(p); }
  const order = [...fams.keys()].sort(chipSort);
  const pk = picked();
  const famSlugs = (f) => fams.get(f).map((p) => p.slug);
  const wholeNow = S.family && fams.has(S.family) && famSlugs(S.family).length > 1 && famSlugs(S.family).every((s) => pk.has(s)) && pk.size === famSlugs(S.family).length;
  if (S.family && !fams.has(S.family)) S.family = null;
  const total = S.platforms.reduce((t, p) => t + p.count, 0);
  const famCount = (f) => fams.get(f).reduce((t, p) => t + p.count, 0);
  const famState = (f) => { const sl = famSlugs(f); const k = sl.filter((s) => pk.has(s)).length; return k === 0 ? '' : k === sl.length ? ' on whole' : ' on part'; };
  host.innerHTML = `
    <div class="ph-chip-row" role="tablist">
      <button type="button" class="ph-chip${pk.size === 0 ? ' on' : ''}" data-ph-chip-all title="All platforms">All <small>${n(total)}</small></button>
      ${order.map((f) => `<button type="button" class="ph-chip${S.family === f ? ' open' : ''}${famState(f)}" data-ph-chip-fam="${esc(f)}" style="--chip-c:${famColourOf(f)}" aria-expanded="${S.family === f}" title="${esc(familyName(f))}: show its platforms">${esc(familyLabel(f))} <small>${n(famCount(f))}</small></button>`).join('')}
    </div>
    ${S.family ? `<div class="ph-chip-row ph-chip-plats">${fams.get(S.family).sort((a, b) => chipSort(a.name, b.name)).map((p) => `<button type="button" class="ph-chip plat${pk.has(p.slug) && !wholeNow ? ' on' : ''}" data-ph-chip-plat="${esc(p.slug)}" style="--chip-c:${accentOf(p.slug)}" title="${esc(p.name)}: click to ${pk.has(p.slug) && !wholeNow ? 'turn off' : 'turn on'}"><span>${esc(platformBadge(p))}</span> <small>${n(p.count)}</small></button>`).join('')}</div>` : ''}`;
}

function chipClick(e) {
  const all = e.target.closest('[data-ph-chip-all]'), fam = e.target.closest('[data-ph-chip-fam]'), pl = e.target.closest('[data-ph-chip-plat]');
  if (!all && !fam && !pl) return false;
  const famSlugs = (f) => S.platforms.filter((p) => (p.family || 'Others') === f).map((p) => p.slug);
  if (all) { S.family = null; S.picked = []; }
  else if (fam) {
    // A family chip selects the whole family and shows its platforms; clicking it again clears the selection (as in the Library).
    const f = fam.dataset.phChipFam, slugs = famSlugs(f);
    const whole = slugs.length && S.picked.length === slugs.length && slugs.every((s) => S.picked.includes(s));
    if (whole) { S.family = null; S.picked = []; } else { S.family = f; S.picked = slugs; }
  } else {
    const slug = pl.dataset.phChipPlat;
    const fs = famSlugs(platOf(slug).family || 'Others');
    const wholeFamily = fs.length > 1 && S.picked.length === fs.length && fs.every((s) => S.picked.includes(s));
    S.picked = wholeFamily ? [slug] : S.picked.includes(slug) ? S.picked.filter((x) => x !== slug) : [...S.picked, slug];
  }
  S.letter = '';
  const sc = $('#ph-scroll'); if (sc) sc.scrollTop = 0;
  load();
  return true;
}

const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
function paintLetters(counts = {}) {
  const box = $('#ph-letters'); if (!box) return;
  const on = S.sort === 'title' || S.sort === '-title';
  box.classList.toggle('off', !on);
  box.innerHTML = on ? LETTERS.map((l) => `<button type="button" class="az-l${S.letter === l ? ' on' : ''}" data-ph-letter="${l}"${counts[l] ? '' : ' disabled'} title="${counts[l] ? l + ': ' + n(counts[l]) + ' games' : 'No games under ' + l}">${l}</button>`).join('') : '';
}

/* ───────────── clicks ───────────── */

function onClick(e) {
  if (chipClick(e)) return;
  const lt = e.target.closest('[data-ph-letter]');
  if (lt && !lt.disabled) { S.letter = S.letter === lt.dataset.phLetter ? '' : lt.dataset.phLetter; load(); return; }
  const tg = e.target.closest('[data-ph-toggle]');
  if (tg) { const k = tg.dataset.phToggle; S[k] = !S[k]; S.letter = ''; load(); return; }
  const vw = e.target.closest('[data-ph-view]'), dn = e.target.closest('[data-ph-density]');
  if (vw || dn) {
    if (dn) { S.density = dn.dataset.phDensity; store.set('density', S.density); }
    const next = vw ? 'shelf' : 'tiles';
    store.set('view', next);
    const changed = next !== S.view; S.view = next; paintToolbar();
    if (!S.items.length) return;
    if (changed) { const sc = $('#ph-scroll'); if (S.view === 'shelf') renderShelf(); else renderTiles(true); sc.scrollTop = 0; if (S.openId != null) markCurrent(true); }
    else $('#ph-tiles').classList.toggle('compact', S.density === 'compact');
    return;
  }
  if (e.target.closest('#ph-top')) { $('#ph-scroll').scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (e.target.closest('#ph-reset')) { reset(); load(); return; }
  if (e.target.closest('[data-ph-clear]')) { S.family = null; S.picked = []; S.letter = ''; load(); return; }
  const act = e.target.closest('[data-ph-act]');
  if (act) { const a = act.dataset.phAct; if (a === 'add') openAdd(); else if (a === 'import') openImport(); else if (a === 'lookup') lookupAgain(act); return; }
  const fav = e.target.closest('[data-ph-fav]');
  if (fav) { e.stopPropagation(); toggleFav(Number(fav.dataset.phFav)); return; }
  const tile = e.target.closest('[data-ph-id]');
  if (tile) openDetail(Number(tile.dataset.phId));
}

async function toggleFav(id) {
  const g = S.byId.get(id); if (!g) return;
  try { await ctx.api(`/physical/games/${id}`, { method: 'PATCH', body: JSON.stringify({ favourite: !g.favourite }) }); } catch (err) { ctx.toast(err.message, true); return; }
  await load(true);
  if (S.openId === id) openDetail(id);
}

async function lookupAgain(btn) {
  btn.disabled = true;
  try {
    const j = await ctx.api('/physical/match', { method: 'POST', body: JSON.stringify({ retry: true }) });
    ctx.toast(j.running ? `Looking up ${n(j.total)} games` : 'Every game already has its details');
  } catch (err) { ctx.toast(err.message, true); } finally { btn.disabled = false; load(true); }
}

/* ───────────── tiles ───────────── */

const tileHtml = (g) => {
  const col = accentOf(g.platform), p = platOf(g.platform);
  return `<div class="card ph-card" data-ph-id="${g.id}" tabindex="0" role="button" aria-label="${esc(g.title)}, ${esc(p.name)}">
    <div class="card-cover" style="background:linear-gradient(160deg,${col},#12141a)">
      <div class="card-fallback${g.has_cover ? ' has-cover' : ''}">${esc(initials(g.title))}</div>
      ${g.cover_url ? `<img loading="lazy" src="${esc(g.cover_url)}" alt="" onerror="this.style.display='none';this.previousElementSibling?.classList.remove('has-cover')" />` : ''}
      <span class="card-badge ph-badge" style="background:${esc(col)}" title="${esc(p.name)}"><span class="dg-badge-txt">${esc(platformBadge(p))}</span></span>
      <button type="button" class="card-fav ${g.favourite ? 'on' : ''}" data-ph-fav="${g.id}" tabindex="-1" title="${g.favourite ? 'Remove from favourites' : 'Add to favourites'}" aria-label="Favourite">${g.favourite ? ctx.ICON.starFill : ctx.ICON.star}</button>
    </div>
    <div class="card-title">${esc(g.title)}${g.region ? ` <span class="ph-region">${esc(g.region)}</span>` : ''}</div>
  </div>`;
};

function renderTiles(reset) {
  $('#ph-shelf').classList.add('hidden'); $('#ph-shelf').innerHTML = ''; slideShelfBack();
  const grid = $('#ph-tiles'); grid.classList.remove('hidden'); grid.classList.toggle('compact', S.density === 'compact');
  if (reset) { grid.innerHTML = ''; S.tilesRendered = 0; }
  grid.querySelector('.ph-sentinel')?.remove();
  const target = Math.min(S.items.length, Math.max(S.tilesShown, S.tilesRendered || 0));
  if (target > (S.tilesRendered || 0)) grid.insertAdjacentHTML('beforeend', S.items.slice(S.tilesRendered || 0, target).map(tileHtml).join(''));
  S.tilesRendered = target; S.tilesShown = target;
  S.obs?.disconnect();
  if (target < S.items.length) {
    const s = document.createElement('div'); s.className = 'ph-sentinel'; s.style.cssText = 'grid-column:1/-1;height:1px'; grid.appendChild(s);
    S.obs = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { S.tilesShown = S.tilesRendered + 80; renderTiles(false); } }, { root: $('#ph-scroll'), rootMargin: '800px' });
    S.obs.observe(s);
  }
}

/* ───────────── the shelf ─────────────
   Each game is a spine: coloured by its platform (a touch lighter or darker per game), with the platform's name on a band at the top and the
   title running down it. Games are packed onto shelves to fit the width. Opening a game pulls its spine off the shelf and turns it to show the
   cover, and the spines beside it slide apart to make room; stepping to the next game slides one back in and pulls the next one out.
   With the list sorted by platform each platform starts with a small brass plate. */

// Games in the same kind of case stand the same size, as on a real shelf: Wii, Wii U, Xbox, Xbox 360, GameCube and PS2 all share the DVD case, and a Switch
// case is shorter and thinner. A CASE is [height in mm, spine thickness as a share of the height]: rough real sizes, easy to adjust. A platform that is in no
// case below stands as its own kind, at the default size. Where games in a kind of case have spine pictures, the thickness is the median shape of those pictures
// (pooled across the platforms that share the case), so the art fits exactly and nothing is stretched.
// PlayStation and Xbox Blu-ray cases are the same height; the PlayStation ones are a little thicker.
const CASES = { dvd: [190, 0.074], psbd: [172, 0.081], xbbd: [172, 0.07], switch: [170, 0.062], jewel: [125, 0.08] };
const PLATFORM_CASE = {
  wii: 'dvd', wiiu: 'dvd', xbox: 'dvd', xbox360: 'dvd', gamecube: 'dvd', ps2: 'dvd',
  ps3: 'psbd', ps4: 'psbd', ps5: 'psbd', xboxone: 'xbbd', xboxseries: 'xbbd',
  switch: 'switch', switch2: 'switch',
  ps1: 'jewel', saturn: 'jewel', dreamcast: 'jewel'
};
const caseOf = (slug) => PLATFORM_CASE[slug] || `own:${slug}`;
const BOX_DEFAULT = [190, 0.08], PX_PER_MM = 1.2, SPINE_ART_MIN = 8, SPINE_ART_MAX = 56, OPEN_DEFAULT_AR = 0.7, MIN_SAMPLES = 3;
// SLACK is the room kept at the end of each row for the one pulled-out game, whose cover is wider than its spine.
const SPINE_GAP = 3, PLATE_W = 74, SLACK = 170, ROWS_AT_A_TIME = 4;
const shelfWidth = () => Math.max(260, ($('#ph-scroll')?.clientWidth || 800) - 56);

/** The median spine shape (width / height) of the spine pictures in each kind of case, for kinds with at least a few. */
function spineShapes(platforms) {
  const by = new Map();
  for (const p of platforms) for (const ar of p.spine_ars || []) if (Number(ar) > 0) { const k = caseOf(p.slug); if (!by.has(k)) by.set(k, []); by.get(k).push(Number(ar)); }
  const out = new Map();
  for (const [slug, list] of by) if (list.length >= MIN_SAMPLES) { list.sort((a, b) => a - b); out.set(slug, list[Math.floor(list.length / 2)]); }
  return out;
}

function spineOf(g, i) {
  const h = hash(g.title + g.platform);
  const [mm, share] = CASES[PLATFORM_CASE[g.platform]] || BOX_DEFAULT;
  const ht = Math.round(mm * PX_PER_MM);
  const w = Math.round(Math.min(SPINE_ART_MAX, Math.max(SPINE_ART_MIN, ht * (S.shapes.get(caseOf(g.platform)) || share))) * 2) / 2;
  const shade = ((h >>> 7) % 7) - 3;   // -3 .. 3: darker .. lighter, so a run of one platform is not a flat block of colour
  const ow = Math.round(ht * (Number(g.cover_ar) || OPEN_DEFAULT_AR));   // pulled out, the spine turns into the whole cover at the cover's own shape
  return { g, w, ht, shade, ow, i };
}

function buildRows() {
  const width = shelfWidth(); S.packW = width;
  S.shapes = spineShapes(S.platforms);   // the whole shelf, not the filtered list
  const items = []; let lastPlat = null;
  for (const g of S.items) {
    if (S.sort === 'platform' && g.platform !== lastPlat) { items.push({ plate: platOf(g.platform) }); lastPlat = g.platform; }
    items.push(spineOf(g));
  }
  const rows = []; let cur = [], used = 0;
  for (const it of items) {
    const w = (it.plate ? PLATE_W : it.w) + SPINE_GAP;
    if (cur.length && used + w > width - SLACK) { rows.push(cur); cur = []; used = 0; }
    cur.push(it); used += w;
  }
  if (cur.length) rows.push(cur);
  S.rows = rows; S.rowOf = new Map();
  rows.forEach((r, ri) => r.forEach((it) => { if (it.g) S.rowOf.set(it.g.id, ri); }));
}

function spineHtml(it, k) {
  const { g, w, ht, shade, ow } = it, col = accentOf(g.platform), p = platOf(g.platform);
  const tone = shade < 0 ? `color-mix(in srgb, ${col} ${100 + shade * 9}%, #000)` : shade > 0 ? `color-mix(in srgb, ${col} ${100 - shade * 9}%, #fff)` : col;
  const art = g.has_spine ? `<img class="ph-sp-art" alt="" loading="lazy" src="${esc(g.spine_url)}" />` : '';
  return `<button type="button" class="ph-spine${g.favourite ? ' is-fav' : ''}${g.has_spine ? ' has-art' : ''}" data-ph-id="${g.id}" style="--w:${w}px;--h:${ht}px;--ow:${ow}px;--c:${esc(tone)};--i:${Math.min(k, 40)}" title="${esc(g.title)} · ${esc(p.name)}${g.region ? ' · ' + esc(g.region) : ''}" aria-label="${esc(g.title)}, ${esc(p.name)}">
    <span class="ph-sp-band">${esc(platformBadge(p))}</span>
    <span class="ph-sp-title">${esc(g.title)}</span>
    <span class="ph-sp-foot">${g.favourite ? '★' : ''}</span>
    ${art}
    <span class="ph-face" aria-hidden="true"><span class="ph-face-fb">${esc(g.title)}</span></span>
  </button>`;
}
const rowHtml = (row, ri) => `<div class="ph-row" data-row="${ri}"><div class="ph-books">${row.map((it, k) => it.plate
  ? `<span class="ph-plate" style="--c:${accentOf(it.plate.slug)};--i:${Math.min(k, 40)}" title="${esc(it.plate.name)}"><b>${esc(platformBadge(it.plate))}</b></span>`
  : spineHtml(it, k)).join('')}</div><div class="ph-plank"></div></div>`;

/* A spine picture arrived: it is shown and the drawn text steps aside. One that cannot be loaded is dropped, and that game keeps its drawn spine. */
function onSpineLoad(e) {
  const img = e.target;
  if (!img?.classList?.contains('ph-sp-art')) return;
  const spine = img.closest('.ph-spine'); if (!spine) return;
  if (e.type === 'error' || !img.naturalWidth || !img.naturalHeight) { img.remove(); spine.classList.remove('has-art'); return; }
  spine.classList.add('art-ok');
}

function renderShelf(upTo = 0) {
  $('#ph-tiles').classList.add('hidden'); $('#ph-tiles').innerHTML = '';
  S.obs?.disconnect();
  const host = $('#ph-shelf'); host.classList.remove('hidden');
  buildRows();
  host.innerHTML = ''; S.rowsShown = 0;
  drawRows(Math.max(ROWS_AT_A_TIME, upTo + 1));
}
function drawRows(count) {
  const host = $('#ph-shelf'); host.querySelector('.ph-sentinel')?.remove();
  const to = Math.min(S.rows.length, Math.max(count, S.rowsShown));
  if (to > S.rowsShown) host.insertAdjacentHTML('beforeend', S.rows.slice(S.rowsShown, to).map((r, k) => rowHtml(r, S.rowsShown + k)).join(''));
  S.rowsShown = to;
  S.obs?.disconnect();
  if (to < S.rows.length) {
    const s = document.createElement('div'); s.className = 'ph-sentinel'; s.style.height = '1px'; host.appendChild(s);
    S.obs = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) drawRows(S.rowsShown + ROWS_AT_A_TIME); }, { root: $('#ph-scroll'), rootMargin: '600px' });
    S.obs.observe(s);
  }
  if (S.openId != null) markCurrent(false);
}

/* The open game's spine is pulled out and shows its cover (loaded only now: a shelf of thousands must not fetch thousands of pictures). */
function pullOut(id, scroll) {
  const prev = $('.ph-spine.is-open'); if (prev && Number(prev.dataset.phId) !== id) prev.classList.remove('is-open');
  const el = $(`.ph-spine[data-ph-id="${id}"]`); if (!el) return;
  const g = S.byId.get(id), face = $('.ph-face', el);
  if (g?.cover_url && face && !$('img', face)) {
    const img = new Image(); img.alt = ''; img.onload = () => face.classList.add('has-img'); img.onerror = () => img.remove(); img.src = g.cover_url; face.prepend(img);
  }
  requestAnimationFrame(() => el.classList.add('is-open'));
  if (scroll) el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  slideShelfClear(el);
}

/* The details window slides in over the right-hand side of the page. A spine standing under it would be pulled out where nobody can see it, so the
   whole shelf slides left, just far enough, and back again when the window closes. (Pinned, the page itself makes room, and the shelf is packed to fit.) */
const OPEN_FACE_W = 118, EDGE = 28;   // OPEN_FACE_W: used only if the spine has no width of its own for the open state
function slideShelfClear(el) {
  const shelf = $('#ph-shelf'), scroll = $('#ph-scroll'), drawer = $('#drawer');
  if (!shelf || !scroll) return;
  const covered = ctx.pinned() || drawer.classList.contains('hidden') ? 0 : drawer.getBoundingClientRect().width;
  const avail = scroll.getBoundingClientRect().right - covered;
  const base = Number(shelf.dataset.shift || 0);
  const spineLeft = el.getBoundingClientRect().left + base;   // where it would be with the shelf at rest
  const openW = parseFloat(el.style.getPropertyValue('--ow')) || OPEN_FACE_W;
  const shift = Math.max(0, Math.round(spineLeft + openW + EDGE - avail));
  shelf.dataset.shift = String(shift);
  shelf.style.transform = shift ? `translateX(${-shift}px)` : '';
}
function slideShelfBack() { const shelf = $('#ph-shelf'); if (shelf) { shelf.dataset.shift = '0'; shelf.style.transform = ''; } }

function markCurrent(scroll) {
  const id = S.openId; if (id == null) return;
  $$('.ph-card.nav-current').forEach((c) => c.classList.remove('nav-current'));
  if (S.view === 'shelf') {
    const ri = S.rowOf.get(id);
    if (ri != null && ri >= S.rowsShown) drawRows(ri + 2);
    pullOut(id, scroll);
  } else {
    let tile = $(`.ph-card[data-ph-id="${id}"]`);
    if (!tile) { const at = S.items.findIndex((g) => g.id === id); if (at >= 0) { S.tilesShown = at + 20; renderTiles(false); tile = $(`.ph-card[data-ph-id="${id}"]`); } }
    if (tile) { tile.classList.add('nav-current'); if (scroll) tile.scrollIntoView({ block: 'nearest' }); }
  }
}

/* ───────────── previous / next in the details window ───────────── */

const ids = () => S.items.map((g) => g.id);
export function syncNav() {
  const box = $('#drawer-nav'); if (!box || S.openId == null) return;
  const list = ids(), i = list.indexOf(S.openId);
  box.classList.toggle('hidden', i < 0 || list.length < 2);
  $('#drawer-prev').disabled = i <= 0; $('#drawer-next').disabled = i < 0 || i >= list.length - 1;
  $('#drawer-pos').textContent = i < 0 ? '' : `${i + 1} / ${list.length}`;
}
export function step(dir) {
  if (S.openId == null) return;
  const list = ids(), t = list[list.indexOf(S.openId) + dir];
  if (t != null) openDetail(t);
}

/* ───────────── the details window ───────────── */

function openShell() {
  const drawer = $('#drawer');
  drawer.classList.remove('hidden'); ctx.syncPin(); $('#scrim').classList.toggle('hidden', ctx.pinned());
  $('#drawer-body').innerHTML = '<div class="skel" style="height:300px"></div>';
  drawer.scrollTop = 0;
}

export async function openDetail(id) {
  const myOpen = (ctx.state.detailToken = (ctx.state.detailToken || 0) + 1);
  ctx.state.openRomId = null; ctx.state.openDigital = null; ctx.state.openPhysical = id;
  S.openId = id;
  openShell(); syncNav(); markCurrent(true);
  let g;
  try { g = await ctx.api(`/physical/games/${id}`); }
  catch (err) { if (myOpen !== ctx.state.detailToken) return; ctx.toast(err.message, true); return ctx.closeDrawer(); }
  if (myOpen !== ctx.state.detailToken) return;
  const col = hex(g.platform_accent, accentOf(g.platform));
  const rows = [
    ['Platform', esc(g.platform_name)],
    ['Region', g.region ? esc(g.region) : '—'],
    ['Released', g.release_year || '—'],
    ['Developer', g.developer ? esc(g.developer) : '—'],
    ['Publisher', g.publisher ? esc(g.publisher) : '—'],
    ['Genre', g.genre ? esc(g.genre) : '—'],
    ['Players', g.players || '—'],
    ['Rating', g.rating != null ? `${g.rating} / 5` : '—'],
    ['Details from', g.matched ? esc(g.meta_source) : 'not matched yet'],
    ['Spine art', g.has_spine ? `<img src="${esc(g.spine_url)}" alt="" style="height:5.5rem;max-width:100%;border-radius:2px;vertical-align:middle" />` : 'none found (the shelf draws one)'],
    ['Notes', g.notes ? esc(g.notes) : '—']
  ];
  const I = ctx.ICON;
  $('#drawer-body').innerHTML = `
    ${g.genre ? `<div class="genre-pills" aria-label="Genres">${g.genre.split(/\s*[,;/]\s*/).filter(Boolean).slice(0, 6).map((x) => `<span class="genre-pill">${esc(x)}</span>`).join('')}</div>` : ''}
    <div class="detail-cover dg-detail-cover" style="background:linear-gradient(160deg,${esc(col)},#12141a)${g.has_cover && g.cover_ar ? `;aspect-ratio:${g.cover_ar}` : ''}">
      <div class="card-fallback${g.has_cover ? ' has-cover' : ''}">${esc(initials(g.title))}</div>
      ${g.cover_url ? `<img src="${esc(g.cover_url)}" alt="" onerror="this.style.display='none';this.previousElementSibling?.classList.remove('has-cover')" />` : ''}
    </div>
    <div class="detail-head"><div style="flex:1">
      <h2 class="detail-title">${esc(g.title)}</h2>
      <div class="detail-plat"><i style="background:${esc(col)}"></i>${esc(g.platform_name)} · on your shelf${g.release_year ? ` · ${g.release_year}` : ''}</div>
    </div></div>
    <div class="detail-actions">
      <button class="ibtn${g.favourite ? ' is-on fav' : ''}" data-d="fav" data-tip="${g.favourite ? 'Remove from favourites' : 'Add to favourites'}" aria-label="Favourite">${g.favourite ? I.starFill : I.star}</button>
      <button class="ibtn" data-d="auto" data-tip="Look this game up again by its title and platform" aria-label="Look up again">${I.refresh}</button>
      ${g.matched ? `<button class="ibtn" data-d="clear" data-tip="Clear the match: remove a wrong cover and details" aria-label="Clear match">${I.undo}</button>` : ''}
      <button class="ibtn ibtn-danger" data-d="delete" data-tip="Remove from your shelf" aria-label="Remove">${I.trash}</button>
    </div>
    ${g.description ? `<p class="detail-desc">${esc(g.description)}</p>` : `<p class="hint">${g.matched ? 'The match has no description.' : 'No details or cover were found for this game yet. Search for it below and pick the right entry: the cover comes with it.'}</p>`}

    ${identifyBlock({ idp: 'ph', title: g.title, platform: g.platform, prefs: ctx.state.prefs })}

    <div class="section-label">Details</div>
    <dl class="meta-table">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>

    <div class="section-label">Edit</div>
    <form class="edit-form" id="ph-edit">
      <label class="field"><span>Title</span><input name="title" value="${esc(g.title)}" /></label>
      <div class="field-row">
        <label class="field"><span>Platform</span><select name="platform" class="select">${platformSelect(g.platform)}</select></label>
        <label class="field"><span>Region</span><input name="region" value="${esc(g.region || '')}" placeholder="PAL, NTSC-U, JP…" /></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Developer</span><input name="developer" value="${esc(g.developer || '')}" /></label>
        <label class="field"><span>Publisher</span><input name="publisher" value="${esc(g.publisher || '')}" /></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Genre</span><input name="genre" value="${esc(g.genre || '')}" /></label>
        <label class="field"><span>Year</span><input name="release_year" type="number" min="1950" max="2100" value="${g.release_year || ''}" /></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Players</span><input name="players" type="number" min="1" max="16" value="${g.players || ''}" /></label>
        <label class="field"><span>Rating (0–5)</span><input name="rating" type="number" min="0" max="5" step="0.1" value="${g.rating ?? ''}" /></label>
      </div>
      <label class="field"><span>Notes (condition, edition, where it is kept)</span><input name="notes" value="${esc(g.notes || '')}" /></label>
      <label class="field"><span>Description</span><textarea name="description" rows="4">${esc(g.description || '')}</textarea></label>
      <button class="btn btn-primary" type="submit">Save</button>
    </form>`;
  bindDetail(g);
}

function bindDetail(g) {
  const body = $('#drawer-body'), id = g.id;
  const refreshAll = async () => { await load(true); await openDetail(id); };
  $('[data-d="fav"]', body).onclick = () => toggleFav(id);
  $('[data-d="auto"]', body).onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; b.classList.add('spin');
    try { const r = await ctx.api(`/physical/games/${id}/auto-match`, { method: 'POST' }); ctx.toast(r.matched ? `Details found (${r.game.meta_source})` : 'No match found: search for it below', !r.matched); await refreshAll(); }
    catch (err) { ctx.toast(err.message, true); b.disabled = false; b.classList.remove('spin'); }
  };
  $('[data-d="clear"]', body)?.addEventListener('click', async () => {
    try { await ctx.api(`/physical/games/${id}/match`, { method: 'DELETE' }); ctx.toast('Match cleared'); await refreshAll(); } catch (err) { ctx.toast(err.message, true); }
  });
  $('[data-d="delete"]', body).onclick = async () => {
    const ok = await ctx.confirmDialog({ title: `Remove ${g.title}?`, body: 'It is taken off your shelf. Importing a CSV that lists it brings it back.', okLabel: 'Remove', danger: true });
    if (!ok) return;
    try { await ctx.api(`/physical/games/${id}`, { method: 'DELETE' }); } catch (err) { ctx.toast(err.message, true); return; }
    ctx.closeDrawer(); ctx.toast('Removed from your shelf'); load(true);
  };
  $('#ph-edit', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = {};
    for (const [k, v] of new FormData(e.target).entries()) out[k] = ['release_year', 'players', 'rating'].includes(k) ? (v === '' ? null : Number(v)) : v;
    try { await ctx.api(`/physical/games/${id}`, { method: 'PATCH', body: JSON.stringify(out) }); ctx.toast('Saved'); await refreshAll(); } catch (err) { ctx.toast(err.message, true); }
  });

  // Identify: the Library's search, with the picked entry (cover included) put on this game.
  wireIdentify(body, { idp: 'ph', ctx, onPick: async (cand) => { await ctx.api(`/physical/games/${id}/match`, { method: 'POST', body: JSON.stringify({ candidate: cand }) }); await refreshAll(); } });
}

/* ───────────── add a game / import a CSV (both in the details window) ───────────── */

function openAdd() {
  ctx.state.openRomId = null; ctx.state.openDigital = null; ctx.state.openPhysical = 0; S.openId = null; ctx.state.detailToken = (ctx.state.detailToken || 0) + 1;
  openShell(); $('#drawer-nav')?.classList.add('hidden');
  const first = S.picked.length === 1 ? S.picked[0] : '';
  $('#drawer-body').innerHTML = `
    <h2 class="detail-title">Add a game to your shelf</h2>
    <p class="hint">Type the title as it is on the box. Details and a cover are looked up for you afterwards, and you can match it by hand if they are wrong.</p>
    <form class="edit-form" id="ph-add">
      <label class="field"><span>Title</span><input name="title" required autocomplete="off" /></label>
      <div class="field-row">
        <label class="field"><span>Platform</span><select name="platform" class="select" required><option value="">Choose…</option>${platformSelect(first)}</select></label>
        <label class="field"><span>Region (optional)</span><input name="region" placeholder="PAL, NTSC-U, JP…" /></label>
      </div>
      <label class="field"><span>Notes (optional)</span><input name="notes" placeholder="Boxed, manual, disc only…" /></label>
      <div style="display:flex;gap:8px"><button class="btn btn-primary" type="submit">Add to shelf</button><button class="btn" type="button" id="ph-add-more" title="Add this game and keep the form open">Add and another</button></div>
    </form>`;
  const form = $('#ph-add');
  const submit = async (again) => {
    const body = Object.fromEntries(new FormData(form).entries());
    try { await ctx.api('/physical/games', { method: 'POST', body: JSON.stringify(body) }); } catch (err) { ctx.toast(err.message, true); return; }
    ctx.toast(`Added “${body.title}”`);
    await load(true);
    if (again) { form.title.value = ''; form.notes.value = ''; form.title.focus(); } else ctx.closeDrawer();
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(false); });
  $('#ph-add-more').onclick = () => { if (form.reportValidity()) submit(true); };
  form.title.focus();
}

/** One line telling what an import did (or would do), shared with Settings › CSV tools. */
export function importSummary(r, platformName = (s) => s) {
  const per = Object.entries(r.by_platform || {}).map(([k, v]) => `${esc(platformName(k))} ${n(v)}`).join(', ');
  const what = r.applied
    ? `<b>Imported.</b> ${n(r.added)} added, ${n(r.updated)} updated, ${n(r.unchanged)} already there${r.removed ? `, ${n(r.removed)} removed` : ''}.`
    : `${n(r.games)} games in the file (${per || 'none'}): ${n(r.added)} would be added, ${n(r.updated)} updated, ${n(r.unchanged)} ${r.unchanged === 1 ? 'is' : 'are'} already there${r.removed ? `, ${n(r.removed)} would be removed` : ''}.`;
  const notes = [r.duplicates ? `${n(r.duplicates)} repeated row${r.duplicates === 1 ? '' : 's'} counted once` : '', r.skipped ? `${n(r.skipped)} row${r.skipped === 1 ? '' : 's'} skipped` : ''].filter(Boolean).join('; ');
  return what + (notes ? ` ${notes}.` : '')
    + (r.problems?.length ? '<br>' + r.problems.map((p) => `Line ${p.line}: ${esc(p.reason)}`).join('<br>') : '')
    + (r.applied && r.match_job?.running ? `<br>Details and covers are being looked up now (${n(r.match_job.total)} games). Open <b>Physical</b> to watch them arrive.` : '');
}

function openImport() {
  ctx.state.openRomId = null; ctx.state.openDigital = null; ctx.state.openPhysical = 0; S.openId = null; ctx.state.detailToken = (ctx.state.detailToken || 0) + 1;
  openShell(); $('#drawer-nav')?.classList.add('hidden');
  $('#drawer-body').innerHTML = `
    <h2 class="detail-title">Import a CSV</h2>
    <p class="hint">A CSV with the columns <code>Platform</code> and <code>Game</code>, and optionally <code>Region</code>, <code>Notes</code> and <code>Year</code> (the first row names the columns, in any order). The platform can be any name from the Library's platform list: <b>SNES</b>, <b>Mega Drive</b>, <b>PS2</b>, <b>Game Boy</b>… Importing the same file again adds nothing twice. Preview shows what would change before anything is saved.</p>
    <div class="panel" style="padding:12px;display:grid;gap:10px">
      <label class="field"><span>CSV file</span><input type="file" id="ph-imp-file" accept=".csv,text/csv" class="file-input" /></label>
      <label class="policy-row"><input type="checkbox" id="ph-imp-replace" /> <span>Remove games no longer in the file (only for the platforms the file lists)</span></label>
      <div style="display:flex;gap:8px"><button class="btn" id="ph-imp-preview">Preview</button><button class="btn btn-primary" id="ph-imp-apply" disabled>Import games</button></div>
      <p class="hint" id="ph-imp-result" style="margin:0"></p>
    </div>`;
  const file = $('#ph-imp-file'), out = $('#ph-imp-result'), apply = $('#ph-imp-apply');
  const pname = (s) => platOf(s).name;
  const run = async (doApply) => {
    const f = file.files?.[0]; if (!f) return ctx.toast('Choose a CSV file first', true);
    let csv; try { csv = await f.text(); } catch { return ctx.toast('The file could not be read', true); }
    try {
      const r = await ctx.api('/physical/import', { method: 'POST', body: JSON.stringify({ csv, apply: doApply, replace: $('#ph-imp-replace').checked }) });
      out.innerHTML = importSummary(r, pname);
      apply.disabled = doApply || !(r.added || r.updated || r.removed);
      if (doApply) { ctx.toast(`${n(r.added)} games added to your shelf`); load(true); }
    } catch (err) { out.textContent = err.message; ctx.toast(err.message, true); }
  };
  $('#ph-imp-preview').onclick = () => run(false); apply.onclick = () => run(true);
  file.onchange = () => { apply.disabled = true; out.textContent = ''; }; $('#ph-imp-replace').onchange = () => { apply.disabled = true; };
}
