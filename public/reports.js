// Settings > Reports (admin): the whole collection (ROM Library, Physical shelves, Digital lists) as cards of charts. The numbers come from GET /api/admin/reports.
import { rankedCard, donutCard, stackedCard, columnsCard, sameGameCard } from './charts.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString();
const open = new Set();   // the ranked cards that are showing all their rows
let data = null, root = null, ctx = null, gen = null;

function rows(kind) {
  const list = data[kind] || [];
  // A platform with a Library slug and a genre can be opened in the Library; years and shelf / Digital-only platforms have nothing to filter on yet.
  if (kind === 'platforms') return list.map((r) => ({ ...r, go: r.slug ? { platform: r.slug } : null }));
  if (kind === 'genres') return list.map((r) => ({ ...r, go: data.totals.roms ? { genre: r.label } : null }));
  return list;
}

function draw() {
  const { t } = ctx, T = data.totals, cp = data.cross_platform || { groups: [], by_generation: [] };
  if (!cp.by_generation.some((g) => g.gen === gen)) gen = cp.by_generation[0]?.gen ?? null;
  const tile = (k, v) => `<div class="rp-tile"><b>${num(v)}</b><span>${esc(t(k))}</span></div>`;
  const hist = (data.history || []).map((h) => ({ label: h.day.slice(5), count: h.all || 0 })).slice(-30);
  const years = (data.years || []).map((y) => ({ label: y.label, count: y.count })).sort((a, b) => Number(a.label) - Number(b.label)).slice(-40);
  const card = (id, title, kind) => rankedCard({ id, title: t(title), rows: rows(kind), all: open.has(id), more: t('tap to show all'), less: t('show top 5'), empty: t('Nothing to show yet.') });
  root.innerHTML = `
    <div class="rp-tiles">${tile('Games in all', T.all)}${tile('Platforms', T.platforms)}${tile('With a cover', T.with_cover)}${tile('Complete (cover and description)', T.complete)}</div>
    <div class="rp-grid">
      ${donutCard({ title: t('Collection split'), parts: [{ label: t('ROM library'), value: T.roms }, { label: t('Physical shelves'), value: T.physical }, { label: t('Digital'), value: T.digital }], centre: T.all, unit: t('games') })}
      ${card('platforms', 'Games by platform', 'platforms')}
      ${card('genres', 'Games by genre', 'genres')}
      ${card('years', 'Games by release year', 'years')}
      ${stackedCard({ title: t('Completeness by platform'), note: t('the 14 biggest platforms; click a part of a bar to see those games'), of: t('of'), rows: data.completeness || [],
        segments: [{ key: 'complete', label: t('Complete') }, { key: 'no_cover', label: t('No cover') }, { key: 'no_desc', label: t('No description') }, { key: 'neither', label: t('Neither') }] })}
      ${sameGameCard({ title: t('The same game on several platforms'), note: t('ROM library, shelves and Digital together; same console generation; for information'), groups: cp.groups, byGen: cp.by_generation, gen, all: open.has('same'),
        genLabel: (g) => t('Generation {n}', { n: g }), more: t('show all'), less: t('show fewer'), empty: t('No game turns up on more than one platform of a generation.'), check: t('Check a title'), checkHint: t('Type part of a game name') })}
      ${years.length > 1 ? columnsCard({ title: t('Release years, in order'), rows: years, note: t('the latest 40 years with games') }) : ''}
      ${columnsCard({ title: t('Collection size by day'), rows: hist, note: hist.length > 1 ? t('one reading a day') : t('One reading a day: the trend appears as the days pass.') })}
    </div>
    <p class="hint rp-foot">${esc(t('Counts every account together; a game on several accounts is counted once. Hidden and System items are left out.'))}</p>`;
}

function onClick(e) {
  const more = e.target.closest('[data-more]');
  if (more) { const id = more.dataset.more; open.has(id) ? open.delete(id) : open.add(id); draw(); return; }
  const seg = e.target.closest('[data-seg]');
  if (seg) {   // a part of a completeness bar: that platform's games with that gap (no cover, no description, or both)
    const k = seg.dataset.seg, go = { platform: seg.dataset.row };
    if (k === 'no_cover' || k === 'neither') go.cover = 'none';
    if (k === 'no_desc' || k === 'neither') go.desc = 'none';
    ctx.openLibrary(go); return;
  }
  const tab = e.target.closest('[data-gen]');
  if (tab) { gen = Number(tab.dataset.gen); open.delete('same'); draw(); return; }
  const row = e.target.closest('[data-go]');
  if (row) { const r = rows(row.dataset.go)[Number(row.dataset.i)]; if (r?.go) ctx.openLibrary(r.go); }
}

const KIND = { roms: 'ROM library', physical: 'Physical shelf', digital: 'Digital' };
async function find(form) {
  const out = form.parentNode.querySelector('.rp-found'), q = form.q.value.trim();
  if (q.length < 2) { out.textContent = ''; return; }
  const { items } = await ctx.api('/admin/reports/find?q=' + encodeURIComponent(q));
  const t = ctx.t;
  out.innerHTML = items.length ? `<table>${items.map((i) => `<tr><td>${esc(i.title)}</td><td>${esc(i.platform)}</td><td>${esc(t(KIND[i.kind] || i.kind))}</td>
    <td>${i.gen ? esc(t('Generation {n}', { n: i.gen })) : esc(t('no console generation'))}</td>
    <td class="${i.same_generation ? 'ok' : 'no'}">${i.same_generation ? esc(t('also on {n} other platform(s) of this generation', { n: i.same_generation })) : esc(t('not on another platform of this generation'))}</td></tr>`).join('')}</table>` : `<span class="no">${esc(t('No game with that name.'))}</span>`;
}

/** Show the Reports panel's charts. ctx: { api, t, openLibrary({ platform?, genre? }) }. */
export async function load(el, c) {
  root = el; ctx = c;
  if (!root.dataset.wired) { root.dataset.wired = '1'; root.addEventListener('submit', (e) => { if (e.target.closest('.rp-find')) { e.preventDefault(); find(e.target).catch(() => {}); } }); root.addEventListener('click', onClick); root.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-go], [data-seg]')) { e.preventDefault(); onClick(e); } }); }
  root.innerHTML = `<p class="hint">${esc(ctx.t('Counting the collection…'))}</p>`;
  data = await ctx.api('/admin/reports');
  draw();
}
