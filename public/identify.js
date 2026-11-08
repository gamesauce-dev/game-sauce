// "Identify this game": the Library's manual match, shared by the pages that keep games with no ROM behind them (Physical and Digital).
// Search TheGamesDB, IGDB or LaunchBox by title (and platform), pick the right entry, and the page puts its details and cover on the game.
// The search itself is the Library's own (POST /metadata/search); what picking an entry does is up to the page (onPick).
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sorter = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;

/** <option>s for every Library platform, grouped by family. any: adds "Any platform" first. */
export function platformSelect(selected, { any = false } = {}) {
  const groups = new Map();
  for (const p of (window.__platformsCache || []).filter((x) => x.slug !== 'other')) { const f = p.family || 'Others'; if (!groups.has(f)) groups.set(f, []); groups.get(f).push(p); }
  return (any ? '<option value="all">Any platform</option>' : '') + [...groups.keys()].sort(sorter).map((f) => `<optgroup label="${esc(f)}">${groups.get(f).sort((a, b) => sorter(a.name, b.name)).map((p) => `<option value="${esc(p.slug)}"${p.slug === selected ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>`).join('');
}

/* A type-to-find box in place of a long <select> (which can only jump by first letter): type any part of a name and the list narrows, pick one, or type it in full.
   The visible box has no name; the hidden one carries the value (the slug / id) that the form sends, and is empty until what was typed is one of the options. */
let comboN = 0;
export function platformOptions() {
  const sorted = (window.__platformsCache || []).filter((x) => x.slug !== 'other').map((p) => ({ value: p.slug, label: p.name, hint: p.family || 'Others' }));
  return sorted.sort((a, b) => sorter(a.hint, b.hint) || sorter(a.label, b.label));
}
export function comboHtml({ name = 'platform', options, selected = '', placeholder = 'Type to find…', required = true }) {
  const id = `combo-${name}-${++comboN}`, cur = options.find((o) => o.value === selected);
  return `<input type="text" class="combo-text" data-combo="${name}" list="${id}" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" value="${esc(cur?.label || '')}"${required ? ' required' : ''} />`
    + `<input type="hidden" name="${name}" value="${esc(cur?.value || '')}" />`
    + `<datalist id="${id}">${options.map((o) => `<option value="${esc(o.label)}"${o.hint ? ` label="${esc(o.hint)}"` : ''}></option>`).join('')}</datalist>`;
}
export function wireCombo(form, name, options, what = 'platform') {
  const text = form.querySelector(`[data-combo="${name}"]`), hid = form.elements[name]; if (!text || !hid) return;
  const find = () => {
    const t = text.value.trim().toLowerCase(); if (!t) return null;
    const exact = options.find((o) => o.label.toLowerCase() === t); if (exact) return exact;
    const part = options.filter((o) => o.label.toLowerCase().includes(t)); return part.length === 1 ? part[0] : null;   // one clear match is taken
  };
  const sync = (commit) => { const o = find(); hid.value = o?.value || ''; if (commit && o) text.value = o.label; text.setCustomValidity(o || !text.value.trim() ? '' : `Choose a ${what} from the list`); };
  text.addEventListener('input', () => sync(false)); text.addEventListener('change', () => sync(true)); sync(false);
}

const PROVIDERS = [['thegamesdb', 'TheGamesDB'], ['igdb', 'IGDB'], ['launchbox', 'LaunchBox']];

/** The section's markup. idp is a prefix for the element ids (so two pages never clash), platform a Library platform slug for the platform box. */
export function identifyBlock({ idp, title, platform, prefs }) {
  const prov = prefs?.identify_provider || 'thegamesdb';
  return `
    <div class="section-label">Identify this game</div>
    <div class="panel" style="padding:12px">
      <p class="hint" style="margin:0 0 10px">No match, wrong game, or missing art? Search and pick the right entry — cover included.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="${idp}-id-q" class="search" style="flex:1;min-width:180px" type="search" placeholder="Title to search…" value="${esc(title)}" autocomplete="off" />
        <select id="${idp}-id-prov" class="select" title="Which catalogue to search">${PROVIDERS.map(([v, l]) => `<option value="${v}"${v === prov ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <select id="${idp}-id-plat" class="select" style="max-width:190px">${platformSelect(platform, { any: true })}</select>
        <button class="btn" id="${idp}-id-go">Search</button>
      </div>
      <div id="${idp}-id-list" class="results" style="margin-top:10px"></div>
    </div>`;
}

/** Make the section work. onPick(candidate) puts the entry on the game (and redraws); a failure is shown and the search runs again. */
export function wireIdentify(root, { idp, ctx, onPick }) {
  const q = $(`#${idp}-id-q`, root), list = $(`#${idp}-id-list`, root);
  const run = async () => {
    const text = q.value.trim(); if (!text) return ctx.toast('Type a title to search for', true);
    const provider = $(`#${idp}-id-prov`, root).value, label = { igdb: 'IGDB', launchbox: 'LaunchBox' }[provider] || 'TheGamesDB';
    list.innerHTML = `<div class="side-empty">Searching ${label}…</div>`;
    try {
      const data = await ctx.api('/metadata/search', { method: 'POST', body: JSON.stringify({ q: text, platform: $(`#${idp}-id-plat`, root).value || 'all', provider }) });
      if (!data.items?.length) { list.innerHTML = `<div class="side-empty">${esc(data.error || 'No matches — try fewer words, another platform, or the other provider.')}</div>`; return; }
      list.innerHTML = data.items.map((c, i) => `
        <button class="result-row ${c.has_cover ? 'ok' : 'skip'}" data-cand="${i}">
          <span class="status"></span>
          ${c.cover_url ? `<img class="candidate-cover" loading="lazy" src="${esc(c.cover_url)}" alt="" onerror="this.remove()" />` : ''}
          <span class="name">${esc(c.title)}${c.release_year ? ` <span class="note">(${c.release_year})</span>` : ''}<span class="note"> · ${esc(c.source === 'igdb' ? 'IGDB' : c.source === 'launchbox' ? 'LaunchBox' : 'TGDB')}</span></span>
          <span class="note">${c.has_cover ? 'art ✓' : 'no art'}</span>
        </button>`).join('');
      $$('[data-cand]', list).forEach((btn) => btn.addEventListener('click', async () => {
        const cand = data.items[Number(btn.dataset.cand)];
        btn.disabled = true; btn.innerHTML = '<span class="status"></span><span class="name">Applying… downloading cover…</span>';
        try { await onPick(cand); ctx.toast(`Matched as “${cand.title}”`); }
        catch (err) { ctx.toast(err.message, true); btn.disabled = false; run(); }
      }));
    } catch (err) { list.innerHTML = `<div class="side-empty">${esc(err.message)}</div>`; }
  };
  $(`#${idp}-id-go`, root).onclick = run;
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
}
