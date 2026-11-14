// Big Screen: the Library for a PC on the TV, driven by a gamepad (or the keyboard). Three screens:
//   platforms  a row of family tiles (Sony, Nintendo...), with Favourites and Collections (when you have any) on a row of their own below it; then the platforms of the family chosen;
//   games      the games of a platform, your favourites or one collection as a wheel, the one in the middle large;
//   game       a menu on the left (Play, Favourite, Add to Collection, Mark as Broken, Hide), the cover, and the details.
// On top of those: the collection chooser, a keyboard to type a name with the pad, and a question (hide from everyone?).
// The pad is read by public/gamepad.js, which sends what was pressed to this layer as a 'cv-pad' event (the same way the cover carousel is driven).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const HEX = /^#[0-9a-f]{6}$/i;
const PAGE = 500, MAX = 3000;       // games fetched for one platform, a page at a time

/** Where a game sits on the wheel for its distance `o` from the middle one (0 = middle). Pure, so it can be tested. */
export function wheelStyle(o) {
  const a = Math.abs(o);
  return {
    y: o === 0 ? 0 : Math.sign(o) * (13.5 + (a - 1) * 5.4),                       // em, up (-) or down (+) from the middle
    scale: o === 0 ? 1 : Math.max(0.55, 0.8 - (a - 1) * 0.1),
    opacity: a > 4 ? 0 : o === 0 ? 1 : Math.max(0.12, 0.6 - (a - 1) * 0.16)
  };
}

/** A game's own pictures for Big Screen: its logo and its marquee, when it has them. An imported one (logo_url, marquee_url) comes first; a game matched by ScreenScraper also keeps them as "wheel" and "marquee". */
export const gameLogo = (g) => g?.logo_url || (g?.media?.wheel ? `/api/roms/${g.id}/media/wheel` : '');
export const gameMarquee = (g) => g?.marquee_url || (g?.media?.marquee ? `/api/roms/${g.id}/media/marquee` : '');

/** What the wheel shows for a game: its marquee (the art an arcade game is known by, and a banner for any other game that has one), else its logo, else the cover. */
export const wheelArt = (g) => gameMarquee(g) || gameLogo(g);

/** The picture behind a game: its own background art (imported, or a ScreenScraper match's fan art), else a screenshot; null when it has neither (the cover is blurred instead). */
export const gameBackdrop = (g) => g?.backdrop_url || (g?.media?.fanart ? `/api/roms/${g.id}/media/fanart` : g?.media?.screenshot ? `/api/roms/${g.id}/media/screenshot` : '');

/** The sounds of Big Screen: short tones made on the spot (no files), switched off with Start, the speaker in the top bar or M. The choice is kept on this device. */
const MUTE_KEY = 'gamesauce_bs_muted';
const muted = () => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } };
let audio = null;
const TONES = { move: [[760, 0.05, 0.3]], select: [[620, 0.07, 0.38], [930, 0.1, 0.38]], back: [[560, 0.07, 0.34], [380, 0.1, 0.34]], error: [[180, 0.2, 0.34]], key: [[1000, 0.04, 0.24]] };   // [pitch in Hz, length in s, volume 0 to 1]
export function sfx(kind) {
  if (muted() || !TONES[kind]) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume?.().catch(() => {});
    let t = audio.currentTime;
    for (const [freq, len, vol] of TONES[kind]) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = kind === 'error' ? 'sawtooth' : 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + len + 0.02); t += len * 0.9;
    }
  } catch { /* no audio on this device: Big Screen stays silent */ }
}

/** The menu of the game screen. Pure, so it can be tested. */
export function gameMenu(g) {
  return [
    { k: 'play', label: 'Play' },
    { k: 'fav', label: 'Favourite', on: Boolean(g?.favorite) },   // a toggle: the word stays, it turns gold when it is on
    { k: 'coll', label: 'Add to Collection' },
    ...(g?.manual_url ? [{ k: 'manual', label: 'Read Manual' }] : []),
    { k: 'broken', label: g?.broken ? 'Unmark as Broken' : 'Mark as Broken' },
    { k: 'hide', label: 'Hide' }
  ];
}

/** The on-screen keyboard (to name a collection with the pad), and how the pad moves over it. Pure, so it can be tested. */
export const KEYBOARD = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '-'],
  ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '.', 'back'],
  ['space', 'cancel', 'done']
];
export function kbMove(r, c, dir) {
  const rows = KEYBOARD;
  if (dir === 'left') return [r, Math.max(0, c - 1)];
  if (dir === 'right') return [r, Math.min(rows[r].length - 1, c + 1)];
  const r2 = dir === 'up' ? Math.max(0, r - 1) : Math.min(rows.length - 1, r + 1);
  if (r2 === r) return [r, c];
  const from = rows[r].length, to = rows[r2].length;
  return [r2, from <= 1 ? 0 : Math.max(0, Math.min(to - 1, Math.round(c * (to - 1) / (from - 1))))];
}

let root = null, off = null;

/** Open Big Screen. host: { api, toast, platforms(), user(), openPlayer(rom), platformIcon?(p, size), kiosk?: boolean, start?: { platform } }. */
export function openBigScreen(host) {
  if (root) return;
  const st = { screen: 'platforms', level: 0, row: 0, pis: [0, 0], sub: null, fam: null, plat: null, src: null, plats: [], pi: 0, games: [], gi: 0, mi: 0, lp: null, cache: new Map(), peek: new Map(), tok: 0, bg: 0, favCount: 0, colls: [], dirty: false };
  const noLauncher = () => host.user()?.can_download === false;
  const known = () => (noLauncher() ? [] : st.lp);
  const launchable = (slug) => known() === null || known().includes(slug);
  const isAdmin = () => host.user()?.role === 'admin';
  const accent = (p) => (HEX.test(p?.accent || '') ? p.accent : HEX.test(p?.family_colour || '') ? p.family_colour : '#3b82f6');
  // Only the platforms this PC's emulator setup reports as ready (Set up emulators / Check my PC). An account that cannot use the launcher gets the platforms that play in the browser.
  // Until the launcher has reported once, nothing is known, so every platform shows (and a note says how to narrow it).
  const platList = () => (host.platforms() || [])
    .map((p) => (noLauncher() ? { ...p, visible_count: p.playable_count || 0 } : p))
    .filter((p) => (noLauncher() || st.lp === null || st.lp.includes(p.slug)) && ((p.visible_count ?? p.count) || 0) > 0)
    .sort((a, b) => String(a.family || '').localeCompare(String(b.family || '')) || (a.generation || 99) - (b.generation || 99) || String(a.name).localeCompare(b.name));
  const count = (p) => (p.visible_count ?? p.count) || 0;
  const famColour = (p) => (HEX.test(p?.family_colour || '') ? p.family_colour : '#6b7280');
  const gameAccent = (g) => (HEX.test(g?.platform_accent || '') ? g.platform_accent : accent(st.plats.find((p) => p.slug === g?.platform)));
  // the first row: Favourites and Collections (when there are any), then the families; then the platforms of one family, or the collections
  const families = () => { const m = new Map(); for (const p of st.plats) { const k = p.family || 'Others'; if (!m.has(k)) m.set(k, { kind: 'family', name: k, colour: famColour(p), logo_v: p.family_logo_v, plats: [], games: 0 }); const f = m.get(k); f.plats.push(p); f.games += count(p); } return [...m.values()]; };
  const extraItems = () => [...(st.favCount > 0 ? [{ kind: 'fav', name: 'Favourites', colour: '#e11d48', games: st.favCount }] : []), ...(st.colls.length ? [{ kind: 'colls', name: 'Collections', colour: '#7c3aed', n: st.colls.length, covers: st.colls.flatMap((c) => (c.covers || []).slice(0, 1)).slice(0, 4) }] : [])];   // the row of their own below the families
  const collItems = () => st.colls.map((c) => ({ kind: 'collection', id: c.id, name: c.name, games: Number(c.count || 0), covers: (c.covers || []).slice(0, 4), colour: '#7c3aed' }));
  const switchRow = (r) => { if (r === st.row || (r === 1 && !extraItems().length)) return false; st.pis[st.row] = st.pi; st.row = r; st.pi = st.pis[r] || 0; return true; };
  const railItems = () => (st.level === 0 ? (st.row === 1 ? extraItems() : families()) : st.sub === 'colls' ? collItems() : (families().find((f) => f.name === st.fam)?.plats || []));
  const item = () => railItems()[st.pi];
  const game = () => st.games[st.gi];

  root = document.createElement('div');
  root.className = 'bs' + (/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent) ? ' bs-lite' : '');   // Linux web views draw in software: no blur or crossfades
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Big Screen');
  root.innerHTML = `
    <div class="bs-bg" aria-hidden="true"><i class="bs-bgl a"></i><i class="bs-bgl b"></i><i class="bs-shade"></i></div>
    <div class="bs-top"><span class="bs-crumb" id="bs-crumb"></span><span class="bs-right"><button type="button" class="bs-snd" id="bs-snd" title="Navigation sounds (Start or M)"></button><span class="bs-clock" id="bs-clock"></span></span></div>
    <div class="bs-main" id="bs-main"></div>
    <div class="bs-hints" id="bs-hints" aria-hidden="true"></div>
    <div class="bs-toast" id="bs-toast" role="status" aria-live="polite"></div>`;
  document.body.appendChild(root);
  document.body.classList.add('bs-open');
  const $ = (s) => root.querySelector(s);
  const prevFocus = document.activeElement;

  // ── the top bar and the hints ──
  const tick = () => { const el = $('#bs-clock'); if (el) el.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  tick(); const clock = setInterval(tick, 15000);
  const paintSnd = () => { const b = $('#bs-snd'); if (b) { b.textContent = muted() ? '♪ Off' : '♪ On'; b.classList.toggle('off', muted()); } };
  const toggleSound = () => { try { localStorage.setItem(MUTE_KEY, muted() ? '0' : '1'); } catch { /* not kept */ } paintSnd(); say(muted() ? 'Sounds off.' : 'Sounds on.'); sfx('select'); };
  paintSnd();
  const hint = (b, t) => `<span><i>${b}</i>${t}</span>`;
  const paintHints = () => {
    const h = {
      platforms: [hint('A', 'Select'), st.level === 1 ? hint('B', 'Back') : (host.kiosk ? '' : hint('B', 'Close'))],
      games: [hint('A', 'Open'), hint('B', 'Back'), hint('LB RB', 'Jump by letter'), hint('X', 'Play in browser'), hint('Y', 'Play on this PC')],
      game: [hint('A', 'Choose'), hint('B', 'Back'), hint('LB RB', 'Previous / next game'), hint('X', 'Play in browser'), hint('Y', 'Play on this PC')],
      pick: [hint('A', 'Add / remove'), hint('B', 'Done')],
      kbd: [hint('A', 'Type'), hint('X', 'Delete'), hint('Y', 'Space'), hint('B', 'Cancel')],
      confirm: [hint('A', 'Choose'), hint('B', 'Cancel')],
      manual: [hint('A', 'Fit the width'), hint('B', 'Close'), hint('LB RB', 'Page up / down'), hint('◀ ▶', 'Zoom'), hint('▲ ▼', 'Scroll')]
    }[st.screen] || [];
    const closeGame = () => '<span class="bs-closehint"><i>Select + Start</i>Hold in a game to close it</span>';   // gamepad.js closes a running game on this
    $('#bs-hints').innerHTML = (['pick', 'kbd', 'confirm', 'manual'].includes(st.screen) ? '' : closeGame()) + h.join('');
  };
  let toastTimer = 0;
  const say = (msg, bad = false) => { const t = $('#bs-toast'); if (!t) return; if (bad) sfx('error'); t.textContent = msg; t.classList.toggle('bad', bad); t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3200); };

  // ── the backdrop: a blurred picture and the platform's colour, crossfaded ──
  const setBackdrop = (url, colour, art = false) => {   // art: the game's own background picture (shown sharper than a blurred cover)
    root.style.setProperty('--ac', colour || '#3b82f6');
    st.bg = 1 - st.bg;
    const on = root.querySelector(st.bg ? '.bs-bgl.a' : '.bs-bgl.b'), offL = root.querySelector(st.bg ? '.bs-bgl.b' : '.bs-bgl.a');
    on.style.backgroundImage = url ? `url("${url}")` : 'none'; on.classList.toggle('art', Boolean(art && url)); on.classList.add('on'); offL.classList.remove('on');
  };

  // ── loading: the games of a platform, of your favourites, or of one collection ──
  const srcKey = (s) => (s.kind === 'platform' ? 'p:' + s.slug : s.kind === 'fav' ? 'fav' : 'c:' + s.id);
  const srcQuery = (s) => (s.kind === 'platform' ? { platform: s.slug } : s.kind === 'fav' ? { favorite: '1' } : { collection: String(s.id) });
  const usable = (g) => !g.missing && (g.playable || (!noLauncher() && launchable(g.platform)));   // a game this PC can start, in the browser or with its emulator
  const loadGames = (s) => {
    const key = srcKey(s);
    if (st.cache.has(key)) return st.cache.get(key);
    const job = (async () => {
      let all = [], total = Infinity;
      while (all.length < Math.min(total, MAX)) {
        const q = new URLSearchParams({ ...srcQuery(s), sort: 'title', limit: String(PAGE), offset: String(all.length) });
        if (s.kind === 'platform' && (host.user()?.play_only || !launchable(s.slug))) q.set('playable', '1');   // no emulator of this platform on this PC: only the games that play in the browser
        const data = await host.api(`/roms?${q}`);
        total = data.total; all = all.concat(s.kind === 'platform' ? data.items.filter((g) => !g.missing) : data.items.filter(usable));
        if (!data.items.length) break;
      }
      return all;
    })();
    st.cache.set(key, job); job.catch(() => st.cache.delete(key));
    return job;
  };
  const peek = (s) => {   // a few games, for the picture behind a tile
    const key = srcKey(s);
    if (!st.peek.has(key)) { const q = new URLSearchParams({ ...srcQuery(s), sort: 'title', limit: '24' }); if (s.kind === 'platform' && (host.user()?.play_only || !launchable(s.slug))) q.set('playable', '1'); st.peek.set(key, host.api(`/roms?${q}`).then((d) => d.items.filter((g) => g.cover_url && !g.missing)).catch(() => [])); }
    return st.peek.get(key);
  };
  const forget = () => { st.cache.clear(); st.peek.clear(); };   // something changed (a favourite, a collection, a hidden game): the lists are fetched again when next opened

  // ── screen 1: the tiles ──
  const pico = (p, size = 56) => (host.platformIcon ? host.platformIcon(p, size) : '');
  const HEART = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
  const STACK = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="2.5" width="14" height="9" rx="2" opacity=".35"/><rect x="3.5" y="5.5" width="17" height="10" rx="2" opacity=".6"/><rect x="2" y="9" width="20" height="12.5" rx="2.5"/></svg>';
  const mosaic = (covers) => `<span class="bs-mosaic" aria-hidden="true">${[0, 1, 2, 3].map((n) => `<i${covers?.[n] ? ` style="background-image:url('${esc(covers[n])}')"` : ''}></i>`).join('')}</span>`;
  const tileHtml = (x, i, r = 0) => {
    const k = x.kind || 'platform';
    let colour = x.colour, inner, cls = '';
    if (k === 'family') inner = x.logo_v ? `<img src="/api/platforms/families/logo?family=${encodeURIComponent(x.name)}&v=${x.logo_v}" alt="" draggable="false" />` : `<b>${esc(x.name)}</b>`;
    else if (k === 'platform') { colour = accent(x); inner = x.logo_v ? `<img src="/api/platforms/${encodeURIComponent(x.slug)}/logo?v=${x.logo_v}" alt="" draggable="false" />` : `<span class="bs-pico">${pico(x)}</span><b>${esc(x.name)}</b>`; }
    else if (k === 'fav') { cls = ' bs-t-fav'; inner = `<span data-mos="fav">${mosaic([])}</span><span class="bs-ticon">${HEART}</span><span class="bs-ttxt"><b>Favourites</b><small>${plural(x.games, 'game')}</small></span>`; }
    else if (k === 'colls') { cls = ' bs-t-colls'; inner = `${mosaic(x.covers)}<span class="bs-ticon">${STACK}</span><span class="bs-ttxt"><b>Collections</b><small>${plural(x.n, 'collection')}</small></span>`; }
    else { cls = ' bs-t-coll'; inner = `${mosaic(x.covers)}<span class="bs-ticon">${STACK}</span><span class="bs-ttxt"><b>${esc(x.name)}</b><small>${plural(x.games, 'game')}</small></span>`; }
    return `<div class="bs-ptile${cls}" data-i="${i}" data-r="${r}" style="--pc:${esc(colour)}">${inner}</div>`;
  };
  const drawPlatforms = () => {
    st.screen = 'platforms'; $('#bs-crumb').textContent = st.level === 0 ? 'Platforms' : st.sub === 'colls' ? 'Collections' : st.fam; paintHints();
    const items = railItems(), extras = st.level === 0 ? extraItems() : [];
    if (!items.length && !extras.length) { $('#bs-main').innerHTML = '<div class="bs-empty">No games in the Library yet.</div>'; return; }
    const two = extras.length > 0;
    if (st.level === 0 && st.row === 1 && !extras.length) st.row = 0;
    const main = st.level === 0 ? families() : items;
    $('#bs-main').className = 'bs-main' + (two ? ' two' : '');
    $('#bs-main').innerHTML = `<div class="bs-hero" id="bs-hero"></div><div class="bs-railwrap" id="bs-rw0"><div class="bs-rail" id="bs-rail">${main.map((x, n) => tileHtml(x, n, 0)).join('')}</div></div>${two ? `<div class="bs-railwrap r2" id="bs-rw1"><div class="bs-rail" id="bs-rail2">${extras.map((x, n) => tileHtml(x, n, 1)).join('')}</div></div>` : ''}`;
    focusPlatform(st.pi);
    if (two) fillMosaics();
  };
  const fillMosaics = () => {   // the covers behind the Favourites tile come from your favourite games
    if (st.favCount > 0) peek({ kind: 'fav' }).then((g) => { const host_ = $('[data-mos="fav"]'); if (!host_ || !g.length) return; host_.innerHTML = mosaic(g.slice(0, 4).map((x) => x.cover_url)); }).catch(() => {});
  };
  const plural = (n, w) => `${Number(n).toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  let heroTimer = 0;
  // A row that fits on the screen is centred as a whole (Favourites and Collections, a family with few platforms); a longer row keeps the chosen tile in the middle.
  const placeRail = (rail, idx) => { if (!rail) return; const tile = rail.querySelector('.bs-ptile'); const w = rail.parentElement.clientWidth, tw = tile?.offsetWidth || 0, step = tw + parseFloat(getComputedStyle(rail).gap || 0), total = rail.scrollWidth; rail.style.transform = `translateX(${Math.round(total > 0 && total <= w ? (w - total) / 2 : w / 2 - (idx * step + tw / 2))}px)`; };
  const focusPlatform = (i) => {
    const items = railItems(); st.pi = Math.max(0, Math.min(items.length - 1, i));
    const x = items[st.pi]; if (!x) return;
    const k = x.kind || 'platform', two = st.level === 0 && Boolean($('#bs-rw1'));
    root.querySelectorAll('.bs-ptile').forEach((t) => t.classList.toggle('on', Number(t.dataset.i) === st.pi && Number(t.dataset.r) === (st.level === 0 ? st.row : 0)));
    $('#bs-rw0')?.classList.toggle('dim', two && st.row === 1); $('#bs-rw1')?.classList.toggle('dim', two && st.row === 0);
    placeRail($('#bs-rail'), st.level === 0 && st.row === 1 ? (st.pis[0] || 0) : st.pi); placeRail($('#bs-rail2'), st.row === 1 ? st.pi : (st.pis[1] || 0));
    const ac = k === 'platform' ? accent(x) : x.colour;
    const logo = k === 'family' ? (x.logo_v ? `/api/platforms/families/logo?family=${encodeURIComponent(x.name)}&v=${x.logo_v}` : '') : k === 'platform' ? (x.logo_v ? `/api/platforms/${encodeURIComponent(x.slug)}/logo?v=${x.logo_v}` : '') : '';
    const pills = k === 'family' ? `<span class="bs-pill">${plural(x.plats.length, 'platform')}</span><span class="bs-pill dim">${plural(x.games, 'game')}</span>`
      : k === 'platform' ? `${x.manufacturer ? `<span class="bs-pill">${esc(x.manufacturer)}</span>` : ''}<span class="bs-pill dim">${plural(count(x), 'game')}</span>`
      : k === 'fav' ? `<span class="bs-pill dim">${plural(x.games, 'game')}</span>` : k === 'colls' ? `<span class="bs-pill dim">${plural(x.n, 'collection')}</span>` : `<span class="bs-pill dim">${plural(x.games, 'game')}</span>`;
    const art = k === 'fav' ? HEART : k === 'colls' || k === 'collection' ? STACK : '';
    $('#bs-hero').innerHTML = `${art ? `<div class="bs-heroart bs-ha-${k}" style="--pc:${esc(x.colour)}"><span class="bs-heroicon">${art}</span><div class="bs-heroname">${esc(x.name)}</div></div>` : logo ? `<img class="bs-herologo" src="${logo}" alt="" />` : `<div class="bs-heroname">${esc(x.name)}</div>`}<div class="bs-facts">${pills}</div>`;
    setBackdrop(null, ac);
    clearTimeout(heroTimer);
    const s = k === 'family' ? { kind: 'platform', slug: x.plats[0].slug } : k === 'platform' ? { kind: 'platform', slug: x.slug } : k === 'fav' ? { kind: 'fav' } : k === 'collection' ? { kind: 'coll', id: x.id } : null;
    const token = st.pi + ':' + st.level + ':' + st.sub + ':' + st.row;
    if (!s) { if (k === 'colls' && st.colls[0]?.covers?.[0]) setBackdrop(st.colls[0].covers[0], ac); return; }
    heroTimer = setTimeout(async () => { const g = await peek(s); if (!root || st.screen !== 'platforms' || token !== st.pi + ':' + st.level + ':' + st.sub + ':' + st.row || !g.length) return; setBackdrop(g[Math.floor(Math.random() * g.length)].cover_url, ac); if (k === 'platform') loadGames(s).catch(() => {}); }, 350);   // the games load while the person looks at the platform
  };
  const enterSource = (src) => { st.src = src; if (src.kind === 'platform') st.plat = src.plat; st.gi = 0; drawGames(); };
  const leaveGames = () => {   // back from the wheel: to the tile row it came from
    st.screen = 'platforms';
    const s = st.src || { kind: 'platform' };
    if (s.kind === 'fav') { st.level = 0; st.sub = null; st.fam = null; st.row = 1; st.pi = Math.max(0, extraItems().findIndex((x) => x.kind === 'fav')); }
    else if (s.kind === 'coll') { st.level = 1; st.sub = 'colls'; st.fam = null; st.pi = Math.max(0, collItems().findIndex((x) => x.id === s.id)); }
    else {
      const f = families().find((x) => x.name === (st.plat?.family || 'Others')) || families()[0];
      if (f && f.plats.length > 1) { st.level = 1; st.sub = 'family'; st.fam = f.name; st.pi = Math.max(0, f.plats.findIndex((p) => p.slug === st.plat?.slug)); } else { st.level = 0; st.sub = null; st.fam = null; st.row = 0; st.pi = Math.max(0, families().findIndex((x) => x.name === f?.name)); }
    }
    drawPlatforms();
  };

  // ── screen 2: the wheel ──
  const drawGames = async () => {
    st.screen = 'games'; $('#bs-crumb').textContent = st.src?.name || 'Games'; paintHints();
    if (st.dirty) { forget(); st.dirty = false; }
    $('#bs-main').innerHTML = '<div class="bs-empty">Loading…</div>';
    const tok = ++st.tok;
    try { st.games = await loadGames(st.src); } catch (err) { if (tok === st.tok) $('#bs-main').innerHTML = `<div class="bs-empty">${esc(err.message || 'Could not load the games')}</div>`; return; }
    if (tok !== st.tok || st.screen !== 'games') return;
    if (!st.games.length) { $('#bs-main').innerHTML = '<div class="bs-empty">No games here yet.</div>'; return; }
    st.gi = Math.min(st.gi, st.games.length - 1);
    $('#bs-main').innerHTML = '<div class="bs-wheel" id="bs-wheel"></div><div class="bs-pos" id="bs-pos"></div>';
    st.els = new Map(); placeWheel();
  };
  const rowHtml = (g) => {
    const logo = wheelArt(g);
    return `<div class="bs-title">${esc(g.title)}${g.broken ? ' <em class="bs-flag">Broken</em>' : ''}</div><div class="bs-mid${logo ? ' has-logo' : ''}">${logo ? `<img class="bs-logo" src="${esc(logo)}" alt="" draggable="false" decoding="async" onerror="this.closest('.bs-mid').classList.remove('has-logo')" />` : ''}<div class="bs-cov${g.cover_url ? ' has-img' : ''}" style="--gc:${esc(HEX.test(g.platform_accent || '') ? g.platform_accent : '#5b6b88')}">${g.cover_url ? `<img src="${esc(g.cover_url)}" alt="" draggable="false" decoding="async" onerror="this.parentElement.classList.remove('has-img')" />` : ''}<span>${esc(g.title)}</span></div></div><div class="bs-year">${esc(st.src?.kind === 'platform' ? (g.release_year || '') : (g.platform_name || g.release_year || ''))}</div>`;
  };
  const placeWheel = () => {
    const wheel = $('#bs-wheel'); if (!wheel) return;
    const n = st.games.length, reach = root.classList.contains('bs-lite') ? 3 : 4;
    const lo = Math.max(0, st.gi - reach), hi = Math.min(n - 1, st.gi + reach);
    for (const [i, el] of st.els) if (i < lo || i > hi) { el.remove(); st.els.delete(i); }
    for (let i = lo; i <= hi; i++) {
      let el = st.els.get(i);
      if (!el) { el = document.createElement('div'); el.className = 'bs-row' + (st.games[i].broken ? ' is-broken' : ''); el.dataset.i = i; el.innerHTML = rowHtml(st.games[i]); st.els.set(i, el); wheel.appendChild(el); }
      const s = wheelStyle(i - st.gi);
      el.style.transform = `translateY(calc(-50% + ${s.y}em)) scale(${s.scale})`; el.style.opacity = s.opacity; el.style.zIndex = 10 - Math.abs(i - st.gi); el.classList.toggle('on', i === st.gi);
    }
    const g = game(); $('#bs-pos').textContent = `${(st.gi + 1).toLocaleString()} of ${n.toLocaleString()}`;
    root.style.setProperty('--ac', gameAccent(g));
    clearTimeout(st.bgT); st.bgT = setTimeout(() => { const art = gameBackdrop(g); if (root && st.screen === 'games' && game() === g) setBackdrop(art || g.cover_url, gameAccent(g), Boolean(art)); }, 140);   // the picture follows when the wheel settles
  };
  const goGame = (i) => { if (!st.games.length) return; st.gi = Math.max(0, Math.min(st.games.length - 1, i)); placeWheel(); };
  const letter = (g) => (String(g.title).replace(/^[^a-z0-9]+/i, '')[0] || '#').toUpperCase().replace(/[0-9]/, '#');
  const jumpLetter = (d) => {
    const here = letter(game()); let i = st.gi;
    while (i + d >= 0 && i + d < st.games.length) { i += d; if (letter(st.games[i]) !== here) break; }
    if (d < 0) { const l = letter(st.games[i]); while (i > 0 && letter(st.games[i - 1]) === l) i--; }   // going back lands on the first game of that letter
    goGame(i);
  };

  // ── screen 3: one game ──
  const drawGame = () => {
    const g = game(); if (!g) return;
    st.screen = 'game'; st.mi = 0; st.vPaused = false; $('#bs-crumb').textContent = st.src?.kind === 'platform' ? (st.src.name || '') : `${st.src?.name || ''} · ${g.platform_name || ''}`; paintHints();
    const art = gameBackdrop(g); setBackdrop(art || null, gameAccent(g), Boolean(art));
    const shot = g.media?.screenshot ? `/api/roms/${g.id}/media/screenshot` : '';
    const facts = [g.release_year && String(g.release_year), g.players && `${g.players} player${String(g.players) === '1' ? '' : 's'}`, g.rating && `Rated ${g.rating}`, g.developer, g.publisher && g.publisher !== g.developer ? g.publisher : '', g.region].filter(Boolean);
    $('#bs-main').innerHTML = `<div class="bs-game${g.broken ? ' is-broken' : ''}">
      <div class="bs-leftbg" aria-hidden="true">${g.cover_url ? `<i style="background-image:url('${esc(g.cover_url)}')"></i>` : ''}</div>
      <nav class="bs-menu" id="bs-menu" aria-label="${esc(g.title)}"></nav>
      <div class="bs-box"><div class="bs-favstar${g.favorite ? ' on' : ''}" aria-hidden="true">★</div><div class="bs-ribbon">Broken</div><div class="bs-brokennote">Marked as broken: the emulator cannot run this game</div><div class="bs-boxcover${g.cover_url ? ' has-img' : ''}" style="--gc:${esc(HEX.test(g.platform_accent || '') ? g.platform_accent : '#5b6b88')}">${g.cover_url ? `<img src="${esc(g.cover_url)}" alt="" draggable="false" onerror="this.parentElement.classList.remove('has-img')" />` : ''}<span>${esc(g.title)}</span></div></div>
      <section class="bs-info">
        ${gameMarquee(g) ? `<div class="bs-marquee"><img src="${esc(gameMarquee(g))}" alt="" onerror="this.parentElement.remove()" /></div>` : ''}
        <div class="bs-genre">${esc(g.genre || g.platform_name || '')}${g.broken ? ' <em class="bs-flag">Marked as broken: the emulator cannot run it</em>' : ''}</div>
        <h1 class="bs-name${gameLogo(g) ? ' has-logo' : ''}">${gameLogo(g) ? `<img class="bs-glogo" src="${esc(gameLogo(g))}" alt="" onerror="this.closest('h1').classList.remove('has-logo')" />` : ''}<span>${esc(g.title)}</span></h1>
        <div class="bs-factline">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div>
        <div class="bs-scroll" id="bs-scroll"><div class="bs-scrollin" id="bs-scrollin">
          <p class="bs-desc">${esc(g.description || 'No description yet.')}</p>
        </div></div>
        <div class="bs-media" id="bs-media">${g.has_video ? `<video src="/api/videos/file?kind=rom&id=${encodeURIComponent(g.id)}"${shot ? ` poster="${esc(shot)}"` : ''} loop playsinline preload="auto"></video>` : shot ? `<img src="${esc(shot)}" alt="" />` : ''}</div>
      </section>
      <section class="bs-manpane" id="bs-man" hidden></section></div>`;
    const v = $('#bs-media video');
    if (v) {   // the video plays as the page opens, with its sound; if the browser will not start it with sound (nothing has been pressed yet), it plays without
      v.addEventListener('error', () => { const m = $('#bs-media'); if (m) m.innerHTML = shot ? `<img src="${esc(shot)}" alt="" />` : ''; });
      v.muted = false; v.volume = 0.8;
      v.play?.().catch(() => { v.muted = true; v.play?.().catch(() => {}); });
    }
    buildMenu(); autoScroll();
  };
  // The description scrolls slowly when it is longer than the space: a pause, a slow glide to the end, a pause, and back to the top.
  let scrollTimer = 0;
  const autoScroll = () => {
    clearInterval(scrollTimer);
    const box = $('#bs-scroll'), inner = $('#bs-scrollin'); if (!box || !inner || reduced()) return;
    const max = inner.offsetHeight - box.clientHeight; if (max < 4) return;
    let phase = 'wait', t0 = Date.now();
    scrollTimer = setInterval(() => {
      if (!inner.isConnected) { clearInterval(scrollTimer); return; }
      const now = Date.now();
      if (phase === 'wait') { if (now - t0 > 5000) { phase = 'go'; t0 = now; } }   // it starts after about five seconds
      else if (phase === 'go') { const y = Math.min(max, (now - t0) / 1000 * 14); inner.style.transform = `translateY(${-y}px)`; if (y >= max) { phase = 'end'; t0 = now; } }
      else if (now - t0 > 3500) { inner.style.transition = 'transform .6s ease'; inner.style.transform = 'translateY(0)'; phase = 'back'; t0 = now; }
      else if (phase === 'back' && now - t0 > 700) { inner.style.transition = ''; phase = 'wait'; t0 = now; }
    }, 40);
  };
  const buildMenu = () => {
    const g = game(), menu = $('#bs-menu'); if (!g || !menu) return;
    menu.innerHTML = '<i class="bs-sel" id="bs-sel" aria-hidden="true"></i>' + gameMenu(g).map((m) => `<button type="button" class="bs-mi" data-k="${m.k}">${esc(m.label)}</button>`).join('');
    st.selShown = false; paintMenu();
  };
  const paintMenu = () => {   // the labels and the chosen item change in place, so the bar can move
    const g = game(), menu = $('#bs-menu'), sel = $('#bs-sel'); if (!g || !menu || !sel) return;
    const items = gameMenu(g), btns = [...menu.querySelectorAll('.bs-mi')];
    btns.forEach((b, i) => { if (b.textContent !== items[i].label) b.textContent = items[i].label; b.classList.toggle('on', i === st.mi); b.classList.toggle('fav-on', Boolean(items[i].on)); });
    const b = btns[st.mi]; if (!b) return;
    const moved = st.selShown && sel.style.top !== b.offsetTop + 'px';
    sel.style.top = b.offsetTop + 'px'; sel.style.height = b.offsetHeight + 'px'; sel.classList.add('shown'); st.selShown = true;
    if (moved && !reduced()) { sel.classList.remove('moving'); void sel.offsetWidth; sel.classList.add('moving'); }   // shorter while it moves, then back to its full length
  };
  const paintBroken = (g) => {   // a game marked (or cleared) as broken: the ribbon, the note and the heading change in place
    root.querySelector('.bs-game')?.classList.toggle('is-broken', Boolean(g.broken));
    const genre = $('.bs-genre'); if (genre) genre.innerHTML = `${esc(g.genre || g.platform_name || '')}${g.broken ? ' <em class="bs-flag">Marked as broken: the emulator cannot run it</em>' : ''}`;
  };

  // The video on the game page stops while a game is starting or running (an emulator window opens over this one, or the browser player), and while this window is not the one in front;
  // it carries on when the person is back.
  const pageVideo = () => $('#bs-media video');
  const pauseVideo = () => { const v = pageVideo(); if (v && !v.paused) { v.pause(); st.vPaused = true; } };
  const resumeVideo = () => { const v = pageVideo(); if (v && st.vPaused && st.screen === 'game' && !document.querySelector('#player-scrim:not(.hidden)')) { st.vPaused = false; v.play?.().catch(() => {}); } };
  window.addEventListener('blur', pauseVideo); window.addEventListener('focus', resumeVideo);

  // ── playing ──
  const canBrowser = (g) => Boolean(g && g.playable && !g.missing);
  const canLocalPlay = (g) => Boolean(g && host.user()?.can_download !== false && launchable(g.platform));
  const openBrowser = (g) => { if (!canBrowser(g)) return say('This game cannot be played in the browser.', true); pauseVideo(); host.api(`/roms/${g.id}`).then(host.openPlayer).catch((err) => say(err.message, true)); };
  const playLocal = async (g) => {
    if (!canLocalPlay(g)) return say('No emulator is set up on this PC for this platform.', true);
    pauseVideo();
    try {
      const j = await host.api(`/roms/${g.id}/launch`, { method: 'POST' });
      const q = new URLSearchParams({ server: location.origin, token: j.token, platform: j.platform, ext: j.ext, title: j.title, rom: j.id ?? '', fp: j.fp ?? '' });
      say('Starting the emulator…'); location.href = `gamesauce://launch?${q}`;
    } catch (err) { say(err.message || 'Could not start the game', true); }
  };
  const play = (g) => { if (!g) return; if (g.broken) say('This game is marked as broken. Trying anyway…', true); if (canLocalPlay(g)) return playLocal(g); if (canBrowser(g)) return openBrowser(g); say('This game cannot be started from this PC.', true); };

  // ── the questions on top: a yes/no, the keyboard, the collection chooser ──
  const overlay = (id, html) => { $('#' + id)?.remove(); const d = document.createElement('div'); d.className = 'bs-ov'; d.id = id; d.innerHTML = html; root.appendChild(d); return d; };
  const askConfirm = (title, body, yes) => new Promise((resolve) => {
    const prev = st.screen; st.screen = 'confirm'; st.cf = { i: 0, resolve, prev, yes }; paintHints();
    overlay('bs-cf', `<div class="bs-cfcard"><h2>${esc(title)}</h2><p>${esc(body)}</p><div class="bs-cfbtns"><button type="button" class="bs-cfb" data-i="0">${esc(yes)}</button><button type="button" class="bs-cfb" data-i="1">Cancel</button></div></div>`);
    paintConfirm();
  });
  const paintConfirm = () => root.querySelectorAll('.bs-cfb').forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === st.cf.i));
  const endConfirm = (ok) => { const cf = st.cf; $('#bs-cf')?.remove(); st.screen = cf.prev; st.cf = null; paintHints(); cf.resolve(ok); };

  const askText = (title, initial = '') => new Promise((resolve) => {
    const prev = st.screen; st.screen = 'kbd'; st.kb = { v: initial, r: 0, c: 0, shift: !initial, resolve, prev, title }; paintHints();
    overlay('bs-kb', `<div class="bs-kbcard"><h2>${esc(title)}</h2><div class="bs-kbfield" id="bs-kbfield"></div><div class="bs-kbgrid" id="bs-kbgrid"></div></div>`);
    paintKb();
  });
  const keyLabel = (k) => (k === 'shift' ? '⇧' : k === 'back' ? '⌫' : k === 'space' ? 'Space' : k === 'cancel' ? 'Cancel' : k === 'done' ? 'Done' : st.kb.shift ? k.toUpperCase() : k);
  const paintKb = () => {
    const kb = st.kb; if (!kb) return;
    $('#bs-kbfield').innerHTML = `${esc(kb.v)}<i class="bs-caret"></i>`;
    $('#bs-kbgrid').innerHTML = KEYBOARD.map((row, r) => `<div class="bs-kbrow">${row.map((k, c) => `<button type="button" class="bs-key k-${k.length > 1 ? k : 'ch'}${kb.r === r && kb.c === c ? ' on' : ''}${k === 'shift' && kb.shift ? ' lit' : ''}" data-r="${r}" data-c="${c}">${esc(keyLabel(k))}</button>`).join('')}</div>`).join('');
  };
  const kbType = (ch) => { const kb = st.kb; if (kb.v.length >= 60) return; kb.v += kb.shift ? ch.toUpperCase() : ch; if (/[a-z]/i.test(ch)) kb.shift = false; paintKb(); };
  const kbPress = (k) => {
    const kb = st.kb;
    if (k === 'shift') { kb.shift = !kb.shift; paintKb(); }
    else if (k === 'back') { kb.v = kb.v.slice(0, -1); paintKb(); }
    else if (k === 'space') { if (kb.v && !kb.v.endsWith(' ')) { kb.v += ' '; kb.shift = true; paintKb(); } }
    else if (k === 'cancel') endText(null);
    else if (k === 'done') { const t = kb.v.trim(); if (t) endText(t); else say('Type a name first.', true); }
    else kbType(k);
  };
  const endText = (value) => { const kb = st.kb; $('#bs-kb')?.remove(); st.screen = kb.prev; st.kb = null; paintHints(); kb.resolve(value); };

  // the collection chooser: every collection of yours, ticked when the game is in it; choosing one adds or removes the game; the last entry makes a new one
  const openPick = async (g) => {
    let list, mine;
    try { [list, mine] = await Promise.all([host.api('/collections'), host.api(`/roms/${g.id}`)]); } catch (err) { return say(err.message, true); }
    const has = new Set((mine.collections || []).map((c) => c.id));
    st.pk = { g, i: 0, prev: st.screen, items: [...(list.items || list || []).map((c) => ({ id: c.id, name: c.name, count: Number(c.count || 0), has: has.has(c.id) })), { isNew: true, name: '＋ New collection…' }] };
    st.screen = 'pick'; paintHints(); overlay('bs-pick', ''); paintPick();
  };
  const paintPick = () => {
    const pk = st.pk, box = $('#bs-pick'); if (!pk || !box) return;
    box.innerHTML = `<div class="bs-pickcard"><h2>Collections for “${esc(pk.g.title)}”</h2>${pk.items.map((c, i) => `<button type="button" class="bs-pi${i === pk.i ? ' on' : ''}" data-ci="${i}"><span class="bs-tick">${c.isNew ? '' : c.has ? '✓' : ''}</span><span class="bs-pn">${esc(c.name)}</span>${c.isNew ? '' : `<small>${c.count.toLocaleString()}</small>`}</button>`).join('')}</div>`;
    box.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const closePick = () => { const pk = st.pk; $('#bs-pick')?.remove(); st.screen = pk?.prev || 'game'; st.pk = null; paintHints(); };
  const pickChoose = async () => {
    const pk = st.pk, c = pk.items[pk.i]; if (!c) return;
    try {
      if (c.isNew) {
        const name = await askText('Name the new collection');
        if (!name || !st.pk) return;
        const made = await host.api('/collections', { method: 'POST', body: JSON.stringify({ name }) });
        await host.api(`/collections/${made.id}/roms`, { method: 'POST', body: JSON.stringify({ rom_ids: [pk.g.id] }) });
        pk.items.splice(pk.items.length - 1, 0, { id: made.id, name: made.name, count: 1, has: true }); pk.i = pk.items.length - 2;
        st.colls = (await host.api('/collections')).items || st.colls; st.dirty = true; paintPick(); say(`Added to the new collection “${made.name}”.`); return;
      }
      if (c.has) { await host.api(`/collections/${c.id}/roms/${pk.g.id}`, { method: 'DELETE' }); c.has = false; c.count = Math.max(0, c.count - 1); say(`Removed from ${c.name}.`); }
      else { await host.api(`/collections/${c.id}/roms`, { method: 'POST', body: JSON.stringify({ rom_ids: [pk.g.id] }) }); c.has = true; c.count += 1; say(`Added to ${c.name}.`); }
      st.dirty = true; st.colls = (await host.api('/collections')).items || st.colls; paintPick();
    } catch (err) { say(err.message, true); }
  };

  // the manual: read on the right of the game page, where the details were (the menu and the cover stay as they are; nothing opens elsewhere). A PDF is drawn by the app's own reader (public/pdfview.js); a picture is shown as it is.
  const openManual = async (g) => {
    const pane = $('#bs-man');
    if (!g.manual_url) return say('This game has no manual yet.', true);
    if (!pane) return;
    pauseVideo();
    const isPdf = !/^image\//.test(g.manual_type || '');
    st.man = { prev: st.screen, v: null, scroller: null };
    st.screen = 'manual'; paintHints();
    pane.innerHTML = `<div class="bs-manbar" id="bs-manbar"><b>${esc(g.title)} · manual</b></div><div class="bs-manscroll" id="bs-manscroll" tabindex="0"></div>`;
    pane.hidden = false; $('.bs-game')?.classList.add('reading');
    const scroller = $('#bs-manscroll'), bar = $('#bs-manbar'); st.man.scroller = scroller;
    if (!isPdf) { scroller.innerHTML = `<img class="bs-manimg" src="${esc(g.manual_url)}" alt="" />`; return; }
    try {
      const { pdfReady, mountViewer } = await import('./pdfview.js');
      if (!(await pdfReady())) { scroller.innerHTML = `<iframe class="bs-manframe" src="${esc(g.manual_url)}" title="Manual"></iframe>`; return; }
      if (st.man && scroller.isConnected) st.man.v = mountViewer({ url: g.manual_url, scroller, bar });
    } catch { if (scroller.isConnected) scroller.innerHTML = '<p class="bs-empty">The manual could not be shown.</p>'; }
  };
  const closeManual = () => {
    const m = st.man; try { m?.v?.destroy?.(); } catch { /* gone */ }
    const pane = $('#bs-man'); if (pane) { pane.innerHTML = ''; pane.hidden = true; }
    $('.bs-game')?.classList.remove('reading');
    st.screen = m?.prev || 'game'; st.man = null; paintHints(); resumeVideo();
  };
  const manualKey = (key) => st.man?.scroller?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));   // the reader's own keys: + - 0, Page up and down

  // ── the menu's actions ──
  const afterRemoval = () => {   // the game left the list on the wheel (hidden, or no longer a favourite)
    if (!st.games.length) { st.plats = platList(); return leaveGames(); }
    st.gi = Math.min(st.gi, st.games.length - 1); backToWheel();
  };
  const toggleFav = async (g) => {
    try {
      const r = await host.api(`/roms/${g.id}/favorite`, { method: 'POST', body: JSON.stringify({}) });
      g.favorite = r.favorite; st.favCount = Math.max(0, st.favCount + (r.favorite ? 1 : -1)); st.dirty = true; paintMenu(); $('.bs-favstar')?.classList.toggle('on', Boolean(g.favorite));
      say(g.favorite ? 'Added to your favourites.' : 'Removed from your favourites.');
      if (!g.favorite && st.src?.kind === 'fav') { st.games.splice(st.gi, 1); afterRemoval(); }   // on the Favourites wheel it leaves the list
    } catch (err) { say(err.message, true); }
  };
  const toggleBroken = async (g) => { try { const r = await host.api(`/roms/${g.id}/broken`, { method: 'POST', body: JSON.stringify({}) }); g.broken = r.broken; st.dirty = true; paintBroken(g); paintMenu(); say(g.broken ? 'Marked as broken.' : 'No longer marked as broken.'); } catch (err) { say(err.message, true); } };
  const hideGame = async (g) => {
    // Hide is the Library's Hide: for you it takes the game out of your views; for an admin it also hides it from every member, so that is asked first.
    if (isAdmin() && !(await askConfirm(`Hide “${g.title}” from everyone?`, 'As an admin your Hide takes this game away from every member as well. It stays in the Library under Hidden, where you can show it again.', 'Hide from everyone'))) return;
    try {
      await host.api(`/roms/${g.id}/hide`, { method: 'POST', body: JSON.stringify({ hidden: true }) });
      st.games.splice(st.gi, 1); st.dirty = true; say('Hidden. You can show it again from the Library.');
      if (g.favorite) st.favCount = Math.max(0, st.favCount - 1);
      if (st.src?.kind === 'platform') { const p = st.plat; if (p) { if (p.visible_count != null) p.visible_count--; else p.count--; } }   // the platform's count follows
      afterRemoval();
    } catch (err) { say(err.message, true); }
  };
  const runMenu = (k) => {
    const g = game(); if (!g) return;
    if (k === 'play') play(g); else if (k === 'fav') toggleFav(g); else if (k === 'coll') openPick(g); else if (k === 'manual') openManual(g); else if (k === 'broken') toggleBroken(g); else if (k === 'hide') hideGame(g);
  };

  // ── moving between screens ──
  const backToWheel = () => { st.screen = 'games'; $('#bs-crumb').textContent = st.src?.name || 'Games'; paintHints(); $('#bs-main').innerHTML = '<div class="bs-wheel" id="bs-wheel"></div><div class="bs-pos" id="bs-pos"></div>'; st.els = new Map(); placeWheel(); };
  const close = () => {
    if (!root) return;
    document.removeEventListener('keydown', onKey); window.removeEventListener('blur', pauseVideo); window.removeEventListener('focus', resumeVideo); clearInterval(clock); clearInterval(scrollTimer); clearTimeout(heroTimer); clearTimeout(toastTimer);
    root.remove(); root = null; document.body.classList.remove('bs-open');
    try { prevFocus?.focus?.(); } catch { /* the opener is gone */ }
  };
  off = close;

  // ── input: the pad (and the keyboard) become the same few actions ──
  const act = (a) => {
    const s = st.screen;
    if (st.vPaused) resumeVideo();   // back from a game: the video carries on at the next press
    if (a === 'menu') { toggleSound(); return; }
    if (s === 'kbd') sfx('key'); else if (['up', 'down', 'left', 'right', 'prev-family', 'next-family'].includes(a)) sfx('move'); else if (a === 'select') sfx('select'); else if (a === 'back') sfx('back');
    if (s === 'kbd') {
      const kb = st.kb;
      if (a === 'up' || a === 'down' || a === 'left' || a === 'right') { [kb.r, kb.c] = kbMove(kb.r, kb.c, a); paintKb(); }
      else if (a === 'select') kbPress(KEYBOARD[kb.r][kb.c]);
      else if (a === 'back') endText(null);
      else if (a === 'browser') kbPress('back');   // X deletes
      else if (a === 'local') kbPress('space');    // Y adds a space
      return;
    }
    if (s === 'manual') {
      const sc = st.man?.scroller;
      if (a === 'up' || a === 'down') sc?.scrollBy({ top: a === 'down' ? 150 : -150 });
      else if (a === 'left') manualKey('-'); else if (a === 'right') manualKey('+');
      else if (a === 'prev-family') manualKey('PageUp'); else if (a === 'next-family') manualKey('PageDown');
      else if (a === 'select') manualKey('0'); else if (a === 'back') closeManual();
      return;
    }
    if (s === 'confirm') {
      if (a === 'left' || a === 'right' || a === 'up' || a === 'down') { st.cf.i = 1 - st.cf.i; paintConfirm(); }
      else if (a === 'select') endConfirm(st.cf.i === 0); else if (a === 'back') endConfirm(false);
      return;
    }
    if (s === 'pick') {
      if (a === 'up' || a === 'down') { st.pk.i = Math.max(0, Math.min(st.pk.items.length - 1, st.pk.i + (a === 'down' ? 1 : -1))); paintPick(); }
      else if (a === 'select') pickChoose(); else if (a === 'back') closePick();
      return;
    }
    if (s === 'platforms') {
      if (a === 'left') focusPlatform(st.pi - 1); else if (a === 'right') focusPlatform(st.pi + 1);
      else if ((a === 'up' || a === 'down') && st.level === 0) { if (switchRow(a === 'down' ? 1 : 0)) focusPlatform(st.pi); }
      else if (a === 'prev-family') focusPlatform(st.pi - 5); else if (a === 'next-family') focusPlatform(st.pi + 5);
      else if (a === 'select' && item()) {
        const x = item(), k = x.kind || 'platform';
        if (k === 'fav') enterSource({ kind: 'fav', name: 'Favourites' });
        else if (k === 'colls') { st.pis[1] = st.pi; st.level = 1; st.sub = 'colls'; st.pi = 0; drawPlatforms(); }
        else if (k === 'collection') enterSource({ kind: 'coll', id: x.id, name: x.name });
        else if (k === 'family') { st.pis[0] = st.pi; if (x.plats.length === 1) enterSource({ kind: 'platform', slug: x.plats[0].slug, name: x.plats[0].name, plat: x.plats[0] }); else { st.level = 1; st.sub = 'family'; st.fam = x.name; st.pi = 0; drawPlatforms(); } }
        else enterSource({ kind: 'platform', slug: x.slug, name: x.name, plat: x });
      }
      else if (a === 'back') { if (st.level === 1) { const wasColls = st.sub === 'colls', k = wasColls ? extraItems().findIndex((f) => f.kind === 'colls') : families().findIndex((f) => f.name === st.fam); st.level = 0; st.sub = null; st.fam = null; st.row = wasColls ? 1 : 0; st.pi = Math.max(0, k); drawPlatforms(); } else if (!host.kiosk) close(); }
    } else if (s === 'games') {
      if (a === 'up' || a === 'left') goGame(st.gi - (a === 'left' ? 10 : 1)); else if (a === 'down' || a === 'right') goGame(st.gi + (a === 'right' ? 10 : 1));
      else if (a === 'prev-family') jumpLetter(-1); else if (a === 'next-family') jumpLetter(1);
      else if (a === 'select') drawGame();
      else if (a === 'back') leaveGames();
      else if (a === 'browser') openBrowser(game()); else if (a === 'local') playLocal(game());
    } else if (s === 'game') {
      if (a === 'up' || a === 'down') { st.mi = Math.max(0, Math.min(gameMenu(game()).length - 1, st.mi + (a === 'down' ? 1 : -1))); paintMenu(); }
      else if (a === 'select') runMenu(gameMenu(game())[st.mi].k);
      else if (a === 'back') backToWheel();
      else if (a === 'prev-family' || a === 'next-family' || a === 'left' || a === 'right') { const n = st.gi + (a === 'next-family' || a === 'right' ? 1 : -1); if (n >= 0 && n < st.games.length) { st.gi = n; drawGame(); } else say(n < 0 ? 'This is the first game.' : 'This is the last game.'); }
      else if (a === 'browser') openBrowser(game()); else if (a === 'local') playLocal(game());
    }
  };
  root.addEventListener('cv-pad', (e) => act(e.detail?.act));
  const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'select', Escape: 'back', Backspace: 'back', PageUp: 'prev-family', PageDown: 'next-family' };
  function onKey(e) {
    if (document.querySelector('.player-scrim:not(.hidden), #player-scrim:not(.hidden)')) return;   // a game is open on top: leave the keys to it
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (st.screen === 'kbd') {   // a real keyboard types straight into the name
      if (e.key.length === 1) { e.preventDefault(); const kb = st.kb; if (kb.v.length < 60) { kb.v += e.key; kb.shift = false; paintKb(); } return; }
      if (e.key === 'Backspace') { e.preventDefault(); kbPress('back'); return; }
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); kbPress('done'); return; }
    }
    const a = KEYS[e.key] || (e.key === 'x' ? 'browser' : e.key === 'y' ? 'local' : e.key === 'm' ? 'menu' : null);
    if (!a) return;
    e.preventDefault(); act(a);
  }
  document.addEventListener('keydown', onKey);
  root.addEventListener('click', (e) => {
    if (e.target.closest('#bs-snd')) { toggleSound(); return; }
    const t = e.target.closest('.bs-ptile'); if (t && st.screen === 'platforms') { const i = Number(t.dataset.i), r = Number(t.dataset.r || 0); if (st.level === 0 && r !== st.row) { switchRow(r); focusPlatform(i); return; } if (i === st.pi) act('select'); else focusPlatform(i); return; }
    const r = e.target.closest('.bs-row'); if (r && st.screen === 'games') { const i = Number(r.dataset.i); if (i === st.gi) act('select'); else goGame(i); return; }
    const m = e.target.closest('.bs-mi[data-k]'); if (m && st.screen === 'game') { st.mi = [...m.parentElement.querySelectorAll('.bs-mi')].indexOf(m); paintMenu(); runMenu(m.dataset.k); return; }
    const c = e.target.closest('.bs-pi'); if (c && st.screen === 'pick') { st.pk.i = Number(c.dataset.ci); pickChoose(); return; }
    const k = e.target.closest('.bs-key'); if (k && st.screen === 'kbd') { st.kb.r = Number(k.dataset.r); st.kb.c = Number(k.dataset.c); kbPress(KEYBOARD[st.kb.r][st.kb.c]); return; }
    const b = e.target.closest('.bs-cfb'); if (b && st.screen === 'confirm') { endConfirm(b.dataset.i === '0'); }
  });
  $('#bs-main').addEventListener('wheel', (e) => { if (st.screen !== 'games') return; e.preventDefault(); goGame(st.gi + (e.deltaY > 0 ? 1 : -1)); }, { passive: false });

  // ── start: which platforms this PC can start (the launcher reports it), your favourites and collections, then the tiles ──
  const parseLp = (prefs) => { try { const j = JSON.parse(prefs?.launcher_platforms || 'null'); return j && Array.isArray(j.platforms) ? j : null; } catch { return null; } };
  st.plats = platList();
  const want = st.plats.find((p) => p.slug === host.start?.platform);
  if (want) { st.plat = want; const f = families().find((x) => x.name === (want.family || 'Others')); if (f && f.plats.length > 1) { st.level = 1; st.sub = 'family'; st.fam = f.name; st.pi = f.plats.indexOf(want); } else st.pi = Math.max(0, families().findIndex((x) => x.name === (want.family || 'Others'))); }
  drawPlatforms();
  const refreshTop = () => { if (root && st.screen === 'platforms' && st.level === 0) { const cur = item()?.name; st.pi = Math.max(0, railItems().findIndex((x) => x.name === cur)); drawPlatforms(); } };
  host.api('/roms?favorite=1&limit=1').then((d) => { st.favCount = Number(d.total || 0); refreshTop(); }).catch(() => {});
  host.api('/collections').then((d) => { st.colls = d.items || d || []; refreshTop(); }).catch(() => {});
  host.api('/prefs').then((p) => { const lp = parseLp(p); if (!lp && root && !noLauncher()) say('Showing every platform. Run Check my PC in the Carousel so only the ones this PC can start show here.'); if (lp && root) { st.lp = lp.platforms; st.plats = platList(); st.level = 0; st.row = 0; st.sub = null; st.fam = null; st.pi = 0; if (st.screen === 'platforms') drawPlatforms(); } }).catch(() => {});
}

export const closeBigScreen = () => off?.();
