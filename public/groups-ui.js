// Age restrictions on the page, all of it the admin's: Settings > Groups and age limits, the group and age limit on each account, and who a game is
// blocked for. Everything here is display and the admin's tools; the server decides who sees what.
import { t } from './i18n.js';   // text put together here is translated before it is shown

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => Number(v || 0).toLocaleString();

/** The choices of an age limit: none, or up to one of the ratings of the classification setting. */
const limitOptions = (limits, chosen) => `<option value="">${esc(t('No limit'))}</option>${limits.map((l) => `<option value="${l.level}"${l.level === chosen ? ' selected' : ''}>${esc(t('Up to {rating}', { rating: l.label }))}</option>`).join('')}`;
const limitFrom = (select) => (select.value ? Number(select.value) : null);

/* ───────── Settings > Groups and age limits ───────── */

export async function initGroupsPanel(ctx) {
  const { api, toast, confirmDialog, openList } = ctx;
  const list = $('#group-list'), form = $('#group-add');
  if (!list || !form) return;

  const paint = (s) => {
    $('#group-unrated').textContent = t('Games with no age rating are not held back by any limit. Unrated games now: {n}.', { n: num(s.unrated) });
    list.innerHTML = s.items.length ? s.items.map((g) => `
      <div class="group-row" data-agegroup="${g.id}">
        <div class="group-fields">
          <label class="field"><span>Group name</span><input class="search" data-act="name" maxlength="40" value="${esc(g.name)}" /></label>
          <label class="field"><span>Age limit</span><select class="select" data-act="limit">${limitOptions(s.limits, g.age_limit)}</select></label>
          <label class="group-check"><input type="checkbox" data-act="edit"${g.can_edit ? ' checked' : ''} /> <span>Members may edit games</span></label>
          <button type="button" class="btn btn-sm btn-danger" data-act="delete">Delete</button>
        </div>
        <p class="hint">${g.members.length ? `<span>${esc(t('In this group:'))}</span> <span translate="no">${g.members.map((m) => esc(m.username)).join(', ')}</span>` : `<span>${esc(t('Nobody is in this group yet.'))}</span>`}${g.blocked_games ? ` · <span>${esc(t('Games blocked for it: {n}', { n: num(g.blocked_games) }))}</span>` : ''}</p>
      </div>`).join('') : '<p class="hint">No groups yet. Without a group, and without a limit of their own, a person sees the whole Library.</p>';
    $('#group-new-limit').innerHTML = limitOptions(s.limits, null);

    $$('[data-agegroup]', list).forEach((row) => {
      const id = Number(row.dataset.agegroup), g = s.items.find((x) => x.id === id);
      const change = async (body) => {
        try { paint(await api(`/groups/${id}`, { method: 'PATCH', body: JSON.stringify(body) })); toast('Saved'); }
        catch (err) { toast(err.message, true); await load(); }
      };
      $('[data-act="name"]', row).addEventListener('change', (e) => change({ name: e.target.value }));
      $('[data-act="limit"]', row).addEventListener('change', (e) => change({ age_limit: limitFrom(e.target) }));
      $('[data-act="edit"]', row).addEventListener('change', (e) => change({ can_edit: e.target.checked }));
      $('[data-act="delete"]', row).addEventListener('click', async () => {
        const sure = await confirmDialog({ title: 'Delete this group?', body: 'Its age limit and its blocked games stop applying to the people in it. Their accounts stay.', okLabel: 'Delete', danger: true });
        if (!sure) return;
        try { paint(await api(`/groups/${id}`, { method: 'DELETE' })); toast(t('Group {name} deleted', { name: g.name })); await ctx.onChanged(); }
        catch (err) { toast(err.message, true); }
      });
    });
  };
  const load = async () => paint(await api('/groups'));

  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      paint(await api('/groups', { method: 'POST', body: JSON.stringify({ name: $('#group-new-name').value, age_limit: limitFrom($('#group-new-limit')), can_edit: $('#group-new-edit').checked }) }));
      form.reset();
      toast('Group added');
      await ctx.onChanged();
    } catch (err) { toast(err.message, true); }
  };
  $('#group-show-unrated').onclick = () => openList('unrated');
  try { await load(); } catch (err) { toast(err.message, true); }
}

/* ───────── on the accounts ───────── */

/** The age limit and group boxes for one person's row in User accounts (HTML). */
export function userRestrictions(user, info) {
  if (user.role === 'admin') return '';
  return `<label class="dl-pick" title="A limit for this person alone. Where their groups have limits too, the strictest wins."><span>Age limit</span>
      <select class="select" data-act="age-setting">${limitOptions(info.limits, user.age_limit)}</select></label>
    ${info.items.length ? `<fieldset class="user-groups"><legend>Groups</legend>${info.items.map((g) => `<label><input type="checkbox" data-act="group-setting" value="${g.id}"${user.groups.includes(g.id) ? ' checked' : ''} /> <span translate="no">${esc(g.name)}</span></label>`).join('')}</fieldset>` : ''}`;
}

export function bindUserRestrictions(row, id, { api, toast, reload }) {
  const save = async (body) => {
    try { await api(`/auth/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); toast('Saved'); }
    catch (err) { toast(err.message, true); reload(); }
  };
  $('[data-act="age-setting"]', row)?.addEventListener('change', (e) => save({ age_limit: limitFrom(e.target) }));
  $$('[data-act="group-setting"]', row).forEach((box) => box.addEventListener('change', () => save({ groups: $$('[data-act="group-setting"]:checked', row).map((b) => Number(b.value)) })));
}

/** The Group choice of the Add user form. Where there are groups the admin has to choose one, or "No group, no limit": it is never left to chance. */
export function fillNewUserGroup(form, info) {
  const select = form?.querySelector('[name="group"]');
  if (!select) return;
  const chosen = select.value, any = info.items.length > 0;
  select.innerHTML = `${any ? `<option value="" disabled>${esc(t('Choose…'))}</option>` : ''}<option value="none">${esc(t('No group, no limit'))}</option>${info.items.map((g) => `<option value="${g.id}" translate="no">${esc(g.name)}</option>`).join('')}`;
  select.value = [...select.options].some((o) => o.value === chosen && !o.disabled) ? chosen : (any ? '' : 'none');
  const role = form.querySelector('[name="role"]');
  const sync = () => { const admin = role.value === 'admin'; select.disabled = admin; select.required = !admin; select.closest('.field').classList.toggle('hidden', admin); };
  role.onchange = sync;
  form.onreset = () => setTimeout(() => { select.value = any ? '' : 'none'; sync(); });
  sync();
}

/* ───────── in a game's details ───────── */

/** Who this game is blocked for. It saves as soon as a box changes. */
export async function fillBlockPicker(box, rom, { api, toast }) {
  if (!box) return;
  let s;
  try { s = await api(`/groups/blocks/${rom.id}`); } catch { return; }
  const boxes = (items, kind, nameOf, chosen) => items.map((x) => `<label><input type="checkbox" data-kind="${kind}" value="${x.id}"${chosen.includes(x.id) ? ' checked' : ''} /> <span translate="no">${esc(nameOf(x))}</span></label>`).join('');
  const none = !s.groups.length && !s.users.length;
  const paint = () => {
    box.innerHTML = `<details class="block-picker"${s.blocked.users.length || s.blocked.groups.length ? ' open' : ''}><summary>Block this game</summary>
      <p class="hint">Whoever is ticked cannot see this game anywhere, nor its other versions on this platform.</p>
      ${none ? '<p class="hint">There is nobody to block yet: add a member or a group under Settings.</p>' : ''}
      ${s.groups.length ? `<fieldset class="user-groups"><legend>Groups</legend>${boxes(s.groups, 'groups', (g) => g.name, s.blocked.groups)}</fieldset>` : ''}
      ${s.users.length ? `<fieldset class="user-groups"><legend>People</legend>${boxes(s.users, 'users', (u) => u.username, s.blocked.users)}</fieldset>` : ''}</details>`;
    $$('input[type="checkbox"]', box).forEach((input) => input.addEventListener('change', async () => {
      const ticked = (kind) => $$(`input[data-kind="${kind}"]:checked`, box).map((b) => Number(b.value));
      try { s = await api(`/groups/blocks/${rom.id}`, { method: 'PUT', body: JSON.stringify({ users: ticked('users'), groups: ticked('groups') }) }); toast('Saved'); }
      catch (err) { toast(err.message, true); }
      paint();
    }));
  };
  paint();
}
