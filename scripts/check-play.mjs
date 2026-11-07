#!/usr/bin/env node
// Checks which games flagged "play in browser" really start, by loading each one in a real (headless) browser and looking at
// the picture. A game the browser core cannot run drops into RetroArch's own menu; the emulator never reports that as an
// error, so this looks at what is drawn. Run it on a PC, pointed at your server. It needs a signed-in ADMIN.
//
//   npm ci                                    (once, in the game-sauce folder: this installs the test browser tooling)
//   npx playwright install chromium           (once: downloads the browser, about 150 MB)
//   node scripts/check-play.mjs --server http://YOUR-SERVER:8765 --user admin --platform mame,fba
//
// It READS only. It plays each game for a few seconds with saving switched off, and test plays are not counted in "Continue
// playing" or the stats. Nothing is changed unless you add --apply (which switches off browser play for the games that
// landed in the RetroArch menu; you can switch any of them back on from the game's ⋯ menu).
//
// Options
//   --server URL        your server (default http://127.0.0.1:8765)
//   --user NAME         an admin account;  the password is asked for, or set GAMESAUCE_PASSWORD
//   --platform a,b      platform slugs to check, e.g. mame,fba,neogeo,cps1,cps2,cps3,cave (default: every platform that can play)
//   --candidates        also test games the app does NOT offer yet: MAME after the year cut-off, CPS3, Cave. The ones that run can
//                       be switched ON with --apply, which is how the list of working games is built up.
//   --cutoff            find the year where games stop working: tests games oldest first, in steps of one or more years (years
//                       with few games are grouped so every step is judged on enough games), and stops once two steps in a
//                       row mostly fail. Failures only count after a stretch that mostly ran: the very oldest games (Pong,
//                       Galaxy Game) are not ordinary programs and fail anywhere. Prints a table, then the year to use.
//   --per-year N        games tried per step with --cutoff (default 8; a step is a year, or several years added together until
//                       they hold at least N games)
//   --sample N          check N random games per platform (default 20: a quick health check). With --resume the random
//                       games come only from ones not tested yet, and a platform with few left is simply finished.
//   --all               check EVERY playable game (slow: about 12 seconds each, a few at a time)
//   --limit N           only the first N games per platform (alphabetical)
//   --only TEXT         only games whose title contains TEXT (to re-test one game, e.g. --only "ghouls")
//   --seconds N         how long to let each game run before judging it (default 12)
//   --concurrency N     games checked at once (default 2)
//   --recheck           also test games that are already switched ON. By default they are skipped: they passed before.
//   --resume            carry on an earlier run (skips games already in the output folder). Without it, a new run starts a fresh
//                       results file and the old one is kept beside it as results-<date>.jsonl.bak
//   --off               do not test anything: switch browser play OFF for every game on the platforms you name with --platform (and,
//                       with --only, whose title contains that text). It lists how many first and asks you to confirm (--yes skips
//                       the question). Use it for a platform where the in-browser player cannot work at all, e.g.
//                       --platform neogeo --off. Any game can be switched back on from its ⋯ menu.
//   --yes               with --off: do not ask for confirmation
//   --apply             change the flags AS IT GOES, so a stopped run keeps its progress: every game that runs is switched ON, and
//                       a game that shows the RetroArch menu or the core's own error screen (FinalBurn Neo's "romset is missing
//                       files") is switched OFF if it was on. Games already ON are skipped
//                       (unless --recheck). Each flag can be changed back from the game's ⋯ menu.
//   --out DIR           where to put the results (default ./play-check)
//   --headed            show the browser while it runs
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { isFailure } from '../src/lib/playcheck.js';
import { connect, offeredGames, switchOff, runCheck, tallyByPlatform, pendingChanges } from './lib/check-play-core.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

if (flag('--help') || flag('-h')) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(0); }

const server = (opt('--server', 'http://127.0.0.1:8765')).replace(/\/+$/, '');
const user = opt('--user', 'admin');
const platforms = (opt('--platform', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const outDir = path.resolve(opt('--out', './play-check'));
const apply = flag('--apply');
const candidates = flag('--candidates') || flag('--cutoff');
const cutoff = flag('--cutoff');
const only = (opt('--only', '') || '').toLowerCase();

async function ask(question, hidden) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) { rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); }; }
  return new Promise((res) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a); }));
}

const pw = process.env.GAMESAUCE_PASSWORD || await ask(`Password for ${user}: `, true);
const conn = await connect(server, user, pw).catch((e) => { console.error(e.message); process.exit(1); });

if (flag('--off')) {
  if (!platforms.length) { console.error('--off needs --platform (for example --platform neogeo): it will not switch off browser play everywhere.'); process.exit(1); }
  const todoOff = await offeredGames(conn, platforms, only);
  if (!todoOff.length) { console.log('No game on that platform is offered for browser play, so there is nothing to switch off.'); process.exit(0); }
  console.log(`${todoOff.length} game${todoOff.length === 1 ? ' is' : 's are'} offered for browser play on ${platforms.join(', ')}${only ? ` matching "${only}"` : ''}.`);
  if (!flag('--yes') && !/^y/i.test(await ask('Switch browser play OFF for all of them? (y/N) ', false))) { console.log('Nothing changed.'); process.exit(0); }
  const { n, failed } = await switchOff(conn, todoOff, (d, t) => console.log(`  ${d}/${t}`));
  console.log(`Browser play switched OFF for ${n} game${n === 1 ? '' : 's'}${failed ? ` (${failed} could not be changed)` : ''}. Switch any back on from the game's ⋯ menu, or test them properly with --candidates --recheck --apply.`);
  process.exit(failed ? 1 : 0);
}

const show = ({ rec, finished, of }) => {
  const mark = rec.verdict === 'runs' ? '  ok ' : isFailure(rec.verdict) ? ' FAIL' : ' ??  ';
  console.log(`[${finished}${of ? '/' + of : ''}] ${mark} ${rec.platform.padEnd(8)} ${String(rec.year || '----')}  ${rec.title}  ${rec.verdict === 'runs' ? '' : '(' + rec.verdict + ')'}`);
};
const ac = new AbortController();
process.on('SIGINT', () => { if (ac.signal.aborted) process.exit(130); console.log('\nStopping after the games in progress... (Ctrl+C again to quit now). Run again with --resume to carry on.'); ac.abort(); });

let r;
try {
  r = await runCheck(conn, {
    platforms, sample: Number(opt('--sample', 20)), all: flag('--all'), limit: Number(opt('--limit', 0)) || 0, only,
    seconds: Number(opt('--seconds', 12)), concurrency: Number(opt('--concurrency', 2)), apply, recheck: flag('--recheck'),
    candidates, cutoff, perYear: Number(opt('--per-year', 8)), resume: flag('--resume'), headed: flag('--headed'), outDir,
  }, { signal: ac.signal, emit: (type, d) => { if (type === 'log') console.log(d); else if (type === 'game') show(d); } });
} catch (e) { console.error(e.message); process.exit(1); }
if (r.nothing) process.exit(0);

// ---- report
const all = r.all;
console.log('\n=== Result ===');
for (const [p, v] of Object.entries(tallyByPlatform(all))) { const n = Object.values(v).reduce((a, b) => a + b, 0); console.log(`${p.padEnd(10)} ${n} checked: ${Object.entries(v).map(([k, c]) => `${c} ${k}`).join(', ')}`); }
console.log(`\nResults: ${outDir}${path.sep}results.jsonl   Pictures of the failures: ${outDir}${path.sep}report.html`);
const { toOn, toOff } = pendingChanges(all);
if (cutoff) {
  console.log('\n=== Where games stop working ===');
  for (const s of r.cutoffReport.filter((x) => x.summary)) {
    console.log(`\n${s.platform}, by year (a step counts as running when half or more of its games ran):`);
    for (const x of s.results) console.log(`   ${(x.from === x.to ? String(x.from) : `${x.from}-${x.to}`).padEnd(10)} ${String(x.ran).padStart(2)}/${String(x.tried).padEnd(2)} ${'#'.repeat(Math.round(x.tried ? x.ran / x.tried * 20 : 0)).padEnd(20, '.')} ${x.tried ? Math.round(x.ran / x.tried * 100) : 0}%`);
    if (!s.seenGood) console.log(`\n${s.platform}: no stretch of years mostly ran, so there is no cut-off to suggest. (The very oldest games are not ordinary programs and fail on any core.)`);
    else if (s.stop) console.log(`\n${s.platform}: games up to ${s.lastGood} mostly run. From ${s.firstBad} two steps in a row mostly failed, so I stopped there. Suggested cut-off year: ${s.lastGood}.`);
    else console.log(`\n${s.platform}: every stretch after the first good one mostly ran, so there is no cut-off to suggest (last year tried: ${s.lastGood}).`);
  }
  console.log('\nTo use a year: set GAMESAUCE_MAME_PLAY_MAX_YEAR to it on the server (it only affects MAME), then restart game-sauce.');
  console.log('A cut-off is a rough guide: failures are not neatly by year. The full run (--candidates --all --apply) is what settles each game.');
}
if (apply) {
  console.log(`\nBrowser play switched ON for ${r.switchedOn} game${r.switchedOn === 1 ? '' : 's'} that ran, and OFF for ${r.switchedOff} that showed the RetroArch menu. (Any can be changed back from the game's ⋯ menu.)`);
} else {
  if (toOn.length) console.log(`\n${toOn.length} game${toOn.length === 1 ? '' : 's'} ran fine. Run again with --resume --apply to switch browser play ON for them.`);
  if (toOff.length) console.log(`${toOff.length} game${toOff.length === 1 ? '' : 's'} showed the RetroArch menu and ${toOff.length === 1 ? 'is' : 'are'} offered today. Look at report.html, then --resume --apply to switch ${toOff.length === 1 ? 'it' : 'them'} off.`);
}
if (r.aborted) console.log('\nStopped early. Run the same command again with --resume to carry on.');
