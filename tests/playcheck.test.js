import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFrame, verdict } from '../src/lib/playcheck.js';

// Numbers measured from real screenshots of the player (640x480): RetroArch's menu, and a game that is running.
const MENU = { colours: 9, top: [{ r: 64, g: 64, b: 64, share: 0.896 }, { r: 32, g: 32, b: 32, share: 0.034 }, { r: 0, g: 0, b: 0, share: 0.026 }] };
const RED_GAME = { colours: 2, top: [{ r: 216, g: 40, b: 0, share: 0.98 }, { r: 0, g: 0, b: 0, share: 0.02 }] };
const BUSY_GAME = { colours: 3000, top: [{ r: 20, g: 20, b: 60, share: 0.2 }, { r: 200, g: 180, b: 40, share: 0.1 }, { r: 90, g: 90, b: 90, share: 0.08 }] };
// Measured from a real screenshot of Ms. Pac-Man's attract screen: a running game that is 97% black.
const MSPACMAN = { colours: 6, top: [{ r: 0, g: 0, b: 0, share: 0.9735 }, { r: 248, g: 0, b: 0, share: 0.0111 }, { r: 216, g: 216, b: 248, share: 0.0081 }] };
// Measured from a real screenshot of Ghouls'n Ghosts (CPS1) on its start-up self-test: 98.6% black, grey text.
const GHOULS_SELFTEST = { colours: 2, top: [{ r: 0, g: 0, b: 0, share: 0.9861 }, { r: 168, g: 168, b: 168, share: 0.0139 }] };
const BLACK = { colours: 1, top: [{ r: 0, g: 0, b: 0, share: 1 }] };
const GREY_SKY_GAME = { colours: 800, top: [{ r: 64, g: 64, b: 64, share: 0.6 }, { r: 200, g: 40, b: 40, share: 0.1 }] }; // grey, but many colours: a real game

test('the RetroArch menu is recognised, a running game is not mistaken for it', () => {
  assert.equal(classifyFrame(MENU), 'retroarch-menu');
  assert.equal(classifyFrame(RED_GAME), 'runs');
  assert.equal(classifyFrame(BUSY_GAME), 'runs');
  assert.equal(classifyFrame(GREY_SKY_GAME), 'runs', 'a mostly grey game with plenty of colours is a game');
  assert.equal(classifyFrame(MSPACMAN), 'runs', 'a mostly black arcade screen is still a game');
  assert.equal(classifyFrame(BLACK), 'blank');
  assert.equal(classifyFrame({ colours: 3, top: [{ r: 0, g: 0, b: 0, share: 0.999 }] }), 'blank', 'black with next to nothing else');
  assert.equal(classifyFrame(GHOULS_SELFTEST), 'runs', "a game's own start-up test screen (grey text on black) is a game running");
  assert.equal(classifyFrame({ colours: 0, top: [] }), 'blank');
  assert.equal(classifyFrame(null), 'blank');
});

test('verdict over several pictures: any menu frame is a failure; black all the way is blank, not a failure', () => {
  assert.equal(verdict([RED_GAME, RED_GAME, RED_GAME]), 'runs');
  assert.equal(verdict([BLACK, BUSY_GAME, BUSY_GAME]), 'runs', 'a slow start is fine');
  assert.equal(verdict([RED_GAME, MENU, MENU]), 'retroarch-menu');
  assert.equal(verdict([BLACK, BLACK, BLACK]), 'blank');
  assert.equal(verdict([]), 'no-picture');
});

import { planBuckets, judgeSteps } from '../src/lib/playcheck.js';

test('years with few games are grouped so each step is judged on enough games', () => {
  const years = [{ year: 1971, count: 1 }, { year: 1972, count: 1 }, { year: 1973, count: 2 }, { year: 1974, count: 6 }, { year: 1975, count: 9 }, { year: 1976, count: 3 }];
  const steps = planBuckets(years, 5);
  assert.deepEqual(steps.map((s) => [s.from, s.to, s.count]), [[1971, 1974, 10], [1975, 1975, 9], [1976, 1976, 3]]);
  assert.equal(planBuckets([], 5).length, 0);
  assert.deepEqual(planBuckets([{ year: 1990, count: 50 }], 8).map((s) => [s.from, s.to]), [[1990, 1990]]);
});

test('Pong failing at the very start does not end the search (the case from a real run)', () => {
  // 1971 and 1972 held one game each and both showed the menu; the old rule stopped there.
  const early = [{ from: 1971, to: 1971, tried: 1, ran: 0 }, { from: 1972, to: 1972, tried: 1, ran: 0 }];
  assert.equal(judgeSteps(early).stop, false);
  const later = [...early, { from: 1973, to: 1976, tried: 8, ran: 0 }, { from: 1977, to: 1978, tried: 8, ran: 0 }];
  assert.equal(judgeSteps(later).stop, false, 'still nothing has worked yet: failures before the first good stretch prove nothing');
  assert.equal(judgeSteps(later).seenGood, false);
});

test('the cut-off is found: good stretch, then two bad steps in a row', () => {
  const r = [
    { from: 1971, to: 1972, tried: 2, ran: 0 },
    { from: 1973, to: 1978, tried: 8, ran: 7 },
    { from: 1979, to: 1982, tried: 8, ran: 8 },
    { from: 1983, to: 1984, tried: 8, ran: 6 },
    { from: 1985, to: 1986, tried: 8, ran: 2 },
    { from: 1987, to: 1987, tried: 8, ran: 1 }
  ];
  const j = judgeSteps(r);
  assert.deepEqual([j.stop, j.seenGood, j.lastGood, j.firstBad], [true, true, 1984, 1985]);
});

test('one bad step among good ones, and steps with too little evidence, do not end it', () => {
  const dip = [{ from: 1980, to: 1981, tried: 8, ran: 7 }, { from: 1982, to: 1983, tried: 8, ran: 3 }, { from: 1984, to: 1985, tried: 8, ran: 6 }];
  assert.equal(judgeSteps(dip).stop, false);
  assert.equal(judgeSteps(dip).lastGood, 1985);
  const thin = [{ from: 1980, to: 1981, tried: 8, ran: 7 }, { from: 1982, to: 1982, tried: 2, ran: 0 }, { from: 1983, to: 1983, tried: 1, ran: 0 }];
  assert.equal(judgeSteps(thin).stop, false, 'two games failing is too little to decide anything');
});

import { isCoreError, isFailure } from '../src/lib/playcheck.js';

// Measured from the real screenshot the user sent: FinalBurn Neo's own error screen ("This game is known but one of your romsets is
// missing files for THIS VERSION of FBNeo"), drawn by a running core: light grey, a blue title bar, dark text.
const FBNEO_ERROR = { colours: 97, top: [{ r: 216, g: 216, b: 216, share: 0.889 }, { r: 0, g: 0, b: 248, share: 0.032 }, { r: 208, g: 208, b: 208, share: 0.005 }, { r: 168, g: 168, b: 168, share: 0.005 }] };
const LIGHT_GAME = { colours: 1800, top: [{ r: 224, g: 224, b: 224, share: 0.5 }, { r: 40, g: 40, b: 200, share: 0.1 }] };     // a bright game with a blue sky: many colours
const WHITE_TITLE = { colours: 12, top: [{ r: 240, g: 240, b: 240, share: 0.7 }, { r: 20, g: 20, b: 20, share: 0.2 }] };     // light screen, no blue bar

test("a core's own error screen (FinalBurn Neo 'romset is missing files') is a failure, not a running game", () => {
  assert.equal(classifyFrame(FBNEO_ERROR), 'core-error');
  assert.equal(isCoreError(FBNEO_ERROR), true);
  assert.equal(verdict([FBNEO_ERROR, FBNEO_ERROR, FBNEO_ERROR]), 'core-error');
  assert.equal(verdict([BLACK, FBNEO_ERROR, BUSY_GAME]), 'core-error', 'any error frame is enough: it never goes away on its own');
  assert.equal(isFailure('core-error'), true); assert.equal(isFailure('retroarch-menu'), true);
  assert.equal(isFailure('runs'), false); assert.equal(isFailure('blank'), false, 'blank is only reported, never switched off on its own');
});

test('real games are not mistaken for the error screen', () => {
  assert.equal(classifyFrame(LIGHT_GAME), 'runs', 'bright and blue, but thousands of colours');
  assert.equal(classifyFrame(WHITE_TITLE), 'runs', 'a light screen with no blue title bar');
  assert.equal(classifyFrame(RED_GAME), 'runs'); assert.equal(classifyFrame(MSPACMAN), 'runs'); assert.equal(classifyFrame(GHOULS_SELFTEST), 'runs');
  assert.equal(classifyFrame({ colours: 1, top: [{ r: 248, g: 248, b: 248, share: 1 }] }), 'blank', 'a screen that is nothing but white is blank');
});
