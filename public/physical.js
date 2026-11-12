// Physical: the games on your shelf that have no ROM behind them (boxed discs and cartridges), kept by hand or from a CSV.
// Two ways to look at them: the Library's tiles, or a shelf with the games' spines showing. Platform chips, the details window and the
// metadata match all work like the Library's. Each person has their own shelf.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

import { platformSelect, identifyBlock, wireIdentify, platformOptions, comboHtml, wireCombo } from './identify.js';
import { platformBadge, familyName, familyLabel } from './platform-names.js';
import { landChips } from './chip-motion.js';
import { renderArtImport } from './artimport-ui.js';
import { drawPage, mountViewer, pdfReady } from './pdfview.js';
import { attachBulk } from './bulk.js';

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
  // Select mode: pick tiles, or Select all under the current filters, and delete them together (a Digital counterpart the shelf made goes with its disc).
  attachBulk({
    view, grid: $('#ph-tiles'), tile: '.ph-card', barAfter: $('#ph-bar'), toggleSel: '[data-bulk-toggle]', ctx, noun: 'game', where: 'your shelf',
    keyOf: (t) => Number(t.dataset.phId) || null,
    allKeys: () => S.items.map((g) => g.id),
    canStart: () => { if (S.view === 'shelf') { ctx.toast('Switch to the tile view to select games', true); return false; } return true; },
    remove: async (ids) => (await ctx.api('/physical/games/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) })).removed,
    reload: () => load(true)
  });
  for (const t of ['load', 'error']) $('#ph-shelf')?.addEventListener(t, onSpineLoad, true);   // load and error do not bubble: caught on the way down
  let t; $('#ph-q')?.addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value.trim(); S.letter = ''; load(); }, 200); });
  $('#ph-sort')?.addEventListener('change', (e) => { S.sort = e.target.value; S.letter = ''; load(); });
  let rt; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (S.view === 'shelf' && !view.classList.contains('hidden') && Math.abs(shelfWidth() - S.packW) > 8) { const sc = $('#ph-scroll'), top = sc.scrollTop; renderShelf(rowsNeeded(top), false); sc.scrollTop = top; } }, 160); }).observe($('#ph-scroll'));
}

export const isOpen = () => S.openId != null;
export const openIdNow = () => S.openId;
export function reset() { Object.assign(S, { picked: [], family: null, q: '', sort: 'title', fav: false, nocover: false, unmatched: false, spine: false, letter: '' }); const q = $('#ph-q'); if (q) q.value = ''; const s = $('#ph-sort'); if (s) s.value = 'title'; }
export function forgetOpen() { lastAdd = { platform: '', region: '' }; closeCase(true); S.openId = null; $$('.ph-card.nav-current, .ph-spine.is-open:not(.is-fore)').forEach((e) => e.classList.remove('nav-current', 'is-open')); slideShelfBack(); }

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
  if (S.view === 'shelf') renderShelf(keep ? rowsNeeded(keepTop) : 0, !keep); else renderTiles(true);
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
  landChips(host, S.family);
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

/* With the details window not pinned, a dark layer covers the page (the pulled-out cover too). A click on that cover still means "the cover": bring the case forward. */
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('#scrim') || S.view !== 'shelf' || S.openId == null) return;
  const sp = $('.ph-spine.is-open'); if (!sp) return;
  const r = sp.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
  const id = Number(sp.dataset.phId), g = S.byId.get(id);
  if (!g || !isDisc(g.platform) || CASE.id === id) return;   // any other game: the click closes the window, as before
  e.stopImmediatePropagation(); e.preventDefault();
  showCase(id);
}, true);

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
    const changed = next !== S.view; S.view = next; paintToolbar(); if (changed) closeCase(false);
    if (!S.items.length) return;
    if (changed) { const sc = $('#ph-scroll'); if (S.view === 'shelf') renderShelf(); else renderTiles(true); sc.scrollTop = 0; if (S.openId != null) markCurrent(true); }
    else $('#ph-tiles').classList.toggle('compact', S.density === 'compact');
    return;
  }
  if (e.target.closest('#ph-top')) { $('#ph-scroll').scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (e.target.closest('#ph-reset')) { reset(); load(); return; }
  if (e.target.closest('[data-ph-clear]')) { S.family = null; S.picked = []; S.letter = ''; load(); return; }
  const act = e.target.closest('[data-ph-act]');
  if (act) { const a = act.dataset.phAct; if (a === 'add') openAdd(); else if (a === 'import') openImport(); else if (a === 'art') openArtImport(); else if (a === 'lookup') lookupAgain(act); else if (a === 'digital') digitalAll(act); else if (a === 'review') reviewDigital(); return; }
  const fav = e.target.closest('[data-ph-fav]');
  if (fav) { e.stopPropagation(); toggleFav(Number(fav.dataset.phFav)); return; }
  const tile = e.target.closest('[data-ph-id]');
  if (!tile) return;
  const id = Number(tile.dataset.phId);
  // On the shelf, a spine that is already pulled out (showing its cover) goes back when it is clicked again: the details window closes and the spine slides home.
  // (A disc case has more steps first: to the front, then open; see "disc cases" below.)
  if (S.view === 'shelf' && S.openId === id && tile.classList.contains('is-open')) {
    const g = S.byId.get(id);
    if (g && isDisc(g.platform) && CASE.id !== id) { showCase(id); return; }   // a disc case: its cover is clicked to bring it to the front
    ctx.closeDrawer(); return;
  }
  // On a phone the details window covers the whole screen, which would hide the case: so the case comes forward at once, and the details open on its last tap.
  if (S.view === 'shelf' && narrow()) { const g = S.byId.get(id); if (g && isDisc(g.platform)) { if (CASE.id !== id) { if (S.openId != null) ctx.closeDrawer(); showCase(id); } return; } }
  openDetail(id);
}

async function toggleFav(id) {
  const g = S.byId.get(id); if (!g) return;
  try { await ctx.api(`/physical/games/${id}`, { method: 'PATCH', body: JSON.stringify({ favourite: !g.favourite }) }); } catch (err) { ctx.toast(err.message, true); return; }
  await load(true);
  if (S.openId === id) openDetail(id);
}

/* The Digital entries disc to digital made on its own: listed, each one ticked, and nothing happens until the person confirms. A game can be both a disc and a
   purchase, so every entry can be unticked. */
async function reviewDigital() {
  ctx.state.openRomId = null; ctx.state.openDigital = null; ctx.state.openPhysical = 0; S.openId = null; ctx.state.detailToken = (ctx.state.detailToken || 0) + 1;
  openShell(); $('#drawer-nav')?.classList.add('hidden');
  let r;
  try { r = await ctx.api('/physical/digital/review'); } catch (err) { ctx.toast(err.message, true); return; }
  const row = (g, box) => `<label class="policy-row">${box ? `<input type="checkbox" data-rv="${g.id}" checked />` : ''} <span>${esc(g.title)} <span class="hint">${esc(g.platform)}${g.why ? ` · kept: ${esc(g.why)}` : ''}</span></span></label>`;
  $('#drawer-body').innerHTML = `
    <h2 class="detail-title">Xbox Digital entries from your discs</h2>
    <p class="hint">These Digital entries were created by disc to digital and you have not touched them since. A game can be both a disc and a purchase, so untick any you do own digitally. Only ticked ones are taken out of Digital; the discs stay on your shelf, and you can switch disc to digital on again from a game's details.</p>
    ${r.remove.length ? `<div class="results" id="ph-rv-list">${r.remove.map((g) => row(g, true)).join('')}</div>
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-primary" id="ph-rv-go">Take out selected</button><button class="btn" id="ph-rv-none">Untick all</button></div>` : '<p class="hint">Nothing to take out.</p>'}
    ${r.kept.length ? `<div class="section-label">Kept (you have used them)</div><div class="results">${r.kept.map((g) => row(g, false)).join('')}</div>` : ''}
    <p class="hint">${n(r.already_there)} Digital game${r.already_there === 1 ? '' : 's'} that were in your Digital library before their disc was linked are never offered here.</p>`;
  const boxes = () => $$('[data-rv]', $('#drawer-body')), count = () => boxes().filter((b) => b.checked).length;
  const paint = () => { const go = $('#ph-rv-go'); if (go) { go.textContent = `Take out selected (${n(count())})`; go.disabled = !count(); } };
  boxes().forEach((b) => b.addEventListener('change', paint)); paint();
  $('#ph-rv-none')?.addEventListener('click', () => { boxes().forEach((b) => { b.checked = false; }); paint(); });
  $('#ph-rv-go')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget, ids = boxes().filter((b) => b.checked).map((b) => Number(b.dataset.rv));
    const ok = await ctx.confirmDialog({ title: `Take ${n(ids.length)} entr${ids.length === 1 ? 'y' : 'ies'} out of Digital?`, body: 'They are taken out of your Digital library. The discs stay on your shelf.', okLabel: 'Take out', danger: true });
    if (!ok) return;
    btn.disabled = true;
    try { const j = await ctx.api('/physical/digital/review', { method: 'POST', body: JSON.stringify({ ids }) }); ctx.toast(`${n(j.removed)} taken out of Digital`); ctx.closeDrawer(); load(true); }
    catch (err) { ctx.toast(err.message, true); btn.disabled = false; }
  });
}

async function digitalAll(btn) {
  btn.disabled = true;
  try {
    const j = await ctx.api('/physical/digital/all', { method: 'POST' });
    ctx.toast(j.added ? `${n(j.added)} Xbox disc${j.added === 1 ? '' : 's'} added to Digital${j.left_off ? ` (${n(j.left_off)} kept out)` : ''}` : j.left_off ? `Nothing new to add (${n(j.left_off)} kept out of Digital)` : 'Every Xbox One / Series disc is already in Digital');
  } catch (err) { ctx.toast(err.message, true); } finally { btn.disabled = false; load(true); }
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
  return `<div class="card ph-card" data-ph-id="${g.id}"${g.has_video ? ` data-vid="physical:${g.id}"` : ''} tabindex="0" role="button" aria-label="${esc(g.title)}, ${esc(p.name)}">
    <div class="card-cover" style="background:linear-gradient(160deg,${col},#12141a)">
      <div class="card-fallback${g.has_cover ? ' has-cover' : ''}">${esc(initials(g.title))}</div>
      ${g.cover_url ? `<img loading="lazy" src="${esc(g.cover_url)}" alt="" onerror="this.style.display='none';this.previousElementSibling?.classList.remove('has-cover')" />` : ''}
      <span class="card-badge ph-badge" style="background:${esc(col)}" title="${esc(p.name)}"><span class="dg-badge-txt">${esc(platformBadge(p))}</span></span>
      ${g.digital_linked ? `<span class="dg-disc" title="Disc to digital" aria-label="Disc to digital">${ctx.ICON.disc}</span>` : ''}
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
/* The room the details window takes when it is PINNED beside the games (the page makes room for it when it opens and gives it back when it closes). */
const pinReserve = () => (ctx?.pinned?.() && innerWidth > 720 ? Math.round(Math.min(parseFloat(getComputedStyle(document.documentElement).fontSize) * 32.8571, innerWidth * 0.92)) : 0);
/* The shelves are packed for the width they have with the window OPEN, always. Packed for the full width while it is closed, a pinned window made every shelf re-pack the moment
   a game was opened or put back: each spine landed on another shelf and the page jumped. Now the same games stand on the same shelves either way. */
const shelfWidth = () => {
  let w = $('#ph-scroll')?.clientWidth || 800;
  if ($('#drawer')?.classList.contains('hidden')) w -= pinReserve();   // closed: take off what the window will take when it opens
  return Math.max(260, w - 56);
};
/** How many shelves must be drawn to cover down to a scroll position (and a screen's height below it), so a redraw can put you back where you were. */
const rowsNeeded = (top) => { const sc = $('#ph-scroll'); const rh = ($('.ph-row')?.getBoundingClientRect().height || 300) + 14; return Math.ceil(((top || 0) + (sc?.clientHeight || 600)) / rh) + 1; };

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

function renderShelf(upTo = 0, animate = true) {
  $('#ph-tiles').classList.add('hidden'); $('#ph-tiles').innerHTML = '';
  S.obs?.disconnect();
  const host = $('#ph-shelf'); host.classList.remove('hidden');
  host.classList.toggle('no-anim', !animate);   // a redraw that only keeps your place does not drop every spine onto its shelf again
  buildRows();
  host.style.maxWidth = pinReserve() ? `${S.packW + 56}px` : '';   // pinned: the shelves end where the details window begins, open or closed
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
  if (CASE.id != null && CASE.id !== id) closeCase(true);   // any other spine puts the case in front (or open) back on the shelf
  const prev = $('.ph-spine.is-open'); if (prev && Number(prev.dataset.phId) !== id) prev.classList.remove('is-open');
  const el = $(`.ph-spine[data-ph-id="${id}"]`); if (!el) return;
  el.classList.toggle('is-fore', CASE.id === id);
  const g = S.byId.get(id), face = $('.ph-face', el);
  if (g?.cover_url && face && !$('img', face)) {
    const img = new Image(); img.alt = ''; img.onload = () => face.classList.add('has-img'); img.onerror = () => img.remove(); img.src = g.cover_url; face.prepend(img);
  }
  requestAnimationFrame(() => el.classList.add('is-open'));
  if (scroll) el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  slideShelfClear(el);
}

/* ───────────── disc cases: in front, then open ─────────────
   Boxed discs (PlayStation 2 to 5, Xbox to Series X|S) have two more steps on the shelf. Click the spine: it is pulled out and shows its cover (as for every game).
   Click that cover: the whole case comes to the front. Click it again: the case opens, the manual on the left and the disc in its tray on the right.
   Clicking any other spine, or the open case, puts it back on the shelf. (There is no real manual or disc picture to show, so both are drawn.) */
const DISC = new Set(['ps2', 'ps3', 'ps4', 'ps5', 'xbox', 'xbox360', 'xboxone', 'xboxseries', 'gamecube', 'wii', 'wiiu', 'switch', 'switch2']);
const isDisc = (slug) => DISC.has(slug);
const isCart = (slug) => slug === 'switch' || slug === 'switch2';   // a cartridge in the tray, not a disc
const CASE = { el: null, id: null, open: false };
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrow = () => matchMedia('(max-width: 720px)').matches;   // the details window is as wide as the screen here

function caseHtml(g) {
  const col = accentOf(g.platform), p = platOf(g.platform);
  const pic = g.cover_url ? `<img src="${esc(g.cover_url)}" alt="" onerror="this.remove()" />` : '';
  const tone = `linear-gradient(160deg,${esc(col)},#12141a)`;
  return `<div class="ph-case-slide">
    <div class="ph-case-back"><div class="ph-tray"><div class="ph-disc${isCart(g.platform) ? ' ph-cart' : ''}${g.disc_locked ? ' is-own' : ''}${g.platform === 'gamecube' ? ' is-mini' : ''}" style="--c:${esc(col)}"><span>${esc(platformBadge(p))}</span>${g.disc_url ? `<img class="ph-disc-art" src="${esc(g.disc_url)}" alt="" onload="this.parentElement.classList.add('has-art')" onerror="this.remove()" />` : ''}</div></div></div>
    <div class="ph-case-front">
      <div class="ph-case-cover" style="background:${tone}"><b class="ph-case-fb">${esc(g.title)}</b>${pic}</div>
      <div class="ph-case-inside" title="${g.has_manual ? 'Click to read the manual' : 'No manual yet: add one in the details window'}"><div class="ph-manual${g.has_manual ? ' has-manual' : ''}"><div class="ph-man-cover" style="background:${tone}">${pic}</div><b>${esc(g.title)}</b><i></i><i></i><i></i><i></i><i></i><em class="ph-man-tag">${g.has_manual ? 'Read the manual ▸' : 'No manual yet'}</em></div></div>
    </div>${g.back_url ? `<div class="ph-case-rear"><img src="${esc(g.back_url)}" alt="" /></div>` : ''}</div>${g.back_url ? '<button type="button" class="ph-case-turn" title="Turn the case over to see the back (B)" aria-label="Turn the case over">↻</button>' : ''}`;
}

function showCase(id) {
  closeCase(false);
  const g = S.byId.get(id), spine = $(`.ph-spine[data-ph-id="${id}"]`), scroll = $('#ph-scroll');
  if (!g || !spine || !scroll) return;
  const sr = spine.getBoundingClientRect(), r = scroll.getBoundingClientRect(), drawer = $('#drawer');
  const covered = ctx.pinned() || drawer.classList.contains('hidden') ? 0 : drawer.getBoundingClientRect().width;   // the room the details window takes
  const left = r.left, right = r.right - covered, top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
  const ar = Number(g.cover_ar) > 0 ? Math.min(0.95, Math.max(0.55, Number(g.cover_ar))) : 0.72;   // width / height of the cover
  const h = Math.round(Math.max(200, Math.min((bottom - top) * 0.8, 480, ((right - left) * 0.9) / (2 * ar))));   // opened, the case is two covers wide
  const w = Math.round(h * ar), cx = (left + right) / 2, cy = (top + bottom) / 2;
  const el = document.createElement('div');
  el.id = 'ph-case'; el.className = 'ph-case'; el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', `${g.title}: open the case`);
  el.style.cssText = `--cw:${w}px;--ch:${h}px;left:${Math.round(cx - w / 2)}px;top:${Math.round(cy - h / 2)}px`;
  el.innerHTML = caseHtml(g);
  el.addEventListener('click', onCaseClick);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); advanceCase(); } else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); turnCase(); } });
  document.body.append(el);
  CASE.el = el; CASE.id = id; CASE.open = false;
  manualPage(el, g, w);   // the manual's first page goes on the left once it is drawn
  spine.classList.add('is-fore');
  if (!reducedMotion()) el.animate([{ transform: `translate(${sr.left + sr.width / 2 - cx}px, ${sr.top + sr.height / 2 - cy}px) scale(${sr.width / w}, ${sr.height / h})`, opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
  el.focus({ preventScroll: true });
}

/** The real first page of the manual (a PDF, or the first picture) in place of the drawn booklet. It is drawn in the background and appears when ready. */
function manualPage(el, g, caseW) {
  const m = g.manual; if (!m || m.kind === 'link') return;
  const box = $('.ph-manual', el); if (!box) return;
  const width = Math.max(80, Math.round(caseW * 0.84) - 2);
  if (m.type === 'application/pdf') {
    const c = document.createElement('canvas');
    drawPage(m.url, 1, c, width).then(() => { if (box.isConnected) { box.prepend(c); box.classList.add('has-page'); } }).catch(() => { /* the drawn booklet stays */ });
  } else if (/^image\//.test(m.type || '')) {
    const img = new Image(); img.alt = '';
    img.onload = () => { if (box.isConnected) { box.prepend(img); box.classList.add('has-page'); } };
    img.src = m.url;
  }
}

/** A click on the case: on the manual (the left side, once open) it reads the manual; anywhere else it goes on to the next step. */
function onCaseClick(e) {
  if (e.target.closest('.ph-case-turn')) { e.stopPropagation(); turnCase(); return; }
  if (CASE.open && e.target.closest('.ph-case-inside')) { openManual(S.byId.get(CASE.id)); return; }
  advanceCase();
}

/** Turn the closed case over to its back (a flat turn), or back to the front. Only when the game has a back picture. */
function turnCase() {
  const el = CASE.el; if (!el || CASE.open || !el.querySelector('.ph-case-rear')) return;
  const on = el.classList.toggle('is-back');
  el.classList.add('is-turning'); setTimeout(() => el.classList.remove('is-turning'), 720);   // the disc tray is hidden while the case swings round, so only the dark case shows in the gap
  el.setAttribute('aria-label', on ? `${S.byId.get(CASE.id)?.title || 'Game'}: the back. Turn it to the front` : `${S.byId.get(CASE.id)?.title || 'Game'}: open the case`);
}

/** Another click on the case in front: open it; on the open case: put everything back on the shelf. */
function advanceCase() {
  if (!CASE.el) return;
  if (CASE.el.classList.contains('is-back')) { turnCase(); return; }   // showing the back: the click turns it to the front again
  if (!CASE.open) { CASE.open = true; CASE.el.classList.add('is-open'); CASE.el.setAttribute('aria-label', 'Put the case back on the shelf'); }
  else if (narrow() && $('#drawer').classList.contains('hidden')) { const id = CASE.id; closeCase(true); openDetail(id); }   // phone: the case goes back and the details open
  else ctx.closeDrawer();   // closing the details window puts the spine back too (forgetOpen)
}

function closeCase(animate) {
  const el = CASE.el, id = CASE.id, wasOpen = CASE.open;
  CASE.el = null; CASE.id = null; CASE.open = false;
  const spine = id != null ? $(`.ph-spine[data-ph-id="${id}"]`) : null;
  if (!el) { spine?.classList.remove('is-fore'); return; }
  if (!animate || reducedMotion()) { el.remove(); spine?.classList.remove('is-fore'); return; }
  // Put away: an open case swings shut first, then the case slides back to its place on the shelf (the empty slot stays until it gets there).
  const finish = () => { el.remove(); if (CASE.id === id) return; spine?.classList.remove('is-fore'); if (S.openId !== id) spine?.classList.remove('is-open'); };
  const fly = () => {
    const sr = spine?.getBoundingClientRect(), er = el.getBoundingClientRect();
    const to = sr && sr.width ? `translate(${sr.left + sr.width / 2 - (er.left + er.width / 2)}px, ${sr.top + sr.height / 2 - (er.top + er.height / 2)}px) scale(${sr.width / er.width}, ${sr.height / er.height})` : 'scale(.9)';
    const a = el.animate([{ transform: 'none', opacity: 1 }, { transform: to, opacity: 0.5 }], { duration: 300, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' });
    a.onfinish = finish; a.oncancel = finish;
  };
  el.style.pointerEvents = 'none';
  if (wasOpen) { el.classList.remove('is-open'); el.classList.add('is-closing'); setTimeout(fly, 560); } else fly();
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
      ${g.digital_possible ? `<button class="ibtn${g.digital_linked ? ' is-on' : ''}" data-d="digital" aria-pressed="${Boolean(g.digital_linked)}" data-tip="Disc to digital" aria-label="Disc to digital">${I.disc}</button>` : ''}
      ${g.matched ? `<button class="ibtn" data-d="clear" data-tip="Clear the match: remove a wrong cover and details" aria-label="Clear match">${I.undo}</button>` : ''}
      <button class="ibtn" data-d="art" data-tip="Upload your own picture: cover, spine or disc" aria-label="Upload a picture" aria-expanded="false">${I.image}</button>
      <button class="ibtn ibtn-danger" data-d="delete" data-tip="Remove from your shelf" aria-label="Remove">${I.trash}</button>
    </div>
    ${artMenu(g)}
    ${g.description ? `<p class="detail-desc">${esc(g.description)}</p>` : `<p class="hint">${g.matched ? 'The match has no description.' : 'No details or cover were found for this game yet. Search for it below and pick the right entry: the cover comes with it.'}</p>`}

    ${identifyBlock({ idp: 'ph', title: g.title, platform: g.platform, prefs: ctx.state.prefs })}

    <div class="vid-slot" data-kind="physical" data-id="${g.id}"></div>

    <div class="section-label">Details</div>
    <dl class="meta-table">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>

${manualBlock(g)}

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
  // Your own picture: choose what it is (cover, spine or disc), then the file; or go back to the automatic one.
  const menu = $('#ph-art-menu', body), artFile = $('#ph-art-file', body);
  $('[data-d="art"]', body).onclick = (e) => { const open = menu.classList.toggle('hidden') === false; e.currentTarget.setAttribute('aria-expanded', String(open)); };
  $$('[data-art]', menu).forEach((b) => b.addEventListener('click', () => { artFile.dataset.kind = b.dataset.art; artFile.click(); }));
  artFile.onchange = async (e) => {
    const f = e.target.files?.[0], kind = artFile.dataset.kind; if (!f || !kind) return;
    if (f.size > 8 * 1024 * 1024) { ctx.toast('That image is over 8 MB', true); e.target.value = ''; return; }
    const fd = new FormData(); fd.append('image', f);
    try { await ctx.api(`/physical/games/${id}/art/${kind}`, { method: 'POST', body: fd }); ctx.toast(`${kind[0].toUpperCase() + kind.slice(1)} picture updated`); await refreshAll(); } catch (err) { ctx.toast(err.message, true); }
    e.target.value = '';
  };
  $$('[data-art-reset]', menu).forEach((b) => b.addEventListener('click', async () => {
    try { await ctx.api(`/physical/games/${id}/art/${b.dataset.artReset}`, { method: 'DELETE' }); ctx.toast('Back to the automatic picture: use Look up again to fetch one'); await refreshAll(); } catch (err) { ctx.toast(err.message, true); }
  }));
  $('[data-d="digital"]', body)?.addEventListener('click', async (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    try { await ctx.api(`/physical/games/${id}/digital`, { method: 'PUT', body: JSON.stringify({ on }) }); ctx.toast(on ? 'Added to your Digital library' : 'Taken out of your Digital library'); await refreshAll(); }
    catch (err) { ctx.toast(err.message, true); }
  });
  $('[data-d="delete"]', body).onclick = async () => {
    const ok = await ctx.confirmDialog({ title: `Remove ${g.title}?`, body: 'It is taken off your shelf' + (g.digital_made ? ' and out of your Digital library' : '') + '. Importing a CSV that lists it brings it back.', okLabel: 'Remove', danger: true });
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

  // Manual: a link, a file of your own, or neither.
  $('#ph-man-open', body)?.addEventListener('click', () => openManual(g));
  $('#ph-man-upload', body).onclick = () => $('#ph-man-file', body).click();
  $('#ph-man-file', body).onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const fd = new FormData(); fd.append('manual', f);
    try { await ctx.api(`/physical/games/${id}/manual`, { method: 'POST', body: fd }); ctx.toast('Manual saved'); await refreshAll(); } catch (err) { ctx.toast(err.message, true); }
    e.target.value = '';
  };
  $('#ph-man-find', body).onclick = () => window.open(`https://duckduckgo.com/?q=${encodeURIComponent(`${g.title} ${g.platform_name} manual pdf`)}`, '_blank', 'noopener,noreferrer');
  $('#ph-man-remove', body)?.addEventListener('click', async () => {
    const ok = await ctx.confirmDialog({ title: 'Remove this manual?', body: g.manual?.kind === 'file' ? 'The file you uploaded is deleted from the server.' : 'The link is taken off the game.', okLabel: 'Remove', danger: true });
    if (!ok) return;
    try { await ctx.api(`/physical/games/${id}/manual`, { method: 'DELETE' }); ctx.toast('Manual removed'); await refreshAll(); } catch (err) { ctx.toast(err.message, true); }
  });
  $('#ph-man-link', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const link = String(new FormData(e.target).get('link') || '').trim();
    try { await ctx.api(`/physical/games/${id}/manual`, { method: 'PUT', body: JSON.stringify({ link }) }); ctx.toast(link ? 'Link saved' : 'Link removed'); await refreshAll(); } catch (err) { ctx.toast(err.message, true); }
  });

  // Identify: the Library's search, with the picked entry (cover included) put on this game.
  wireIdentify(body, { idp: 'ph', ctx, onPick: async (cand) => { await ctx.api(`/physical/games/${id}/match`, { method: 'POST', body: JSON.stringify({ candidate: cand }) }); await refreshAll(); } });
}

/* ───────────── your own pictures ───────────── */

/** The small panel under the details actions: what the picture you are about to choose is for. Hidden until the picture button is pressed. */
function artMenu(g) {
  const kinds = [['cover', 'Cover', g.cover_locked, 'The front of the box or case'], ['spine', 'Spine', g.spine_locked, 'Tall and narrow: it stands on the shelf'], ...(isDisc(g.platform) ? [isCart(g.platform) ? ['disc', 'Cartridge', g.disc_locked, 'The cartridge: shown in its tray in the open case'] : ['disc', 'Disc', g.disc_locked, 'Roughly square: shown as a circle in the open case'], ['back', 'Back', g.back_locked, 'The back of the case: shown when you turn the case over']] : [])];
  return `<div class="ph-art-menu hidden" id="ph-art-menu">
    <p class="hint" style="margin:0">Upload a picture of your own as the game's… (JPEG, PNG or WebP, up to 8 MB). It is kept, and automatic lookups never replace it.</p>
    <div class="ph-art-row">${kinds.map(([k, label, mine, tip]) => `<span class="ph-art-opt"><button type="button" class="btn btn-sm" data-art="${k}" title="${esc(tip)}">${label}</button>${mine ? `<button type="button" class="btn btn-sm btn-ghost" data-art-reset="${k}" title="Go back to the automatic ${k} picture">Automatic</button>` : ''}</span>`).join('')}</div>
    <input type="file" id="ph-art-file" accept="image/jpeg,image/png,image/webp" class="hidden" />
  </div>`;
}

/* ───────────── manuals ───────────── */

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

/** The details window's Manual section: what the game has (a link or the person's own file), and ways to add or change it. */
function manualBlock(g) {
  const m = g.manual;
  const now = m
    ? `<p class="hint" style="margin:0">${m.kind === 'file' ? `Your file: <b>${esc(m.name)}</b>` : `A link: <b>${esc(hostOf(m.url))}</b>`}</p>`
    : '<p class="hint" style="margin:0">No manual yet. Add a web link to one, or upload your own PDF. On the shelf, open the game\'s case and click the manual to read it.</p>';
  return `<div class="section-label">Manual</div>
    <div class="panel ph-manual-box" style="padding:12px;display:grid;gap:10px">
      ${now}
      <div class="ph-man-actions">
        ${m ? '<button type="button" class="btn btn-sm btn-primary" id="ph-man-open" title="Read the manual">Read the manual</button>' : ''}
        <button type="button" class="btn btn-sm" id="ph-man-upload" title="Upload a PDF or pictures of the pages. It is kept privately with your shelf">Upload a file</button>
        <input type="file" id="ph-man-file" accept="application/pdf,image/png,image/jpeg,image/webp,.pdf" hidden />
        <button type="button" class="btn btn-sm" id="ph-man-find" title="Search the web for this game's manual (opens a search page)">Look for one online</button>
        ${m ? '<button type="button" class="btn btn-sm btn-ghost" id="ph-man-remove" title="Take this manual away from the game">Remove</button>' : ''}
      </div>
      <form class="edit-form" id="ph-man-link" style="grid-template-columns:1fr auto;align-items:end">
        <label class="field"><span>Link to a manual</span><input name="link" type="url" inputmode="url" placeholder="https://…" value="${esc(g.manual_link || '')}" /></label>
        <button class="btn btn-sm" id="ph-man-save" type="submit" title="Save this link">Save link</button>
      </form>
    </div>`;
}

/** Read a game's manual: a link opens in a new tab (in the desktop app, in your browser); a file you uploaded opens in a viewer over the page. */
function openManual(g) {
  const m = g?.manual;
  if (!m) { ctx.toast('No manual for this game yet: add a link or upload one in its details window', true); return; }
  if (m.kind === 'link') { window.open(m.url, '_blank', 'noopener,noreferrer'); return; }
  $('#ph-manview')?.remove();
  const el = document.createElement('div');
  el.id = 'ph-manview'; el.className = 'ph-manview'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', `${g.title}: manual`);
  const save = m.url.replace(/\?.*$/, '') + '?download=1';
  el.innerHTML = `<div class="ph-mv-bar"><b>${esc(g.title)} · manual</b>
      <a class="btn btn-sm" href="${esc(save)}" download="${esc(m.name)}" title="Save a copy of this manual">Download</a>
      <button type="button" class="btn btn-sm btn-primary" data-mv-close title="Close the manual">Close</button></div>
    ${m.type === 'application/pdf' ? '<div class="ph-pv-host"></div>' : `<div class="ph-mv-img"><img src="${esc(m.url)}" alt="" /></div>`}`;
  document.body.append(el);
  let viewer = null;
  if (m.type === 'application/pdf') {
    // Our own reader (pdf.js), so a PDF reads the same everywhere; the window's own PDF viewer is the fallback when it cannot be loaded.
    pdfReady().then((ok) => {
      const host = $('.ph-pv-host', el); if (!host || !el.isConnected) return;
      if (ok) viewer = mountViewer({ url: m.url, scroller: host, bar: $('.ph-mv-bar', el) });
      else host.outerHTML = `<iframe src="${esc(m.url)}" title="${esc(m.name)}"></iframe>`;
    });
  }
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const close = () => { viewer?.destroy(); el.remove(); document.removeEventListener('keydown', onKey, true); };
  document.addEventListener('keydown', onKey, true);
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-mv-close]')) close(); });
  $('[data-mv-close]', el)?.focus();
}

/* ───────────── add a game / import a CSV (both in the details window) ───────────── */

// What was last typed in the add form, kept for as long as the form stays open (pinned, or "Add and another") and forgotten when it closes.
let lastAdd = { platform: '', region: '' };

function openAdd() {
  if ($('#drawer')?.classList.contains('hidden') || !$('#ph-add')) lastAdd = { platform: '', region: '' };   // opened afresh: start clean
  ctx.state.openRomId = null; ctx.state.openDigital = null; ctx.state.openPhysical = 0; S.openId = null; ctx.state.detailToken = (ctx.state.detailToken || 0) + 1;
  openShell(); $('#drawer-nav')?.classList.add('hidden');
  const first = lastAdd.platform || (S.picked.length === 1 ? S.picked[0] : '');
  $('#drawer-body').innerHTML = `
    <h2 class="detail-title">Add a game to your shelf</h2>
    <p class="hint">Type the title as it is on the box. Details and a cover are looked up for you afterwards, and you can match it by hand if they are wrong.</p>
    <form class="edit-form" id="ph-add">
      <label class="field"><span>Title</span><input name="title" required autocomplete="off" /></label>
      <div class="field-row">
        <label class="field"><span>Platform</span>${comboHtml({ options: platformOptions(), selected: first, placeholder: 'Type to find a platform…' })}</label>
        <label class="field"><span>Region (optional)</span><input name="region" placeholder="PAL, NTSC-U, JP…" value="${esc(lastAdd.region)}" /></label>
      </div>
      <label class="field"><span>Notes (optional)</span><input name="notes" placeholder="Boxed, manual, disc only…" /></label>
      <p class="hint" style="margin:0">An Xbox One or Series disc is only added to your Digital library if you switch on the disc to digital icon in the game's details.</p>
      <div style="display:flex;gap:8px"><button class="btn btn-primary" type="submit">Add to shelf</button><button class="btn" type="button" id="ph-add-more" title="Add this game and keep the form open">Add and another</button></div>
    </form>`;
  const form = $('#ph-add');
  wireCombo(form, 'platform', platformOptions());
  const submit = async (again) => {
    const body = Object.fromEntries(new FormData(form).entries());
    try { await ctx.api('/physical/games', { method: 'POST', body: JSON.stringify(body) }); } catch (err) { ctx.toast(err.message, true); return; }
    ctx.toast(`Added “${body.title}”`);
    lastAdd = { platform: body.platform || '', region: body.region || '' };   // the next game is usually the same platform and region
    await load(true);
    if (again || ctx.pinned()) { form.title.value = ''; form.notes.value = ''; form.title.focus(); }   // pinned: the window stays, ready for the next one
    else { lastAdd = { platform: '', region: '' }; ctx.closeDrawer(); }
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
  const notes = [r.digital_on ? `${n(r.digital_on)} Xbox disc${r.digital_on === 1 ? '' : 's'} ${r.applied ? 'also in' : 'would also go to'} Digital` : '', r.digital_off ? `${n(r.digital_off)} kept out of Digital` : '', r.duplicates ? `${n(r.duplicates)} repeated row${r.duplicates === 1 ? '' : 's'} counted once` : '', r.skipped ? `${n(r.skipped)} row${r.skipped === 1 ? '' : 's'} skipped` : ''].filter(Boolean).join('; ');
  return what + (notes ? ` ${notes}.` : '')
    + (r.problems?.length ? '<br>' + r.problems.map((p) => `Line ${p.line}: ${esc(p.reason)}`).join('<br>') : '')
    + (r.applied && r.match_job?.running ? `<br>Details and covers are being looked up now (${n(r.match_job.total)} games). Open <b>Physical</b> to watch them arrive.` : '');
}

/** Bring in pictures and manuals from a folder on the server (see public/artimport-ui.js). */
function openArtImport() {
  ctx.state.openRomId = null; ctx.state.openDigital = null; ctx.state.openPhysical = 0; S.openId = null; ctx.state.detailToken = (ctx.state.detailToken || 0) + 1;
  openShell(); $('#drawer-nav')?.classList.add('hidden');
  renderArtImport(ctx, $('#drawer-body'), { target: 'physical', onDone: () => load(true) });
}

function openImport() {
  ctx.state.openRomId = null; ctx.state.openDigital = null; ctx.state.openPhysical = 0; S.openId = null; ctx.state.detailToken = (ctx.state.detailToken || 0) + 1;
  openShell(); $('#drawer-nav')?.classList.add('hidden');
  $('#drawer-body').innerHTML = `
    <h2 class="detail-title">Import a CSV</h2>
    <p class="hint">A CSV with the columns <code>Platform</code> and <code>Game</code>, and optionally <code>Region</code>, <code>Notes</code>, <code>Year</code>, <code>Manual</code> (a web link to the game's manual) and <code>Digital</code> (yes or no, for Xbox One and Series discs: whether the game is also in your Digital library) (the first row names the columns, in any order). The platform can be any name from the Library's platform list: <b>SNES</b>, <b>Mega Drive</b>, <b>PS2</b>, <b>Game Boy</b>… Importing the same file again adds nothing twice. Preview shows what would change before anything is saved.</p>
    <div class="panel" style="padding:12px;display:grid;gap:10px">
      <label class="field"><span>CSV file</span><input type="file" id="ph-imp-file" accept=".csv,text/csv" class="file-input" /></label>
      <label class="policy-row"><input type="checkbox" id="ph-imp-digital" /> <span>Also add Xbox One and Xbox Series discs to my Digital library (a <code>Digital</code> column of no keeps one out)</span></label>
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
      const r = await ctx.api('/physical/import', { method: 'POST', body: JSON.stringify({ csv, apply: doApply, replace: $('#ph-imp-replace').checked, digital: $('#ph-imp-digital').checked }) });
      out.innerHTML = importSummary(r, pname);
      apply.disabled = doApply || !(r.added || r.updated || r.removed);
      if (doApply) { ctx.toast(`${n(r.added)} games added to your shelf`); load(true); }
    } catch (err) { out.textContent = err.message; ctx.toast(err.message, true); }
  };
  $('#ph-imp-preview').onclick = () => run(false); apply.onclick = () => run(true);
  file.onchange = () => { apply.disabled = true; out.textContent = ''; }; $('#ph-imp-replace').onchange = $('#ph-imp-digital').onchange = () => { apply.disabled = true; };
}
