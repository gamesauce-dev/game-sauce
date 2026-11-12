// Digital Library: the games a person owns without a ROM or a disc on the shelf. Steam comes from the Steam Web API (hours played and all); PlayStation,
// Nintendo and Xbox games come from a CSV or are added by hand. Laid out like the Physical Library: store chips with each console's own chips under them,
// search, sort, filters, A-Z, a heading with how many (and, for Steam, the hours), tiles, and the details window. Each person has their own list.
import { identifyBlock, wireIdentify, comboHtml, wireCombo } from './identify.js';
import { landChips } from './chip-motion.js';
import { renderArtImport } from './artimport-ui.js';
import { familyLabel, platformBadge } from './platform-names.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Number(v || 0).toLocaleString();
const initials = (t) => String(t).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

let ctx = null;

/* The stores Digital lists: Steam from its Web API, and console games brought in from a CSV or added by hand. `chip` is the colour of the store's chip. */
const DG_STORE = {
  steam: { label: 'Steam', short: 'STEAM', bg: '#1b2838', chip: '#66c0f4' },
  playstation: { label: 'PlayStation', short: 'PS', bg: '#0070d1', chip: '#0070d1' },
  nintendo: { label: 'Nintendo', short: 'NINTENDO', bg: '#e60012', chip: '#e60012' },
  xbox: { label: 'Xbox', short: 'XBOX', bg: '#107c10', chip: '#107c10' }
};
/* A store holds several consoles, and each game carries the badge of its own (games imported before consoles were told apart show XBOX).
 * `lib` is the Library platform the console is looked up as (its colour and the identify search's platform box). */
const DG_PLATFORM = {
  ps2: { store: 'playstation', label: 'PlayStation 2', short: 'PS2', lib: 'ps2' },   ps3: { store: 'playstation', label: 'PlayStation 3', short: 'PS3', lib: 'ps3' }, ps4: { store: 'playstation', label: 'PlayStation 4', short: 'PS4', lib: 'ps4' },
  ps5: { store: 'playstation', label: 'PlayStation 5', short: 'PS5', lib: 'ps5' },
  switch2: { store: 'nintendo', label: 'Nintendo Switch 2', short: 'SWITCH 2', lib: 'switch2' }, switch: { store: 'nintendo', label: 'Nintendo Switch', short: 'SWITCH', lib: 'switch' },
  wii: { store: 'nintendo', label: 'Nintendo Wii', short: 'WII', lib: 'wii' }, wiiu: { store: 'nintendo', label: 'Nintendo Wii U', short: 'WII U', lib: 'wiiu' },
  '3ds': { store: 'nintendo', label: 'Nintendo 3DS', short: '3DS', lib: '3ds' }, ds: { store: 'nintendo', label: 'Nintendo DS', short: 'DS', lib: 'nds' },
  xbox: { store: 'xbox', label: 'Xbox', short: 'XBOX', lib: 'xbox' }, x360: { store: 'xbox', label: 'Xbox 360', short: 'XBOX 360', lib: 'xbox360' },
  xone: { store: 'xbox', label: 'Xbox One', short: 'XBOX ONE', lib: 'xboxone' }, xsx: { store: 'xbox', label: 'Xbox Series X|S', short: 'X|S', lib: 'xboxseries' }
};
export const storeLabel = (s) => DG_STORE[s]?.label || s;
/** The name of a game's store or console, as its badge says it in full ("PlayStation 5", "Nintendo Switch"): used when a game is shared in a message. */
export const badgeLabel = (g) => badgeOf(g).label;
const STORE_ORDER = ['steam', 'playstation', 'nintendo', 'xbox'];
const badgeOf = (g) => {
  const st = DG_STORE[g.store] || { label: g.store, short: String(g.store || '').toUpperCase(), bg: '#1b2838' };
  return g.store === 'steam' ? st : { ...st, ...(DG_PLATFORM[g.platform] || (g.store === 'xbox' ? DG_PLATFORM.xbox : {})) };
};
/** The badge text an admin set for the Library platform behind a Digital console (Settings > Platforms), or null for the default. */
const customBadge = (platform) => { const p = (window.__platformsCache || []).find((x) => x.slug === DG_PLATFORM[platform]?.lib); const b = String(p?.badge || '').trim(); return b ? b.toUpperCase() : null; };
const libAccent = (platform) => { const p = (window.__platformsCache || []).find((x) => x.slug === DG_PLATFORM[platform]?.lib); return /^#[0-9a-f]{6}$/i.test(p?.accent || '') ? p.accent : null; };

const dg = {
  picked: [],            // chips: 's:playstation' is a whole store, 'p:ps4' one console
  family: null,          // the store whose consoles are showing
  sort: 'name', q: '', fav: false, nocover: false, installed: false, hidden: false, density: 'comfortable', letter: '',
  info: { steam: {}, stores: [], platforms: [], counts: {}, details_job: {} }, ids: [], html: [], items: [], hours: 0, total: 0, rendered: 0, shown: 60, token: 0
};
const store = {
  get(k, d) { try { return localStorage.getItem('gamesauce_dg_' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gamesauce_dg_' + k, v); } catch { /* storage unavailable */ } }
};
const tok = { store: (s) => `s:${s}`, plat: (p) => `p:${p}` };
const picks = () => ({ stores: dg.picked.filter((t) => t.startsWith('s:')).map((t) => t.slice(2)), platforms: dg.picked.filter((t) => t.startsWith('p:')).map((t) => t.slice(2)) });
const steamPossible = () => !dg.picked.length || dg.picked.includes('s:steam');
const isAdmin = () => ctx?.user?.()?.role === 'admin';

export function initDigital(c) {
  ctx = c;
  dg.density = store.get('density', 'comfortable') === 'compact' ? 'compact' : 'comfortable';
  const view = $('#view-digital'); if (!view || view.dataset.ready) return;
  view.dataset.ready = '1';
  view.addEventListener('click', onClick);
  let t; $('#dg-q')?.addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { dg.q = e.target.value.trim(); dg.letter = ''; loadDigital(); }, 200); });
  $('#dg-sort')?.addEventListener('change', (e) => { dg.sort = e.target.value; dg.letter = ''; loadDigital(); });
}

export { loadDigital as load };   // what app.js calls when the page is opened

export function reset() {
  Object.assign(dg, { picked: [], family: null, sort: 'name', q: '', fav: false, nocover: false, installed: false, hidden: false, letter: '' });
  const q = $('#dg-q'); if (q) q.value = '';
}
export function forgetOpen() { lastAdd = { platform: '', country: '' }; $$('.dg-card.nav-current').forEach((c) => c.classList.remove('nav-current')); }

/* ───────────── the tiles (drawn in chunks, 60 at a time, as you scroll) ─────────────
   Drawing thousands at once, each with its own buttons, froze iPhones and iPads. dg.ids is the whole list in order, so previous / next still walk all of it. */
const dgIds = () => dg.ids || [];
// One game in the list: its store and its id in that store (the same title on two consoles is two games, each with its own id).
const dgKey = (store, appId) => `${store}:${appId}`;
function dgRender(reset) {
  const grid = $('#dg-grid'); if (!grid) return;
  if (reset) { grid.innerHTML = ''; dg.rendered = 0; }
  grid.querySelector('.dg-sentinel')?.remove();
  const html = dg.html || [], target = Math.min(html.length, Math.max(dg.shown || 60, dg.rendered || 0));
  if (target > (dg.rendered || 0)) grid.insertAdjacentHTML('beforeend', html.slice(dg.rendered || 0, target).join(''));
  dg.rendered = target; dg.shown = target;
  dg.obs?.disconnect();
  if (target < html.length) {
    const s = document.createElement('div'); s.className = 'dg-sentinel'; s.style.cssText = 'grid-column:1/-1;height:1px';
    grid.appendChild(s);
    dg.obs = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { dg.shown = dg.rendered + 60; dgRender(false); } }, { root: grid, rootMargin: '800px' });
    dg.obs.observe(s);
  }
}

/* Previous / next inside the Digital list: the tiles in the order shown now (hidden games only when Show hidden is on). */
function syncDigitalNav() {
  const box = $('#drawer-nav'), cur = ctx.state.openDigital; if (!box || !cur) return;
  const ids = dgIds(), i = ids.indexOf(dgKey(cur.store, cur.appId));
  box.classList.toggle('hidden', i < 0 || ids.length < 2);
  $('#drawer-prev').disabled = i <= 0; $('#drawer-next').disabled = i < 0 || i >= ids.length - 1;
  $('#drawer-pos').textContent = i < 0 ? '' : `${i + 1} / ${ids.length}`;
  $$('.dg-card.nav-current').forEach((c) => c.classList.remove('nav-current'));
  const tile = $(`.dg-card[data-dg-store-of="${CSS.escape(cur.store)}"][data-dg-app="${CSS.escape(cur.appId)}"]`); if (tile) { tile.classList.add('nav-current'); tile.scrollIntoView({ block: 'nearest' }); }
}
export function step(dir) { stepDigital(dir); }
function stepDigital(dir) {
  const cur = ctx.state.openDigital; if (!cur || !cur.appId) return;   // an add / import panel has no place in the list
  const ids = dgIds(), at = ids.indexOf(dgKey(cur.store, cur.appId)) + dir, t = ids[at];
  if (t != null) { if (at >= (dg.rendered || 0)) { dg.shown = at + 20; dgRender(false); } const cut = t.indexOf(':'); openDigitalDetail(t.slice(0, cut), t.slice(cut + 1)); }
}

const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
function paintLetters(counts = {}) {
  const box = $('#dg-letters'); if (!box) return;
  const on = dg.sort === 'name' || dg.sort === '-name';   // a letter only means something in title order
  box.classList.toggle('off', !on);
  box.innerHTML = on ? LETTERS.map((l) => `<button type="button" class="az-l${dg.letter === l ? ' on' : ''}" data-dg-letter="${l}"${counts[l] ? '' : ' disabled'} title="${counts[l] ? l + ': ' + n(counts[l]) + ' games' : 'No games under ' + l}">${l}</button>`).join('') : '';
  $$('[data-dg-density]').forEach((b) => b.classList.toggle('is-on', b.dataset.dgDensity === dg.density));
}

/* ───────────── the bar, the chips, the heading ───────────── */

function paintSort() {
  const sel = $('#dg-sort'); if (!sel) return;
  const steam = steamPossible();
  if (!steam && (dg.sort === 'hours' || dg.sort === 'recent')) dg.sort = 'name';   // Steam's two sorts mean nothing for a console game
  sel.innerHTML = `<option value="name">Title A–Z</option><option value="-name">Title Z–A</option><option value="platform">Platform</option><option value="added">Recently added</option><option value="year">Year</option>`
    + (steam ? '<optgroup label="Steam only"><option value="hours">Most played</option><option value="recent">Recently played</option></optgroup>' : '');
  sel.value = dg.sort;
}

function paintToolbar() {
  const cn = dg.info.counts || {}, hasSteam = (dg.info.stores || []).some((s) => s.store === 'steam');
  $('#dg-toggles').innerHTML = `
    <button type="button" class="ph-pill${dg.fav ? ' on' : ''}" data-dg-toggle="fav" title="Favourites: only your favourites (${n(cn.favourites)})">★ Favourites <small>${n(cn.favourites)}</small></button>`
    + `<button type="button" class="ph-pill${dg.nocover ? ' on' : ''}" data-dg-toggle="nocover" title="No cover: console games with no cover picture yet (${n(cn.nocover)})">▢ No cover <small>${n(cn.nocover)}</small></button>`
    + (hasSteam ? `<button type="button" class="ph-pill${dg.installed ? ' on' : ''}" data-dg-toggle="installed" title="Installed: only the Steam games you switched the play button on for, installed on this PC (${n(cn.installed)})">▶ Installed <small>${n(cn.installed)}</small></button>` : '')
    + `<button type="button" class="ph-pill${dg.hidden ? ' on' : ''}" data-dg-toggle="hidden" title="Show hidden: also show the games you hid (${n(cn.hidden)})">◌ Show hidden <small>${n(cn.hidden)}</small></button>`;
  const any = dg.picked.length || dg.q || dg.fav || dg.nocover || dg.installed || dg.hidden || dg.letter;
  $('#dg-reset')?.classList.toggle('hidden', !any);
  $$('[data-dg-density]').forEach((b) => b.classList.toggle('is-on', b.dataset.dgDensity === dg.density));
}

function renderChips() {
  const host = $('#dg-chips'); if (!host) return;
  const stores = STORE_ORDER.map((s) => (dg.info.stores || []).find((x) => x.store === s)).filter((x) => x && x.visible > 0);
  if (!stores.length) { host.innerHTML = ''; return; }
  const plats = (dg.info.platforms || []).filter((p) => p.count > 0);
  const total = stores.reduce((t, s) => t + s.visible, 0);
  const pk = new Set(dg.picked);
  const subsOf = (s) => plats.filter((p) => p.store === s);
  const whole = (s) => pk.has(tok.store(s));
  const part = (s) => subsOf(s).some((p) => pk.has(tok.plat(p.platform)));
  if (dg.family && !subsOf(dg.family).length) dg.family = null;
  const famState = (s) => (whole(s) ? ' on whole' : part(s) ? ' on part' : '');
  host.innerHTML = `
    <div class="ph-chip-row" role="tablist">
      <button type="button" class="ph-chip${pk.size === 0 ? ' on' : ''}" data-dg-chip-all title="All your games">All <small>${n(total)}</small></button>
      ${stores.map((s) => `<button type="button" class="ph-chip${dg.family === s.store ? ' open' : ''}${famState(s.store)}" data-dg-chip-store="${esc(s.store)}" style="--chip-c:${DG_STORE[s.store]?.chip || '#6b7280'}"${subsOf(s.store).length ? ` aria-expanded="${dg.family === s.store}"` : ''} title="${esc(s.label || storeLabel(s.store))}${subsOf(s.store).length ? ': show its consoles' : ''}">${esc(familyLabel(s.label || storeLabel(s.store)))} <small>${n(s.visible)}</small></button>`).join('')}
    </div>
    ${dg.family ? `<div class="ph-chip-row ph-chip-plats">${subsOf(dg.family).map((p) => `<button type="button" class="ph-chip plat${pk.has(tok.plat(p.platform)) && !whole(dg.family) ? ' on' : ''}" data-dg-chip-plat="${esc(p.platform)}" style="--chip-c:${libAccent(p.platform) || DG_STORE[dg.family]?.chip || '#6b7280'}" title="${esc(p.label)}: click to ${pk.has(tok.plat(p.platform)) && !whole(dg.family) ? 'turn off' : 'turn on'}"><span>${esc(customBadge(p.platform) || platformBadge({ slug: DG_PLATFORM[p.platform]?.lib || p.platform, short_name: DG_PLATFORM[p.platform]?.short }))}</span> <small>${n(p.count)}</small></button>`).join('')}</div>` : ''}`;
  landChips(host, dg.family);
}

function chipClick(e) {
  const all = e.target.closest('[data-dg-chip-all]'), st = e.target.closest('[data-dg-chip-store]'), pl = e.target.closest('[data-dg-chip-plat]');
  if (!all && !st && !pl) return false;
  if (all) { dg.family = null; dg.picked = []; }
  else if (st) {
    // A store chip selects the whole store (All goes off) and shows its consoles; clicking it again clears the selection (as in the Library).
    const s = st.dataset.dgChipStore, isWhole = dg.picked.length === 1 && dg.picked[0] === tok.store(s);
    if (isWhole) { dg.family = null; dg.picked = []; }
    else { dg.family = (dg.info.platforms || []).some((p) => p.store === s && p.count > 0) ? s : null; dg.picked = [tok.store(s)]; }
  } else {
    const t = tok.plat(pl.dataset.dgChipPlat), wholeFam = dg.picked.length === 1 && dg.picked[0] === tok.store(dg.family);
    // With a whole store selected, a click narrows to that one console; after that, clicks add and remove consoles.
    dg.picked = wholeFam ? [t] : dg.picked.includes(t) ? dg.picked.filter((x) => x !== t) : [...dg.picked, t];
  }
  dg.letter = '';
  const sc = $('#dg-grid'); if (sc) sc.scrollTop = 0;
  loadDigital();
  return true;
}

/** The heading above the tiles: a dot in the colour of what is picked, its name, how many games, and for Steam alone the hours played; "All platforms" clears the picks. */
function renderHeading() {
  const box = $('#dg-heading'); if (!box) return;
  if (!dg.info.stores?.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const count = `${n(dg.total)} ${dg.total === 1 ? 'game' : 'games'}`;
  const steamOnly = dg.items.length > 0 && dg.items.every((g) => g.store === 'steam');
  const asOf = dg.info.steam?.last_sync ? new Date(dg.info.steam.last_sync.replace(' ', 'T') + 'Z') : null;
  const hours = steamOnly && dg.hours ? `<span class="lib-total" title="Hours played are as of the last time you pressed Refresh${asOf ? ' (' + asOf.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + asOf.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + ')' : ''}. Press it again to update them.">${n(dg.hours)} h played</span>` : '';
  if (!dg.picked.length) { box.innerHTML = `<span class="lib-dot" style="background:var(--accent)"></span><h2>All stores</h2><span class="lib-total">${count}</span>`; return; }
  const names = dg.picked.map((t) => (t.startsWith('s:') ? storeLabel(t.slice(2)) : DG_PLATFORM[t.slice(2)]?.label || t.slice(2)));
  const name = names.length > 3 ? `${names.length} platforms` : names.join(' + ');
  const first = dg.picked[0], dot = first.startsWith('s:') ? DG_STORE[first.slice(2)]?.chip : libAccent(first.slice(2)) || DG_STORE[DG_PLATFORM[first.slice(2)]?.store]?.chip;
  box.innerHTML = `<span class="lib-dot" style="background:${esc(dot || 'var(--accent)')}"></span><h2>${esc(name)}</h2><span class="lib-total">${count}</span>${hours}
    <button type="button" class="btn btn-sm btn-ghost lib-clear" data-dg-clear title="Show every store again">✕ All platforms</button>`;
}

/* ───────────── loading ───────────── */

export async function loadDigital(keep = false) {
  const token = ++dg.token;
  if (keep !== true) dg.shown = 60;   // a new list starts with one screenful; a mark keeps what was drawn
  const msg = $('#dg-msg'), grid = $('#dg-grid');
  let info;
  try { info = await ctx.api('/digital'); } catch (err) { msg.textContent = err.message; return; }
  if (token !== dg.token) return;
  dg.info = info;
  const connected = info.steam.connected, consoleGames = info.stores.some((s) => s.store !== 'steam');
  // A pick that no longer has games (the last one was removed or hidden) is dropped.
  const have = new Set([...info.stores.filter((s) => s.visible > 0).map((s) => tok.store(s.store)), ...info.platforms.map((p) => tok.plat(p.platform))]);
  dg.picked = dg.picked.filter((t) => have.has(t));
  // Refresh fetches the Steam library again and looks up details for console games that have none yet.
  const sync = $('#dg-sync');
  sync.classList.toggle('hidden', !connected && !consoleGames);
  sync.title = connected && consoleGames ? 'Fetch your Steam library again, and look up details for console games that have none' : connected ? 'Fetch your Steam library again' : 'Look up details and covers for console games that have none';
  $('[data-dg-act="import"]')?.classList.toggle('hidden', !isAdmin());
  const hasGames = connected || consoleGames;
  $('#dg-bar').classList.toggle('hidden', !hasGames); $('#dg-az').classList.toggle('hidden', !hasGames);
  paintSort(); paintToolbar(); renderChips();
  const job = info.details_job || {};
  msg.innerHTML = (connected && info.steam.last_error ? `<div class="dg-warn">${esc(info.steam.last_error)}</div>` : '')
    + (job.running ? `<div class="dg-note">Looking up details and covers for console games: ${n(job.done)} of ${n(job.total)} done. They appear as they are found.</div>` : '');
  // While the lookup runs, the page checks back every few seconds so covers appear without a reload.
  clearTimeout(dg.jobTimer);
  if (job.running) dg.jobTimer = setTimeout(() => { if (ctx.state.view === 'digital' && !$('#view-digital')?.classList.contains('hidden')) { const sc = $('#dg-grid'), keepTop = sc?.scrollTop || 0; loadDigital(true).then(() => { if (sc) sc.scrollTop = keepTop; }); } }, 4000);
  const empty = $('#dg-empty');
  if (!hasGames) {
    $('#dg-heading').classList.add('hidden'); grid.innerHTML = '';
    empty.classList.remove('hidden');
    empty.innerHTML = `<div class="empty"><h2>Your Digital Library is empty</h2><p>Connect Steam and the games you own appear here with your hours played. PlayStation, Nintendo and Xbox games are added by hand${isAdmin() ? ' or from a CSV' : ''}. Only you can see your list.</p>
      <div class="dg-actions"><button class="btn btn-primary" id="dg-setup">Set up Steam</button><button class="btn" data-dg-act="add">Add a game</button>${isAdmin() ? '<button class="btn" data-dg-act="import">Import a CSV</button>' : ''}</div></div>`;
    $('#dg-setup').onclick = () => { ctx.setView('settings'); ctx.showSettingsModule('steam'); };
    return;
  }
  empty.classList.add('hidden');
  const { stores, platforms } = picks();
  const params = new URLSearchParams({ sort: dg.sort });
  if (stores.length) params.set('stores', stores.join(',')); if (platforms.length) params.set('platforms', platforms.join(','));
  if (dg.q) params.set('q', dg.q); if (dg.fav) params.set('favourites', '1'); if (dg.nocover) params.set('nocover', '1'); if (dg.installed) params.set('installed', '1'); if (dg.hidden) params.set('hidden', 'show'); if (dg.letter) params.set('letter', dg.letter);
  let list;
  try { list = await ctx.api('/digital/games?' + params); } catch (err) { msg.textContent = err.message; return; }
  if (token !== dg.token) return;
  const { items, total, total_hours: hours, letters } = list;
  dg.items = items; dg.total = total; dg.hours = hours;
  paintLetters(letters); renderHeading();
  grid.classList.toggle('compact', dg.density === 'compact');
  if (!total) { dg.ids = []; dg.html = []; grid.innerHTML = '<div class="empty"><h2>No games match</h2><p>Try clearing the search or a filter.</p></div>'; return; }
  grid.scrollTop = 0;
  dg.ids = items.map((g) => dgKey(g.store, g.app_id));
  dg.html = items.map((g) => {
    const st = badgeOf(g), steam = g.store === 'steam';
    return `<div class="card dg-card${g.hidden ? ' is-hidden' : ''}" data-dg-app="${esc(g.app_id)}" data-dg-store-of="${esc(g.store)}">
      <div class="card-cover" style="background:linear-gradient(160deg,${st.bg},#12141a)">
        <div class="card-fallback">${esc(initials(g.name))}</div>
        ${g.cover_url ? `<img loading="lazy" src="${esc(g.cover_url)}" data-fb="${esc(g.cover_fallback_url || '')}" alt="" onload="this.previousElementSibling?.classList.add('has-cover')" onerror="if(this.dataset.fb&&!this.dataset.tried){this.dataset.tried=1;this.src=this.dataset.fb}else{this.style.display='none'}" />` : ''}
        ${steam
          ? `<span class="card-badge dg-badge" data-store="${esc(g.store)}" title="${esc(st.label)}" aria-label="${esc(st.label)}"><span class="dg-badge-ico" aria-hidden="true"></span><span class="dg-badge-txt">${esc(st.short)}</span></span>`
          // A console game's badge is the same as in the Library and Physical: the platform's colour (Settings > Platforms) with its short name.
          : `<span class="card-badge ph-badge" style="background:${esc(libAccent(g.platform) || st.bg)}" title="${esc(st.label)}" aria-label="${esc(st.label)}"><span class="dg-badge-txt">${esc(customBadge(g.platform) || st.short)}</span></span>`}
        ${g.launch_url ? `<a class="card-playbtn dg-launch" href="${esc(g.launch_url)}" title="Open in Steam (works on a PC that has Steam installed)" aria-label="Open ${esc(g.name)} in Steam">▶</a>` : ''}
        <button type="button" class="card-fav ${g.favourite ? 'on' : ''}" data-dg-mark="favourite" data-value="${g.favourite ? 0 : 1}" tabindex="-1" title="${g.favourite ? 'Remove from favourites' : 'Add to favourites'}" aria-label="Favourite">${g.favourite ? ctx.ICON.starFill : ctx.ICON.star}</button>
        <button type="button" class="card-hide" data-dg-mark="hidden" data-value="${g.hidden ? 0 : 1}" tabindex="-1" title="${g.hidden ? 'Unhide' : 'Hide from your Digital list'}" aria-label="${g.hidden ? 'Unhide' : 'Hide'}">${g.hidden ? ctx.ICON.eye : ctx.ICON.eyeOff}</button>
        ${!steam && g.physical ? `<span class="dg-disc" title="Also on your shelf as a disc" aria-label="Also on your shelf as a disc"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.442 6.537 C4.844 6.537 5.17 6.184 5.17 5.75 C5.17 5.315 4.844 4.963 4.442 4.963 C4.04 4.963 3.715 5.315 3.715 5.75 C3.715 6.184 4.04 6.537 4.442 6.537 M1.047 2.339 C1.047 2.049 1.264 1.814 1.532 1.814 L12.202 1.814 C12.47 1.814 12.687 2.049 12.687 2.339 L12.687 18.081 C12.687 18.371 12.47 18.606 12.202 18.606 L1.532 18.606 C1.264 18.606 1.047 18.371 1.047 18.081 Z M4.927 9.685 L4.927 17.556 L11.717 17.556 L11.717 2.864 L2.017 2.864 L2.017 17.556 L3.957 17.556 L3.957 9.685 C3.957 9.395 4.174 9.161 4.442 9.161 C4.71 9.161 4.927 9.395 4.927 9.685" fill="currentColor"/><path d="M18.369 2.247 L17.552 2.171 L17.476 2.987 L18.293 3.063 Z M19.051 3.809 L19.115 3.126 L18.432 3.063 L18.369 3.745 Z M13.709 5.209 C13.887 6.055 14.485 6.771 15.283 7.106 C17.114 7.87 18.983 6.63 19.151 4.832 L18.089 4.733 C17.984 5.862 16.783 6.63 15.636 6.089 C15.211 5.89 14.891 5.505 14.773 5.051 C14.45 3.824 15.428 2.788 16.555 2.891 L16.556 2.888 L16.559 2.888 L16.658 1.826 C14.855 1.659 13.295 3.266 13.709 5.209 M16.727 3.066 L16.629 4.122 L17.688 4.221 L17.787 3.161 L16.731 3.063 L16.73 3.066 Z" fill="currentColor"/></svg></span>` : ''}
        ${steam ? `<button type="button" class="dg-playsw ${g.play ? 'on' : ''}" data-dg-mark="play" data-value="${g.play ? 0 : 1}" tabindex="-1" title="${g.play ? 'Play button is on (click to turn it off)' : 'Play button is off: turn it on for games installed on this PC'}" aria-label="Play button ${g.play ? 'on' : 'off'}">${g.play ? ctx.ICON.gamepad : ctx.ICON.gamepadOff}</button>
        <span class="dg-hours" title="Hours played">${g.hours ? g.hours.toLocaleString() + ' h' : 'unplayed'}</span>` : ''}
      </div>
      <div class="card-title">${esc(g.name)}</div>
    </div>`;
  });
  dgRender(true);
}

/* ───────────── clicks ───────────── */

async function onClick(e) {
  if (chipClick(e)) return;
  const lt = e.target.closest('[data-dg-letter]');
  if (lt && !lt.disabled) { dg.letter = dg.letter === lt.dataset.dgLetter ? '' : lt.dataset.dgLetter; loadDigital(); return; }
  const tg = e.target.closest('[data-dg-toggle]');
  if (tg) { const k = tg.dataset.dgToggle; dg[k] = !dg[k]; dg.letter = ''; loadDigital(); return; }
  const dn = e.target.closest('[data-dg-density]');
  if (dn) { dg.density = dn.dataset.dgDensity; store.set('density', dg.density); $('#dg-grid')?.classList.toggle('compact', dg.density === 'compact'); paintToolbar(); return; }
  if (e.target.closest('#dg-top')) { $('#dg-grid')?.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (e.target.closest('#dg-reset')) { reset(); loadDigital(); return; }
  if (e.target.closest('[data-dg-clear]')) { dg.family = null; dg.picked = []; dg.letter = ''; loadDigital(); return; }
  const act = e.target.closest('[data-dg-act]');
  if (act) { if (act.dataset.dgAct === 'add') openAdd(); else if (act.dataset.dgAct === 'import') openImport(); else if (act.dataset.dgAct === 'art') openArtImport(); return; }
  const mk = e.target.closest('[data-dg-mark]');
  if (mk) {
    e.preventDefault(); e.stopPropagation();
    const card = mk.closest('.dg-card'), scroller = $('#dg-grid'), keepTop = scroller?.scrollTop || 0;
    try { await ctx.api(`/digital/games/${encodeURIComponent(card.dataset.dgStoreOf)}/${encodeURIComponent(card.dataset.dgApp)}/mark`, { method: 'PUT', body: JSON.stringify({ field: mk.dataset.dgMark, value: mk.dataset.value === '1' }) }); }
    catch (err) { ctx.toast(err.message, true); return; }
    await loadDigital(true); if (scroller) scroller.scrollTop = keepTop;   // the list is redrawn; stay where you were
    return;
  }
  const tile = e.target.closest('.dg-card');
  if (tile && !e.target.closest('.dg-launch')) { openDigitalDetail(tile.dataset.dgStoreOf, tile.dataset.dgApp); return; }
  if (e.target.closest('#dg-sync')) {
    const b = $('#dg-sync'); b.disabled = true;
    let steamOn = false;
    try { steamOn = (await ctx.api('/digital')).steam.connected; } catch { /* the sync below says what is wrong */ }
    if (steamOn) {
      try { const r = await ctx.api('/digital/steam/sync', { method: 'POST' }); ctx.toast(`${r.count.toLocaleString()} Steam games fetched`); }
      catch (err) { ctx.toast(err.message, true); }
    }
    // Console games with no details yet (or none found last time) are looked up again.
    try { const j = await ctx.api('/digital/consoles/details', { method: 'POST', body: JSON.stringify({ retry: true }) }); if (j.running && !steamOn) ctx.toast(`Looking up ${j.total.toLocaleString()} console games`); else if (!steamOn) ctx.toast('Every console game already has its details'); }
    catch (err) { if (!steamOn) ctx.toast(err.message, true); }
    b.disabled = false; loadDigital();
  }
}

/* ───────────── the details windows ───────────── */

function openShell(placeholder = false) {
  const token = (ctx.state.detailToken = (ctx.state.detailToken || 0) + 1);
  ctx.state.openRomId = null; ctx.state.openPhysical = null;
  if (placeholder) ctx.state.openDigital = { store: '', appId: '' };   // an add / import panel: still Digital's, so it closes when you leave
  const drawer = $('#drawer');
  drawer.classList.remove('hidden'); ctx.syncPin(); $('#scrim').classList.toggle('hidden', ctx.pinned());
  $('#drawer-body').innerHTML = '<div class="skel" style="height:300px"></div>';
  drawer.scrollTop = 0;
  return token;
}

const afterChange = async () => { const sc = $('#dg-grid'), keepTop = sc?.scrollTop || 0; if (ctx.state.view === 'digital') { await loadDigital(true); if (sc) sc.scrollTop = keepTop; } };
const gameUrl = (store, appId) => `/digital/games/${encodeURIComponent(store)}/${encodeURIComponent(appId)}`;

/** Open one game's details window: a Steam game's (favourite, hide, play switch, a store link) or a console game's (those, plus match and edit). */
export async function openDigitalDetail(store, appId) {
  const myOpen = openShell();
  ctx.state.openDigital = { store, appId: String(appId) };
  syncDigitalNav();
  let r;
  try { r = await ctx.api(gameUrl(store, appId)); }
  catch (err) { if (myOpen !== ctx.state.detailToken) return; ctx.toast(err.message, true); return ctx.closeDrawer(); }
  if (myOpen !== ctx.state.detailToken) return;
  if (store === 'steam') return renderSteamDetail(r.game, r.details, appId);
  return renderConsoleDetail(r.game, r.details, store, appId, r.custom);
}

const markHandlers = (g, store, appId) => $$('[data-dgd]', $('#drawer-body')).forEach((b) => b.addEventListener('click', async () => {
  const field = b.dataset.dgd, value = field === 'favourite' ? !g.favourite : field === 'play' ? !g.play : !g.hidden;
  try { await ctx.api(`${gameUrl(store, appId)}/mark`, { method: 'PUT', body: JSON.stringify({ field, value }) }); }
  catch (err) { ctx.toast(err.message, true); return; }
  openDigitalDetail(store, appId); afterChange();
}));

/* The details window for a Steam game: the library's window, trimmed to what applies (favourite, hide, play switch, a store link). There is nothing to
 * match or edit: the details come from Steam's public store page and are cached on the server. */
function renderSteamDetail(g, d, appId) {
  const I = ctx.ICON;
  const when = g.last_played ? new Date(g.last_played * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const rows = [
    ['Store', 'Steam'],
    ['Hours played', (g.hours ? `${g.hours.toLocaleString()} h` : 'not played yet') + ' <span class="note">(as of your last fetch)</span>'],
    ['Last played', when],
    ['Developer', d?.developers?.length ? esc(d.developers.join(', ')) : '—'],
    ['Publisher', d?.publishers?.length ? esc(d.publishers.join(', ')) : '—'],
    ['Released', d?.release ? esc(d.release) : '—'],
    ['Genre', d?.genres?.length ? esc(d.genres.join(', ')) : '—'],
    ['Metacritic', d?.metacritic ? `${d.metacritic} / 100` : '—'],
    ['Store price', d?.price ? esc(d.price) : '—'],
    ['Runs on', d?.platforms?.length ? esc(d.platforms.map((p) => ({ windows: 'Windows', mac: 'Mac', linux: 'Linux' })[p] || p).join(', ')) : '—'],
    ['Steam app ID', `<span class="mono">${esc(g.app_id)}</span>`]
  ];
  const pills = (d?.genres || []).length ? `<div class="genre-pills" aria-label="Genres">${d.genres.map((x) => `<span class="genre-pill">${esc(x)}</span>`).join('')}</div>` : '';
  $('#drawer-body').innerHTML = `
    ${pills}
    <div class="detail-cover dg-detail-cover" style="background:linear-gradient(160deg,#1b2838,#12141a)"${d?.header ? ` data-shot="${esc(d.header)}"` : ''}>
      <div class="card-fallback">${esc(initials(g.name))}</div>
      ${g.cover_url ? `<img src="${esc(g.cover_url)}" data-fb="${esc(g.cover_fallback_url || '')}" alt="" onload="this.previousElementSibling?.classList.add('has-cover')" onerror="if(this.dataset.fb&&!this.dataset.tried){this.dataset.tried=1;this.src=this.dataset.fb}else{this.style.display='none'}" />` : ''}
    </div>
    <div class="detail-head"><div style="flex:1">
      <h2 class="detail-title">${esc(g.name)}</h2>
      <div class="detail-plat"><i style="background:#1b2838"></i>Steam${d?.release ? ` · ${esc(d.release)}` : ''}</div>
    </div></div>
    <div class="detail-actions">
      ${g.launch_url ? `<a class="ibtn ibtn-play" data-act="play" href="${esc(g.launch_url)}" data-tip="Open in Steam (works on a PC that has Steam installed)" aria-label="Open in Steam">${I.play}</a>` : ''}
      <button class="ibtn${g.favourite ? ' is-on fav' : ''}" data-act="favorite" data-dgd="favourite" data-tip="${g.favourite ? 'Remove from favourites' : 'Add to favourites'}" aria-label="Favourite">${g.favourite ? I.starFill : I.star}</button>
      <button class="ibtn${g.play ? ' is-on' : ''}" data-act="dgplay" data-dgd="play" data-tip="${g.play ? 'Play button is on (click to turn it off)' : 'Play button is off: turn it on for games installed on this PC'}" aria-label="Play button ${g.play ? 'on' : 'off'}">${g.play ? I.gamepad : I.gamepadOff}</button>
      <button class="ibtn" data-act="dghide" data-dgd="hidden" data-tip="${g.hidden ? 'Unhide' : 'Hide from your Digital list'}" aria-label="${g.hidden ? 'Unhide' : 'Hide'}">${g.hidden ? I.eye : I.eyeOff}</button>
      <a class="ibtn" data-act="dgstore" href="https://store.steampowered.com/app/${encodeURIComponent(g.app_id)}" target="_blank" rel="noreferrer" data-tip="Open the Steam store page" aria-label="Open the Steam store page"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a>
    </div>
    ${d?.description ? `<p class="detail-desc">${esc(d.description)}</p>` : `<p class="hint">Steam has no store page for this game (it may be delisted or an add-on), so only your own details are shown.</p>`}
    ${d?.screenshots?.length ? `<div class="section-label">Screenshots</div><div class="media-strip">${d.screenshots.map((u) => `<a href="${esc(u)}" target="_blank" rel="noreferrer"><img loading="lazy" src="${esc(u)}" alt="" onerror="this.parentElement.remove()" /></a>`).join('')}</div>` : ''}
    <div class="section-label">Details</div>
    <dl class="meta-table">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  markHandlers(g, 'steam', appId);
}

/* The details window for a console game: the same window as Steam's, with what applies to a game brought in from a CSV or added by hand. There is no play
 * button. The details and cover come from the Library's metadata providers; match it by hand under Identify, or correct anything under Edit (those are your own
 * corrections: nobody else's list changes). Remove takes it out of your list. */
function renderConsoleDetail(g, d, store, appId, custom) {
  const I = ctx.ICON, st = badgeOf({ ...g, store });
  const list = (a) => (Array.isArray(a) ? a.join(', ') : '');
  const rows = [
    ['Platform', esc(g.store_label || st.label)],
    ['Store country', g.country_name ? esc(g.country_name) : '—'],
    ['Developer', d?.developers?.length ? esc(d.developers.join(', ')) : '—'],
    ['Publisher', d?.publishers?.length ? esc(d.publishers.join(', ')) : '—'],
    ['Released', d?.release ? esc(d.release) : '—'],
    ['Genre', d?.genres?.length ? esc(d.genres.join(', ')) : '—'],
    ['Rating', d?.rating != null ? `${esc(String(d.rating))} / 5` : '—'],
    ['Details from', d?.source ? esc(d.source) : '—']
  ];
  const pills = (d?.genres || []).length ? `<div class="genre-pills" aria-label="Genres">${d.genres.map((x) => `<span class="genre-pill">${esc(x)}</span>`).join('')}</div>` : '';
  $('#drawer-body').innerHTML = `
    ${pills}
    <div class="detail-cover dg-detail-cover" style="background:linear-gradient(160deg,${st.bg},#12141a)">
      <div class="card-fallback">${esc(initials(g.name))}</div>
      ${g.cover_url ? `<img src="${esc(g.cover_url)}" alt="" onload="this.previousElementSibling?.classList.add('has-cover');if(this.naturalWidth&&this.naturalHeight)this.parentElement.style.aspectRatio=Math.min(1.6,Math.max(0.5,this.naturalWidth/this.naturalHeight))" onerror="this.style.display='none'" />` : ''}
    </div>
    <div class="detail-head"><div style="flex:1">
      <h2 class="detail-title">${esc(g.name)}</h2>
      <div class="detail-plat"><i style="background:${st.bg}"></i>${esc(st.label)}${d?.release ? ` · ${esc(d.release)}` : ''}</div>
    </div></div>
    <div class="detail-actions">
      <button class="ibtn${g.favourite ? ' is-on fav' : ''}" data-act="favorite" data-dgd="favourite" data-tip="${g.favourite ? 'Remove from favourites' : 'Add to favourites'}" aria-label="Favourite">${g.favourite ? I.starFill : I.star}</button>
      <button class="ibtn" data-act="dghide" data-dgd="hidden" data-tip="${g.hidden ? 'Unhide' : 'Hide from your Digital list'}" aria-label="${g.hidden ? 'Unhide' : 'Hide'}">${g.hidden ? I.eye : I.eyeOff}</button>
      ${g.store_url ? `<a class="ibtn" data-act="dgstore" href="${esc(g.store_url)}" target="_blank" rel="noreferrer" data-tip="Find it in the ${esc(store === 'xbox' ? 'Xbox' : 'PlayStation')} Store${g.country_name ? ' (' + esc(g.country_name) + ')' : ''}" aria-label="Open the store page"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a>` : ''}
      ${g.physical ? `<span class="ibtn is-on dg-disc-ind" data-tip="Also on your shelf as a disc" role="img" aria-label="Also on your shelf as a disc">${I.disc}</span>` : ''}
      <button class="ibtn" data-d="lookup" data-tip="Look this game up again by its title and platform" aria-label="Look up again">${I.refresh}</button>
      <button class="ibtn" data-d="cover" data-tip="Upload your own cover (JPEG, PNG or WebP, up to 8 MB)" aria-label="Upload a cover">${I.image}</button>
      <input type="file" id="dg-cover-file" accept="image/jpeg,image/png,image/webp" class="hidden" />
      ${g.own_cover ? `<button class="ibtn" data-d="coverreset" data-tip="Go back to the automatic cover" aria-label="Automatic cover">${I.undo}</button>` : ''}
      ${custom ? `<button class="ibtn" data-d="clear" data-tip="Clear your match and edits: back to the details the providers found" aria-label="Clear match">${I.undo}</button>` : ''}
      <button class="ibtn ibtn-danger" data-act="delete" data-dgremove data-tip="Remove from your Digital list" aria-label="Remove">${I.trash}</button>
    </div>
    ${d?.description ? `<p class="detail-desc">${esc(d.description)}</p>` : `<p class="hint">${d ? 'No description was found for this game.' : 'No details or cover were found for this game yet. Search for it below and pick the right entry: the cover comes with it.'}</p>`}
    ${d?.screenshots?.length ? `<div class="section-label">Screenshots</div><div class="media-strip">${d.screenshots.map((u) => `<a href="${esc(u)}" target="_blank" rel="noreferrer"><img loading="lazy" src="${esc(u)}" alt="" onerror="this.parentElement.remove()" /></a>`).join('')}</div>` : ''}

    <div class="vid-slot" data-kind="digital" data-store="${esc(store)}" data-id="${esc(String(appId))}"></div>

    ${identifyBlock({ idp: 'dg', title: g.name, platform: DG_PLATFORM[g.platform]?.lib || 'all', prefs: ctx.state.prefs })}

    <div class="section-label">Details</div>
    <dl class="meta-table">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>

    <div class="section-label">Edit</div>
    <form class="edit-form" id="dg-edit">
      <div class="field-row">
        <label class="field"><span>Developer</span><input name="developers" value="${esc(list(d?.developers))}" /></label>
        <label class="field"><span>Publisher</span><input name="publishers" value="${esc(list(d?.publishers))}" /></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Genre</span><input name="genres" value="${esc(list(d?.genres))}" /></label>
        <label class="field"><span>Released</span><input name="release" value="${esc(d?.release || '')}" placeholder="Year" /></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Rating (0–5)</span><input name="rating" type="number" min="0" max="5" step="0.1" value="${d?.rating ?? ''}" /></label>
        <label class="field"><span>Store country</span><input name="country" value="${esc(g.country_name || '')}" placeholder="Australia or AU" /></label>
      </div>
      <label class="field"><span>Description</span><textarea name="description" rows="4">${esc(d?.description || '')}</textarea></label>
      <p class="hint" style="margin:0">Your changes are yours alone: nobody else's list changes.</p>
      <button class="btn btn-primary" type="submit">Save</button>
    </form>`;
  const body = $('#drawer-body');
  markHandlers(g, store, appId);
  const refreshAll = async () => { await afterChange(); await openDigitalDetail(store, appId); };
  $('[data-d="lookup"]', body).onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; b.classList.add('spin');
    try { const r = await ctx.api(`${gameUrl(store, appId)}/lookup`, { method: 'POST' }); ctx.toast(r.found ? 'Details found' : 'No match found: search for it below', !r.found); await refreshAll(); }
    catch (err) { ctx.toast(err.message, true); b.disabled = false; b.classList.remove('spin'); }
  };
  // Your own cover: choose a picture, or go back to the automatic one. It is yours alone.
  $('[data-d="cover"]', body).onclick = () => $('#dg-cover-file', body).click();
  $('#dg-cover-file', body).onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 8 * 1024 * 1024) { ctx.toast('That image is over 8 MB', true); e.target.value = ''; return; }
    const fd = new FormData(); fd.append('cover', f);
    try { await ctx.api(`${gameUrl(store, appId)}/cover`, { method: 'POST', body: fd }); ctx.toast('Cover updated'); await refreshAll(); } catch (err) { ctx.toast(err.message, true); }
    e.target.value = '';
  };
  $('[data-d="coverreset"]', body)?.addEventListener('click', async () => {
    try { await ctx.api(`${gameUrl(store, appId)}/cover`, { method: 'DELETE' }); ctx.toast('Back to the automatic cover'); await refreshAll(); } catch (err) { ctx.toast(err.message, true); }
  });
  $('[data-d="clear"]', body)?.addEventListener('click', async () => {
    try { await ctx.api(`${gameUrl(store, appId)}/match`, { method: 'DELETE' }); ctx.toast('Your match and edits are cleared'); await refreshAll(); } catch (err) { ctx.toast(err.message, true); }
  });
  $('[data-dgremove]', body)?.addEventListener('click', async () => {
    const ok = await ctx.confirmDialog({ title: `Remove ${g.name}?`, body: 'It is taken out of your Digital list. Importing your CSV again brings it back.', okLabel: 'Remove', danger: true });
    if (!ok) return;
    try { await ctx.api(gameUrl(store, appId), { method: 'DELETE' }); }
    catch (err) { ctx.toast(err.message, true); return; }
    ctx.toast(`${g.name} removed`); ctx.closeDrawer(); afterChange();
  });
  $('#dg-edit', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = Object.fromEntries(new FormData(e.target).entries());
    out.rating = out.rating === '' ? null : Number(out.rating);
    try { await ctx.api(gameUrl(store, appId), { method: 'PATCH', body: JSON.stringify(out) }); ctx.toast('Saved'); await refreshAll(); } catch (err) { ctx.toast(err.message, true); }
  });
  // Identify: the Library's search, with the picked entry (cover included) put on this game, for you only.
  wireIdentify(body, { idp: 'dg', ctx, onPick: async (cand) => { await ctx.api(`${gameUrl(store, appId)}/match`, { method: 'POST', body: JSON.stringify({ candidate: cand }) }); await refreshAll(); } });
}

/* ───────────── add a game by hand / import a CSV (both in the details window) ───────────── */

const consoleOptions = () => ['playstation', 'nintendo', 'xbox'].flatMap((s) => Object.entries(DG_PLATFORM).filter(([, p]) => p.store === s).map(([id, p]) => ({ value: id, label: p.label, hint: DG_STORE[s].label })));

let lastAdd = { platform: '', country: '' };   // kept while the form stays open (pinned, or "Add and another"), forgotten when it closes

function openAdd() {
  if ($('#drawer')?.classList.contains('hidden') || !$('#dg-add')) lastAdd = { platform: '', country: '' };
  openShell(true); $('#drawer-nav')?.classList.add('hidden');
  const first = lastAdd.platform || (dg.picked.length === 1 && dg.picked[0].startsWith('p:') ? dg.picked[0].slice(2) : '');
  $('#drawer-body').innerHTML = `
    <h2 class="detail-title">Add a game to your Digital Library</h2>
    <p class="hint">For PlayStation, Nintendo and Xbox games you own as downloads. Steam games come from Steam (set that up under Settings → My account → Steam), so they are not added by hand. Details and a cover are looked up afterwards, and you can match the game by hand if they are wrong.</p>
    <form class="edit-form" id="dg-add">
      <label class="field"><span>Title</span><input name="title" required autocomplete="off" /></label>
      <div class="field-row">
        <label class="field"><span>Console</span>${comboHtml({ options: consoleOptions(), selected: first, placeholder: 'Type to find a console…' })}</label>
        <label class="field"><span>Store country (optional)</span><input name="country" placeholder="Australia or AU" value="${esc(lastAdd.country)}" /></label>
      </div>
      <div style="display:flex;gap:8px"><button class="btn btn-primary" type="submit">Add to Digital Library</button><button class="btn" type="button" id="dg-add-more" title="Add this game and keep the form open">Add and another</button></div>
    </form>`;
  const form = $('#dg-add');
  wireCombo(form, 'platform', consoleOptions(), 'console');
  const submit = async (again) => {
    const body = Object.fromEntries(new FormData(form).entries());
    try { await ctx.api('/digital/games', { method: 'POST', body: JSON.stringify(body) }); } catch (err) { ctx.toast(err.message, true); return; }
    ctx.toast(`Added “${body.title}”`);
    lastAdd = { platform: body.platform || '', country: body.country || '' };
    await loadDigital(true);
    if (again || ctx.pinned()) { form.title.value = ''; form.title.focus(); }
    else { lastAdd = { platform: '', country: '' }; ctx.closeDrawer(); }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(false); });
  $('#dg-add-more').onclick = () => { if (form.reportValidity()) submit(true); };
  form.title.focus();
}

/** One line telling what an import did (or would do). */
function importSummary(r) {
  const per = Object.entries(r.by_store || {}).map(([k, v]) => `${esc(storeLabel(k))} ${n(v)}`).join(', ');
  const what = r.applied
    ? `<b>Imported.</b> ${n(r.added)} added, ${n(r.updated)} updated, ${n(r.unchanged)} already there${r.removed ? `, ${n(r.removed)} removed` : ''}.`
    : `${n(r.games)} games in the file (${per || 'none'}): ${n(r.added)} would be added, ${n(r.updated)} updated, ${n(r.unchanged)} ${r.unchanged === 1 ? 'is' : 'are'} already there${r.removed ? `, ${n(r.removed)} would be removed` : ''}.`;
  const notes = [r.physical_on ? `${n(r.physical_on)} marked as owned on disc or cartridge` : '', r.physical_off ? `${n(r.physical_off)} marked digital only` : '', r.duplicates ? `${n(r.duplicates)} repeated row${r.duplicates === 1 ? '' : 's'} counted once` : '', r.skipped ? `${n(r.skipped)} row${r.skipped === 1 ? '' : 's'} skipped` : ''].filter(Boolean).join('; ');
  return what + (notes ? ` ${notes}.` : '')
    + (r.problems?.length ? '<br>' + r.problems.map((p) => `Line ${p.line}: ${esc(p.reason)}`).join('<br>') : '')
    + (r.applied && r.details_job?.running ? `<br>Details and covers are being looked up now (${n(r.details_job.total)} games). They appear here as they are found.` : '');
}

/** Bring in covers for your console games from a folder on the server (see public/artimport-ui.js). */
function openArtImport() {
  openShell(true); $('#drawer-nav')?.classList.add('hidden');
  renderArtImport(ctx, $('#drawer-body'), { target: 'digital', onDone: () => loadDigital(true) });
}

function openImport() {
  openShell(true); $('#drawer-nav')?.classList.add('hidden');
  $('#drawer-body').innerHTML = `
    <h2 class="detail-title">Import a CSV</h2>
    <p class="hint">A CSV with the columns <code>Platform</code>, <code>Game</code> and <code>Country</code>, and optionally <code>Media</code> (the first row names the columns, in any order). The platform can be <b>PS3</b>, <b>PS4</b>, <b>PS5</b>, <b>Switch 2</b>, <b>Switch</b>, <b>Wii</b>, <b>Wii U</b>, <b>3DS</b>, <b>DS</b>, <b>Xbox</b>, <b>Xbox 360</b>, <b>Xbox One</b> or <b>Xbox Series X|S</b>. Importing the same file again adds nothing twice. Preview shows what would change before anything is saved.</p>
    <div class="panel" style="padding:12px;display:grid;gap:10px">
      <label class="field"><span>CSV file</span><input type="file" id="dg-imp-file" accept=".csv,text/csv" class="file-input" /></label>
      <label class="policy-row"><input type="checkbox" id="dg-imp-replace" /> <span>Remove games no longer in the file (only for the platforms the file lists)</span></label>
      <div style="display:flex;gap:8px"><button class="btn" id="dg-imp-preview">Preview</button><button class="btn btn-primary" id="dg-imp-apply" disabled>Import games</button></div>
      <p class="hint" id="dg-imp-result" style="margin:0"></p>
    </div>`;
  const file = $('#dg-imp-file'), out = $('#dg-imp-result'), apply = $('#dg-imp-apply');
  const run = async (doApply) => {
    const f = file.files?.[0]; if (!f) return ctx.toast('Choose a CSV file first', true);
    let csv; try { csv = await f.text(); } catch { return ctx.toast('The file could not be read', true); }
    try {
      const r = await ctx.api('/digital/consoles/import', { method: 'POST', body: JSON.stringify({ csv, apply: doApply, replace: $('#dg-imp-replace').checked }) });
      out.innerHTML = importSummary(r);
      apply.disabled = doApply || !(r.added || r.updated || r.removed || r.physical_on || r.physical_off);
      if (doApply) { ctx.toast(`${n(r.added)} console games added to your Digital Library`); loadDigital(true); }
    } catch (err) { out.textContent = err.message; ctx.toast(err.message, true); }
  };
  $('#dg-imp-preview').onclick = () => run(false); apply.onclick = () => run(true);
  file.onchange = () => { apply.disabled = true; out.textContent = ''; }; $('#dg-imp-replace').onchange = () => { apply.disabled = true; };
}
