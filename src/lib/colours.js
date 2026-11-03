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
