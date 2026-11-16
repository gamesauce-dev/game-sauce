// The progress card for "Play on this PC". The game is downloaded by the launcher on this PC, not by the page, so the page cannot see the
// download itself: it asks the server how far this launch has got (the server counts the bytes it sends, and a newer launcher also says
// what it is doing: downloading, unpacking, starting, running) and shows that as a card with a bar. One card at a time; starting another
// launch replaces it. Used by the game's details window, the Carousel and Big Screen.
import { t } from './i18n.js';

const POLL_MS = 700;
const GIVE_UP_S = 130;              // a launch link is good for two minutes: after that nobody is coming for the file
const HINT_AFTER_S = 8;             // still nothing from the launcher after this long: say what to check
const TERMINAL = new Set(['closed', 'error']);

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};
/** "42 s", "3 min", "1 h 20 min": a rough time left (the units are the same in every language). Pure, so it can be tested. */
export function fmtLeft(s) {
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 90) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** What to show for a state the server reported. Pure (no page needed), so it can be tested.
 *  Returns { line, pct (0-100, or null when the time cannot be known), tone: 'busy' | 'ok' | 'bad', hold (ms to stay before hiding, or 0 to stay), meta } */
export function describeLaunch(v, { speed = 0 } = {}) {
  const p = v.phase;
  if (p === 'waiting') {
    return { line: t('Waiting for the launcher on your PC…'), pct: null, tone: 'busy', hold: 0, meta: v.age_s >= HINT_AFTER_S ? t('Nothing yet? Check the launcher is installed and that your browser was allowed to open it (docs/LOCAL-LAUNCH.md).') : '' };
  }
  if (p === 'downloading') {
    const pct = v.total ? Math.min(100, (v.bytes / v.total) * 100) : null;
    let meta = v.total ? t('{a} of {b} ({c}%)', { a: fmtBytes(v.bytes), b: fmtBytes(v.total), c: Math.floor(pct) }) : fmtBytes(v.bytes);
    if (speed > 0) { meta += ' · ' + fmtBytes(speed) + '/s'; if (v.total && v.total > v.bytes) meta += ' · ' + t('about {a} left', { a: fmtLeft((v.total - v.bytes) / speed) }); }
    return { line: t('Downloading to your PC…'), pct, tone: 'busy', hold: 0, meta };
  }
  if (p === 'sent') return { line: t('Sent to your PC. Your emulator should open any moment.'), pct: 100, tone: 'ok', hold: 9000, meta: '' };   // an older launcher says nothing more
  if (p === 'unpacking') return { line: t('Unpacking the game… this can take a while for a big one.'), pct: null, tone: 'busy', hold: 0, meta: '' };
  if (p === 'starting') return { line: t('Starting your emulator…'), pct: null, tone: 'busy', hold: 0, meta: '' };
  if (p === 'running') return { line: t('Playing on this PC'), pct: 100, tone: 'ok', hold: 5000, meta: '' };
  if (p === 'error') return { line: v.message || t('The launch failed.'), pct: v.total && v.bytes < v.total ? (v.bytes / v.total) * 100 : null, tone: 'bad', hold: 0, meta: '' };
  return { line: '', pct: null, tone: 'ok', hold: 1, meta: '' };   // closed
}

let current = null;   // { el, token, timer, hideTimer }

function removeCard() {
  if (!current) return;
  current.token = null;
  clearTimeout(current.timer); clearTimeout(current.hideTimer);
  current.el.remove();
  current = null;
}

function makeCard(title, big) {
  const el = document.createElement('div');
  el.className = 'launch-card' + (big ? ' lc-big' : '');
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = '<div class="lc-head"><b class="lc-title"></b><button type="button" class="lc-x" aria-label="Close" title="Close">✕</button></div>'
    + '<div class="lc-line"></div><div class="lc-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div><div class="lc-meta"></div>';
  el.querySelector('.lc-title').textContent = title;
  el.querySelector('.lc-x').addEventListener('click', removeCard);
  document.body.append(el);
  return el;
}

/** Show the progress card for a launch the server has just made. `launch` is what POST /roms/:id/launch answered ({ lid, title, size });
 *  `api` is the page's own api(); `big` makes the card larger (Big Screen, on a TV). */
export function trackLaunch({ api, launch, big = false }) {
  removeCard();
  if (!launch || !launch.lid) { return; }
  const el = makeCard(t('Starting {a} on this PC', { a: launch.title || t('the game') }), big);
  const cur = current = { el, token: Symbol('launch'), timer: 0, hideTimer: 0 };
  const line = el.querySelector('.lc-line'), meta = el.querySelector('.lc-meta'), bar = el.querySelector('.lc-bar'), fill = bar.firstElementChild;
  let last = null, speed = 0, failures = 0, wasIndet = true;

  const paint = (v) => {
    const d = describeLaunch(v, { speed });
    line.textContent = d.line;
    meta.textContent = d.meta;
    el.dataset.tone = d.tone;
    bar.classList.toggle('lc-indet', d.pct === null);
    if (d.pct === null) { fill.style.width = ''; bar.removeAttribute('aria-valuenow'); }
    else {
      if (wasIndet) fill.style.transition = 'none';   // coming from the moving bar: jump to the real width, do not slide back from it
      fill.style.width = d.pct.toFixed(1) + '%';
      if (wasIndet) { void fill.offsetWidth; fill.style.transition = ''; }
      bar.setAttribute('aria-valuenow', String(Math.round(d.pct)));
    }
    wasIndet = d.pct === null;
    return d;
  };
  paint({ phase: 'waiting', age_s: 0, bytes: 0, total: launch.size || 0 });

  const tick = async () => {
    if (current !== cur) return;
    let v = null;
    try { v = await api(`/launch-status/${encodeURIComponent(launch.lid)}`); failures = 0; } catch { failures++; }
    if (current !== cur) return;
    if (!v) {
      if (failures >= 5) paint({ phase: 'error', message: t('Lost touch with the server.'), bytes: 0, total: 0 });
      else cur.timer = setTimeout(tick, POLL_MS * 2);
      return;
    }
    // a smoothed download speed from the last two answers
    const now = Date.now();
    if (last && v.phase === 'downloading' && v.bytes >= last.bytes && now > last.at) {
      const inst = (v.bytes - last.bytes) / ((now - last.at) / 1000);
      speed = speed ? speed * 0.7 + inst * 0.3 : inst;
    } else if (v.phase !== 'downloading') speed = 0;
    last = { bytes: v.bytes, at: now };

    if (v.phase === 'waiting' && v.age_s > GIVE_UP_S) v = { ...v, phase: 'error', message: t('The launcher never answered. Check it is installed on this PC (docs/LOCAL-LAUNCH.md), then try again.') };
    const d = paint(v);
    if (v.phase === 'closed') { removeCard(); return; }
    if (d.hold) { cur.hideTimer = setTimeout(() => { if (current === cur) removeCard(); }, d.hold); }
    if (TERMINAL.has(v.phase) || d.hold) return;       // finished (or about to hide): stop asking
    cur.timer = setTimeout(tick, POLL_MS);
  };
  cur.timer = setTimeout(tick, 400);
}

/** Close the card (a game was started some other way, or the page is going away). */
export const hideLaunch = removeCard;
