// Multi-disc sets: a game on several discs (Game (Disc 1), Game (Disc 2)...) is one game, but each disc is a ROM of its own, and Play on this PC sends the launcher
// ONE file, so a set cannot be played that way (an emulator that handles multi-disc sets can still be given the downloaded files by hand).
// A ROM is part of a multi-disc set when its file name says so (detectMultiDisc), unless an admin set it by hand (roms.multidisc_override: 1 yes, 0 no, null = go by the name).
// Browser play is not affected: the platforms that play in the browser are cartridge systems.

const TAG = /[\[(]\s*(?:disc|disk|cd)\s*([1-9]|[a-e])(?![0-9a-z])(?:\s*(?:of|\/)\s*(\d+))?\s*[\])]/i;   // (Disc 2), [CD1], (Disc 1 of 3), (Disk A); not "(CD32)"
const TRAILING = /[-–,:]\s*(?:disc|disk|cd)\s*([1-9]|[a-e])(?![0-9a-z])(?:\s*of\s*(\d+))?\s*$/i;          // "Game - Disc 2"

/** Does this file name say the game is one disc of a set? A playlist (.m3u) names several discs, so it counts too; "(Disc 1 of 1)" does not. */
export function detectMultiDisc(filename) {
  const name = String(filename || '');
  if (/\.m3u8?$/i.test(name)) return true;
  const base = name.replace(/\.[^.\\/]+$/, '');
  const m = TAG.exec(base) || TRAILING.exec(base);
  if (!m) return false;
  return !(m[2] && Number(m[2]) === 1);
}

/** The answer for a ROM row: the admin's setting when there is one, else the file name's. */
export function isMultiDisc(row) {
  const o = row?.multidisc_override;
  if (o === 1 || o === 0) return o === 1;
  return detectMultiDisc(row?.filename);
}

export const MULTIDISC_MESSAGE = 'This game is part of a multi-disc set, which Play on this PC cannot start (it sends one file). Download the files and open them in an emulator that handles multi-disc sets.';
