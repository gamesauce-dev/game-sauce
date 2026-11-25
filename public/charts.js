// Small SVG / HTML charts for Settings > Reports. No library: each function returns a string of HTML. Colours come from the page's own variables (public/reports.css),
// so they follow the light and dark themes. Every chart is plain markup with labels, so it reads without colour and works for a screen reader.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString();

/** A card of ranked bars: the label inside the bar, the count at the right, a track behind. Shows the top `top` rows, or all of them when `all` is true.
 *  rows: [{ label, count, go? }]  A row with `go` can be clicked (data-go, data-i). */
export function rankedCard({ id, title, rows, top = 5, all = false, more = 'tap to show all', less = 'show top 5', empty = 'Nothing to show yet.' }) {
  const shown = all ? rows : rows.slice(0, top);
  const max = rows[0]?.count || 1;
  const list = shown.length ? shown.map((r, i) => `<div class="rp-row${r.go ? ' go' : ''}" role="${r.go ? 'button' : 'listitem'}"${r.go ? ` tabindex="0" data-go="${esc(id)}" data-i="${i}"` : ''} title="${esc(r.label)}: ${num(r.count)}">
      <i style="width:${Math.max(2, Math.round((r.count / max) * 100))}%"></i><span>${esc(r.label)}</span><em>${num(r.count)}</em></div>`).join('') : `<p class="rp-empty">${esc(empty)}</p>`;
  return `<section class="rp-card" id="rp-${esc(id)}"><header><b>${esc(title)}</b>${rows.length > top ? `<button type="button" class="rp-more" data-more="${esc(id)}">${esc(all ? less : more)}</button>` : ''}</header><div class="rp-body" role="list">${list}</div></section>`;
}

/** A donut: parts [{ label, value }] with the total in the middle. Up to 8 parts get their own colour, the rest are folded into "Other". */
export function donutCard({ title, parts, centre, other = 'Other', unit = 'games' }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  let list = parts.filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  if (list.length > 8) { const rest = list.slice(7).reduce((s, p) => s + p.value, 0); list = [...list.slice(0, 7), { label: other, value: rest }]; }
  let off = 0;
  const arcs = list.map((p, i) => {
    const pct = (p.value / total) * 100, len = Math.max(0, pct - 0.6);
    const a = `<circle class="rp-arc s${i + 1}" cx="21" cy="21" r="15.9155" fill="none" stroke-width="6" stroke-dasharray="${len.toFixed(2)} ${(100 - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 21 21)"><title>${esc(p.label)}: ${num(p.value)}</title></circle>`;
    off += pct; return a;
  }).join('');
  const lines = list.map((p, i) => `<li><s class="s${i + 1}"></s><span>${esc(p.label)}</span><b>${Math.round((p.value / total) * 100)}%</b><small>${num(p.value)}</small></li>`).join('');
  return `<section class="rp-card"><header><b>${esc(title)}</b></header><div class="rp-body rp-donut">
    <svg viewBox="0 0 42 42" width="150" height="150" role="img" aria-label="${esc(title)}: ${esc(list.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', '))}">
      <circle cx="21" cy="21" r="15.9155" fill="none" class="rp-ring" stroke-width="6"/>${arcs}
      <text x="21" y="22.4" text-anchor="middle" class="rp-big">${num(centre ?? total)}</text><text x="21" y="27.6" text-anchor="middle" class="rp-sm">${esc(unit)}</text></svg>
    <ul class="rp-legend">${lines}</ul></div></section>`;
}

/** Stacked horizontal bars, one per row: segments [{ key, label }] with the row's values by key; each row sums to its own count. */
export function stackedCard({ title, rows, segments, note = '', of = 'of' }) {
  const body = rows.map((r) => {
    const t = r.count || 1;
    const bar = segments.map((s, i) => { const v = r[s.key] || 0; return v ? `<div class="s${i + 1}${r.slug ? ' go' : ''}" style="width:${(v / t) * 100}%" title="${esc(s.label)}: ${num(v)} (${Math.round((v / t) * 100)}%)"${r.slug ? ` role="button" tabindex="0" data-seg="${esc(s.key)}" data-row="${esc(r.slug)}"` : ''}></div>` : ''; }).join('');
    return `<div class="rp-lbl"><span>${esc(r.label)}</span><span>${Math.round(((r[segments[0].key] || 0) / t) * 100)}% ${esc(segments[0].label.toLowerCase())} <small>${esc(of)} ${num(r.count)}</small></span></div><div class="rp-stk">${bar}</div>`;
  }).join('');
  const legend = segments.map((s, i) => `<span><s class="s${i + 1}"></s>${esc(s.label)}</span>`).join('');
  return `<section class="rp-card rp-wide"><header><b>${esc(title)}</b>${note ? `<small>${esc(note)}</small>` : ''}</header><div class="rp-body">${body}<div class="rp-key">${legend}</div></div></section>`;
}

/** Columns for an ordered series [{ label, count }] (release years, growth over days). */
export function columnsCard({ title, rows, note = '' }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const cols = rows.map((r) => `<div title="${esc(r.label)}: ${num(r.count)}"><em>${num(r.count)}</em><i style="height:${Math.max(2, Math.round((r.count / max) * 100))}%"></i><span>${esc(r.label)}</span></div>`).join('');
  return `<section class="rp-card rp-wide"><header><b>${esc(title)}</b>${note ? `<small>${esc(note)}</small>` : ''}</header><div class="rp-body"><div class="rp-cols">${cols}</div></div></section>`;
}

/** The same game on several platforms of one generation. groups: [{ title, gen, platforms: [{ name }] }]. Tabs pick the generation; informational only. */
export function sameGameCard({ title, groups, byGen, gen, all = false, top = 12, note = '', genLabel = (g) => 'Generation ' + g, more = 'show all', less = 'show fewer', empty = 'No game turns up on more than one platform of a generation.', check = 'Check a title', checkHint = 'Type part of a game name' }) {
  const tabs = byGen.map((g) => `<button type="button" class="rp-tab${g.gen === gen ? ' on' : ''}" data-gen="${g.gen}">${esc(genLabel(g.gen))} <small>${num(g.count)}</small></button>`).join('');
  const list = groups.filter((x) => x.gen === gen);
  const shown = all ? list : list.slice(0, top);
  const rows = shown.map((x) => `<li><b>${esc(x.title)}</b><span>${x.platforms.map((p) => `<s title="${esc((p.kinds || []).join(', '))}">${esc(p.name)}</s>`).join('')}</span></li>`).join('');
  return `<section class="rp-card rp-wide" id="rp-same"><header><b>${esc(title)}</b>${note ? `<small>${esc(note)}</small>` : ''}</header><div class="rp-body">
    <form class="rp-find" role="search"><input type="search" name="q" placeholder="${esc(checkHint)}" aria-label="${esc(check)}" maxlength="80"><button type="submit" class="btn btn-sm">${esc(check)}</button></form><div class="rp-found" aria-live="polite"></div>
    ${byGen.length ? `<div class="rp-tabs" role="tablist">${tabs}</div><ul class="rp-same">${rows}</ul>${list.length > top ? `<button type="button" class="rp-more rp-more-same" data-more="same">${esc(all ? less : `${more} (${num(list.length)})`)}</button>` : ''}` : `<p class="rp-empty">${esc(empty)}</p>`}</div></section>`;
}
