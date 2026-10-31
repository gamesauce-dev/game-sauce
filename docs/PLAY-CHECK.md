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
| `--all` | every playable game: slow, about 12 seconds each, a couple at a time |
| `--seconds 15` | how long each game runs before it is judged (default 12) |
| `--concurrency 3` | games checked at once (default 2) |
| `--resume` | carry on a stopped run, skipping games already done |
| `--candidates` | also test games the app does not offer yet (MAME after the year cut-off, CPS3, Cave) |
| `--cutoff` | find the year where games stop working: a few games per year, oldest first, stops after two bad years in a row |
| `--per-year 8` | games tried per year with `--cutoff` |
| `--recheck` | also test games already switched on (they are skipped by default: they passed before) |
| `--apply` | switch browser play **off** for games that showed the RetroArch menu, and **on** (with `--candidates`) for games that ran |
| `--out DIR` | where the results go (default `./play-check`) |

## Building a list of verified arcade games

Nothing about an arcade game says whether the browser core will run it, so the dependable way is to test them all and keep
the ones that ran.

1. Test everything, including games the app does not offer yet. Slow, so leave it running:
   ```
   node scripts/check-play.mjs --server http://YOUR-SERVER:8765 --user admin --platform mame,fba,neogeo,cps1,cps2,cps3,cave --candidates --all --apply
   ```
   Games that ran are switched **on**; games that showed the RetroArch menu are switched **off**.
2. In **Settings, System setup, User accounts**, tick **Arcade browser play: verified games only**. From then on only the games
   the tool saw running are offered.

To find a sensible MAME year cut-off instead of testing every game, run `--platform mame --cutoff`. It stops once two years in a
row mostly fail and tells you the year to set in `GAMESAUCE_MAME_PLAY_MAX_YEAR`.

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
