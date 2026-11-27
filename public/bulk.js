// Select mode for the Digital and Physical tile lists: pick tiles (or Select all of what the filters show), then favourite, hide or delete them in one go.
// Each list says how to read a tile's key, what "all" is, and how to delete; this file does the bar, the ticks and the confirmation.
// While select mode is on, a click on a tile picks it instead of opening its details.
import { t } from './i18n.js';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const n = (v) => Number(v || 0).toLocaleString();

/**
 * view: the list's page element; grid: the element holding the tiles; tile: CSS selector of one tile; keyOf(tileEl) -> key or null (null = cannot be picked);
 * allKeys() -> every deletable key under the current filters; remove(keys) -> Promise<number>; reload(); ctx: { confirmDialog, toast };
 * noun: "game"; where: what the entries are taken out of ("your Digital library"); toggleSel: the button that turns the mode on; barAfter: element the bar goes after.
 * marks (optional): { favourite(keys, value) -> Promise<number>, hidden(keys, value) -> Promise<number> } adds the four buttons that turn a favourite or a hide on and off for the picked games.
 * deletable(keys) -> the keys that can be deleted (a Steam game cannot: it comes from Steam).
 */
export function attachBulk({ view, grid, tile, keyOf, allKeys, remove, reload, ctx, noun = 'game', where, toggleSel, barAfter, canStart = () => true, marks = null, deletable = (keys) => keys }) {
  if (!view || !grid || view.dataset.bulk) return { off() {} };
  view.dataset.bulk = '1';
  const picked = new Set();
  let on = false;

  const bar = document.createElement('div');
  bar.className = 'sel-bar hidden';
  bar.innerHTML = `<span class="sel-count">${t('Selected: {count}', { count: 0 })}</span>
    <button type="button" class="btn btn-sm" data-bulk="all" title="Select every game the filters show"></button>
    <button type="button" class="btn btn-sm" data-bulk="none" title="Clear the selection">Untick all</button>
    ${marks ? `<button type="button" class="btn btn-sm" data-bulk="fav-on" title="Add the selected games to your favourites" disabled>★ Favourite</button>
    <button type="button" class="btn btn-sm" data-bulk="fav-off" title="Remove the selected games from your favourites" disabled>☆ Unfavourite</button>
    <button type="button" class="btn btn-sm" data-bulk="hide" title="Hide the selected games (nothing is deleted)" disabled>◌ Hide</button>
    <button type="button" class="btn btn-sm" data-bulk="unhide" title="Show the selected hidden games again" disabled>● Unhide</button>` : ''}
    <button type="button" class="btn btn-sm btn-danger" data-bulk="delete" title="Delete the selected games from ${where}" disabled>🗑 Delete selected</button>
    <button type="button" class="btn btn-sm" data-bulk="done" title="Leave selection mode">✕ Done</button>`;
  barAfter.insertAdjacentElement('afterend', bar);

  const paint = () => {
    $$(tile, grid).forEach((t) => { const k = keyOf(t); t.classList.toggle('bulk-picked', k != null && picked.has(k)); t.classList.toggle('bulk-off', on && k == null); });
    const total = allKeys().length;
    $('.sel-count', bar).textContent = t('Selected: {count}', { count: n(picked.size) });
    const all = $('[data-bulk="all"]', bar); all.textContent = `Select all (${n(total)})`; all.title = `Select all ${n(total)} shown`;   // the title is what the icon-only look keeps
    $$('[data-bulk="delete"], [data-bulk="fav-on"], [data-bulk="fav-off"], [data-bulk="hide"], [data-bulk="unhide"]', bar).forEach((b) => { b.disabled = !picked.size; });
  };
  let raf = 0; const soon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (on) paint(); }); };
  new MutationObserver(soon).observe(grid, { childList: true, subtree: true });   // tiles are drawn a screenful at a time

  const set = (next) => {
    on = next; if (!on) picked.clear();
    view.classList.toggle('bulk-mode', on); bar.classList.toggle('hidden', !on);
    const t = $(toggleSel, view); if (t) { t.classList.toggle('is-on', on); t.textContent = on ? '☑ Selecting' : '☐ Select'; }
    paint();
  };

  // Capture phase: runs before the list's own click handler, so a pick never opens the details window.
  view.addEventListener('click', async (e) => {
    const tg = e.target.closest(toggleSel);
    if (tg) { e.stopPropagation(); if (!on && !canStart()) return; set(!on); return; }
    if (!on) return;
    const b = e.target.closest('[data-bulk]');
    if (b && bar.contains(b)) {
      e.stopPropagation();
      const act = b.dataset.bulk;
      if (act === 'all') { allKeys().forEach((k) => picked.add(k)); paint(); }
      else if (act === 'none') { picked.clear(); paint(); }
      else if (act === 'done') set(false);
      else if (marks && picked.size && ['fav-on', 'fav-off', 'hide', 'unhide'].includes(act)) {
        const keys = [...picked], field = act.startsWith('fav') ? 'favourite' : 'hidden', value = act === 'fav-on' || act === 'hide';
        b.disabled = true;
        try {
          const done = await marks[field](keys, value), s = done === 1 ? '' : 's';
          ctx.toast(act === 'fav-on' ? `${n(done)} ${noun}${s} added to your favourites` : act === 'fav-off' ? `${n(done)} ${noun}${s} removed from your favourites` : act === 'hide' ? `${n(done)} ${noun}${s} hidden` : `${n(done)} ${noun}${s} shown again`);
          picked.clear(); await reload();
        } catch (err) { ctx.toast(err.message, true); }
        paint();
      }
      else if (act === 'delete' && picked.size) {
        const keys = deletable([...picked]), c = keys.length;
        if (!c) return ctx.toast('Games that come from Steam are not deleted here', true);
        const ok = await ctx.confirmDialog({ title: `Delete ${n(c)} ${noun}${c === 1 ? '' : 's'}?`, body: `They are taken out of ${where}. This cannot be undone.`, okLabel: 'Delete', danger: true });
        if (!ok) return;
        b.disabled = true;
        try { const done = await remove(keys); ctx.toast(`${n(done)} ${noun}${done === 1 ? '' : 's'} deleted`); picked.clear(); await reload(); }
        catch (err) { ctx.toast(err.message, true); }
        paint();
      }
      return;
    }
    const t = e.target.closest(tile);
    if (t && grid.contains(t)) {
      e.preventDefault(); e.stopPropagation();
      const k = keyOf(t); if (k == null) return;
      if (picked.has(k)) picked.delete(k); else picked.add(k);
      paint();
    }
  }, true);

  return { off: () => set(false), isOn: () => on };
}
