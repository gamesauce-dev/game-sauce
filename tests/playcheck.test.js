import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFrame, verdict } from '../src/lib/playcheck.js';

// Numbers measured from real screenshots of the player (640x480): RetroArch's menu, and a game that is running.
const MENU = { colours: 9, top: [{ r: 64, g: 64, b: 64, share: 0.896 }, { r: 32, g: 32, b: 32, share: 0.034 }, { r: 0, g: 0, b: 0, share: 0.026 }] };
const RED_GAME = { colours: 2, top: [{ r: 216, g: 40, b: 0, share: 0.98 }, { r: 0, g: 0, b: 0, share: 0.02 }] };
const BUSY_GAME = { colours: 3000, top: [{ r: 20, g: 20, b: 60, share: 0.2 }, { r: 200, g: 180, b: 40, share: 0.1 }, { r: 90, g: 90, b: 90, share: 0.08 }] };
const BLACK = { colours: 1, top: [{ r: 0, g: 0, b: 0, share: 1 }] };
const GREY_SKY_GAME = { colours: 800, top: [{ r: 64, g: 64, b: 64, share: 0.6 }, { r: 200, g: 40, b: 40, share: 0.1 }] }; // grey, but many colours: a real game

test('the RetroArch menu is recognised, a running game is not mistaken for it', () => {
  assert.equal(classifyFrame(MENU), 'retroarch-menu');
  assert.equal(classifyFrame(RED_GAME), 'runs');
  assert.equal(classifyFrame(BUSY_GAME), 'runs');
  assert.equal(classifyFrame(GREY_SKY_GAME), 'runs', 'a mostly grey game with plenty of colours is a game');
  assert.equal(classifyFrame(BLACK), 'blank');
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
