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
| `--apply` | switch browser play **off** for games that showed the RetroArch menu |
| `--out DIR` | where the results go (default `./play-check`) |

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
