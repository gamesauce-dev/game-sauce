// The launcher as a download, for people who use game-sauce in a browser (no desktop app): a zip of the launcher folder plus a READ ME FIRST that says what to do.
// The launcher is the small program on a PC that starts a game in an emulator installed there (see docs/LOCAL-LAUNCH.md); the desktop app already carries it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = () => fileURLToPath(new URL('../../launcher/', import.meta.url));

/** The text of READ ME FIRST (Windows line endings, so Notepad shows it properly). `origin` is the address the person reached game-sauce at. */
export function readMe(origin) {
  return [
    'game-sauce launcher',
    '===================',
    '',
    'What it is: the small program that lets the "Play on this PC" button start a game in an emulator',
    'you have installed on THIS computer. The game file stays on your game-sauce server: a temporary copy is',
    'downloaded, the emulator opens it, and the copy is deleted when you close the emulator.',
    '',
    'What you need: Node.js 18 or newer on this computer (free, from https://nodejs.org).',
    '',
    'Set it up (once per computer)',
    '-----------------------------',
    '1. Unzip this folder somewhere it can stay (for example C:\\Tools\\game-sauce-launcher, or ~/game-sauce-launcher).',
    '   Do not run anything from inside the zip, and do not move the folder afterwards (run the installer again if you do).',
    '2. Register the gamesauce:// link (no administrator rights needed):',
    '   - Windows: double-click install-windows.bat',
    '   - Linux:   open a terminal in the folder and run   sh install-linux.sh',
    '   - macOS:   open a terminal in the folder and run   sh install-macos.sh',
    `3. In game-sauce (${origin}) open Settings > My account > Play on this PC, and press "Set up emulators".`,
    '   A page opens on this computer: choose the program that plays each platform, then Save.',
    '4. Press "Check my PC" in the same place so the Carousel only shows games this computer can start.',
    '',
    'Undo it',
    '-------',
    'Run uninstall-windows.bat, uninstall-linux.sh or uninstall-macos.sh. Your emulators and games are never touched.',
    '',
    'More: docs/LOCAL-LAUNCH.md in the game-sauce project explains every setting.',
    ''
  ].join('\r\n');
}

/** What goes in the zip: [{ name, data | file }]. Empty when this installation has no launcher folder. */
export function launcherEntries(origin) {
  let names;
  try { names = fs.readdirSync(dir()).filter((n) => fs.statSync(path.join(dir(), n)).isFile()); } catch { return []; }
  if (!names.length) return [];
  return [
    { name: 'game-sauce-launcher/READ ME FIRST.txt', data: Buffer.from(readMe(origin), 'utf8') },
    ...names.sort().map((n) => ({ name: `game-sauce-launcher/${n}`, file: path.join(dir(), n) }))
  ];
}
