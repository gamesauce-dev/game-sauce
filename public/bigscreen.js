// Big Screen: the Library for a PC on the TV, driven by a gamepad (or the keyboard). Three screens:
//   platforms  a row of family tiles (Sony, Nintendo...), then the platforms of the one chosen, each with its logo and the focused one large above;
//   games      the games of a platform as a wheel, the one in the middle large;
//   game       a menu on the left (Play, Favourite, Add to Collection, Mark as Broken, Hide), the cover, and the details.
// The pad is read by public/gamepad.js, which sends what was pressed to this layer as a 'cv-pad' event (the same way the cover carousel is driven).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const HEX = /^#[0-9a-f]{6}$/i;
const PAGE = 500, MAX = 3000;       // games fetched for one platform, a page at a time
const TILE = 320;                   // a platform tile's width plus its gap, in px at the base size (see layoutRail)

/** Where a game sits on the wheel for its distance `o` from the middle one (0 = middle). Pure, so it can be tested. */
export function wheelStyle(o) {
  const a = Math.abs(o);
  return {
    y: o === 0 ? 0 : Math.sign(o) * (13.5 + (a - 1) * 5.4),                       // em, up (-) or down (+) from the middle
    scale: o === 0 ? 1 : Math.max(0.55, 0.8 - (a - 1) * 0.1),
    opacity: a > 4 ? 0 : o === 0 ? 1 : Math.max(0.12, 0.6 - (a - 1) * 0.16)
  };
}

/** A game's own pictures for Big Screen: its logo and its marquee, when it has them (a game matched by ScreenScraper keeps both; see applyProviderMedia). */
export const gameLogo = (g) => (g?.media?.wheel ? `/api/roms/${g.id}/media/wheel` : '');
export const gameMarquee = (g) => (g?.media?.marquee ? `/api/roms/${g.id}/media/marquee` : '');

/** The menu of the game screen. Pure, so it can be tested. */
export function gameMenu(g) {
  return [
    { k: 'play', label: 'Play' },
    { k: 'fav', label: g?.favorite ? 'Remove Favourite' : 'Favourite' },
    { k: 'coll', label: 'Add to Collection' },
    { k: 'broken', label: g?.broken ? 'Unmark as Broken' : 'Mark as Broken' },
    { k: 'hide', label: 'Hide' }
  ];
}

let root = null, off = null;

/** Open Big Screen. host: { api, toast, platforms(), user(), openPlayer(rom), kiosk?: boolean, start?: { platform } }. */
export function openBigScreen(host) {
  if (root) return;
  const st = { screen: 'platforms', level: 0, fam: null, plat: null, plats: [], pi: 0, games: [], gi: 0, mi: 0, lp: null, cache: new Map(), peek: new Map(), tok: 0, picks: [], ci: 0, bg: 0 };
  const noLauncher = () => host.user()?.can_download === false;
  const known = () => (noLauncher() ? [] : st.lp);
  const launchable = (slug) => known() === null || known().includes(slug);
  const accent = (p) => (HEX.test(p?.accent || '') ? p.accent : HEX.test(p?.family_colour || '') ? p.family_colour : '#3b82f6');
  // Only the platforms this PC's emulator setup reports as ready (Set up emulators / Check my PC). An account that cannot use the launcher gets the platforms that play in the browser.
  // Until the launcher has reported once, nothing is known, so every platform shows (and a note says how to narrow it).
  const platList = () => (host.platforms() || [])
    .map((p) => (noLauncher() ? { ...p, visible_count: p.playable_count || 0 } : p))
    .filter((p) => (noLauncher() || st.lp === null || st.lp.includes(p.slug)) && ((p.visible_count ?? p.count) || 0) > 0)
    .sort((a, b) => String(a.family || '').localeCompare(String(b.family || '')) || (a.generation || 99) - (b.generation || 99) || String(a.name).localeCompare(b.name));
  const count = (p) => (p.visible_count ?? p.count) || 0;
  const cur = () => st.plat || st.plats[0];   // the platform whose games are shown
  const famColour = (p) => (HEX.test(p?.family_colour || '') ? p.family_colour : '#6b7280');
  // the family tiles, then the platforms of one family
  const families = () => { const m = new Map(); for (const p of st.plats) { const k = p.family || 'Others'; if (!m.has(k)) m.set(k, { name: k, colour: famColour(p), logo_v: p.family_logo_v, plats: [], games: 0 }); const f = m.get(k); f.plats.push(p); f.games += count(p); } return [...m.values()]; };
  const railItems = () => (st.level === 0 ? families() : (families().find((f) => f.name === st.fam)?.plats || []));
  const item = () => railItems()[st.pi];
  const game = () => st.games[st.gi];

  root = document.createElement('div');
  root.className = 'bs' + (/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent) ? ' bs-lite' : '');   // Linux web views draw in software: no blur or crossfades
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Big Screen');
  root.innerHTML = `
    <div class="bs-bg" aria-hidden="true"><i class="bs-bgl a"></i><i class="bs-bgl b"></i><i class="bs-shade"></i></div>
    <div class="bs-top"><span class="bs-crumb" id="bs-crumb"></span><span class="bs-clock" id="bs-clock"></span></div>
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
  const hint = (b, t) => `<span><i>${b}</i>${t}</span>`;
  const paintHints = () => {
    const h = { platforms: [hint('A', 'Select'), st.level === 1 ? hint('B', 'Back') : (host.kiosk ? '' : hint('B', 'Close'))], games: [hint('A', 'Open'), hint('B', 'Back'), hint('LB RB', 'Jump by letter'), hint('X', 'Play in browser'), hint('Y', 'Play on this PC')],
      game: [hint('A', 'Choose'), hint('B', 'Back'), hint('LB RB', 'Other game'), hint('X', 'Play in browser'), hint('Y', 'Play on this PC')], pick: [hint('A', 'Add'), hint('B', 'Cancel')] }[st.screen] || [];
    $('#bs-hints').innerHTML = h.join('');
  };
  let toastTimer = 0;
  const say = (msg, bad = false) => { const t = $('#bs-toast'); if (!t) return; t.textContent = msg; t.classList.toggle('bad', bad); t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3200); };

  // ── the backdrop: a blurred picture and the platform's colour, crossfaded ──
  const setBackdrop = (url, colour) => {
    root.style.setProperty('--ac', colour || '#3b82f6');
    st.bg = 1 - st.bg;
    const on = root.querySelector(st.bg ? '.bs-bgl.a' : '.bs-bgl.b'), offL = root.querySelector(st.bg ? '.bs-bgl.b' : '.bs-bgl.a');
    on.style.backgroundImage = url ? `url("${url}")` : 'none'; on.classList.add('on'); offL.classList.remove('on');
  };

  // ── loading ──
  const loadGames = (slug) => {
    if (st.cache.has(slug)) return st.cache.get(slug);
    const job = (async () => {
      let all = [], total = Infinity;
      while (all.length < Math.min(total, MAX)) {
        const q = new URLSearchParams({ platform: slug, sort: 'title', limit: String(PAGE), offset: String(all.length) });
        if (host.user()?.play_only || !launchable(slug)) q.set('playable', '1');   // no emulator of this platform on this PC: only the games that play in the browser
        const data = await host.api(`/roms?${q}`);
        total = data.total; all = all.concat(data.items.filter((g) => !g.missing));
        if (!data.items.length) break;
      }
      return all;
    })();
    st.cache.set(slug, job); job.catch(() => st.cache.delete(slug));
    return job;
  };
  const peek = (slug) => {   // a few games of a platform, for the picture behind its tile
    if (!st.peek.has(slug)) { const q = new URLSearchParams({ platform: slug, sort: 'title', limit: '24' }); if (host.user()?.play_only || !launchable(slug)) q.set('playable', '1'); st.peek.set(slug, host.api(`/roms?${q}`).then((d) => d.items.filter((g) => g.cover_url && !g.missing)).catch(() => [])); }
    return st.peek.get(slug);
  };

  // ── screen 1: families, then the platforms of one ──
  const tileHtml = (x, i) => (st.level === 0
    ? `<div class="bs-ptile" data-i="${i}" style="--pc:${esc(x.colour)}">${x.logo_v ? `<img src="/api/platforms/families/logo?family=${encodeURIComponent(x.name)}&v=${x.logo_v}" alt="" draggable="false" />` : `<b>${esc(x.name)}</b>`}</div>`
    : `<div class="bs-ptile" data-i="${i}" style="--pc:${esc(accent(x))}">${x.logo_v ? `<img src="/api/platforms/${encodeURIComponent(x.slug)}/logo?v=${x.logo_v}" alt="" draggable="false" />` : `<b>${esc(x.name)}</b>`}</div>`);
  const drawPlatforms = () => {
    st.screen = 'platforms'; $('#bs-crumb').textContent = st.level === 0 ? 'Platforms' : st.fam; paintHints();
    const items = railItems();
    if (!items.length) { $('#bs-main').innerHTML = '<div class="bs-empty">No games in the Library yet.</div>'; return; }
    $('#bs-main').innerHTML = `<div class="bs-hero" id="bs-hero"></div><div class="bs-railwrap"><div class="bs-rail" id="bs-rail">${items.map(tileHtml).join('')}</div></div>`;
    focusPlatform(st.pi);
  };
  let heroTimer = 0;
  const focusPlatform = (i) => {
    const items = railItems(); st.pi = Math.max(0, Math.min(items.length - 1, i));
    const x = items[st.pi]; if (!x) return;
    root.querySelectorAll('.bs-ptile').forEach((t) => t.classList.toggle('on', Number(t.dataset.i) === st.pi));
    const rail = $('#bs-rail'); if (rail) { const w = rail.parentElement.clientWidth, tile = rail.querySelector('.bs-ptile')?.offsetWidth || 0, step = tile + parseFloat(getComputedStyle(rail).gap || 0); rail.style.transform = `translateX(${Math.round(w / 2 - (st.pi * step + tile / 2))}px)`; }
    const fam = st.level === 0, first = fam ? x.plats[0] : x, ac = fam ? x.colour : accent(x);
    const logo = fam ? (x.logo_v ? `/api/platforms/families/logo?family=${encodeURIComponent(x.name)}&v=${x.logo_v}` : '') : (x.logo_v ? `/api/platforms/${encodeURIComponent(x.slug)}/logo?v=${x.logo_v}` : '');
    $('#bs-hero').innerHTML = `${logo ? `<img class="bs-herologo" src="${logo}" alt="" />` : `<div class="bs-heroname">${esc(x.name)}</div>`}
      <div class="bs-facts">${fam ? `<span class="bs-pill">${x.plats.length} platform${x.plats.length === 1 ? '' : 's'}</span><span class="bs-pill dim">${x.games.toLocaleString()} game${x.games === 1 ? '' : 's'}</span>` : `${x.manufacturer ? `<span class="bs-pill">${esc(x.manufacturer)}</span>` : ''}<span class="bs-pill dim">${count(x).toLocaleString()} game${count(x) === 1 ? '' : 's'}</span>`}</div>`;
    setBackdrop(null, ac);
    clearTimeout(heroTimer);
    const slug = first.slug, token = st.pi + ':' + st.level; heroTimer = setTimeout(async () => { const g = await peek(slug); if (!root || st.screen !== 'platforms' || token !== st.pi + ':' + st.level || !g.length) return; setBackdrop(g[Math.floor(Math.random() * g.length)].cover_url, ac); if (!fam) loadGames(slug).catch(() => {}); }, 350);   // the games load while the person looks at the platform
  };
  const enterPlatform = (p) => { st.plat = p; st.gi = 0; drawGames(p.slug); };
  const leaveGames = () => {   // back from the wheel: to the family's platforms, or to the families when it had only one
    const f = families().find((x) => x.name === (st.plat?.family || 'Others')) || families()[0];
    st.screen = 'platforms';
    if (f && f.plats.length > 1) { st.level = 1; st.fam = f.name; st.pi = Math.max(0, f.plats.findIndex((p) => p.slug === st.plat?.slug)); } else { st.level = 0; st.fam = null; st.pi = Math.max(0, families().findIndex((x) => x.name === f?.name)); }
    drawPlatforms();
  };

  // ── screen 2: the wheel ──
  const drawGames = async (slug) => {
    st.screen = 'games'; const p = cur(); $('#bs-crumb').textContent = p?.name || 'Games'; paintHints();
    $('#bs-main').innerHTML = '<div class="bs-empty">Loading…</div>';
    const tok = ++st.tok;
    try { st.games = await loadGames(slug); } catch (err) { if (tok === st.tok) $('#bs-main').innerHTML = `<div class="bs-empty">${esc(err.message || 'Could not load the games')}</div>`; return; }
    if (tok !== st.tok || st.screen !== 'games') return;
    if (!st.games.length) { $('#bs-main').innerHTML = '<div class="bs-empty">No games here yet.</div>'; return; }
    st.gi = Math.min(st.gi, st.games.length - 1);
    $('#bs-main').innerHTML = '<div class="bs-wheel" id="bs-wheel"></div><div class="bs-pos" id="bs-pos"></div>';
    st.els = new Map(); placeWheel();
  };
  const rowHtml = (g) => {
    const logo = gameLogo(g);
    return `<div class="bs-title">${esc(g.title)}${g.broken ? ' <em class="bs-flag">Broken</em>' : ''}</div><div class="bs-mid${logo ? ' has-logo' : ''}">${logo ? `<img class="bs-logo" src="${esc(logo)}" alt="" draggable="false" decoding="async" onerror="this.closest('.bs-mid').classList.remove('has-logo')" />` : ''}<div class="bs-cov" style="--gc:${esc(HEX.test(g.platform_accent || '') ? g.platform_accent : '#5b6b88')}">${g.cover_url ? `<img src="${esc(g.cover_url)}" alt="" draggable="false" decoding="async" />` : `<span>${esc(g.title)}</span>`}</div></div><div class="bs-year">${esc(g.release_year || '')}</div>`;
  };
  const placeWheel = () => {
    const wheel = $('#bs-wheel'); if (!wheel) return;
    const n = st.games.length, reach = root.classList.contains('bs-lite') ? 3 : 4;
    const lo = Math.max(0, st.gi - reach), hi = Math.min(n - 1, st.gi + reach);
    for (const [i, el] of st.els) if (i < lo || i > hi) { el.remove(); st.els.delete(i); }
    for (let i = lo; i <= hi; i++) {
      let el = st.els.get(i);
      if (!el) { el = document.createElement('div'); el.className = 'bs-row'; el.dataset.i = i; el.innerHTML = rowHtml(st.games[i]); st.els.set(i, el); wheel.appendChild(el); }
      const s = wheelStyle(i - st.gi);
      el.style.transform = `translateY(calc(-50% + ${s.y}em)) scale(${s.scale})`; el.style.opacity = s.opacity; el.style.zIndex = 10 - Math.abs(i - st.gi); el.classList.toggle('on', i === st.gi);
    }
    const g = game(); $('#bs-pos').textContent = `${(st.gi + 1).toLocaleString()} of ${n.toLocaleString()}`;
    setBackdrop(g.cover_url, accent(cur()));
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
    st.screen = 'game'; st.mi = 0; $('#bs-crumb').textContent = cur()?.name || ''; paintHints();
    const ac = accent(cur()); setBackdrop(null, ac);
    const shot = g.media?.screenshot ? `/api/roms/${g.id}/media/screenshot` : '';
    const facts = [g.release_year && String(g.release_year), g.players && `${g.players} player${String(g.players) === '1' ? '' : 's'}`, g.rating && `Rated ${g.rating}`, g.developer, g.publisher && g.publisher !== g.developer ? g.publisher : '', g.region].filter(Boolean);
    $('#bs-main').innerHTML = `<div class="bs-game">
      <nav class="bs-menu" id="bs-menu" aria-label="${esc(g.title)}"></nav>
      <div class="bs-box"><div class="bs-boxcover" style="--gc:${esc(HEX.test(g.platform_accent || '') ? g.platform_accent : '#5b6b88')}">${g.cover_url ? `<img src="${esc(g.cover_url)}" alt="" draggable="false" />` : `<span>${esc(g.title)}</span>`}</div></div>
      <section class="bs-info">
        ${gameMarquee(g) ? `<div class="bs-marquee"><img src="${esc(gameMarquee(g))}" alt="" onerror="this.parentElement.remove()" /></div>` : ''}
        <div class="bs-genre">${esc(g.genre || cur()?.name || '')}${g.broken ? ' <em class="bs-flag">Marked as broken: the emulator cannot run it</em>' : ''}</div>
        <h1 class="bs-name${gameLogo(g) ? ' has-logo' : ''}">${gameLogo(g) ? `<img class="bs-glogo" src="${esc(gameLogo(g))}" alt="" onerror="this.closest('h1').classList.remove('has-logo')" />` : ''}<span>${esc(g.title)}</span></h1>
        <div class="bs-factline">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div>
        <p class="bs-desc">${esc(g.description || 'No description yet.')}</p>
        <div class="bs-media" id="bs-media">${g.has_video ? `<video src="/api/videos/file?kind=rom&id=${encodeURIComponent(g.id)}"${shot ? ` poster="${esc(shot)}"` : ''} loop playsinline preload="auto"></video>` : shot ? `<img src="${esc(shot)}" alt="" />` : ''}</div>
      </section></div>`;
    const v = $('#bs-media video');
    if (v) {   // the video plays as the page opens, with its sound; if the browser will not start it with sound (nothing has been pressed yet), it plays without
      v.addEventListener('error', () => { const m = $('#bs-media'); if (m) m.innerHTML = shot ? `<img src="${esc(shot)}" alt="" />` : ''; });
      v.muted = false; v.volume = 0.8;
      v.play?.().catch(() => { v.muted = true; v.play?.().catch(() => {}); });
    }
    paintMenu();
  };
  const paintMenu = () => {
    const g = game(), menu = $('#bs-menu'); if (!g || !menu) return;
    menu.innerHTML = gameMenu(g).map((m, i) => `<button type="button" class="bs-mi${i === st.mi ? ' on' : ''}" data-k="${m.k}">${esc(m.label)}</button>`).join('');
  };

  // ── playing ──
  const canBrowser = (g) => Boolean(g && g.playable && !g.missing);
  const canLocalPlay = (g) => Boolean(g && host.user()?.can_download !== false && launchable(cur()?.slug));
  const openBrowser = (g) => { if (!canBrowser(g)) return say('This game cannot be played in the browser.', true); host.api(`/roms/${g.id}`).then(host.openPlayer).catch((err) => say(err.message, true)); };
  const playLocal = async (g) => {
    if (!canLocalPlay(g)) return say('No emulator is set up on this PC for this platform.', true);
    try {
      const j = await host.api(`/roms/${g.id}/launch`, { method: 'POST' });
      const q = new URLSearchParams({ server: location.origin, token: j.token, platform: j.platform, ext: j.ext, title: j.title, rom: j.id ?? '', fp: j.fp ?? '' });
      say('Starting the emulator…'); location.href = `gamesauce://launch?${q}`;
    } catch (err) { say(err.message || 'Could not start the game', true); }
  };
  const play = (g) => { if (!g) return; if (canLocalPlay(g)) return playLocal(g); if (canBrowser(g)) return openBrowser(g); say('This game cannot be started from this PC.', true); };

  // ── the menu's actions ──
  const toggleFav = async (g) => { try { const r = await host.api(`/roms/${g.id}/favorite`, { method: 'POST', body: JSON.stringify({}) }); g.favorite = r.favorite; paintMenu(); say(g.favorite ? 'Added to your favourites.' : 'Removed from your favourites.'); } catch (err) { say(err.message, true); } };
  const toggleBroken = async (g) => { try { const r = await host.api(`/roms/${g.id}/broken`, { method: 'POST', body: JSON.stringify({}) }); g.broken = r.broken; drawGame(); st.mi = 3; paintMenu(); say(g.broken ? 'Marked as broken.' : 'No longer marked as broken.'); } catch (err) { say(err.message, true); } };
  const hideGame = async (g) => {
    try {
      await host.api(`/roms/${g.id}/hide`, { method: 'POST', body: JSON.stringify({ hidden: true }) });
      st.games.splice(st.gi, 1); say('Hidden. You can show it again from the Library.');
      const p = cur(); if (p) { if (p.visible_count != null) p.visible_count--; else p.count--; }   // the platform's count follows
      if (!st.games.length) { st.plats = platList(); return leaveGames(); }
      st.gi = Math.min(st.gi, st.games.length - 1); backToWheel();
    } catch (err) { say(err.message, true); }
  };
  const openPick = async (g) => {
    try { const d = await host.api('/collections'); st.picks = d.items || d || []; } catch (err) { return say(err.message, true); }
    if (!st.picks.length) return say('You have no collections yet. Make one in the Library first.', true);
    st.screen = 'pick'; st.ci = 0; paintHints();
    const box = document.createElement('div'); box.className = 'bs-pick'; box.id = 'bs-pick'; root.appendChild(box); paintPick(g);
  };
  const paintPick = (g) => { const box = $('#bs-pick'); if (!box) return; box.innerHTML = `<div class="bs-pickcard"><h2>Add “${esc(g.title)}” to</h2>${st.picks.map((c, i) => `<button type="button" class="bs-mi${i === st.ci ? ' on' : ''}" data-ci="${i}">${esc(c.name)} <small>${Number(c.count || 0).toLocaleString()}</small></button>`).join('')}</div>`; box.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); };
  const closePick = () => { $('#bs-pick')?.remove(); st.screen = 'game'; paintHints(); };
  const choosePick = async (g) => {
    const c = st.picks[st.ci]; if (!c) return;
    try { await host.api(`/collections/${c.id}/roms`, { method: 'POST', body: JSON.stringify({ rom_ids: [g.id] }) }); closePick(); say(`Added to ${c.name}.`); } catch (err) { say(err.message, true); }
  };
  const runMenu = (k) => {
    const g = game(); if (!g) return;
    if (k === 'play') play(g); else if (k === 'fav') toggleFav(g); else if (k === 'coll') openPick(g); else if (k === 'broken') toggleBroken(g); else if (k === 'hide') hideGame(g);
  };

  // ── moving between screens ──
  const backToWheel = () => { st.screen = 'games'; $('#bs-crumb').textContent = cur()?.name || 'Games'; paintHints(); $('#bs-main').innerHTML = '<div class="bs-wheel" id="bs-wheel"></div><div class="bs-pos" id="bs-pos"></div>'; st.els = new Map(); placeWheel(); };
  const close = () => {
    if (!root) return;
    document.removeEventListener('keydown', onKey); clearInterval(clock); clearTimeout(heroTimer); clearTimeout(toastTimer);
    root.remove(); root = null; document.body.classList.remove('bs-open');
    try { prevFocus?.focus?.(); } catch { /* the opener is gone */ }
  };
  off = close;

  // ── input: the pad (and the keyboard) become the same few actions ──
  const act = (a) => {
    const s = st.screen;
    if (s === 'pick') {
      const g = game();
      if (a === 'up' || a === 'down') { st.ci = Math.max(0, Math.min(st.picks.length - 1, st.ci + (a === 'down' ? 1 : -1))); paintPick(g); }
      else if (a === 'select') choosePick(g); else if (a === 'back') closePick();
      return;
    }
    if (s === 'platforms') {
      if (a === 'left') focusPlatform(st.pi - 1); else if (a === 'right') focusPlatform(st.pi + 1);
      else if (a === 'prev-family') focusPlatform(st.pi - 5); else if (a === 'next-family') focusPlatform(st.pi + 5);
      else if (a === 'select' && item()) {
        const x = item();
        if (st.level === 0) { if (x.plats.length === 1) enterPlatform(x.plats[0]); else { st.level = 1; st.fam = x.name; st.pi = 0; drawPlatforms(); } }
        else enterPlatform(x);
      }
      else if (a === 'back') { if (st.level === 1) { const k = families().findIndex((f) => f.name === st.fam); st.level = 0; st.fam = null; st.pi = Math.max(0, k); drawPlatforms(); } else if (!host.kiosk) close(); }
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
      else if (a === 'prev-family' || a === 'next-family') { const n = st.gi + (a === 'next-family' ? 1 : -1); if (n >= 0 && n < st.games.length) { st.gi = n; drawGame(); } }
      else if (a === 'browser') openBrowser(game()); else if (a === 'local') playLocal(game());
    }
  };
  root.addEventListener('cv-pad', (e) => act(e.detail?.act));
  const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'select', Escape: 'back', Backspace: 'back', PageUp: 'prev-family', PageDown: 'next-family' };
  function onKey(e) {
    if (document.querySelector('.player-scrim:not(.hidden), #player-scrim:not(.hidden)')) return;   // a game is open on top: leave the keys to it
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const a = KEYS[e.key] || (e.key === 'x' ? 'browser' : e.key === 'y' ? 'local' : null);
    if (!a) return;
    e.preventDefault(); act(a);
  }
  document.addEventListener('keydown', onKey);
  root.addEventListener('click', (e) => {
    const t = e.target.closest('.bs-ptile'); if (t && st.screen === 'platforms') { const i = Number(t.dataset.i); if (i === st.pi) act('select'); else focusPlatform(i); return; }
    const r = e.target.closest('.bs-row'); if (r && st.screen === 'games') { const i = Number(r.dataset.i); if (i === st.gi) act('select'); else goGame(i); return; }
    const m = e.target.closest('.bs-mi[data-k]'); if (m && st.screen === 'game') { st.mi = [...m.parentElement.children].indexOf(m); paintMenu(); runMenu(m.dataset.k); return; }
    const c = e.target.closest('.bs-mi[data-ci]'); if (c && st.screen === 'pick') { st.ci = Number(c.dataset.ci); choosePick(game()); }
  });
  $('#bs-main').addEventListener('wheel', (e) => { if (st.screen !== 'games') return; e.preventDefault(); goGame(st.gi + (e.deltaY > 0 ? 1 : -1)); }, { passive: false });

  // ── start: which platforms this PC can start (the launcher reports it), then the platform row ──
  const parseLp = (prefs) => { try { const j = JSON.parse(prefs?.launcher_platforms || 'null'); return j && Array.isArray(j.platforms) ? j : null; } catch { return null; } };
  st.plats = platList();
  const want = st.plats.find((p) => p.slug === host.start?.platform);
  if (want) { st.plat = want; const f = families().find((x) => x.name === (want.family || 'Others')); if (f && f.plats.length > 1) { st.level = 1; st.fam = f.name; st.pi = f.plats.indexOf(want); } else st.pi = Math.max(0, families().findIndex((x) => x.name === (want.family || 'Others'))); }
  drawPlatforms();
  host.api('/prefs').then((p) => { const lp = parseLp(p); if (!lp && root && !noLauncher()) say('Showing every platform. Run Check my PC in the Carousel so only the ones this PC can start show here.'); if (lp && root) { st.lp = lp.platforms; st.plats = platList(); st.level = 0; st.fam = null; st.pi = 0; if (st.screen === 'platforms') drawPlatforms(); } }).catch(() => {});
}

export const closeBigScreen = () => off?.();
