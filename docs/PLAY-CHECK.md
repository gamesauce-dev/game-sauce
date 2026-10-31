# Checking which games really play in the browser

Games flagged **play in browser** use the EmulatorJS cores. A game a core cannot run does not show an error: it drops into
**RetroArch's own menu** ("Main Menu / Load Content / Quit RetroArch"). The emulator reports it as started either way, so the
only reliable test is to look at the picture. `scripts/check-play.mjs` does that for you, from your own computer.

## One-time setup (on a PC, in the game-sauce folder)

```
npm ci
npx playwright install chromium
```

This downloads a test browser (about 150 MB). Nothing is installed on your server.

## Run it

```
node scripts/check-play.mjs --server http://YOUR-SERVER:8765 --user admin --platform mame,fba
```

It asks for the admin password (or set `GAMESAUCE_PASSWORD`). By default it checks a random **20 games per platform**, which is
a quick health check. Useful options:

| | |
|---|---|
| `--platform mame,fba,neogeo` | which platforms (slugs as shown in Settings → Platforms); default is every platform that can play |
| `--sample 50` | games per platform to try (default 20) |
| `--all` | every playable game: slow, about 12 seconds each, a couple at a time. With `--resume` it tests only the ones not done yet |
| `--seconds 15` | how long each game runs before it is judged (default 12) |
| `--concurrency 3` | games checked at once (default 2) |
| `--only ghouls` | only games whose title contains that text: re-test one game |
| `--resume` | carry on a stopped run, skipping games already done |
| `--candidates` | also test games the app does not offer yet (MAME after the year cut-off, CPS3, Cave) |
| `--cutoff` | find the year where games stop working: games tested oldest first, in steps of one or more years (years with few games are grouped so each step has enough), stops after two bad steps in a row. Failures only count after a stretch that mostly ran, because the very oldest games (Pong, Galaxy Game) fail anywhere |
| `--per-year 8` | games tried per step with `--cutoff` |
| `--recheck` | also test games already switched on (they are skipped by default: they passed before) |
| `--apply` | switch browser play **off** for games that showed the RetroArch menu, and **on** (with `--candidates`) for games that ran |
| `--out DIR` | where the results go (default `./play-check`) |

## Quick reference (the commands you will actually use)

Run these in the game-sauce folder. Swap in your own server address. Add `--user NAME` if your admin is not called `admin`.
It asks for the password each time (or set `GAMESAUCE_PASSWORD` first).

| I want to… | Command (after `node scripts/check-play.mjs --server http://YOUR-SERVER:8765`) |
|---|---|
| **Quick health check** of a platform (random 20, changes nothing) | `--platform fba` |
| **Test every game and switch them ON or OFF as it goes** (the overnight run) | `--platform fba,neogeo,cps1,cps2,cps3,cave,mame --candidates --all --resume --apply` |
| **Carry on** after the PC slept, you stopped it, or it crashed | the same command again: `--resume` skips games already judged |
| Finish a platform that is almost done | add `--all` (it tests only the games not yet done) |
| Do the next batch of 20 untested ones | `--platform mame --candidates --resume --apply` (without `--all`) |
| Re-test one game | `--only "ghouls" --recheck --apply` |
| Re-test games already switched ON | add `--recheck` |
| See what it would do, without changing anything | leave `--apply` off, then run again with `--resume --apply`: games already tested are switched straight away, nothing is tested twice |
| Find the year MAME stops working | `--platform mame --cutoff` (a rough guide, not every game) |
| Go faster | `--concurrency 4` (default 2; more is harder on the PC and the server) |
| Give slow games longer | `--seconds 20` (default 12) |
| Watch it work | `--headed` |

### What the flags mean

- **`--candidates`**: also test games the app is not offering yet (MAME after the year cut-off, CPS3, Cave). Without it, only games already offered are tested, so nothing new can ever be switched on.
- **`--all`**: every game, not just a random 20. Needed for a real run.
- **`--apply`**: actually change the flags: a game that runs is switched **ON**, one that shows the RetroArch menu is switched **OFF**. Without it the run is read-only and **nothing is saved to the server**: the games would be tested again next time.
- **`--resume`**: keep the results file from before. Games in it are not tested again, and `--apply` still switches them.
- A run **without `--all`** tests a random 20 per platform. With `--resume` those 20 come only from games not tested yet, and a platform with only a few left is finished.

### The habits that save time

1. **For a full run always use `--candidates --all --resume --apply` together.** Leave any of them out and you get a partial or read-only run.
2. **Run it from the same folder each time**, because the results file (`play-check/results.jsonl`) is kept there.
3. **Games already switched ON are skipped** on later runs (they passed). Add `--recheck` only if a core has changed.
4. **Switched OFF by mistake?** Open the game, the ⋯ menu, and turn browser play back on.
5. Before leaving it overnight: turn off sleep on the PC and keep the window open. If it stops, run the same command again.
6. **Afterwards:** Settings, System setup, User accounts, tick **Arcade browser play: verified games only**.
7. `report.html` in the `play-check` folder has a picture of every game that failed, and `--help` prints the full option list.

## Building a list of verified arcade games

Nothing about an arcade game says whether the browser core will run it, so the dependable way is to test them all and keep
the ones that ran.

1. Test everything, including games the app does not offer yet. Slow, so leave it running:
   ```
   node scripts/check-play.mjs --server http://YOUR-SERVER:8765 --user admin --platform mame,fba,neogeo,cps1,cps2,cps3,cave --candidates --all --resume --apply
   ```
   Games that ran are switched **on**; games that showed the RetroArch menu are switched **off**.
2. In **Settings, System setup, User accounts**, tick **Arcade browser play: verified games only**. From then on only the games
   the tool saw running are offered.

To find a sensible MAME year cut-off instead of testing every game, run `--platform mame --cutoff`. It prints a table by year and
suggests the year to set in `GAMESAUCE_MAME_PLAY_MAX_YEAR`. Treat it as a rough guide: a step that mixes years can put the answer
one step early or late, and failures are not neatly by year.

## What you get

- A live list as it runs (`ok`, `FAIL`, or `??` for something unclear).
- `play-check/report.html`: a picture of every game that did not run, with its title and platform.
- `play-check/results.jsonl`: one line per game, for your own use.

## Good to know

- It **reads only**. Saving is switched off while it plays, and test plays are not counted in Continue playing or the stats.
- Nothing is changed unless you add `--apply`. Even then it only turns browser play off for the failing games; you can turn any
  back on from the game's ⋯ menu.
- A **blank** (all black) result is reported but never switched off by `--apply`: some arcade games take a moment to start.
- It catches the RetroArch-menu failure. It cannot tell a game that runs but looks wrong from one that works, and a game waiting
  on a title screen counts as running.
- It needs a computer that can run a browser. Run it on a PC, not on the server.
