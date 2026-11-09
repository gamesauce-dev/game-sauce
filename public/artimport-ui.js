// "Import pictures & manuals" (Physical) and "Import covers" (Digital): bring in pictures you already have, from a folder on the server that an admin has listed
// (Settings > Artwork folders). Shown in the details window. A preview says what would happen; nothing is saved until Import is pressed, and it runs in the background.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Number(v || 0).toLocaleString();

/** Draw the panel into `body`. ctx: the page's { api, toast }. target: 'physical' (covers, spines, discs, manuals) or 'digital' (covers of console games). onDone runs after an import. */
export async function renderArtImport(ctx, body, { target, onDone = () => {} }) {
  const kinds = target === 'digital' ? [['cover', 'Covers']] : [['cover', 'Covers'], ['spine', 'Spines'], ['disc', 'Discs'], ['manual', 'Manuals']];
  const what = target === 'digital' ? 'covers' : 'pictures and manuals';
  body.innerHTML = `
    <h2 class="detail-title">${target === 'digital' ? 'Import covers' : 'Import pictures &amp; manuals'}</h2>
    <p class="hint">Bring in ${what} you already have: from a LaunchBox <b>Images</b> folder, or a RetroBat <b>roms</b> folder, on the server. They are matched to your games by platform and title. Nothing is saved until you press <b>Import</b>, and pictures you uploaded yourself are never replaced.</p>
    <div class="panel" id="art-box" style="padding:12px;display:grid;gap:10px">
      <label class="field"><span>Folder on the server</span><select id="art-folder" class="select"></select></label>
      <label class="policy-row"><input type="checkbox" id="art-replace" /> <span>Replace pictures that are already there (the automatic ones only: your own are always kept)</span></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="art-preview" type="button">Preview</button><button class="btn btn-primary" id="art-apply" type="button" disabled>Import</button></div>
      <div id="art-result" style="margin:0"></div>
    </div>`;
  const sel = $('#art-folder', body), res = $('#art-result', body), previewBtn = $('#art-preview', body), applyBtn = $('#art-apply', body), replace = $('#art-replace', body);
  let folders = [], can_edit = false;
  try { ({ folders, can_edit } = await ctx.api('/art/folders')); } catch (err) { res.innerHTML = `<p class="hint">${esc(err.message)}</p>`; previewBtn.disabled = true; return; }
  const usable = folders.filter((f) => f.exists);
  if (!usable.length) {
    res.innerHTML = `<p class="hint" style="margin:0">${folders.length ? 'None of the listed folders can be reached right now.' : 'There are no artwork folders yet.'} ${can_edit ? 'Add them under <b>Settings → Library tools → Artwork folders</b>.' : 'An admin adds them under Settings → Artwork folders.'}</p>`;
    previewBtn.disabled = true; return;
  }
  sel.innerHTML = usable.map((f) => `<option value="${esc(f.path)}">${esc(f.path)}</option>`).join('');
  const req = (apply) => ctx.api('/art/import', { method: 'POST', body: JSON.stringify({ target, folder: sel.value, replace: replace.checked, apply }) });
  const dirty = () => { applyBtn.disabled = true; res.innerHTML = ''; };
  sel.onchange = dirty; replace.onchange = dirty;

  const showProgress = (s) => { res.innerHTML = `<p class="hint" style="margin:0"><span class="spin" aria-hidden="true"></span>Importing… ${n(s.done)} of ${n(s.total)}</p>`; };
  const showDone = (s) => {
    const parts = kinds.filter(([k]) => s.applied[k]).map(([k, l]) => `${n(s.applied[k])} ${l.toLowerCase()}`);
    res.innerHTML = `<p style="margin:0"><b>Done.</b> ${parts.length ? `Imported ${parts.join(', ')}.` : 'Nothing needed importing.'}${s.failed ? ` ${n(s.failed)} could not be imported.` : ''}</p>`
      + (s.failures?.length ? `<ul class="hint" style="margin:6px 0 0 1.1rem">${s.failures.map((f) => `<li>${esc(f.title)} (${esc(f.kind)}): ${esc(f.reason)}</li>`).join('')}</ul>` : '')
      + (s.error ? `<p class="hint">${esc(s.error)}</p>` : '');
    previewBtn.disabled = false; applyBtn.disabled = true; sel.disabled = false; replace.disabled = false;
    onDone();
  };
  const poll = async () => {
    try { const s = await ctx.api('/art/import/status'); if (s.running) { showProgress(s); setTimeout(poll, 1000); } else showDone(s); }
    catch (err) { res.innerHTML = `<p class="hint">${esc(err.message)}</p>`; previewBtn.disabled = false; }
  };
  const busy = (on) => { previewBtn.disabled = on; sel.disabled = on; replace.disabled = on; if (on) applyBtn.disabled = true; };

  previewBtn.onclick = async () => {
    busy(true); res.innerHTML = '<p class="hint" style="margin:0"><span class="spin" aria-hidden="true"></span>Looking through the folder…</p>';
    try {
      const p = await req(false);
      const total = kinds.reduce((t, [k]) => t + p.will[k], 0);
      res.innerHTML = `<p class="hint" style="margin:0">${n(p.files)} useful files in the folder (${n(p.scanned)} looked at); ${n(p.games)} game${p.games === 1 ? '' : 's'} on your list.</p>
        <table class="art-table"><thead><tr><th></th><th>Found for your games</th><th>Will import</th><th>Already there</th></tr></thead><tbody>
        ${kinds.map(([k, l]) => `<tr><th>${l}</th><td>${n(p.matched[k])}</td><td><b>${n(p.will[k])}</b></td><td>${n(p.skipped[k])}</td></tr>`).join('')}</tbody></table>
        ${p.unmatched_total ? `<details><summary>${n(p.unmatched_total)} picture${p.unmatched_total === 1 ? '' : 's'} matched none of your games</summary><ul class="hint" style="margin:6px 0 0 1.1rem">${p.unmatched.map((u) => `<li>${esc(u.title)} <span class="note">(${esc(u.kind)}, ${esc(u.platform)})</span></li>`).join('')}${p.unmatched_total > p.unmatched.length ? `<li>…and ${n(p.unmatched_total - p.unmatched.length)} more</li>` : ''}</ul></details>` : ''}
        ${p.unknown_platforms.length ? `<p class="hint" style="margin:6px 0 0">Folders not recognised as a platform: ${p.unknown_platforms.map((u) => `${esc(u.name)} (${n(u.files)})`).join(', ')}</p>` : ''}
        ${total ? '' : '<p class="hint" style="margin:6px 0 0">Nothing to import: every match is already filled in.</p>'}`;
      applyBtn.disabled = total === 0;
    } catch (err) { res.innerHTML = `<p class="hint">${esc(err.message)}</p>`; }
    finally { previewBtn.disabled = false; sel.disabled = false; replace.disabled = false; }
  };
  applyBtn.onclick = async () => {
    busy(true);
    try { const s = await req(true); showProgress(s); setTimeout(poll, 800); }
    catch (err) { ctx.toast(err.message, true); busy(false); }
  };
  // Opened again while a run is going: pick up its progress.
  try { const s = await ctx.api('/art/import/status'); if (s.running) { busy(true); showProgress(s); setTimeout(poll, 800); } } catch { /* idle */ }
}
