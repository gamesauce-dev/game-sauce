// Game videos (kept by src/lib/emumovies.js) in the interface:
//  * the details window (Library, Physical, Digital): a game's page puts an empty
//      <div class="vid-slot" data-kind="rom|physical|digital" data-id="…" [data-store="xbox"]></div>
//    in it. If the game has a video it plays, muted and looping, in place of the cover at the top; if not and EmuMovies is set up, a "Find video"
//    button asks for it. Nothing is downloaded by opening a window.
//  * tiles: a tile of a game that already has a video carries data-vid="rom:12" / "physical:7" / "digital:xbox:halo-infinite-xone"; hovering it
//    for a moment plays the video over its cover. Tiles never download anything: only videos already kept play.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const query = (slot) => new URLSearchParams({ kind: slot.dataset.kind, id: slot.dataset.id, ...(slot.dataset.store ? { store: slot.dataset.store } : {}) }).toString();
const mb = (b) => `${Math.max(1, Math.round(b / 1048576))} MB`;

async function call(path, options) {
  const res = await fetch(path, { credentials: 'same-origin', headers: options?.body ? { 'Content-Type': 'application/json' } : undefined, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ───────────── details window ───────────── */

/** The video takes the cover's place at the top of the window; the button beside the note puts the cover back (and the video again). */
function playInCover(slot, src) {
  const cover = slot.closest('#drawer-body')?.querySelector('.detail-cover');
  if (!cover || cover.querySelector('.vid-cover')) return false;
  const v = document.createElement('video');
  v.className = 'vid-cover'; v.src = src; v.autoplay = true; v.muted = true; v.loop = true; v.controls = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('aria-label', 'Game video');
  cover.classList.add('has-video'); cover.appendChild(v);
  v.play?.().catch(() => { /* autoplay refused: the controls are there */ });
  return true;
}

function show(slot, s) {
  if (!slot.isConnected) return;
  if (s.available) {
    const src = `/api/videos/file?${query(slot)}`;
    const inCover = playInCover(slot, src);
    slot.innerHTML = inCover
      ? `<p class="hint vid-note">Video${s.bytes ? ` (${esc(mb(s.bytes))})` : ''}, from EmuMovies. <button type="button" class="btn btn-sm vid-toggle">Show cover</button></p>`
      : `<div class="section-label">Video</div><video class="vid-player" controls preload="metadata" playsinline src="${esc(src)}"></video>${s.bytes ? `<p class="hint">${esc(mb(s.bytes))}, from EmuMovies</p>` : ''}`;
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
    <p class="hint">${s.missed ? 'EmuMovies had no video for this game last time it was asked.' : 'No video kept for this game yet.'}</p>
    <button class="btn vid-find" type="button">${s.missed ? 'Try again' : 'Find video'}</button> <span class="hint vid-msg" role="status"></span>`;
  const btn = slot.querySelector('.vid-find'), msg = slot.querySelector('.vid-msg');
  btn.addEventListener('click', async () => {
    btn.disabled = true; msg.textContent = 'asking EmuMovies…';
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
  if (hoverVideo) { hoverVideo.pause(); hoverVideo.remove(); hoverVideo = null; }
  hoverTile = null;
}
function startPreview(tile) {
  const cover = tile.querySelector('.card-cover');
  if (!cover || tile.closest('.selecting, .bulk-mode')) return;   // not while picking tiles
  const v = document.createElement('video');
  v.className = 'vid-hover'; v.src = srcFor(tile.dataset.vid); v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.preload = 'auto';
  v.addEventListener('error', () => { if (hoverVideo === v) stopPreview(); });   // the file has gone: the tile just stays as it was
  v.addEventListener('playing', () => v.classList.add('on'));
  cover.appendChild(v); hoverVideo = v;
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
