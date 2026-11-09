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
  const st = { fam: null, plat: null, games: [], idx: 0, loading: 0, colours: new Map(), els: new Map(), wheel: 0 };
  const steamPlat = () => (st.steam?.length ? [{ slug: STEAM, name: 'Steam', badge: 'STEAM', family: 'Steam', family_colour: '#2b79b8', accent: '#2b79b8', visible_count: st.steam.length }] : []);
  const plats = () => [...(host.platforms() || []).filter((p) => ((p.visible_count ?? p.count) || 0) > 0), ...steamPlat()];
  const fams = () => { const m = new Map(); for (const p of plats()) { const f = p.family || 'Others'; if (!m.has(f)) m.set(f, []); m.get(f).push(p); } return m; };
  const famColour = (f) => { const c = fams().get(f)?.[0]?.family_colour; return HEX.test(c || '') ? c : '#7c8aa5'; };
  const platColour = (p) => (HEX.test(p?.accent || '') ? p.accent : famColour(p?.family || 'Others'));

  root = document.createElement('div');
  root.className = 'cv'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Cover carousel');
  root.innerHTML = `
    <div class="cv-bg" aria-hidden="true"><i class="cv-blob b1"></i><i class="cv-blob b2"></i><i class="cv-blob b3"></i><i class="cv-tint t1"></i><i class="cv-tint t2"></i><i class="cv-grain"></i></div>
    <div class="cv-top"><div class="cv-fams" id="cv-fams" role="tablist"></div><button type="button" class="cv-close" id="cv-close" aria-label="Close" title="Close (Esc)">✕</button></div>
    <div class="cv-subs" id="cv-subs"></div>
    <div class="cv-stage" id="cv-stage" aria-label="Games: use the arrow keys, the mouse wheel or swipe; Enter plays"><div class="cv-rail" id="cv-rail"></div><div class="cv-empty hidden" id="cv-empty"></div></div>
    <div class="cv-info" id="cv-info" aria-live="polite"></div>
    <div class="cv-pad-hint" aria-hidden="true"><b>◀ ▶</b> games <i>·</i> <b>▲ ▼</b> platform <i>·</i> <b>LB RB</b> family <i>·</i> <b>A</b> play <i>·</i> <b>Y</b> on this PC <i>·</i> <b>B</b> close</div>`;
  document.body.appendChild(root);
  document.body.classList.add('cv-open');
  const $ = (s) => root.querySelector(s);
  const prevFocus = document.activeElement;

  // ── chips ──
  const drawFams = () => {
    const f = fams(), names = [...f.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    $('#cv-fams').innerHTML = names.map((n) => `<button type="button" class="cv-chip${st.fam === n ? ' on' : ''}" role="tab" aria-selected="${st.fam === n}" data-fam="${esc(n)}" style="--c:${esc(famColour(n))}">${esc(n)}</button>`).join('');
  };
  const drawSubs = () => {
    const list = st.fam ? [...(fams().get(st.fam) || [])].sort((a, b) => String(a.name).localeCompare(b.name, undefined, { sensitivity: 'base' })) : [];
    const box = $('#cv-subs');
    box.innerHTML = list.map((p, i) => `<button type="button" class="cv-chip cv-sub${st.plat === p.slug ? ' on' : ''}" data-plat="${esc(p.slug)}" style="--c:${esc(platColour(p))};--i:${Math.min(i, 20)}"><span class="cv-ico" aria-hidden="true">${host.platformIcon ? host.platformIcon(p, 16) : ''}</span>${esc(String(p.badge || p.short_name || p.name).toUpperCase())}<small>${(((p.visible_count ?? p.count) || 0)).toLocaleString()}</small></button>`).join('');
    box.classList.remove('land'); if (list.length && !reduced()) { void box.offsetWidth; box.classList.add('land'); }
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
  const render = () => {
    const n = st.games.length, rail = $('#cv-rail');
    const lo = Math.max(0, st.idx - 8), hi = Math.min(n - 1, st.idx + 8);
    for (const [i, el] of st.els) if (i < lo || i > hi) { el.remove(); st.els.delete(i); }
    for (let i = lo; i <= hi; i++) { if (!st.els.has(i)) { const el = makeCard(gameAt(i), i); st.els.set(i, el); rail.appendChild(el); } place(st.els.get(i), i - st.idx); }
    const g = gameAt(st.idx);
    $('#cv-info').innerHTML = g ? `<div class="cv-title">${esc(g.title)}</div>
      <div class="cv-meta">${esc([g.platform_name, g.release_year, g.developer].filter(Boolean).join('  ·  '))}<span class="cv-pos">${(st.idx + 1).toLocaleString()} of ${n.toLocaleString()}</span></div>
      <div class="cv-acts">${g.steam ? '<button type="button" class="cv-btn primary" data-act="play">▶ Play in Steam</button>' : g.playable && !g.missing ? '<button type="button" class="cv-btn primary" data-act="play">▶ Play</button>' : ''}${g.steam || host.user()?.can_download === false ? '' : '<button type="button" class="cv-btn" data-act="local" title="Play with the emulator installed on this PC">🖥 Play on this PC</button>'}</div>` : '';
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
        if (host.user()?.play_only) q.set('playable', '1');
        const data = await host.api(`/roms?${q}`);
        if (tok !== st.loading) return;
        total = data.total; all = all.concat(data.items);
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
  const play = (g) => {
    if (!g) return;
    if (g.steam) return launchSteam(g);
    if (g.playable && !g.missing) openBrowser(g);
    else playLocal(g);
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

  // ── input ──
  root.addEventListener('click', (e) => {
    if (e.target.closest('#cv-close')) return close();
    const fam = e.target.closest('[data-fam]'); if (fam) return chooseFam(fam.dataset.fam);
    const pl = e.target.closest('[data-plat]'); if (pl) return choose(pl.dataset.plat);
    const act = e.target.closest('[data-act]'); if (act) return act.dataset.act === 'play' ? openBrowser(gameAt(st.idx)) : playLocal(gameAt(st.idx));
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
    const a = e.detail?.act;
    if (a === 'left') go(st.idx - 1); else if (a === 'right') go(st.idx + 1);
    else if (a === 'up') { const p = step(platList(), st.plat, -1); if (p && p !== st.plat) choose(p); }
    else if (a === 'down') { const p = step(platList(), st.plat, 1); if (p && p !== st.plat) choose(p); }
    else if (a === 'prev-family' || a === 'next-family') { const f = step(famList(), st.fam, a === 'next-family' ? 1 : -1); if (f && f !== st.fam) chooseFam(f); }
    else if (a === 'select') play(gameAt(st.idx));
    else if (a === 'local') playLocal(gameAt(st.idx));
    else if (a === 'back') close();
  });
  function close() {
    document.removeEventListener('keydown', onKey); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
    root.remove(); root = null; document.body.classList.remove('cv-open');
    try { prevFocus?.focus?.(); } catch { /* the opener is gone */ }
  }
  off = close;

  // Steam games with their Play button on come in next to the platforms (Digital's own list; not for play-only accounts)
  if (!host.user()?.play_only) host.api('/digital/games?store=steam&installed=1&sort=name').then((d) => { st.steam = d.items || []; if (st.steam.length && root) { drawFams(); drawSubs(); } }).catch(() => { /* no Steam, or no Digital: the platforms are all there is */ });

  // start where the Library is: its first chosen platform, else the family with most games
  const all = plats();
  if (!all.length) { drawFams(); $('#cv-empty').classList.remove('hidden'); $('#cv-empty').textContent = 'No games in the Library yet.';  return; }
  const want = all.find((p) => p.slug === host.start?.platform);
  const f = fams(), biggest = [...f.entries()].sort((a, b) => b[1].reduce((n, p) => n + ((p.visible_count ?? p.count) || 0), 0) - a[1].reduce((n, p) => n + ((p.visible_count ?? p.count) || 0), 0))[0][0];
  st.fam = want ? (want.family || 'Others') : biggest; drawFams(); drawSubs();
  choose(want ? want.slug : [...f.get(st.fam)].sort((a, b) => ((b.visible_count ?? b.count) || 0) - ((a.visible_count ?? a.count) || 0))[0].slug);
  
}

export const closeCarousel = () => off?.();
