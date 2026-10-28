/* Gamepad navigation for the whole interface (couch / TV use).
 *
 *   D-pad or left stick   move the focus to the nearest control in that direction
 *   A                     activate the focused control (open a game, press a button)
 *   B                     back: close the panel / dialog, or return to the Library
 *   X                     play the focused game in the browser (when it can be played)
 *   Y                     jump to the search box
 *   LB / RB               previous / next game in the open game panel, otherwise previous / next section
 *
 * It only listens while a controller is connected, ignores input while a game is running in
 * the player (the pad belongs to the game then), and pauses when the tab is hidden.
 * Window-level, no dependencies. Move/activate logic is exposed as window.gamepadNav for tests.
 */
(function () {
  'use strict';
  if (!navigator.getGamepads) return;

  const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
  const STICK = 0.6;          // dead-zone before the stick counts as a press
  const FIRST_REPEAT = 380;   // ms before a held direction starts repeating
  const REPEAT = 130;         // ms between repeats

  const FOCUSABLE = 'button:not([disabled]), a[href], input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  let raf = 0, active = false;
  let prev = { buttons: [], dirs: {} };
  let heldSince = {}, lastRepeat = {};
  let lastAppFocus = null;
  let legend = null;

  const $ = (s, r = document) => r.querySelector(s);
  const hiddenAncestor = (el) => !!el.closest('.hidden, [hidden]');
  const visible = (el) => {
    if (!el || hiddenAncestor(el)) return false;
    const r = el.getClientRects();
    if (!r.length || r[0].width === 0 || r[0].height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.pointerEvents !== 'none';
  };

  /** Which layer owns the controller right now: the topmost dialog, else the game panel, else the app. */
  function currentRoot() {
    const player = $('#player-scrim');
    if (player && !player.classList.contains('hidden')) return null; // a game is running: hands off
    const auth = $('#auth-screen');
    if (auth && !auth.classList.contains('hidden')) return null;
    const modals = [...document.querySelectorAll('.modal-scrim:not(.hidden)')];
    if (modals.length) return modals[modals.length - 1];
    const drawer = $('#drawer');
    if (drawer && !drawer.classList.contains('hidden')) return drawer;
    return $('#app');
  }

  function candidates(root) {
    return [...root.querySelectorAll(FOCUSABLE)].filter(visible);
  }

  function centre(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  /** Nearest candidate in a direction. Cross-axis distance is weighted so rows/columns feel natural. */
  function pick(from, list, dir) {
    const a = from.getBoundingClientRect();
    const ac = centre(a);
    let best = null, bestScore = Infinity;
    for (const el of list) {
      if (el === from || from.contains(el) || el.contains(from)) continue;
      const r = el.getBoundingClientRect();
      const c = centre(r);
      const dx = c.x - ac.x, dy = c.y - ac.y;
      let main, cross, ok;
      if (dir === 'right') { ok = dx > 4; main = dx; cross = Math.abs(dy); }
      else if (dir === 'left') { ok = dx < -4; main = -dx; cross = Math.abs(dy); }
      else if (dir === 'down') { ok = dy > 4; main = dy; cross = Math.abs(dx); }
      else { ok = dy < -4; main = -dy; cross = Math.abs(dx); }
      if (!ok) continue;
      // Overlapping on the cross axis (same row/column) is strongly preferred.
      const overlap = (dir === 'left' || dir === 'right')
        ? Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top) > 0
        : Math.min(a.right, r.right) - Math.max(a.left, r.left) > 0;
      const score = main + cross * (overlap ? 1.2 : 4);
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function focusEl(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Make sure the focus is inside the current layer; returns true if it had to move it. */
  function ensureFocusIn(root) {
    const ae = document.activeElement;
    if (ae && ae !== document.body && root.contains(ae) && visible(ae)) return false;
    let target = null;
    if (root.id === 'drawer') {
      target = $('[data-act="play"]', root) || $('.detail-actions .btn-primary', root) || null;
    } else if (root.classList.contains('modal-scrim')) {
      target = $('.btn-primary, .btn-danger', root);
    } else if (root.id === 'app') {
      if (lastAppFocus && root.contains(lastAppFocus) && visible(lastAppFocus)) target = lastAppFocus;
      else target = $('.card.nav-current') || $('#grid .card') || $('.nav-item.is-active');
    }
    if (!target || !visible(target)) target = candidates(root)[0];
    focusEl(target);
    return true;
  }

  function move(dir) {
    const root = currentRoot();
    if (!root) return false;
    if (ensureFocusIn(root)) return true; // first press only lands the focus
    const from = document.activeElement;
    const next = pick(from, candidates(root), dir);
    if (next) { focusEl(next); if (root.id === 'app') lastAppFocus = next; return true; }
    return false;
  }

  function activate() {
    const root = currentRoot();
    if (!root) return;
    if (ensureFocusIn(root)) return;
    const el = document.activeElement;
    if (!el || el === document.body) return;
    if (el.tagName === 'SELECT' && el.showPicker) { try { el.showPicker(); return; } catch { /* fall through */ } }
    if (el.tagName === 'INPUT' && /text|search|password|number|email|url/.test(el.type || 'text')) { el.focus(); return; }
    if (root.id === 'app') lastAppFocus = el;
    el.click();
    // A tile opens the game panel: carry the focus into it.
    setTimeout(() => { const r = currentRoot(); if (r) ensureFocusIn(r); }, 450);
  }

  function back() {
    const root = currentRoot();
    if (!root) return;
    if (root.id === 'app') {
      const lib = $('.nav-item[data-view="library"]');
      if (lib && !lib.classList.contains('is-active')) lib.click();
      return;
    }
    // Panels and dialogs already close on Escape.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    setTimeout(() => { const r = currentRoot(); if (r) ensureFocusIn(r); }, 250);
  }

  function shoulder(dir) {
    const root = currentRoot();
    if (!root) return;
    const nav = $('#drawer-nav');
    if (root.id === 'drawer' && nav && !nav.classList.contains('hidden')) {
      const b = $(dir > 0 ? '#drawer-next' : '#drawer-prev');
      if (b && !b.disabled) b.click();
      setTimeout(() => { const r = currentRoot(); if (r) ensureFocusIn(r); }, 500);
      return;
    }
    if (root.id !== 'app') return;
    const items = [...document.querySelectorAll('.nav-item')].filter(visible);
    const i = items.findIndex((n) => n.classList.contains('is-active'));
    const target = items[(i + dir + items.length) % items.length];
    if (target) target.click();
  }

  function playFocused() {
    const root = currentRoot();
    if (!root || root.id !== 'app') return;
    const el = document.activeElement;
    const tile = el && el.closest ? el.closest('.card') : null;
    const btn = tile && tile.querySelector('[data-play]');
    if (btn) btn.click();
  }

  function focusSearch() {
    const root = currentRoot();
    if (!root || root.id !== 'app') return;
    const s = $('#search');
    if (s && visible(s)) { s.focus(); s.select?.(); }
  }

  /* ── input loop ── */
  function showLegend(on) {
    if (!legend) {
      legend = document.createElement('div');
      legend.id = 'gp-legend';
      legend.setAttribute('aria-hidden', 'true');
      legend.innerHTML = '<b>◀▲▼▶</b> move <span>·</span> <b>A</b> select <span>·</span> <b>B</b> back <span>·</span> <b>X</b> play <span>·</span> <b>Y</b> search <span>·</span> <b>LB/RB</b> prev/next';
      document.body.appendChild(legend);
    }
    legend.classList.toggle('on', on);
    document.body.classList.toggle('gp-active', on);
  }

  function readPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  function dirsOf(p) {
    const ax = p.axes || [];
    const b = p.buttons || [];
    const pressed = (i) => !!(b[i] && (b[i].pressed || b[i].value > 0.5));
    return {
      up: pressed(BTN.UP) || (ax[1] || 0) < -STICK,
      down: pressed(BTN.DOWN) || (ax[1] || 0) > STICK,
      left: pressed(BTN.LEFT) || (ax[0] || 0) < -STICK,
      right: pressed(BTN.RIGHT) || (ax[0] || 0) > STICK
    };
  }

  function tick(now) {
    if (!active) return;
    raf = requestAnimationFrame(tick);
    if (document.hidden) return;
    const p = readPad();
    if (!p) return;
    const b = p.buttons || [];
    const down = (i) => !!(b[i] && (b[i].pressed || b[i].value > 0.5));
    const edge = (i) => down(i) && !prev.buttons[i];

    let any = false;
    const d = dirsOf(p);
    for (const dir of ['up', 'down', 'left', 'right']) {
      if (d[dir]) {
        any = true;
        if (!prev.dirs[dir]) { heldSince[dir] = now; lastRepeat[dir] = now; move(dir); }
        else if (now - heldSince[dir] > FIRST_REPEAT && now - lastRepeat[dir] > REPEAT) { lastRepeat[dir] = now; move(dir); }
      }
    }
    if (edge(BTN.A)) { any = true; activate(); }
    if (edge(BTN.B)) { any = true; back(); }
    if (edge(BTN.X)) { any = true; playFocused(); }
    if (edge(BTN.Y)) { any = true; focusSearch(); }
    if (edge(BTN.LB)) { any = true; shoulder(-1); }
    if (edge(BTN.RB)) { any = true; shoulder(1); }

    if (any && currentRoot()) showLegend(true);
    prev = { buttons: Array.from({ length: Math.max(b.length, 16) }, (_, i) => down(i)), dirs: d };
  }

  function begin() { if (active) return; active = true; raf = requestAnimationFrame(tick); }
  function end() { active = false; if (raf) cancelAnimationFrame(raf); raf = 0; showLegend(false); prev = { buttons: [], dirs: {} }; }

  window.addEventListener('gamepadconnected', begin);
  window.addEventListener('gamepaddisconnected', () => { if (!readPad()) end(); });
  if (readPad()) begin(); // already connected before the page loaded

  // Back to normal pointer/keyboard feel as soon as the mouse or keyboard is used.
  const quiet = () => { if (document.body.classList.contains('gp-active')) showLegend(false); };
  window.addEventListener('mousemove', quiet, { passive: true });
  window.addEventListener('keydown', (e) => { if (!e.isTrusted || e.key === 'Escape') return; quiet(); }, true);

  window.gamepadNav = { move, activate, back, shoulder, playFocused, focusSearch, currentRoot };
})();
