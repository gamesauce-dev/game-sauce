// Messages: a small private chat between the people who use this server (one to one, plain text, 200 characters, no links), with notices from the admin to everyone.
// Rules live on the server (src/lib/messages.js): only the two people in a conversation can read it; delete is for me only; the sender can recall a message for a few minutes;
// a game can be shared (only its title and platform go in the message). This page shows them, keeps the unread badge on the menu, and raises a toast when something new arrives.
import { badgeLabel } from './digital.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const chars = (s) => [...String(s || '')].length;

let ctx = null;
const M = {
  convs: [], notices: [], people: [], openId: null, openName: '', thread: [], replyTo: null, share: null, drafts: {}, mode: 'idle',   // idle | thread | people
  summary: { chat: true, unread: 0, notices_unread: 0, max_length: 200, recall_minutes: 5 },
  seenMsg: null, seenNotice: null, first: true, timer: null, token: 0
};
const ico = {
  reply: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/></svg>',
  recall: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};

export function initMessages(c) {
  ctx = c;
  const view = $('#view-messages'); if (!view || view.dataset.ready) { restart(); return; }
  view.dataset.ready = '1';
  view.addEventListener('click', onClick);
  view.addEventListener('input', onInput);
  view.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  restart();
}
function restart() { clearTimeout(M.timer); M.first = true; M.seenMsg = null; M.seenNotice = null; setTimeout(tick, 1200); }
const viewOpen = () => ctx?.state?.view === 'messages' && !$('#view-messages')?.classList.contains('hidden');

/* ───────────── the badge, the toast, the polling ───────────── */

function paintBadge() {
  const n = (M.summary.unread || 0) + (M.summary.notices_unread || 0);
  for (const el of $$('.nav-item[data-view="messages"], .mb-navbtn[data-mview="messages"]')) { if (n) el.setAttribute('data-badge', n > 99 ? '99+' : String(n)); else el.removeAttribute('data-badge'); }
}

/** Every 30 seconds (every 8 while the Messages page is open and showing): the unread counts, a toast for anything new, and the open conversation refreshed. */
async function tick() {
  clearTimeout(M.timer);
  if (!ctx?.user?.()) return;   // signed out: nothing to ask, and the timer stops until the next sign-in
  try {
    if (!document.hidden) {
      const s = await ctx.api('/messages/summary');
      const before = M.summary; M.summary = s; paintBadge();
      const latest = s.latest?.id ?? 0, notice = s.notice?.id ?? 0;
      const here = viewOpen() && M.mode === 'thread' && s.latest && s.latest.from_id === M.openId;
      if (M.first) {
        // Just signed in: say once what is waiting.
        const waiting = (s.unread || 0) + (s.notices_unread || 0);
        if (waiting) ctx.toast(waiting === 1 ? (s.unread ? `New message from ${s.latest.from}` : `Notice: ${clip(s.notice.body)}`) : `You have ${waiting} unread messages and notices`);
      } else {
        if (latest > (M.seenMsg ?? 0) && !here) ctx.toast(`New message from ${s.latest.from}`);
        if (notice > (M.seenNotice ?? 0)) ctx.toast(`Notice from ${s.notice.from}: ${clip(s.notice.body)}`);
      }
      M.seenMsg = Math.max(M.seenMsg ?? 0, latest); M.seenNotice = Math.max(M.seenNotice ?? 0, notice); M.first = false;
      if (viewOpen()) { await Promise.all([loadConvs(), loadNotices()]); if (M.mode === 'thread') await loadThread(M.openId, { quiet: true }); }
      void before;
    }
  } catch { /* the next round asks again */ }
  M.timer = setTimeout(tick, viewOpen() ? 8000 : 30000);
}
const clip = (t, n = 60) => (String(t).length > n ? String(t).slice(0, n - 1) + '…' : String(t));

/* ───────────── loading ───────────── */

export async function load() {
  paintShell();
  await Promise.all([loadNotices(), M.summary.chat ? loadConvs() : Promise.resolve()]);
  renderMain();
  clearTimeout(M.timer); M.timer = setTimeout(tick, 100);
}
async function loadConvs() { try { M.convs = (await ctx.api('/messages/conversations')).items; } catch { M.convs = []; } renderSide(); }
async function loadNotices() { try { M.notices = (await ctx.api('/messages/notices')).items; } catch { M.notices = []; } renderSide(); }
async function loadThread(id, { quiet = false } = {}) {
  const token = ++M.token;
  let items; try { items = (await ctx.api(`/messages/with/${id}`)).items; } catch (err) { if (!quiet) ctx.toast(err.message, true); return; }
  if (token !== M.token || id !== M.openId) return;
  const grew = items.length !== M.thread.length || items.some((m, i) => m.id !== M.thread[i]?.id || m.recalled !== M.thread[i]?.recalled || m.seen !== M.thread[i]?.seen);
  M.thread = items;
  if (grew || !quiet) renderThread(!quiet || nearBottom());
  const conv = M.convs.find((c) => c.user.id === id);
  if (!document.hidden && (conv?.unread || items.some((m) => !m.mine))) { try { await ctx.api(`/messages/with/${id}/read`, { method: 'POST' }); M.summary.unread = Math.max(0, (M.summary.unread || 0) - (conv?.unread || 0)); paintBadge(); if (conv) { conv.unread = 0; renderSide(); } } catch { /* shown as unread a little longer */ } }
}
const nearBottom = () => { const l = $('#msg-list'); return !l || l.scrollHeight - l.scrollTop - l.clientHeight < 80; };

/* ───────────── drawing ───────────── */

const when = (at) => {
  const d = new Date(String(at).replace(' ', 'T') + 'Z'); if (Number.isNaN(+d)) return '';
  const now = new Date(), hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${hm}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${hm}`;
};
const tint = (p) => (/^#[0-9a-f]{6}$/i.test(p?.colour || '') ? `--who:${p.colour}` : '');   // the person's colour, set by an admin
const avatar = (p, size = '') => `<span class="msg-av ${size}${p.avatar_v ? ' has-pic' : ''}" style="${tint(p)};${p.avatar_v ? `background-image:url(/api/auth/avatar/${p.id}?v=${esc(p.avatar_v)})` : ''}">${p.avatar_v ? '' : esc(String(p.name || p.username || '?').slice(0, 1).toUpperCase())}</span>`;

function paintShell() {
  const chat = M.summary.chat !== false;
  $('#msg-new')?.classList.toggle('hidden', !chat);
  $('#msg-admin')?.classList.toggle('hidden', ctx.user?.()?.role !== 'admin');
  $('#msg-wrap')?.classList.toggle('in-thread', M.mode === 'thread' || M.mode === 'people');
}

function renderSide() {
  const box = $('#msg-notices'), list = $('#msg-convs'); if (!box || !list) return;
  const admin = ctx.user?.()?.role === 'admin';
  box.innerHTML = M.notices.map((n) => `
    <div class="msg-notice${n.unread ? ' unread' : ''}" data-notice="${n.id}">
      <div class="msg-notice-head"><b>Notice</b><span>${esc(n.from)} · ${esc(when(n.at))}</span>
        ${admin ? `<button type="button" class="msg-x" data-msg-act="withdraw" data-id="${n.id}" title="Withdraw this notice for everyone" aria-label="Withdraw this notice for everyone">${ico.recall}</button>` : ''}
        <button type="button" class="msg-x" data-msg-act="dismiss" data-id="${n.id}" title="Dismiss for me" aria-label="Dismiss for me">${ico.close}</button></div>
      <div class="msg-notice-body">${esc(n.body)}</div>
    </div>`).join('');
  // a notice on screen counts as read
  for (const n of M.notices.filter((x) => x.unread && viewOpen())) { n.unread = false; ctx.api(`/messages/notices/${n.id}/read`, { method: 'POST' }).then(() => { M.summary.notices_unread = Math.max(0, (M.summary.notices_unread || 0) - 1); paintBadge(); }).catch(() => {}); }
  if (M.summary.chat === false) { list.innerHTML = '<p class="hint msg-empty">Chat is not available for this account. Notices from the admin appear above.</p>'; return; }
  list.innerHTML = M.convs.length ? M.convs.map((c) => `
    <button type="button" class="msg-conv${c.user.id === M.openId && M.mode === 'thread' ? ' on' : ''}${c.unread ? ' unread' : ''}" data-msg-act="open" data-id="${c.user.id}" style="${tint(c.user)}">
      ${avatar(c.user)}
      <span class="msg-conv-text"><span class="msg-conv-top"><b>${esc(c.user.name)}</b><small>${esc(when(c.last.at))}</small></span>
        <span class="msg-conv-last">${c.last.mine ? 'You: ' : ''}${esc(c.last.text)}</span></span>
      ${c.unread ? `<span class="msg-unread" aria-label="${c.unread} unread">${c.unread}</span>` : ''}
    </button>`).join('') : '<p class="hint msg-empty">No conversations yet. Press New to write to someone.</p>';
}

function renderMain() {
  const main = $('#msg-main'); if (!main) return;
  paintShell();
  if (M.mode === 'people') return renderPeople();
  if (M.mode === 'thread') return renderThread(true, true);
  main.innerHTML = `<div class="msg-placeholder">${M.summary.chat === false ? '<h2>Notices</h2><p>Chat is not available for this account, but notices from the admin appear here.</p>' : '<h2>Messages</h2><p>Pick a conversation, or press New to write to someone. Messages are private: only you and the other person can read them.</p>'}</div>`;
}

async function renderPeople() {
  const main = $('#msg-main');
  main.innerHTML = '<div class="msg-head"><button type="button" class="msg-back" data-msg-act="back" aria-label="Back" title="Back">←</button><b>Write to…</b></div><div class="msg-people" id="msg-people"><p class="hint msg-empty">Loading…</p></div>';
  try { M.people = (await ctx.api('/messages/people')).items; } catch (err) { $('#msg-people').innerHTML = `<p class="hint msg-empty">${esc(err.message)}</p>`; return; }
  $('#msg-people').innerHTML = M.people.length ? M.people.map((p) => `<button type="button" class="msg-conv" data-msg-act="open" data-id="${p.id}" style="${tint(p)}">${avatar(p)}<span class="msg-conv-text"><span class="msg-conv-top"><b>${esc(p.name)}</b></span><span class="msg-conv-last">${esc(p.username)}</span></span></button>`).join('') : '<p class="hint msg-empty">There is nobody else to write to yet.</p>';
}

const shareLine = (g) => g ? `<div class="msg-game"><span class="msg-game-ico" aria-hidden="true">🎮</span><span><b>${esc(g.title)}</b><small>${esc(g.platform)} · ${g.type === 'rom' ? 'ROM Library' : g.type === 'digital' ? 'their Digital Library' : 'their Physical Library'}</small></span>${g.type === 'rom' ? `<button type="button" class="btn btn-sm" data-msg-act="open-rom" data-id="${g.id}" title="Open this game in the ROM Library">Open</button>` : ''}</div>` : '';

function bubble(m) {
  const act = m.recalled ? '' : `<span class="msg-acts">
      <button type="button" class="msg-act" data-msg-act="reply" data-id="${m.id}" title="Reply" aria-label="Reply">${ico.reply}</button>
      ${m.can_recall ? `<button type="button" class="msg-act" data-msg-act="recall" data-id="${m.id}" title="Recall: take it back for both of you (first ${M.summary.recall_minutes} minutes)" aria-label="Recall">${ico.recall}</button>` : ''}
      <button type="button" class="msg-act" data-msg-act="delete" data-id="${m.id}" title="Delete for me" aria-label="Delete for me">${ctx.ICON.trash}</button></span>`;
  return `<div class="msg ${m.mine ? 'mine' : 'theirs'}${m.recalled ? ' recalled' : ''}" data-id="${m.id}">
    ${m.reply ? `<div class="msg-quote"><b>${m.reply.mine ? 'You' : esc(M.openName)}</b> ${esc(m.reply.text)}</div>` : ''}
    ${m.recalled ? '<div class="msg-text"><i>Message recalled</i></div>' : (m.body ? `<div class="msg-text">${esc(m.body)}</div>` : '')}
    ${m.recalled ? '' : shareLine(m.game)}
    <div class="msg-meta"><span>${esc(when(m.at))}${m.mine && m.seen ? ' · Seen' : ''}</span>${m.recalled ? `<button type="button" class="msg-act" data-msg-act="delete" data-id="${m.id}" title="Delete for me" aria-label="Delete for me">${ctx.ICON.trash}</button>` : act}</div></div>`;
}

function renderThread(scroll = true, full = false) {
  const main = $('#msg-main'); if (!main) return;
  const conv = M.convs.find((c) => c.user.id === M.openId);
  const who = conv?.user || M.people.find((p) => p.id === M.openId) || { id: M.openId, name: M.openName, username: M.openName, avatar_v: null };
  M.openName = who.name;
  if (full || !$('#msg-list')) {
    main.innerHTML = `
      <div class="msg-head"><button type="button" class="msg-back" data-msg-act="back" aria-label="Back" title="Back">←</button>${avatar(who, 'sm')}<b>${esc(who.name)}</b><button type="button" class="msg-x msg-del-conv" data-msg-act="delete-conv" title="Delete this conversation (for you only: ${esc(who.name)} keeps their copy)" aria-label="Delete this conversation">${ctx.ICON.trash}</button></div>
      <div class="msg-list" id="msg-list" style="${tint(who)}"></div>
      <div class="msg-compose">
        <div class="msg-chip hidden" id="msg-reply"></div>
        <div class="msg-chip hidden" id="msg-share-chip"></div>
        <div class="msg-picker hidden" id="msg-picker"><input id="msg-pick-q" class="search" type="search" placeholder="Search a game to share…" autocomplete="off" /><div id="msg-pick-list" class="msg-pick-list"></div></div>
        <div class="msg-row">
          <textarea id="msg-input" rows="2" placeholder="Write a message…" aria-label="Write a message"></textarea>
          <span class="msg-btns"><button type="button" class="btn" id="msg-share" data-msg-act="share" title="Share a game: only its title and platform are sent">Share a game</button><button type="button" class="btn btn-primary" id="msg-send" data-msg-act="send" title="Send">Send</button></span>
        </div>
        <div class="msg-count"><span id="msg-count">0 / ${M.summary.max_length}</span><span>Plain text only, no links. Private to you two.</span></div>
      </div>`;
    const input = $('#msg-input'); input.value = M.drafts[M.openId] || ''; paintCount(); paintChips();
  }
  const list = $('#msg-list');
  list.innerHTML = M.thread.length ? M.thread.map(bubble).join('') : '<p class="hint msg-empty">No messages yet. Say hello.</p>';
  if (scroll) list.scrollTop = list.scrollHeight;
  renderSide();
}

function paintCount() {
  const v = $('#msg-input')?.value || '', n = chars(v), max = M.summary.max_length;
  const c = $('#msg-count'); if (c) { c.textContent = `${n} / ${max}`; c.classList.toggle('warn', n >= max - 20); }
}
function paintChips() {
  const r = $('#msg-reply'), s = $('#msg-share-chip'); if (!r || !s) return;
  const q = M.replyTo && M.thread.find((m) => m.id === M.replyTo);
  r.classList.toggle('hidden', !q); r.innerHTML = q ? `<span>Replying to <b>${q.mine ? 'yourself' : esc(M.openName)}</b>: ${esc(q.recalled ? 'Message recalled' : q.body || 'a shared game')}</span><button type="button" class="msg-x" data-msg-act="cancel-reply" title="Cancel the reply" aria-label="Cancel the reply">${ico.close}</button>` : '';
  s.classList.toggle('hidden', !M.share); s.innerHTML = M.share ? `<span>Sharing <b>${esc(M.share.title)}</b> · ${esc(M.share.platform)}</span><button type="button" class="msg-x" data-msg-act="cancel-share" title="Do not share it" aria-label="Do not share it">${ico.close}</button>` : '';
}

/* ───────────── doing things ───────────── */

async function open(id) {
  const prev = $('#msg-input'); if (prev && M.openId) M.drafts[M.openId] = prev.value;
  M.mode = 'thread'; M.openId = Number(id); M.thread = []; M.replyTo = null; M.share = null;
  const p = M.convs.find((c) => c.user.id === M.openId)?.user || M.people.find((x) => x.id === M.openId); M.openName = p?.name || '';
  renderMain(); await loadThread(M.openId);
  $('#msg-input')?.focus();
}

async function send() {
  const input = $('#msg-input'); if (!input) return;
  const body = input.value.trim();
  if (!body && !M.share) return ctx.toast('Type a message.', true);
  const btn = $('#msg-send'); btn.disabled = true;
  try {
    await ctx.api(`/messages/with/${M.openId}`, { method: 'POST', body: JSON.stringify({ body, game: M.share ? M.share.ref : undefined, reply_to: M.replyTo || undefined }) });
    input.value = ''; delete M.drafts[M.openId]; M.replyTo = null; M.share = null; paintCount(); paintChips(); $('#msg-picker')?.classList.add('hidden');
    await loadThread(M.openId); await loadConvs();
  } catch (err) { ctx.toast(err.message, true); }
  finally { btn.disabled = false; input.focus(); }
}

let pickTimer;
async function pickSearch(q) {
  const list = $('#msg-pick-list'); if (!list) return;
  if (q.trim().length < 2) { list.innerHTML = '<p class="hint msg-empty">Type at least two letters of a game\'s name.</p>'; return; }
  list.innerHTML = '<p class="hint msg-empty">Searching…</p>';
  const enc = encodeURIComponent(q.trim());
  const [roms, digital, physical] = await Promise.all([
    ctx.api(`/roms?q=${enc}&limit=6`).then((r) => r.items || []).catch(() => []),
    ctx.api(`/digital/games?q=${enc}`).then((r) => (r.items || []).slice(0, 6)).catch(() => []),
    ctx.api(`/physical/games?q=${enc}`).then((r) => (r.items || []).slice(0, 6)).catch(() => [])
  ]);
  const platName = (slug) => (window.__platformsCache || []).find((p) => p.slug === slug)?.name || slug;
  const rows = [
    ...roms.map((g) => ({ group: 'ROM Library', title: g.title, platform: g.platform_name, ref: { type: 'rom', id: g.id } })),
    ...digital.map((g) => ({ group: 'Digital Library', title: g.name, platform: g.store === 'steam' ? 'Steam' : badgeLabel(g), ref: { type: 'digital', store: g.store, app_id: g.app_id } })),
    ...physical.map((g) => ({ group: 'Physical Library', title: g.title, platform: platName(g.platform), ref: { type: 'physical', id: g.id } }))
  ];
  M.pickRows = rows;
  list.innerHTML = rows.length ? ['ROM Library', 'Digital Library', 'Physical Library'].map((grp) => { const rs = rows.map((r, i) => ({ r, i })).filter((x) => x.r.group === grp); return rs.length ? `<div class="msg-pick-group">${grp}</div>` + rs.map(({ r, i }) => `<button type="button" class="msg-pick" data-msg-act="pick" data-i="${i}"><b>${esc(r.title)}</b><small>${esc(r.platform)}</small></button>`).join('') : ''; }).join('') : '<p class="hint msg-empty">No game of yours matches that.</p>';
}

async function onClick(e) {
  const b = e.target.closest('[data-msg-act]'); if (!b) return;
  const act = b.dataset.msgAct, id = Number(b.dataset.id);
  if (act === 'new') { M.mode = 'people'; M.openId = null; renderMain(); renderSide(); return; }
  if (act === 'back') { M.mode = 'idle'; M.openId = null; renderMain(); renderSide(); return; }
  if (act === 'open') return open(id);
  if (act === 'send') return send();
  if (act === 'share') { const p = $('#msg-picker'); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) { $('#msg-pick-q').focus(); pickSearch($('#msg-pick-q').value); } return; }
  if (act === 'pick') { const r = M.pickRows?.[Number(b.dataset.i)]; if (r) { M.share = { title: r.title, platform: r.platform, ref: r.ref }; paintChips(); $('#msg-picker').classList.add('hidden'); $('#msg-input').focus(); } return; }
  if (act === 'cancel-share') { M.share = null; paintChips(); return; }
  if (act === 'reply') { M.replyTo = id; paintChips(); $('#msg-input')?.focus(); return; }
  if (act === 'cancel-reply') { M.replyTo = null; paintChips(); return; }
  if (act === 'delete-conv') {
    if (!(await ctx.confirmDialog({ title: `Delete your conversation with ${M.openName}?`, body: 'Every message in it is deleted for you only. The other person keeps their copy, and a new message from them starts a fresh conversation.', okLabel: 'Delete conversation', danger: true }))) return;
    try { await ctx.api(`/messages/with/${M.openId}`, { method: 'DELETE' }); delete M.drafts[M.openId]; M.mode = 'idle'; M.openId = null; M.thread = []; M.replyTo = null; M.share = null; await Promise.all([loadConvs(), tick()]); renderMain(); ctx.toast('Conversation deleted'); }
    catch (err) { ctx.toast(err.message, true); }
    return;
  }
  if (act === 'delete') {
    if (!(await ctx.confirmDialog({ title: 'Delete this message?', body: 'It is deleted for you only. The other person keeps their copy.', okLabel: 'Delete', danger: true }))) return;
    try { await ctx.api(`/messages/${id}`, { method: 'DELETE' }); if (M.replyTo === id) M.replyTo = null; await loadThread(M.openId); await loadConvs(); paintChips(); } catch (err) { ctx.toast(err.message, true); }
    return;
  }
  if (act === 'recall') {
    if (!(await ctx.confirmDialog({ title: 'Recall this message?', body: 'It is wiped for both of you, and "Message recalled" is left in its place.', okLabel: 'Recall', danger: true }))) return;
    try { await ctx.api(`/messages/${id}/recall`, { method: 'POST' }); await loadThread(M.openId); await loadConvs(); } catch (err) { ctx.toast(err.message, true); await loadThread(M.openId); }
    return;
  }
  if (act === 'open-rom') { (document.querySelector('.mb-navbtn[data-mview="library"]') || document.querySelector('.nav-item[data-view="library"]'))?.click(); setTimeout(() => ctx.openRom?.(id), 350); return; }
  if (act === 'dismiss') { try { await ctx.api(`/messages/notices/${id}`, { method: 'DELETE' }); await loadNotices(); } catch (err) { ctx.toast(err.message, true); } return; }
  if (act === 'withdraw') {
    if (!(await ctx.confirmDialog({ title: 'Withdraw this notice?', body: 'It disappears for everyone.', okLabel: 'Withdraw', danger: true }))) return;
    try { await ctx.api(`/messages/notices/${id}/withdraw`, { method: 'POST' }); await loadNotices(); } catch (err) { ctx.toast(err.message, true); }
    return;
  }
  if (act === 'notice-toggle') { $('#msg-notice-form')?.classList.toggle('hidden'); $('#msg-notice-text')?.focus(); return; }
  if (act === 'notice-send') {
    const text = $('#msg-notice-text').value.trim(); if (!text) return ctx.toast('Type the notice.', true);
    try { await ctx.api('/messages/notices', { method: 'POST', body: JSON.stringify({ body: text, hours: Number($('#msg-notice-hours').value) }) }); $('#msg-notice-text').value = ''; $('#msg-notice-form').classList.add('hidden'); ctx.toast('Notice sent to everyone'); await loadNotices(); }
    catch (err) { ctx.toast(err.message, true); }
  }
}

function onInput(e) {
  if (e.target.id === 'msg-input') {
    const max = M.summary.max_length;
    if (chars(e.target.value) > max) e.target.value = [...e.target.value].slice(0, max).join('');
    M.drafts[M.openId] = e.target.value; paintCount();
  } else if (e.target.id === 'msg-notice-text') {
    const max = M.summary.max_length; if (chars(e.target.value) > max) e.target.value = [...e.target.value].slice(0, max).join('');
  } else if (e.target.id === 'msg-pick-q') { clearTimeout(pickTimer); pickTimer = setTimeout(() => pickSearch(e.target.value), 250); }
}
function onKey(e) {
  if (e.target.id === 'msg-input' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === 'Escape' && !$('#msg-picker')?.classList.contains('hidden')) { e.stopPropagation(); $('#msg-picker').classList.add('hidden'); }
}
