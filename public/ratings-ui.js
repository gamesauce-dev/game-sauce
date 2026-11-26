// Age ratings on the page: the line and the admin's picker in a game's details, Set rating for several games, and Settings > Age ratings.
// Everything here is display and the admin's tools; the server decides what a game's rating is and who may change it.
import { t } from './i18n.js';   // text put together here is translated before it is shown

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => Number(v || 0).toLocaleString();
const SOURCE = { igdb: 'IGDB', launchbox: 'LaunchBox', thegamesdb: 'TheGamesDB' };
const RC = 6;

/** The "Age rating" line of a game's details (HTML). Each part is its own piece of text, so each can be translated. */
export function ageLine(age) {
  if (!age) return `<span>${esc(t('Not rated'))}</span>`;
  const notes = [];
  if (age.converted) notes.push(t('converted from {rating}', { rating: age.from }));
  if (age.inherited) notes.push(t('taken from another version of this game'));
  else if (age.source === 'admin') notes.push(t('set by an admin'));
  else if (SOURCE[age.source]) notes.push(t('rating from {source}', { source: SOURCE[age.source] }));
  return `<b translate="no">${esc(age.label)}</b>${age.level === RC ? ` <span>(${esc(t('refused classification'))})</span>` : ''}${notes.map((n) => ` <span class="age-note">· ${esc(n)}</span>`).join('')}`;
}

/** The choices of the current classification, [{ level, label }]. */
async function choices(api) {
  const s = await api('/ratings');
  return s.systems.find((x) => x.id === s.system).ratings;
}
const optionText = (c) => (c.level === RC ? `RC (${t('refused classification')})` : c.label);
const setRating = (api, ids, level) => api('/ratings/set', { method: 'POST', body: JSON.stringify({ ids, level }) });
const removeAsk = { title: 'Take the rating away?', body: 'The rating is removed, including one that was fetched. A later lookup or Fetch ratings may fill it in again.', okLabel: 'Take it away' };

/** The admin's picker in a game's details. It saves as soon as a choice is made; onSaved redraws the page. */
export async function fillAgePicker(box, rom, { api, toast, confirmDialog, onSaved }) {
  if (!box) return;
  let list;
  try { list = await choices(api); } catch { return; }
  const own = rom.age && !rom.age.inherited ? rom.age.level : 0;
  box.innerHTML = `<label class="field"><span>Set the age rating</span><select class="select" id="age-pick">
    <option value="0"${own ? '' : ' selected'}>No rating of its own</option>
    ${list.map((c) => `<option value="${c.level}"${c.level === own ? ' selected' : ''}>${esc(optionText(c))}</option>`).join('')}</select></label>
    <p class="hint">A rating you set here always wins: no lookup changes it.</p>`;
  const sel = $('#age-pick', box);
  sel.addEventListener('change', async () => {
    const level = Number(sel.value) || null;
    if (level === null && !(await confirmDialog(removeAsk))) { sel.value = String(own); return; }
    try {
      await setRating(api, [rom.id], level);
      toast('Saved');
      await onSaved();
    } catch (err) { sel.value = String(own); toast(err.message, true); }
  });
}

/** Set rating for the selected games. Resolves true when something was saved. */
export async function rateMany(ids, { api, toast, confirmChoice, confirmDialog }) {
  try {
    const list = await choices(api);
    const pick = await confirmChoice({
      title: t('Set the age rating of {n} games', { n: num(ids.length) }),
      body: t('A rating you set here always wins: no lookup changes it.'),
      choices: [...list.map((c) => ({ id: c.level, label: optionText(c) })), { id: 'none', label: t('Take the rating away') }]
    });
    if (!pick) return false;
    if (pick === 'none' && !(await confirmDialog(removeAsk))) return false;
    const done = await setRating(api, ids, pick === 'none' ? null : pick);
    toast(t(pick === 'none' ? 'Rating taken away from {n} games' : 'Rating set on {n} games', { n: num(done.changed) }));
    return true;
  } catch (err) { toast(err.message, true); return false; }
}

/* ───────── Settings > Age ratings ───────── */

let timer = null;

export async function initRatingsPanel(ctx) {
  const { api, toast, confirmDialog, platformOptions, openList } = ctx;
  const panel = $('#mod-ratings');
  if (!panel) return;
  const system = $('#age-system'), platform = $('#age-platform'), go = $('#age-fetch'), stop = $('#age-stop'), status = $('#age-job');
  let current = '', wasRunning = false;

  const paintJob = (j) => {
    go.disabled = j.running;
    stop.classList.toggle('hidden', !j.running);
    stop.disabled = Boolean(j.stop);
    const v = { done: num(j.done), total: num(j.total), rated: num(j.rated), unchanged: num(j.unchanged), none: num(j.none), failed: num(j.failed) };
    const lines = [];
    if (j.running) lines.push(t('Fetching ratings: {done} of {total} games looked at, {rated} rated, {none} with no rating found, {failed} failed.', v));
    else if (j.finishedAt) lines.push(t('Last run: {done} of {total} games looked at, {rated} given a new rating, {unchanged} unchanged, {none} with no rating found, {failed} failed.', v));
    if (j.lastError && j.failed) lines.push(t('The last problem: {error}', { error: String(j.lastError).slice(0, 160) }));
    status.textContent = lines.join(' ');
  };

  const paint = (s) => {
    current = s.system;
    system.innerHTML = s.systems.map((x) => `<option value="${x.id}"${x.id === s.system ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    const c = s.counts;
    $('#age-counts').innerHTML = [['Games', c.games], ['Rated', c.rated], ['Unrated', c.unrated], ['Converted', c.converted], ['From another version', c.inherited], ['Set by an admin', c.by_admin]]
      .map(([label, n]) => `<div><span>${label}</span><b>${num(n)}</b></div>`).join('');
    const src = [];
    src.push(s.sources.igdb ? t('IGDB is set up.') : t('IGDB is not set up (Settings > Metadata providers). It is the only source of Australian ratings.'));
    src.push(s.sources.launchbox === 'ready' ? t('The LaunchBox database has its ratings.') : t('The LaunchBox database has no ratings yet: download or update it (Settings > Metadata providers) to use them.'));
    $('#age-sources').textContent = src.join(' ');
    paintJob(s.job);
  };

  const load = async () => paint(await api('/ratings'));
  const poll = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const j = await api('/ratings/fetch');
        paintJob(j);
        if (j.running) { wasRunning = true; return poll(); }
        if (wasRunning) { wasRunning = false; await load(); await ctx.onChanged(); }
      } catch { /* signed out, or the server went away: the next visit loads it again */ }
    }, 1500);
  };

  system.onchange = async () => {
    const next = system.value;
    const ok = await confirmDialog({ title: 'Change the classification?', body: 'Ratings are shown with the new board\'s labels. Fetched ratings are chosen again from what the sources said, so the new board\'s own ratings are used where there are any. Ratings an admin set stay at the same level.', okLabel: 'Change it' });
    if (!ok) { system.value = current; return; }
    try { paint(await api('/ratings/system', { method: 'PUT', body: JSON.stringify({ system: next }) })); toast('Saved'); await ctx.onChanged(); }
    catch (err) { system.value = current; toast(err.message, true); }
  };
  go.onclick = async () => {
    try {
      paintJob(await api('/ratings/fetch', { method: 'POST', body: JSON.stringify({ platform: platform.value, recheck: $('#age-recheck').checked }) }));
      wasRunning = true;
      poll();
    } catch (err) { toast(err.message, true); }
  };
  stop.onclick = async () => { try { paintJob(await api('/ratings/fetch', { method: 'DELETE' })); poll(); } catch (err) { toast(err.message, true); } };
  $('#age-show-unrated').onclick = () => openList('unrated');
  $('#age-show-converted').onclick = () => openList('converted');

  const chosen = platform.value;
  platform.innerHTML = '<option value="">All platforms</option>' + platformOptions({ only: (p) => p.count, label: (p) => `${p.name} (${p.count})` });
  platform.value = chosen;
  try { await load(); wasRunning = Boolean((await api('/ratings/fetch')).running); if (wasRunning) poll(); }
  catch (err) { toast(err.message, true); }
}
