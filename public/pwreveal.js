// An eye in every password box: press it to see what you typed, press again to hide it. Works on boxes that appear later (the welcome tour,
// the new-user form, the login page) because it watches the page. A box is hidden again when its form is sent.
const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path class="pw-slash" d="M4 4l16 16"/></svg>';

function decorate(input) {
  if (input.dataset.pwDone || input.dataset.noReveal !== undefined) return;
  input.dataset.pwDone = '1';
  const wrap = document.createElement('span');
  wrap.className = 'pw-wrap';
  input.before(wrap);
  wrap.append(input);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pw-eye';
  btn.innerHTML = EYE;
  const paint = () => {
    const shown = input.type === 'text';
    btn.classList.toggle('is-shown', shown);
    btn.setAttribute('aria-pressed', String(shown));
    btn.title = btn.ariaLabel = shown ? 'Hide password' : 'Show password';
  };
  btn.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; paint(); input.focus({ preventScroll: true }); });
  btn.addEventListener('mousedown', (e) => e.preventDefault());   // keeps the cursor where it was in the box
  input.form?.addEventListener('submit', () => { if (input.type === 'text') { input.type = 'password'; paint(); } });
  paint();
  wrap.append(btn);
}

const scan = (root = document) => root.querySelectorAll?.('input[type="password"]').forEach(decorate);
scan();
new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) { if (n.matches?.('input[type="password"]')) decorate(n); else scan(n); } })
  .observe(document.body, { childList: true, subtree: true });
