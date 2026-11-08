// Colours for platform and family chips. A colour is only ever used as a tint behind normal text, but this still refuses colours that would
// make a chip hard to read in dark OR light mode (near-black on the dark theme, near-white on the light one), so nothing unreadable can be saved.

export const HEX = /^#[0-9a-f]{6}$/i;

const lum = (h) => {
  const n = parseInt(h.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const DARK_PANEL = '#12141b', LIGHT_PANEL = '#ffffff';
/** The left edge of a chip is drawn in the colour itself, so it has to stand out from the chip's own background in both themes. */
export function usable(hex) {
  if (!HEX.test(String(hex || ''))) return { ok: false, reason: 'Use a colour like #e60012' };
  const h = String(hex).toLowerCase();
  if (contrast(h, DARK_PANEL) < 1.8) return { ok: false, reason: 'That colour is too dark to see on the dark theme' };
  if (contrast(h, LIGHT_PANEL) < 1.4) return { ok: false, reason: 'That colour is too light to see on the light theme' };
  return { ok: true, colour: h };
}

/** Default colour for each built-in family (a person can change any of them). */
export const FAMILY_DEFAULTS = {
  Nintendo: '#e60012', Sony: '#2f6fed', Microsoft: '#107c10', Sega: '#1a8fe0', Atari: '#c4572a',
  'NEC / SNK': '#c2185b', Arcade: '#00897b', Others: '#6b7280'
};

/* ───────── people's colours (chosen by an admin; used in the chat) ─────────
   A person's colour tints their avatar, their row in the chat list and the messages you receive from them. It is checked like any other colour (readable on both themes),
   and GREEN is refused: in the chat your own messages are green, so a received message must never be mistaken for one of yours. */
export const USER_COLOURS = ['#7c5cff', '#3b82f6', '#ec4899', '#f97316', '#06b6d4', '#ef4444', '#a855f7', '#f59e0b', '#0ea5e9', '#d946ef', '#f43f5e', '#b45309'];

/** Hue (0-360), saturation and lightness (0-1) of a #rrggbb colour. */
export function hsl(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}
export const isGreen = (hex) => { const { h, s, l } = hsl(hex); return h >= 100 && h <= 175 && s >= 0.2 && l >= 0.12 && l <= 0.92; };

/** A colour for a person: a readable colour that is not green. */
export function userColour(hex) {
  const u = usable(hex);
  if (!u.ok) return u;
  if (isGreen(u.colour)) return { ok: false, reason: 'Green is kept for your own messages in the chat: choose another colour' };
  return u;
}

/** The first palette colour nobody has yet (or, once they are all taken, round again). */
export function nextUserColour(taken = []) {
  const t = new Set(taken.map((c) => String(c || '').toLowerCase()).filter(Boolean));
  return USER_COLOURS.find((c) => !t.has(c)) || USER_COLOURS[t.size % USER_COLOURS.length];
}
