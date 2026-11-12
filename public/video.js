// Game videos (kept by src/lib/emumovies.js) in the interface:
//  * the details window (Library, Physical, Digital): a game's page puts an empty
//      <div class="vid-slot" data-kind="rom|physical|digital" data-id="…" [data-store="xbox"]></div>
//    in it. If the game has a video it plays, muted and looping, in place of the cover at the top; if not and EmuMovies is set up, a "Find video"
//    button asks for it. Nothing is downloaded by opening a window.
//  * tiles: a tile of a game that already has a video carries data-vid="rom:12" / "physical:7" / "digital:xbox:halo-infinite-xone"; hovering it
//    for a moment opens a small pop-out window beside it with the video playing. Tiles never download anything: only videos already kept play.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const query = (slot) => new URLSearchParams({ kind: slot.dataset.kind, id: slot.dataset.id, ...(slot.dataset.store ? { store: slot.dataset.store } : {}) }).toString();
/* Sound is on by default in the details window. If the person turns it off (or on again) with the video's own control, that choice is remembered on this device. */
const MUTE_KEY = 'gamesauce_video_muted';
const wantMuted = () => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } };
const saveMuted = (m) => { try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* not kept */ } };
/** Starts a video with the person's sound choice. A browser may refuse sound before the person has touched the page: it then plays muted (not remembered) and says so. */
function startWithSound(v, onBlocked = () => {}) {
  let expected = wantMuted(); v.muted = expected;
  v.addEventListener('volumechange', () => { if (v.muted !== expected) { expected = v.muted; saveMuted(v.muted); } });   // a change we did not make is the person's
  const go = v.play?.();
  if (go?.catch) go.catch(() => { if (!expected) { expected = true; v.muted = true; v.play?.().catch(() => {}); onBlocked(); } });
}
const mb = (b) => `${Math.max(1, Math.round(b / 1048576))} MB`;

async function call(path, options) {
  const res = await fetch(path, { credentials: 'same-origin', headers: options?.body ? { 'Content-Type': 'application/json' } : undefined, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ───────────── details window ───────────── */

/** A soft backdrop for the bars around a video: the game's cover, enlarged and blurred (or, with no cover, the colour gradient the cover box has). `from` is the box that holds the cover. */
function backdropFrom(from) {
  const d = document.createElement('div');
  d.className = 'vid-back'; d.setAttribute('aria-hidden', 'true');
  const img = from?.querySelector?.('img');
  const src = img && img.style.display !== 'none' ? (img.currentSrc || img.getAttribute('src') || '') : '';
  if (src) d.style.backgroundImage = `url("${src.replace(/"/g, '%22')}")`;
  else { const g = from ? getComputedStyle(from).backgroundImage : ''; d.style.backgroundImage = g && g !== 'none' ? g : 'linear-gradient(160deg, #2a2f45, #12141a)'; }
  return d;
}
const EXPAND_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>';
const fullscreen = (el) => { try { (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el); } catch { /* not allowed here */ } };

/** The video in a large overlay over the page (Esc, the close button or a click outside puts it back). It carries on from where the small one was. */
function enlarge(small) {
  if (document.querySelector('.vid-lightbox')) return;
  const wasPlaying = !small.paused; small.pause();
  const box = document.createElement('div');
  box.className = 'vid-lightbox'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Game video');
  const v = document.createElement('video');
  v.src = small.currentSrc || small.src; v.controls = true; v.loop = true; v.autoplay = true; v.playsInline = true;
  v.addEventListener('loadedmetadata', () => { try { v.currentTime = small.currentTime; } catch { /* starts from the beginning */ } }, { once: true });
  v.addEventListener('dblclick', () => fullscreen(v));
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'vid-close'; x.title = 'Close'; x.setAttribute('aria-label', 'Close'); x.textContent = '\u2715';
  box.append(backdropFrom(small.parentElement), v, x); document.body.appendChild(box);
  const onKey = (e) => { if (e.key === 'Escape' && !document.fullscreenElement) { e.stopPropagation(); close(); } };
  const close = () => { document.removeEventListener('keydown', onKey, true); try { small.currentTime = v.currentTime; } catch { /* kept */ } v.pause(); box.remove(); if (wasPlaying) small.play?.().catch(() => {}); };
  document.addEventListener('keydown', onKey, true);
  x.addEventListener('click', close);
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  startWithSound(v);
}

/** The video takes the cover's place at the top of the window; the button beside the note puts the cover back (and the video again). */
function playInCover(slot, src) {
  const cover = slot.closest('#drawer-body')?.querySelector('.detail-cover');
  if (!cover || cover.querySelector('.vid-cover')) return false;
  const v = document.createElement('video');
  v.className = 'vid-cover'; v.src = src; v.autoplay = true; v.loop = true; v.controls = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('aria-label', 'Game video');
  cover.classList.add('has-video'); cover.appendChild(backdropFrom(cover)); cover.appendChild(v);
  const big = document.createElement('button');
  big.type = 'button'; big.className = 'vid-expand'; big.title = 'Enlarge the video'; big.setAttribute('aria-label', 'Enlarge the video'); big.innerHTML = EXPAND_ICON;
  big.addEventListener('click', () => enlarge(v));
  cover.appendChild(big);
  v.addEventListener('dblclick', () => fullscreen(v));   // double-click: the whole screen
  startWithSound(v, () => { const n = slot.querySelector('.vid-note'); if (n && !n.querySelector('.vid-sound')) n.insertAdjacentHTML('beforeend', '<span class="vid-sound">Playing without sound: use the video\'s speaker button for sound.</span>'); });
  return true;
}

function show(slot, s) {
  if (!slot.isConnected) return;
  if (s.available) {
    const src = `/api/videos/file?${query(slot)}`;
    const inCover = playInCover(slot, src);
    slot.innerHTML = inCover
      ? `<p class="hint vid-note">Video${s.bytes ? ` (${esc(mb(s.bytes))})` : ''}${s.source ? `, from ${esc(s.source)}` : ''}. <button type="button" class="btn btn-sm vid-toggle">Show cover</button></p>`
      : `<div class="section-label">Video</div><video class="vid-player" controls preload="metadata" playsinline src="${esc(src)}"></video>${s.bytes ? `<p class="hint">${esc(mb(s.bytes))}${s.source ? `, from ${esc(s.source)}` : ''}</p>` : ''}`;
    const tg = slot.querySelector('.vid-toggle');
    tg?.addEventListener('click', () => {
      const cover = slot.closest('#drawer-body')?.querySelector('.detail-cover'), v = cover?.querySelector('.vid-cover'); if (!cover || !v) return;
      const art = cover.classList.toggle('show-art');
      if (art) v.pause(); else v.play?.().catch(() => {});
      tg.textContent = art ? 'Show video' : 'Show cover';
    });
    return;
  }
  if (!s.can_fetch) { slot.innerHTML = ''; return; }   // nobody set EmuMovies up: no empty section
  slot.innerHTML = `<div class="section-label">Video</div>
    <p class="hint">${s.missed ? 'No video was found for this game the last time it was looked for.' : 'No video kept for this game yet.'}${s.why ? ` <span class="vid-why">${esc(s.why)}</span>` : ''}</p>
    <button class="btn vid-find" type="button">${s.missed ? 'Try again' : 'Find video'}</button> <span class="hint vid-msg" role="status"></span>`;
  const btn = slot.querySelector('.vid-find'), msg = slot.querySelector('.vid-msg');
  btn.addEventListener('click', async () => {
    btn.disabled = true; msg.textContent = 'looking for a video…';
    try {
      const r = await call('/api/videos/fetch?' + query(slot), { method: 'POST', body: JSON.stringify({ force: Boolean(s.missed) }) });
      show(slot, r.available ? { ...s, ...r } : { ...s, missed: true });
    } catch (err) { btn.disabled = false; msg.textContent = err.message; }
  });
}

async function fill(slot) {
  if (slot.dataset.vidState) return;
  slot.dataset.vidState = '1';
  try { show(slot, await call('/api/videos/status?' + query(slot))); }
  catch { slot.innerHTML = ''; }   // a quiet failure: the window works without a video
}

const scan = (root) => (root.querySelectorAll ? root.querySelectorAll('.vid-slot') : []).forEach(fill);
new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches?.('.vid-slot')) fill(n); else scan(n); } })
  .observe(document.documentElement, { childList: true, subtree: true });
scan(document);

/* ───────────── tile preview on hover ───────────── */

const canHover = window.matchMedia?.('(hover: hover)').matches !== false;
const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let hoverTile = null, hoverTimer = 0, hoverVideo = null;

function srcFor(id) {
  const [kind, a, b] = String(id).split(':');
  const q = new URLSearchParams(kind === 'digital' ? { kind, store: a, id: b } : { kind, id: a });
  return `/api/videos/file?${q}`;
}
function stopPreview() {
  clearTimeout(hoverTimer); hoverTimer = 0;
  if (hoverVideo) hoverVideo.pause();
  document.querySelector('.vid-pop')?.remove();
  hoverVideo = null; hoverTile = null;
}
/** A small window beside the tile (to its right, or its left when there is no room) with the video playing. It never takes the mouse, so moving on closes it. */
function startPreview(tile) {
  if (tile.closest('.selecting, .bulk-mode')) return;   // not while picking tiles
  const pop = document.createElement('div');
  pop.className = 'vid-pop'; pop.setAttribute('aria-hidden', 'true');
  const v = document.createElement('video');
  v.src = srcFor(tile.dataset.vid); v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.preload = 'auto';
  const cap = document.createElement('div');
  cap.className = 'vid-pop-cap'; cap.textContent = (tile.querySelector('.card-title')?.textContent || tile.getAttribute('aria-label') || '').trim();
  pop.append(backdropFrom(tile.querySelector('.card-cover')), v, cap);
  v.addEventListener('error', () => { if (hoverVideo === v) stopPreview(); });   // the file has gone: nothing is shown
  v.addEventListener('playing', () => pop.classList.add('on'));
  document.body.appendChild(pop); hoverVideo = v;
  const r = tile.getBoundingClientRect(), w = Math.min(420, Math.round(window.innerWidth * 0.4)), gap = 12;
  const h = Math.round(w * 9 / 16) + (cap.textContent ? 30 : 0);
  pop.style.width = w + 'px';
  const left = r.right + gap + w <= window.innerWidth - 8 ? r.right + gap : Math.max(8, r.left - gap - w);
  pop.style.left = left + 'px';
  pop.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, r.top + r.height / 2 - h / 2)) + 'px';
  v.play?.().catch(() => {});
}
if (canHover) {
  document.addEventListener('mouseover', (e) => {
    const tile = e.target.closest?.('[data-vid]');
    if (tile === hoverTile) return;
    stopPreview();
    if (!tile || calm()) return;
    hoverTile = tile;
    hoverTimer = setTimeout(() => startPreview(tile), 450);   // a moment's rest, so moving across the list starts nothing
  });
  document.addEventListener('mouseleave', stopPreview);
  document.addEventListener('scroll', stopPreview, true);
}
