// Decides whether a screenshot of the in-browser player shows a running game or one of the failure screens.
// The emulator itself never reports failure (a bad or unsupported game just drops into RetroArch's own menu), so the only
// reliable test is to look at what is drawn. scripts/check-play.mjs takes the picture and measures it; this decides.
//
// stats = { colours, top: [{ r, g, b, share }, ...] }  (colours counted after rounding each channel to 5 bits)

const isGrey = (c) => Math.abs(c.r - c.g) <= 10 && Math.abs(c.g - c.b) <= 10;
const lum = (c) => (c.r + c.g + c.b) / 3;

/** 'retroarch-menu' | 'blank' | 'runs' for ONE picture. */
export function classifyFrame(stats) {
  const t = stats?.top?.[0];
  if (!t) return 'blank';
  // RetroArch's menu: one flat mid-dark grey over most of the screen, and almost no other colours (white text, a few icons).
  if (isGrey(t) && lum(t) >= 28 && lum(t) <= 80 && t.share >= 0.55 && stats.colours <= 48) return 'retroarch-menu';
  // Nothing drawn: a single black (or near black) colour everywhere.
  if (lum(t) < 14 && t.share >= 0.97) return 'blank';
  return 'runs';
}

/**
 * The verdict for a game from several pictures taken over time.
 * The menu never goes away on its own, so ANY frame showing it is a failure. Black all the way through is "blank"
 * (an arcade game can legitimately take a moment, so it is reported separately and never switched off automatically).
 */
export function verdict(frames) {
  const kinds = frames.map(classifyFrame);
  if (kinds.includes('retroarch-menu')) return 'retroarch-menu';
  if (kinds.length && kinds.every((k) => k === 'blank')) return 'blank';
  return kinds.length ? 'runs' : 'no-picture';
}
