// The browser writes "Choose File" and "No file chosen" in its own language, not the one chosen in game-sauce, and no page can change them.
// So every visible file box (class file-input) is drawn by the page: a button and the chosen name. The real <input> stays, invisible, on top of
// that drawing, so clicking, the keyboard, dragging a file onto it, "required" and every script that reads it work as before.
import { t } from './i18n.js';

const words = (files) => (!files?.length ? t('No file chosen') : files.length === 1 ? files[0].name : t('Files chosen: {count}', { count: files.length }));

function dress(input) {
  if (input.dataset.picked !== undefined || input.hidden || input.classList.contains('hidden')) return;
  input.dataset.picked = '';
  const box = document.createElement('span');
  box.className = 'filepick';
  const face = document.createElement('span');
  face.className = 'filepick-face';
  face.setAttribute('aria-hidden', 'true');   // the input itself is what a screen reader reads
  const button = document.createElement('span');
  button.className = 'filepick-btn';
  button.textContent = t(input.multiple ? 'Choose files' : 'Choose file');
  const name = document.createElement('span');
  name.className = 'filepick-name notranslate';   // a file's name is never translated
  face.append(button, name);
  input.before(box);
  box.append(face, input);
  const show = () => {
    name.textContent = words(input.files);
    input.title = name.textContent;   // without a title the browser shows its own "No file chosen" on hover
  };
  input.addEventListener('change', show);
  // A script that empties the box (value = '') fires no event: watch the property on this one input.
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(input, 'value', { configurable: true, get: () => proto.get.call(input), set: (v) => { proto.set.call(input, v); show(); } });
  show();
}

const dressAll = (root) => {
  if (root.matches?.('input[type="file"].file-input')) dress(root);
  for (const input of root.querySelectorAll?.('input[type="file"].file-input') || []) dress(input);
};

/** Dress the file boxes on the page, and any drawn later. */
export function initFilePickers() {
  dressAll(document);
  new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) dressAll(n); })
    .observe(document.body, { childList: true, subtree: true });
  // A form reset empties its file boxes, after the event.
  document.addEventListener('reset', (e) => setTimeout(() => {
    for (const input of e.target.querySelectorAll?.('input[type="file"][data-picked]') || []) { input.title = words(input.files); const n = input.parentElement.querySelector('.filepick-name'); if (n) n.textContent = words(input.files); }
  }, 0));
}
