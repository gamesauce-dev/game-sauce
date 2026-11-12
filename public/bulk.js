// Select mode for the Digital and Physical tile lists: pick tiles (or Select all of what the filters show), then delete them in one go.
// Each list says how to read a tile's key, what "all" is, and how to delete; this file does the bar, the ticks and the confirmation.
// While select mode is on, a click on a tile picks it instead of opening its details.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const n = (v) => Number(v || 0).toLocaleString();

/**
 * view: the list's page element; grid: the element holding the tiles; tile: CSS selector of one tile; keyOf(tileEl) -> key or null (null = cannot be picked);
 * allKeys() -> every deletable key under the current filters; remove(keys) -> Promise<number>; reload(); ctx: { confirmDialog, toast };
 * noun: "game"; where: what the entries are taken out of ("your Digital library"); toggleSel: the button that turns the mode on; barAfter: element the bar goes after.
 */
export function attachBulk({ view, grid, tile, keyOf, allKeys, remove, reload, ctx, noun = 'game', where, toggleSel, barAfter, canStart = () => true }) {
  if (!view || !grid || view.dataset.bulk) return { off() {} };
  view.dataset.bulk = '1';
  const picked = new Set();
  let on = false;

  const bar = document.createElement('div');
  bar.className = 'sel-bar hidden';
  bar.innerHTML = `<span class="sel-count">0 selected</span>
    <button type="button" class="btn btn-sm" data-bulk="all" title="Select every game the filters show"></button>
    <button type="button" class="btn btn-sm" data-bulk="none" title="Untick all">Untick all</button>
    <button type="button" class="btn btn-sm btn-danger" data-bulk="delete" title="Delete selected" disabled>🗑 Delete selected</button>
    <button type="button" class="btn btn-sm" data-bulk="done" title="Leave selection mode">✕ Done</button>`;
  barAfter.insertAdjacentElement('afterend', bar);

  const paint = () => {
    $$(tile, grid).forEach((t) => { const k = keyOf(t); t.classList.toggle('bulk-picked', k != null && picked.has(k)); t.classList.toggle('bulk-off', on && k == null); });
    const total = allKeys().length;
    $('.sel-count', bar).textContent = `${n(picked.size)} selected`;
    const all = $('[data-bulk="all"]', bar); all.textContent = `Select all (${n(total)})`; all.title = `Select all ${n(total)} shown`;   // the title is what the icon-only look keeps
    $('[data-bulk="delete"]', bar).disabled = !picked.size;
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
      else if (act === 'delete' && picked.size) {
        const keys = [...picked], c = keys.length;
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
