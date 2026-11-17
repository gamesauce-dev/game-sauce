// The description in a game's details window shows at most 7 lines. A longer one scrolls itself up and down slowly (it stops while the mouse is over it, and for people who asked for less motion).
const LINES = 7;
function setUp(p) {
  if (p.dataset.scrollDone) return;
  p.dataset.scrollDone = '1';
  const text = document.createElement('span');
  text.className = 'detail-desc-text';
  while (p.firstChild) text.appendChild(p.firstChild);
  p.appendChild(text);
  requestAnimationFrame(() => {
    const over = text.offsetHeight - p.clientHeight;
    if (over > 2) {
      p.classList.add('is-long');
      p.style.setProperty('--desc-dist', `-${over}px`);
      p.style.setProperty('--desc-time', `${Math.max(8, Math.round(over / 12) + 6)}s`);   // about 12 pixels a second, plus a rest at each end
    }
  });
}
function scan(root) { root.querySelectorAll?.('#drawer-body .detail-desc').forEach(setUp); }
export function initDescScroll() {
  const host = document.querySelector('#drawer-body');
  if (!host || host.dataset.descWatch) return;
  host.dataset.descWatch = '1';
  new MutationObserver(() => scan(document)).observe(host, { childList: true, subtree: true });
  scan(document);
}
export { LINES };
