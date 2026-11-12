// The video in a game's details window (Library, Physical, Digital). A details window puts an empty
//   <div class="vid-slot" data-kind="rom|physical|digital" data-id="…" [data-store="xbox"]></div>
// in its page; this file notices it (the window is rebuilt for every game) and fills it:
// a player when the game has a video, a "Find video" button when EmuMovies is set up, nothing at all otherwise.
// Videos are fetched only when the button is pressed, never by opening a window.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const query = (slot) => new URLSearchParams({ kind: slot.dataset.kind, id: slot.dataset.id, ...(slot.dataset.store ? { store: slot.dataset.store } : {}) }).toString();
const mb = (b) => `${Math.max(1, Math.round(b / 1048576))} MB`;

async function call(path, options) {
  const res = await fetch(path, { credentials: 'same-origin', headers: options?.body ? { 'Content-Type': 'application/json' } : undefined, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function show(slot, s) {
  if (!slot.isConnected) return;
  if (s.available) {
    slot.innerHTML = `<div class="section-label">Video</div>
      <video class="vid-player" controls preload="metadata" playsinline src="/api/videos/file?${esc(query(slot))}"></video>
      ${s.bytes ? `<p class="hint">${mb(s.bytes)}, from EmuMovies</p>` : ''}`;
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
