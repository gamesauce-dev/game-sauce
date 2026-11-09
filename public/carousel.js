// Cover carousel: a full-screen way to browse the ROM Library. Family chips along the top, the family's platform chips under them, and the games of the chosen
// platform as covers on a gentle arc, the middle one in front. Enter, or a click on the middle cover, plays it (in the browser when it can be, otherwise on this PC's own emulator).
// The backdrop is the family's colour, drifting slowly, with a wash of the middle cover's own colours that changes as you scroll.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const HEX = /^#[0-9a-f]{6}$/i;
const STEAM = 'steam:installed';   // the Steam games that have their Play button switched on (installed on this PC): a family and a platform of their own
const PAGE = 500, MAX = 3000;       // games fetched for one platform, a page at a time

/** The arc: where a cover sits for its distance `o` from the middle one (0 = middle, ±1 next to it...). Pure, so it can be tested. */
export function arcStyle(o) {
  const a = Math.abs(o);
  const spread = o === 0 ? 0 : Math.sign(o) * (178 + (a - 1) * 122);   // the middle cover gets room: its neighbours start further out
  return {
    x: Math.round(spread), y: Math.round(a * a * 7), rot: Math.round(o * 4.5 * 10) / 10,
    scale: Math.round((1.22 - Math.min(a, 5) * 0.1) * 100) / 100, z: 100 - Math.round(a), opacity: a > 6 ? 0 : Math.round((1 - a * 0.085) * 100) / 100
  };
}

/** The colour a picture mostly is (a 12 x 12 sample, dark and washed-out pixels counting less), as 'r, g, b'. Null when it cannot be read. */
export function dominantColour(img) {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 12;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 12, 12);
    const d = g.getImageData(0, 0, 12, 12).data; let r = 0, gr = 0, b = 0, w = 0;
    for (let i = 0; i < d.length; i += 4) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      const wt = 0.15 + (mx - mn) / 255 * (mx > 40 ? 1 : 0.2);   // saturated pixels carry the colour of a cover
      r += d[i] * wt; gr += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
    }
    return w ? `${Math.round(r / w)}, ${Math.round(gr / w)}, ${Math.round(b / w)}` : null;
  } catch { return null; }
}

let root = null, off = null;

/** Open the carousel. host: { api, toast, platforms(), user(), openPlayer(rom), platformIcon(p, size), start?: { platform } }. */
export function openCarousel(host) {
  if (root) return;
  const st = { zone: 'covers', hl: null, lp: null, fam: null, plat: null, games: [], idx: 0, loading: 0, colours: new Map(), els: new Map(), wheel: 0 };
  const steamPlat = () => (st.steam?.length ? [{ slug: STEAM, name: 'Steam', badge: 'STEAM', family: 'Steam', family_colour: '#2b79b8', accent: '#2b79b8', visible_count: st.steam.length }] : []);
  // Only games that can be started from this PC: those that play in the browser, plus every game of a platform the launcher reported an emulator for.
  // Until the launcher has reported (Check my PC), every platform is shown, because nothing is known yet. An account that cannot download has no launcher.
  const noLauncher = () => host.user()?.can_download === false;
  const known = () => (noLauncher() ? [] : st.lp);
  const launchable = (slug) => known() === null || known().includes(slug);
  const plats = () => [...(host.platforms() || []).map((p) => (launchable(p.slug) ? p : { ...p, visible_count: p.playable_count || 0 })).filter((p) => ((p.visible_count ?? p.count) || 0) > 0), ...steamPlat()];
  const fams = () => { const m = new Map(); for (const p of plats()) { const f = p.family || 'Others'; if (!m.has(f)) m.set(f, []); m.get(f).push(p); } return m; };
  const famColour = (f) => { const c = fams().get(f)?.[0]?.family_colour; return HEX.test(c || '') ? c : '#7c8aa5'; };
  const platColour = (p) => (HEX.test(p?.accent || '') ? p.accent : famColour(p?.family || 'Others'));

  root = document.createElement('div');
  root.className = 'cv'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Cover carousel');
  root.innerHTML = `
    <div class="cv-bg" aria-hidden="true"><i class="cv-blob b1"></i><i class="cv-blob b2"></i><i class="cv-blob b3"></i><i class="cv-tint t1"></i><i class="cv-tint t2"></i><i class="cv-grain"></i></div>
    <div class="cv-top"><div class="cv-fams" id="cv-fams" role="tablist"></div><button type="button" class="cv-pc" id="cv-setup" title="Choose the emulators this PC uses (opens a small setup page on this PC)">⚙ Set up emulators</button><button type="button" class="cv-pc" id="cv-pc" title="Find out which emulators are set up on this PC, so only games it can start are shown"></button><button type="button" class="cv-close" id="cv-close" aria-label="Close" title="Close (Esc)">✕</button></div>
    <div class="cv-subs" id="cv-subs"></div>
    <div class="cv-note hidden" id="cv-note"></div>
    <div class="cv-stage" id="cv-stage" aria-label="Games: use the arrow keys, the mouse wheel or swipe; Enter plays"><div class="cv-rail" id="cv-rail"></div><div class="cv-empty hidden" id="cv-empty"></div></div>
    <div class="cv-info" id="cv-info" aria-live="polite"></div>
    <div class="cv-pad-hint" aria-hidden="true"><b>◀ ▶</b> games <i>·</i> <b>▲ ▼</b> chips <i>·</i> <b>A</b> play or choose <i>·</i> <b>X</b> browser <i>·</i> <b>Y</b> emulator <i>·</i> <b>B</b> back</div>`;
  document.body.appendChild(root);
  document.body.classList.add('cv-open');
  const $ = (s) => root.querySelector(s);
  const prevFocus = document.activeElement;

  // ── the controller on the chips: up goes from the covers to the platform chips, then to the family chips; left and right move, A chooses, B goes back ──
  function paintHl() {
    root?.querySelectorAll('.pad').forEach((e) => e.classList.remove('pad'));
    if (!root || st.zone === 'covers' || !st.hl) return;
    const attr = st.zone === 'subs' ? 'data-plat' : 'data-fam';
    root.querySelector('[' + attr + '="' + CSS.escape(st.hl) + '"]')?.classList.add('pad');
  }
  function setZone(z) {
    st.zone = z; st.hl = z === 'subs' ? st.plat : z === 'fams' ? st.fam : null;
    root?.classList.toggle('on-chips', z !== 'covers'); paintHl();
  }

  // ── chips ──
  const drawFams = () => {
    const f = fams(), names = [...f.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    $('#cv-fams').innerHTML = names.map((n) => `<button type="button" class="cv-chip${st.fam === n ? ' on' : ''}" role="tab" aria-selected="${st.fam === n}" data-fam="${esc(n)}" style="--c:${esc(famColour(n))}">${esc(n)}</button>`).join('');
    paintHl();
  };
  const drawSubs = () => {
    const list = st.fam ? [...(fams().get(st.fam) || [])].sort((a, b) => String(a.name).localeCompare(b.name, undefined, { sensitivity: 'base' })) : [];
    const box = $('#cv-subs');
    box.innerHTML = list.map((p, i) => `<button type="button" class="cv-chip cv-sub${st.plat === p.slug ? ' on' : ''}" data-plat="${esc(p.slug)}" style="--c:${esc(platColour(p))};--i:${Math.min(i, 20)}">${esc(String(p.badge || p.short_name || p.name).toUpperCase())}<small>${(((p.visible_count ?? p.count) || 0)).toLocaleString()}</small></button>`).join('');
    box.classList.remove('land'); if (list.length && !reduced()) { void box.offsetWidth; box.classList.add('land'); }
    paintHl();
  };
  const setBackdrop = () => {
    const p = plats().find((x) => x.slug === st.plat), c = HEX.test(p?.family_colour || '') ? p.family_colour : (st.fam ? famColour(st.fam) : '#7c8aa5');
    root.style.setProperty('--fam', c);
  };

  // ── covers ──
  const gameAt = (i) => st.games[i];
  const place = (el, o) => {
    const s = arcStyle(o);
    el.style.transform = `translate(-50%, 0) translateX(${s.x}px) translateY(${s.y}px) rotate(${s.rot}deg) scale(${s.scale})`;
    el.style.zIndex = s.z; el.style.opacity = s.opacity; el.classList.toggle('mid', o === 0);
  };
  const makeCard = (g, i) => {
    const el = document.createElement('div'); el.className = 'cv-card'; el.dataset.i = i; el.setAttribute('role', 'button'); el.setAttribute('aria-label', g.title);
    const accent = HEX.test(g.platform_accent || '') ? g.platform_accent : '#5b6b88';
    el.innerHTML = `<div class="cv-face" style="background:linear-gradient(160deg,${accent},#1a1d27)"><span class="cv-fb">${esc(g.title)}</span>${g.cover_url ? `<img src="${esc(g.cover_url)}" alt="" draggable="false" decoding="async" />` : ''}</div>`;
    const img = el.querySelector('img');
    if (img) { img.onerror = () => { if (g.cover_fallback_url && !img.dataset.fb) { img.dataset.fb = '1'; img.src = g.cover_fallback_url; } else img.remove(); }; img.onload = () => { img.parentElement.classList.add('has'); if (i === st.idx) tint(); else colourOf(g, img); }; }
    return el;
  };
  const colourOf = (g, img) => { if (!st.colours.has(g.id) && img?.complete && img.naturalWidth) st.colours.set(g.id, dominantColour(img)); return st.colours.get(g.id) || null; };
  const tint = () => {
    const g = gameAt(st.idx); if (!g) return;
    const img = st.els.get(st.idx)?.querySelector('img');
    const c = colourOf(g, img);
    if (c === st.shown) return;
    st.shown = c; st.layer = !st.layer;                                        // the colour goes onto the layer that is hidden, then it fades in over the other
    const on = root.querySelector(st.layer ? '.t1' : '.t2'), offL = root.querySelector(st.layer ? '.t2' : '.t1');
    if (c) { on.style.setProperty('--tc', `rgb(${c})`); on.classList.add('on'); }
    offL.classList.remove('on');
  };
  const actsHtml = (g) => {
    if (g.steam) return '<button type="button" class="cv-btn primary" data-act="browser">▶ Play in Steam</button>';
    const b = canBrowser(g), l = canLocalPlay(g), pf = preferred();
    const btn = (act, label, main, tip) => `<button type="button" class="cv-btn${main ? ' primary' : ''}" data-act="${act}" title="${tip}">${label}</button>`;
    const out = [];
    if (b) out.push(btn('browser', '▶ Play in browser', !l || pf === 'browser', 'Play it here, in the browser'));
    if (l) out.push(btn('local', '🖥 Play on this PC', !b || pf === 'local', 'Play with the emulator set up on this PC'));
    if (b && l) out.push(`<button type="button" class="cv-link" data-act="prefer" title="Which one Enter, A and a click on the cover use">Enter plays: ${pf === 'local' ? 'your emulator' : 'the browser'} · switch</button>`);
    return out.join('');
  };
  const render = () => {
    const n = st.games.length, rail = $('#cv-rail');
    const lo = Math.max(0, st.idx - 8), hi = Math.min(n - 1, st.idx + 8);
    for (const [i, el] of st.els) if (i < lo || i > hi) { el.remove(); st.els.delete(i); }
    for (let i = lo; i <= hi; i++) { if (!st.els.has(i)) { const el = makeCard(gameAt(i), i); st.els.set(i, el); rail.appendChild(el); } place(st.els.get(i), i - st.idx); }
    const g = gameAt(st.idx);
    $('#cv-info').innerHTML = g ? `<div class="cv-title">${esc(g.title)}</div>
      <div class="cv-meta">${esc([g.platform_name, g.release_year, g.developer].filter(Boolean).join('  ·  '))}<span class="cv-pos">${(st.idx + 1).toLocaleString()} of ${n.toLocaleString()}</span></div>
      <div class="cv-acts">${actsHtml(g)}</div>` : '';
    tint();
  };
  const go = (i) => { const n = st.games.length; if (!n) return; st.idx = Math.max(0, Math.min(n - 1, i)); render(); };

  // ── loading ──
  const choose = async (slug) => {
    st.plat = slug; st.games = []; st.idx = 0; st.els.clear(); $('#cv-rail').innerHTML = ''; $('#cv-info').innerHTML = '';
    const tok = ++st.loading, empty = $('#cv-empty'); empty.classList.remove('hidden'); empty.textContent = 'Loading…';
    drawSubs(); setBackdrop();
    if (slug === STEAM) {   // already fetched: the Steam games that can be played from here
      st.games = (st.steam || []).map((g) => ({ id: 'steam-' + g.app_id, title: g.name, cover_url: g.cover_url, cover_fallback_url: g.cover_fallback_url, platform_name: 'Steam', developer: g.hours ? `${g.hours} h played` : '', launch_url: g.launch_url, steam: true, platform_accent: '#1b2838' }));
      empty.classList.toggle('hidden', st.games.length > 0); empty.textContent = 'No Steam games have their Play button on yet.'; render(); return;
    }
    try {
      let all = [], total = Infinity;
      while (all.length < Math.min(total, MAX)) {
        const q = new URLSearchParams({ platform: slug, sort: 'title', limit: String(PAGE), offset: String(all.length) });
        if (host.user()?.play_only || !launchable(slug)) q.set('playable', '1');   // no emulator of this platform on this PC: only the games that play in the browser
        const data = await host.api(`/roms?${q}`);
        if (tok !== st.loading) return;
        total = data.total; all = all.concat(data.items.filter((g) => !g.missing));   // a game whose file is not reachable cannot be started either
        if (!data.items.length) break;
        if (all.length === data.items.length) { st.games = all; empty.classList.add('hidden'); render(); }   // show the first page at once
      }
      st.games = all; if (tok === st.loading) { empty.classList.toggle('hidden', all.length > 0); empty.textContent = 'No games here yet.'; render(); }
    } catch (err) { if (tok === st.loading) { empty.classList.remove('hidden'); empty.textContent = err.message || 'Could not load the games'; } }
  };
  const chooseFam = (f) => {
    st.fam = f; drawFams(); drawSubs(); setBackdrop();
    const list = fams().get(f) || [];
    if (list.length) choose([...list].sort((a, b) => ((b.visible_count ?? b.count) || 0) - ((a.visible_count ?? a.count) || 0))[0].slug);
  };

  // ── playing ──
  // A game can often be played two ways: in the browser, and with the emulator set up on this PC. Both are offered; Enter, A and a click on the middle cover use the one you prefer
  // (your emulator, until you switch it: the choice is kept on this device).
  const canBrowser = (g) => Boolean(g && g.playable && !g.missing);
  const canLocalPlay = (g) => Boolean(g && !g.steam && host.user()?.can_download !== false && (known() === null || known().includes(st.plat)));
  const prefKey = 'gamesauce_cv_prefer';
  const preferred = () => { try { return localStorage.getItem(prefKey) === 'browser' ? 'browser' : 'local'; } catch { return 'local'; } };
  const play = (g) => {
    if (!g) return;
    if (g.steam) return launchSteam(g);
    const b = canBrowser(g), l = canLocalPlay(g);
    if (b && l) return preferred() === 'local' ? playLocal(g) : openBrowser(g);
    if (b) return openBrowser(g);
    return playLocal(g);
  };
  const launchSteam = (g) => { if (!g.launch_url) return; host.toast('Opening Steam…'); location.href = g.launch_url; };   // steam://rungameid/…: the Steam app on this PC starts it
  const openBrowser = (g) => g.steam ? launchSteam(g) : host.api(`/roms/${g.id}`).then(host.openPlayer).catch((err) => host.toast(err.message, true));   // the player needs the full row
  const playLocal = async (g) => {
    if (!g) return;
    if (g.steam) return launchSteam(g);
    if (host.user()?.can_download === false) { host.toast('This account cannot play on a local emulator', true); return; }
    try {
      const j = await host.api(`/roms/${g.id}/launch`, { method: 'POST' });
      const q = new URLSearchParams({ server: location.origin, token: j.token, platform: j.platform, ext: j.ext, title: j.title });
      host.toast('Opening your local emulator… this needs the game-sauce launcher installed on this PC.');
      location.href = `gamesauce://launch?${q}`;
    } catch (err) { host.toast(err.message || 'Could not start a local launch', true); }
  };

  // ── which platforms this PC can start (the launcher reports it) ──
  const parseLp = (prefs) => { try { const j = JSON.parse(prefs?.launcher_platforms || 'null'); return j && Array.isArray(j.platforms) ? j : null; } catch { return null; } };
  const paintPc = () => {
    const b = $('#cv-pc'), note = $('#cv-note');
    const s = $('#cv-setup');
    if (noLauncher()) { b.classList.add('hidden'); s?.classList.add('hidden'); note.classList.add('hidden'); return; }
    b.textContent = st.lp === null ? '🖥 Check my PC' : '🖥 This PC: ' + st.lp.length + ' platform' + (st.lp.length === 1 ? '' : 's');
    b.classList.toggle('attn', st.lp === null);
    note.classList.toggle('hidden', st.lp !== null);
    note.textContent = 'Showing every game. Press Check my PC so game-sauce can hide the ones this PC cannot start.';
  };
  const reload = () => { drawFams(); drawSubs(); const list = plats(); if (st.plat && st.plat !== STEAM && list.some((p) => p.slug === st.plat)) choose(st.plat); else if (st.fam && fams().has(st.fam)) chooseFam(st.fam); else if (list.length) chooseFam([...fams().keys()][0]); };
  // The launcher opens its setup page (on this PC only); saving there can also tell game-sauce, so the carousel updates.
  const setupEmulators = async () => {
    let before = null;
    try {
      before = parseLp(await host.api('/prefs'))?.at || null;
      const { token } = await host.api('/launcher/sync-token', { method: 'POST' });
      host.toast('Opening the setup page… (it needs the launcher installed on this PC: docs/LOCAL-LAUNCH.md)');
      location.href = 'gamesauce://configure?' + new URLSearchParams({ server: location.origin, token }).toString();
    } catch (err) { host.toast(err.message || 'Could not open the setup page', true); return; }
    for (let i = 0; i < 450 && root; i++) {       // the page can stay open a while: watch for a report for up to 15 minutes
      await new Promise((ok) => setTimeout(ok, 2000));
      try {
        const lp = parseLp(await host.api('/prefs'));
        if (lp && lp.at !== before) { st.lp = lp.platforms; paintPc(); host.toast('This PC can start: ' + (lp.platforms.join(', ') || 'nothing yet')); reload(); return; }
      } catch { /* try again */ }
    }
  };
  const checkPc = async () => {
    let before = null;
    try {
      const prefs = await host.api('/prefs'); before = parseLp(prefs)?.at || null;
      const { token } = await host.api('/launcher/sync-token', { method: 'POST' });
      host.toast('Asking the launcher on this PC… (it needs to be set up: docs/LOCAL-LAUNCH.md)');
      location.href = 'gamesauce://sync?' + new URLSearchParams({ server: location.origin, token }).toString();
    } catch (err) { host.toast(err.message || 'Could not start the check', true); return; }
    for (let i = 0; i < 20 && root; i++) {      // wait up to 40 seconds for the launcher's answer
      await new Promise((ok) => setTimeout(ok, 2000));
      try {
        const lp = parseLp(await host.api('/prefs'));
        if (lp && lp.at !== before) { st.lp = lp.platforms; paintPc(); host.toast(lp.platforms.length ? 'This PC can start: ' + lp.platforms.join(', ') : 'No emulators are set up on this PC yet: only games that play in the browser are shown'); reload(); return; }
      } catch { /* try again */ }
    }
    if (root) host.toast('The launcher did not answer. Is it installed on this PC, and is this server listed in its launcher.json?', true);
  };

  // ── input ──
  root.addEventListener('click', (e) => {
    if (e.target.closest('#cv-close')) return close();
    if (e.target.closest('#cv-pc')) return checkPc();
    if (e.target.closest('#cv-setup')) return setupEmulators();
    const fam = e.target.closest('[data-fam]'); if (fam) return chooseFam(fam.dataset.fam);
    const pl = e.target.closest('[data-plat]'); if (pl) return choose(pl.dataset.plat);
    const act = e.target.closest('[data-act]');
    if (act) {
      const g = gameAt(st.idx), a = act.dataset.act;
      if (a === 'prefer') { try { localStorage.setItem(prefKey, preferred() === 'local' ? 'browser' : 'local'); } catch { /* not kept */ } return render(); }
      return a === 'local' ? playLocal(g) : openBrowser(g);
    }
    const card = e.target.closest('.cv-card'); if (card && !drag.moved) { const i = Number(card.dataset.i); if (i === st.idx) play(gameAt(i)); else go(i); }
  });
  const stage = $('#cv-stage');
  stage.addEventListener('wheel', (e) => {
    e.preventDefault(); st.wheel += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const step = Math.trunc(st.wheel / 70); if (step) { st.wheel -= step * 70; go(st.idx + step); }
  }, { passive: false });
  const drag = { on: false, x: 0, base: 0, moved: false };
  stage.addEventListener('pointerdown', (e) => { if (e.button) return; drag.on = true; drag.moved = false; drag.x = e.clientX; drag.base = st.idx; });
  window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  function onMove(e) { if (!drag.on) return; const dx = e.clientX - drag.x; if (Math.abs(dx) > 6) drag.moved = true; if (drag.moved) go(drag.base - Math.round(dx / 110)); }
  function onUp() { if (!drag.on) return; drag.on = false; setTimeout(() => { drag.moved = false; }, 0); }
  const onKey = (e) => {
    if (document.querySelector('.player-scrim:not(.hidden)')) return;          // a game is open on top: leave the keys to it
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(st.idx + (e.shiftKey ? 10 : 1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(st.idx - (e.shiftKey ? 10 : 1)); }
    else if (e.key === 'Home') go(0); else if (e.key === 'End') go(st.games.length - 1);
    else if (e.key === 'Enter' && !e.target.closest?.('button')) { e.preventDefault(); play(gameAt(st.idx)); }
    else if (/^[a-z0-9]$/i.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest?.('input')) {   // a letter jumps to the first title that starts with it
      const k = e.key.toLowerCase(), i = st.games.findIndex((g) => String(g.title).replace(/^[^a-z0-9]+/i, '').toLowerCase().startsWith(k)); if (i >= 0) go(i);
    }
  };
  document.addEventListener('keydown', onKey);
  // The controller (public/gamepad.js sends what was pressed): left and right move through the games, up and down through the platforms, LB and RB through the families, A plays, X plays too, Y plays on this PC, B closes.
  const step = (list, cur, d) => { const i = list.indexOf(cur); return list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + d))]; };
  const platList = () => [...root.querySelectorAll('[data-plat]')].map((b) => b.dataset.plat);
  const famList = () => [...root.querySelectorAll('[data-fam]')].map((b) => b.dataset.fam);
  root.addEventListener('cv-pad', (e) => {
    const a = e.detail?.act, z = st.zone;
    const hlStep = (d) => { const list = z === 'subs' ? platList() : famList(); st.hl = step(list, st.hl, d); paintHl(); };
    if (a === 'left' || a === 'right') { const d = a === 'right' ? 1 : -1; if (z === 'covers') go(st.idx + d); else hlStep(d); }
    else if (a === 'up') { if (z === 'covers') { if (platList().length) setZone('subs'); else if (famList().length) setZone('fams'); } else if (z === 'subs' && famList().length) setZone('fams'); }
    else if (a === 'down') { if (z === 'fams' && platList().length) setZone('subs'); else if (z === 'subs') setZone('covers'); }
    else if (a === 'prev-family' || a === 'next-family') { const f = step(famList(), st.fam, a === 'next-family' ? 1 : -1); if (f && f !== st.fam) chooseFam(f); }
    else if (a === 'select') {
      if (z === 'covers') play(gameAt(st.idx));
      else if (z === 'subs') { const p = st.hl; setZone('covers'); if (p && p !== st.plat) choose(p); }
      else { const f = st.hl; setZone('covers'); if (f && f !== st.fam) chooseFam(f); }
    }
    else if (a === 'browser') openBrowser(gameAt(st.idx));
    else if (a === 'local') playLocal(gameAt(st.idx));
    else if (a === 'back') { if (z === 'covers') close(); else setZone('covers'); }
  });
  function close() {
    document.removeEventListener('keydown', onKey); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
    root.remove(); root = null; document.body.classList.remove('cv-open');
    try { prevFocus?.focus?.(); } catch { /* the opener is gone */ }
  }
  off = close;

  // Steam games with their Play button on come in next to the platforms (Digital's own list; not for play-only accounts)
  if (!host.user()?.play_only) host.api('/digital/games?store=steam&installed=1&sort=name').then((d) => { st.steam = d.items || []; if (st.steam.length && root) { drawFams(); drawSubs(); if (!st.plat || host.start?.platform === STEAM) chooseFam('Steam'); } else if (host.start?.platform === STEAM && root && !st.plat) { /* no Steam games: the platforms stay */ } }).catch(() => { /* no Steam, or no Digital: the platforms are all there is */ });

  host.api('/prefs').then((p) => { const lp = parseLp(p); if (lp) { st.lp = lp.platforms; if (root) { paintPc(); reload(); } } }).catch(() => {});
  paintPc();

  // start where the Library is: its first chosen platform, else the family with most games
  const all = plats();
  if (!all.length) { drawFams(); $('#cv-empty').classList.remove('hidden'); $('#cv-empty').textContent = 'No games in the Library yet.';  return; }
  const want = all.find((p) => p.slug === host.start?.platform);
  const f = fams(), biggest = [...f.entries()].sort((a, b) => b[1].reduce((n, p) => n + ((p.visible_count ?? p.count) || 0), 0) - a[1].reduce((n, p) => n + ((p.visible_count ?? p.count) || 0), 0))[0][0];
  st.fam = want ? (want.family || 'Others') : biggest; drawFams(); drawSubs();
  choose(want ? want.slug : [...f.get(st.fam)].sort((a, b) => ((b.visible_count ?? b.count) || 0) - ((a.visible_count ?? a.count) || 0))[0].slug);
  
}

export const closeCarousel = () => off?.();
