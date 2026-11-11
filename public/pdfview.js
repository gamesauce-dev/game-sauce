// PDF manuals: the first page for the open case, and a viewer that works the same in every window (the Linux web view has no PDF reader of its own).
// pdf.js (Mozilla, Apache 2.0) is bundled in /vendor/pdfjs, so nothing is fetched from the internet. It is loaded only when a PDF manual is first shown.
const BASE = '/vendor/pdfjs/';
let lib = null;
function pdfjs() {
  if (!lib) {
    lib = import(`${BASE}pdf.min.js`).then((m) => { m.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.js`; return m; });
    lib.catch(() => { lib = null; });   // a failed load can be tried again
  }
  return lib;
}

const docs = new Map();   // url -> Promise of the opened document (kept for the first-page picture and the viewer)
function openDoc(url) {
  if (!docs.has(url)) {
    const p = pdfjs().then((m) => m.getDocument({ url, withCredentials: true }).promise);
    docs.set(url, p);
    p.catch(() => docs.delete(url));
  }
  return docs.get(url);
}

/** Draw one page into a canvas, `cssWidth` CSS pixels wide (sharper on a dense screen). Resolves to { pages, ratio } (ratio: page height / width). */
export async function drawPage(url, pageNo, canvas, cssWidth) {
  const pdf = await openDoc(url);
  const page = await pdf.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale: (cssWidth / base.width) * dpr });
  canvas.width = Math.max(1, Math.floor(vp.width)); canvas.height = Math.max(1, Math.floor(vp.height));
  canvas.style.width = `${Math.round(cssWidth)}px`; canvas.style.height = `${Math.round(cssWidth * base.height / base.width)}px`;
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
  canvas._task = task;
  await task.promise;
  return { pages: pdf.numPages, ratio: base.height / base.width };
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** The viewer's pages and controls. `bar` is the toolbar to add the page count and zoom buttons to; `scroller` is the box the pages scroll in. Returns { destroy }. */
export function mountViewer({ url, scroller, bar }) {
  let zoom = 2, pageCount = 0, ratio = 1.3, gone = false, io = null;   // zoom: an index into ZOOMS (2 = fit to the width)
  const info = document.createElement('span'); info.className = 'ph-pv-info'; info.textContent = 'Loading…';
  const mk = (txt, title) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-sm'; b.textContent = txt; b.title = title; b.setAttribute('aria-label', title); return b; };
  const out = mk('−', 'Zoom out (−)'), inn = mk('+', 'Zoom in (+)'), fit = mk('Fit', 'Fit the width (0)');
  const first = bar.querySelector('a, button');
  for (const el of [info, out, inn, fit]) bar.insertBefore(el, first);
  scroller.classList.add('ph-pv-scroll'); scroller.tabIndex = 0;

  const fitWidth = () => Math.max(140, Math.min(scroller.clientWidth - 28, 1000));
  const widthNow = () => Math.round(fitWidth() * (zoom === 2 ? 1 : ZOOMS[zoom]));
  const rendered = new Map();   // page box -> width it was drawn at

  const draw = async (box) => {
    const n = Number(box.dataset.page), w = widthNow();
    if (gone || rendered.get(box) === w) return;
    rendered.set(box, w);
    const c = box.querySelector('canvas');
    try { if (c._task) c._task.cancel?.(); } catch { /* already done */ }
    try { const r = await drawPage(url, n, c, w); box.style.minHeight = ''; box.classList.add('is-drawn'); ratio = r.ratio; }
    catch (err) { if (!/cancel/i.test(String(err?.name || err?.message || ''))) { box.classList.add('is-bad'); rendered.delete(box); } }
  };
  const layout = () => {
    const w = widthNow();
    scroller.innerHTML = '';
    io?.disconnect();
    io = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) draw(e.target); }, { root: scroller, rootMargin: '150% 0px' });
    rendered.clear();
    for (let i = 1; i <= pageCount; i++) {
      const box = document.createElement('div'); box.className = 'ph-pv-page'; box.dataset.page = String(i);
      box.style.width = `${w}px`; box.style.minHeight = `${Math.round(w * ratio)}px`;
      box.append(document.createElement('canvas'));
      scroller.append(box); io.observe(box);
    }
    info.textContent = `${pageCount} page${pageCount === 1 ? '' : 's'}`;
  };
  const setZoom = (z) => { zoom = Math.max(0, Math.min(ZOOMS.length - 1, z)); const top = scroller.scrollTop / Math.max(1, scroller.scrollHeight); layout(); scroller.scrollTop = top * scroller.scrollHeight; };
  out.onclick = () => setZoom(zoom - 1); inn.onclick = () => setZoom(zoom + 1); fit.onclick = () => setZoom(2);
  const onKey = (e) => {
    if (e.target.closest?.('input, textarea')) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom + 1); }
    else if (e.key === '-') { e.preventDefault(); setZoom(zoom - 1); }
    else if (e.key === '0') { e.preventDefault(); setZoom(2); }
    else if (e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); scroller.scrollBy({ top: scroller.clientHeight * 0.9, behavior: 'smooth' }); }
    else if (e.key === 'PageUp') { e.preventDefault(); scroller.scrollBy({ top: -scroller.clientHeight * 0.9, behavior: 'smooth' }); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); scroller.scrollBy({ top: 90 }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); scroller.scrollBy({ top: -90 }); }
  };
  scroller.addEventListener('keydown', onKey);
  const onScroll = () => {
    const mid = scroller.scrollTop + scroller.clientHeight / 2;
    for (const box of scroller.children) { if (box.offsetTop + box.offsetHeight >= mid) { info.textContent = `Page ${box.dataset.page} of ${pageCount}`; break; } }
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });

  const ready = openDoc(url).then(async (pdf) => {
    if (gone) return;
    pageCount = pdf.numPages;
    try { const p = await pdf.getPage(1); const v = p.getViewport({ scale: 1 }); ratio = v.height / v.width; } catch { /* keep the guess */ }
    layout(); scroller.focus({ preventScroll: true });
  });
  ready.catch(() => { info.textContent = 'This manual could not be shown here: use Download'; });
  return { ready, destroy() { gone = true; io?.disconnect(); scroller.removeEventListener('keydown', onKey); scroller.removeEventListener('scroll', onScroll); } };
}

/** Is a PDF reader available (it needs to be loadable)? Resolves false when the bundled files cannot be loaded. */
export const pdfReady = () => pdfjs().then(() => true, () => false);
