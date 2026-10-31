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
  // Nothing drawn: black and (all but) nothing else. Arcade games are mostly black on their own: Ms. Pac-Man's attract screen is
  // 97% black, and Ghouls'n Ghosts' start-up self-test ("SCROLL 1 OK, WORK RAM OK") is 98.6% black with 2 colours. Text on black
  // is a game running, so only a screen with less than half a percent of anything else counts as blank.
  if (lum(t) < 14 && t.share >= 0.995) return 'blank';
  return 'runs';
}

/** A picture that is almost all black but has something drawn on it: worth waiting a little longer for the game to get going. */
export function isSparse(stats) {
  const t = stats?.top?.[0];
  return Boolean(t) && lum(t) < 14 && t.share >= 0.95;
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

/* ───────────── finding the year where browser play stops working (check-play.mjs --cutoff) ───────────── */

/**
 * Group the years that have games into steps of at least `n` games, oldest first, so every step is judged on enough games.
 * Early years often hold one or two games each; judging a year on one game proves nothing.
 * years = [{ year, count }]  ->  [{ from, to, years: [year, ...], count }]
 */
export function planBuckets(years, n) {
  const out = [];
  let cur = null;
  for (const { year, count } of [...years].sort((a, b) => a.year - b.year)) {
    if (!cur) cur = { from: year, to: year, years: [], count: 0 };
    cur.to = year; cur.years.push(year); cur.count += count;
    if (cur.count >= n) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur); // the newest years may add up to fewer than n: they are still tried, but cannot decide anything alone
  return out;
}

/**
 * Where do games stop working? results = [{ from, to, tried, ran }] in year order. A step "mostly ran" at 50% or more.
 *  - A step with fewer than `minEvidence` games tried is shown but never counts for or against.
 *  - Failures only count AFTER a step that mostly ran. The very oldest games (Pong, Galaxy Game: discrete logic, no ordinary
 *    program) fail on any core, which says nothing about the years after them.
 *  - Two steps in a row that mostly fail end the search.
 * Returns { stop, seenGood, lastGood (a year), firstBad (a year) }.
 */
export function judgeSteps(results, minEvidence = 5) {
  let seenGood = false, lastGood = null, firstBad = null, badStreak = 0;
  for (const r of results) {
    if (!r.tried || r.tried < minEvidence) continue;
    if (r.ran / r.tried >= 0.5) { seenGood = true; lastGood = r.to; firstBad = null; badStreak = 0; }
    else if (seenGood) { firstBad ??= r.from; badStreak++; }
  }
  return { stop: badStreak >= 2, seenGood, lastGood, firstBad };
}
