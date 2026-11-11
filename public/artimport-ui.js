// "Import pictures & manuals" (Physical) and "Import covers" (Digital): bring in pictures you already have, from a folder on the server that an admin has listed
// (Settings > Artwork folders). Shown in the details window. A preview says what would happen; nothing is saved until Import is pressed, and it runs in the background.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Number(v || 0).toLocaleString();

/** Draw the panel into `body`. ctx: the page's { api, toast }. target: 'physical' (covers, spines, discs, manuals) or 'digital' (covers of console games). onDone runs after an import. */
export async function renderArtImport(ctx, body, { target, onDone = () => {}, select = '' }) {
  const kinds = target === 'digital' ? [['cover', 'Covers']] : [['cover', 'Covers'], ['spine', 'Spines'], ['disc', 'Discs'], ['manual', 'Manuals']];
  const what = target === 'digital' ? 'covers' : 'pictures and manuals';
  body.innerHTML = `
    <h2 class="detail-title">${target === 'digital' ? 'Import covers' : 'Import pictures &amp; manuals'}</h2>
    <p class="hint">Bring in ${what} you already have, from a folder on the server. Put them in a folder named after the platform, with a folder inside for each kind: <b>images</b> (or covers, box, front), <b>spines</b>, <b>discs</b>${target === 'digital' ? '' : ', <b>manuals</b>, or <b>wrap</b> for a whole case in one picture (back, spine and front: it is cut for you)'}, and a region folder inside that if you like (LaunchBox and RetroBat folders are recognised as they are). They are matched to your games by platform and title. Nothing is saved until you press <b>Import</b>, and pictures you uploaded yourself are never replaced.</p>
    <div class="panel" id="art-box" style="padding:12px;display:grid;gap:10px">
      <div id="art-add"></div>
      <label class="field" id="art-folder-row"><span>Folder to import from</span><select id="art-folder" class="select"></select></label>
      <details id="art-pick"><summary>The folder names do not say what the pictures are? Tell me instead</summary>
        <div style="display:grid;gap:10px;margin-top:8px">
          <label class="field"><span>Everything in the folder is</span><select id="art-kind" class="select"><option value="">Work it out from the folder names</option>${kinds.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}${target === 'digital' ? '' : '<option value="wrap">Full wraps (back, spine and front in one picture)</option>'}</select></label>
          <label class="field"><span>for the platform</span><select id="art-plat" class="select"><option value="">Work it out from the folder names</option></select></label>
        </div></details>
      <label class="field"><span>Where the game's name ends in the file name (optional)</span><input id="art-cut" placeholder="for example  ' ('  : \"Ace Combat 6 (USA, Japan) (En,Fr).png\" is read as Ace Combat 6" autocomplete="off" spellcheck="false" /></label>
      <label class="policy-row"><input type="checkbox" id="art-replace" /> <span>Replace pictures that are already there (the automatic ones only: your own are always kept)</span></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="art-preview" type="button">Preview</button><button class="btn btn-primary" id="art-apply" type="button" disabled>Import</button></div>
      <div id="art-result" style="margin:0"></div>
    </div>`;
  const sel = $('#art-folder', body), res = $('#art-result', body), previewBtn = $('#art-preview', body), applyBtn = $('#art-apply', body), replace = $('#art-replace', body), cutBox = $('#art-cut', body), kindSel = $('#art-kind', body), platSel = $('#art-plat', body);
  let folders = [], can_edit = false;
  try { ({ folders, can_edit } = await ctx.api('/art/folders')); } catch (err) { res.innerHTML = `<p class="hint">${esc(err.message)}</p>`; previewBtn.disabled = true; return; }
  const usable = folders.filter((f) => f.exists);
  if (can_edit) wireAddFolder(ctx, body, folders, (path) => renderArtImport(ctx, body, { target, onDone, select: path }));
  if (!usable.length) {
    $('#art-folder-row', body).classList.add('hidden');
    res.innerHTML = `<p class="hint" style="margin:0">${folders.length ? 'None of the listed folders can be reached right now.' : 'No folder has been added yet.'} ${can_edit ? 'Add one above: type or paste its full path on the server, or press <b>Browse…</b>.' : 'An admin adds them (Settings → Artwork folders).'}</p>`;
    previewBtn.disabled = true; return;
  }
  sel.innerHTML = usable.map((f) => `<option value="${esc(f.path)}"${f.path === select ? ' selected' : ''}>${esc(f.path)}</option>`).join('');
  const edited = {};   // platform -> { from, to }: where the person put the spine on a sample wrap (kept for next time when they import)
  const req = (apply) => ctx.api('/art/import', { method: 'POST', body: JSON.stringify({ target, folder: sel.value, replace: replace.checked, cut: cutBox.value, kind: kindSel.value, platform: platSel.value, split: edited, apply }) });
  const dirty = () => { applyBtn.disabled = true; res.innerHTML = ''; for (const k of Object.keys(edited)) delete edited[k]; };
  sel.onchange = dirty; replace.onchange = dirty; cutBox.oninput = dirty; kindSel.onchange = dirty; platSel.onchange = dirty;
  ctx.api('/art/platforms').then((d) => { platSel.insertAdjacentHTML('beforeend', (d.items || []).map((p) => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join('')); }).catch(() => { /* the folder names are enough */ });

  const showProgress = (s) => { res.innerHTML = `<p class="hint" style="margin:0"><span class="spin" aria-hidden="true"></span>Importing… ${n(s.done)} of ${n(s.total)}</p>`; };
  const showDone = (s) => {
    const parts = kinds.filter(([k]) => s.applied[k]).map(([k, l]) => `${n(s.applied[k])} ${l.toLowerCase()}`);
    res.innerHTML = `<p style="margin:0"><b>Done.</b> ${parts.length ? `Imported ${parts.join(', ')}.` : 'Nothing needed importing.'}${s.failed ? ` ${n(s.failed)} could not be imported.` : ''}</p>`
      + (s.failures?.length ? `<ul class="hint" style="margin:6px 0 0 1.1rem">${s.failures.map((f) => `<li>${esc(f.title)} (${esc(f.kind)}): ${esc(f.reason)}</li>`).join('')}</ul>` : '')
      + (s.error ? `<p class="hint">${esc(s.error)}</p>` : '');
    previewBtn.disabled = false; applyBtn.disabled = true; sel.disabled = false; replace.disabled = false; kindSel.disabled = false; platSel.disabled = false;
    onDone();
  };
  const poll = async () => {
    try { const s = await ctx.api('/art/import/status'); if (s.running) { showProgress(s); setTimeout(poll, 1000); } else showDone(s); }
    catch (err) { res.innerHTML = `<p class="hint">${esc(err.message)}</p>`; previewBtn.disabled = false; }
  };
  const busy = (on) => { previewBtn.disabled = on; sel.disabled = on; replace.disabled = on; kindSel.disabled = on; platSel.disabled = on; if (on) applyBtn.disabled = true; };

  previewBtn.onclick = async () => {
    busy(true); res.innerHTML = '<p class="hint" style="margin:0"><span class="spin" aria-hidden="true"></span>Looking through the folder…</p>';
    try {
      const p = await req(false);
      const total = kinds.reduce((t, [k]) => t + p.will[k], 0);
      res.innerHTML = `<p class="hint" style="margin:0">${n(p.files)} useful files in the folder (${n(p.scanned)} looked at); ${n(p.games)} game${p.games === 1 ? '' : 's'} on your list.</p>
        <table class="art-table"><thead><tr><th></th><th>Found for your games</th><th>Will import</th><th>Already there</th></tr></thead><tbody>
        ${kinds.map(([k, l]) => `<tr><th>${l}</th><td>${n(p.matched[k])}</td><td><b>${n(p.will[k])}</b></td><td>${n(p.skipped[k])}</td></tr>`).join('')}</tbody></table>
        ${p.unmatched_total ? `<details><summary>${n(p.unmatched_total)} picture${p.unmatched_total === 1 ? '' : 's'} matched none of your games</summary><ul class="hint" style="margin:6px 0 0 1.1rem">${p.unmatched.map((u) => `<li>${esc(u.title)} <span class="note">(${esc(u.kind)}, ${esc(u.platform)})</span></li>`).join('')}${p.unmatched_total > p.unmatched.length ? `<li>…and ${n(p.unmatched_total - p.unmatched.length)} more</li>` : ''}</ul></details>` : ''}
        ${p.wraps?.platforms?.length ? `<div id="art-wraps" class="art-wraps"></div>` : ''}
        ${p.wraps?.odd ? `<details><summary>${n(p.wraps.odd)} wrap${p.wraps.odd === 1 ? '' : 's'} a different shape from the rest: left alone</summary><ul class="hint" style="margin:6px 0 0 1.1rem">${p.wraps.odd_list.map((u) => `<li>${esc(u.title)} <span class="note">(${esc(u.platform)}, ${u.ratio} wide for 1 tall; the rest are ${esc(String((p.wraps.platforms.find((x) => x.slug === u.platform) || {}).ratio || ''))})</span></li>`).join('')}</ul></details>` : ''}
        ${p.unknown_platforms.length ? `<p class="hint" style="margin:6px 0 0">Folders not recognised as a platform: ${p.unknown_platforms.map((u) => `${esc(u.name)} (${n(u.files)})`).join(', ')}</p>` : ''}
        ${total ? '' : '<p class="hint" style="margin:6px 0 0">Nothing to import: every match is already filled in.</p>'}`;
      applyBtn.disabled = total === 0;
      if (p.wraps?.platforms?.length) mountWraps($('#art-wraps', res), p, sel.value, edited);
    } catch (err) { res.innerHTML = `<p class="hint">${esc(err.message)}</p>`; }
    finally { previewBtn.disabled = false; sel.disabled = false; replace.disabled = false; kindSel.disabled = false; platSel.disabled = false; }
  };
  applyBtn.onclick = async () => {
    busy(true);
    try { const s = await req(true); showProgress(s); setTimeout(poll, 800); }
    catch (err) { ctx.toast(err.message, true); busy(false); }
  };
  // Opened again while a run is going: pick up its progress.
  try { const s = await ctx.api('/art/import/status'); if (s.running) { busy(true); showProgress(s); setTimeout(poll, 800); } } catch { /* idle */ }
}

/** Admins can add a folder right here: type or paste a full path on the server, or browse the server's folders (the same listing the Sources page uses). */
function wireAddFolder(ctx, body, folders, onAdded) {
  const host = $('#art-add', body);
  host.innerHTML = `
    <label class="field"><span>Add a folder on the server</span>
      <div class="wz-path"><input id="art-newpath" placeholder="O:\\Launchbox\\images   or   /art/launchbox-images" autocomplete="off" spellcheck="false" /><button class="btn" type="button" id="art-browse">Browse…</button><button class="btn btn-primary" type="button" id="art-addbtn">Add</button></div></label>
    <div class="wz-browser hidden" id="art-browser">
      <div class="wz-bpath" id="art-bpath"></div>
      <div class="wz-bdirs" id="art-bdirs"></div>
      <div class="wz-row"><button class="btn btn-sm" type="button" id="art-bup">↑ Up</button><button class="btn btn-sm btn-primary" type="button" id="art-buse">Use this folder</button><button class="btn btn-sm btn-ghost" type="button" id="art-bcancel">Cancel</button></div>
    </div>`;
  const input = $('#art-newpath', host), box = $('#art-browser', host);
  let here = null, parent = null;
  const browse = async (p) => {
    try {
      const data = await ctx.api(`/sources/browse${p ? `?path=${encodeURIComponent(p)}` : ''}`);
      here = data.path; parent = data.parent;
      $('#art-bpath', host).textContent = data.path;
      $('#art-bdirs', host).innerHTML = data.dirs.length
        ? data.dirs.map((d) => `<button type="button" class="browser-dir" data-dir="${esc(d.path)}"><span aria-hidden="true">🗀</span><span class="browser-dir-name">${esc(d.name)}</span><span class="browser-dir-go">›</span></button>`).join('')
        : '<div class="side-empty">No subfolders here: use this folder as it is.</div>';
      host.querySelectorAll('#art-bdirs .browser-dir').forEach((b) => { b.onclick = () => browse(b.dataset.dir); });
      $('#art-bup', host).disabled = !parent;
      box.classList.remove('hidden');
    } catch (err) { ctx.toast(err.message, true); }
  };
  $('#art-browse', host).onclick = () => browse(input.value.trim() || null);
  $('#art-bup', host).onclick = () => { if (parent) browse(parent); };
  $('#art-bcancel', host).onclick = () => box.classList.add('hidden');
  $('#art-buse', host).onclick = () => { if (here) input.value = here; box.classList.add('hidden'); };
  const add = async () => {
    const p = input.value.trim();
    if (!p) { ctx.toast('Type a folder path, or press Browse', true); return; }
    try {
      const list = [...folders.map((f) => f.path), p];
      const out = await ctx.api('/art/folders', { method: 'PUT', body: JSON.stringify({ folders: list }) });
      ctx.toast('Folder added');
      onAdded(out.folders.map((f) => f.path).find((x) => x === p || x.replace(/[\/]+$/, '') === p.replace(/[\/]+$/, '')) || p);
    } catch (err) { ctx.toast(err.message, true); }
  };
  $('#art-addbtn', host).onclick = add;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
}

/** Full wraps: a sample of each platform's pictures with two lines for where the spine is (drag them; the cut is remembered). The front and the spine as they will be cut show beside it. */
export function mountWraps(host, p, folder, edited) {
  if (!host) return;
  const pct = (v) => (v * 100).toFixed(1) + '%';
  host.innerHTML = '<p class="hint" style="margin:8px 0 0"><b>Full wraps.</b> Check where the spine is on a sample: drag the two lines so the spine sits between them. Everything to the right becomes the cover. This is remembered for the platform.</p>'
    + p.wraps.platforms.filter((w) => w.sample != null).map((w) => `
    <div class="wrap-edit" data-slug="${esc(w.slug)}">
      <div class="wrap-head"><b>${esc(w.slug)}</b> <span class="note">${n(w.count)} wrap${w.count === 1 ? '' : 's'} · spine <span data-w-read>${pct(w.split.from)} to ${pct(w.split.to)}</span></span> <button type="button" class="btn btn-sm btn-ghost" data-w-reset>Reset</button></div>
      <div class="wrap-row">
        <div class="wrap-stage"><img alt="" src="/api/art/wrap-image?folder=${encodeURIComponent(folder)}&i=${w.sample}" /><i class="wl-shade wl-back"></i><i class="wl-shade wl-front"></i><b class="wl wl-a" tabindex="0" role="slider" aria-label="Left edge of the spine"></b><b class="wl wl-b" tabindex="0" role="slider" aria-label="Right edge of the spine"></b></div>
        <div class="wrap-out"><canvas class="wrap-spine" height="140"></canvas><canvas class="wrap-front" height="140"></canvas></div>
      </div>
    </div>`).join('');
  for (const box of host.querySelectorAll('.wrap-edit')) {
    const w = p.wraps.platforms.find((x) => x.slug === box.dataset.slug), orig = { ...w.split };
    const stage = box.querySelector('.wrap-stage'), img = box.querySelector('img'), a = box.querySelector('.wl-a'), b = box.querySelector('.wl-b');
    const cur = { ...w.split };
    const paint = () => {
      a.style.left = pct(cur.from); b.style.left = pct(cur.to);
      box.querySelector('.wl-back').style.width = pct(cur.from); box.querySelector('.wl-front').style.left = pct(cur.to);
      box.querySelector('[data-w-read]').textContent = pct(cur.from) + ' to ' + pct(cur.to);
      if (img.naturalWidth) {
        const W = img.naturalWidth, H = img.naturalHeight, put = (cv, x0, x1) => { const cw = Math.max(1, x1 - x0); cv.width = Math.max(1, Math.round(140 * cw / H)); cv.getContext('2d').drawImage(img, x0, 0, cw, H, 0, 0, cv.width, cv.height); };
        put(box.querySelector('.wrap-spine'), Math.round(W * cur.from), Math.round(W * cur.to)); put(box.querySelector('.wrap-front'), Math.round(W * cur.to), W);
      }
    };
    const set = (k, v) => {
      if (k === 'from') cur.from = Math.max(0.15, Math.min(cur.to - 0.01, v)); else cur.to = Math.min(0.85, Math.max(cur.from + 0.01, v));
      edited[w.slug] = { from: Math.round(cur.from * 10000) / 10000, to: Math.round(cur.to * 10000) / 10000 }; paint();
    };
    const drag = (el, k) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault(); el.setPointerCapture(e.pointerId);
        const move = (ev) => { const r = stage.getBoundingClientRect(); set(k, (ev.clientX - r.left) / r.width); };
        const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); }; el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
      });
      el.addEventListener('keydown', (e) => { const d = e.key === 'ArrowLeft' ? -0.002 : e.key === 'ArrowRight' ? 0.002 : 0; if (d) { e.preventDefault(); set(k, cur[k] + (e.shiftKey ? d * 5 : d)); } });
    };
    drag(a, 'from'); drag(b, 'to');
    box.querySelector('[data-w-reset]').onclick = () => { cur.from = orig.from; cur.to = orig.to; delete edited[w.slug]; paint(); };
    img.addEventListener('load', paint); paint();
  }
}
