# Changelog

All notable changes to game-sauce. Newest first. Dates are `YYYY-MM-DD`.

## [Unreleased]

### Added
- **Restore…** button on every backup kept on the server, so there is no need to download and re-upload it.
- **Close a running game with the controller:** hold Select + Start for a second (a progress bar shows). No other button is taken from the game.
- **Cleaner Library home:** search and the filter pills share one line; the home rows are smaller, collapsible (remembered) and side by side on wide screens; selecting a platform shows its name as a heading above the tiles.
- **Restore from backup** (Settings → Backups): upload a backup, review what is inside and any warnings, then confirm by typing RESTORE. A safety backup is taken first, the server restarts and swaps the data in, and the replaced data is kept in `data/pre-restore-<time>/`. Damaged or half-downloaded files, backups from a newer version and backups with no admin are refused.
- **Upload your own cover** for any game (JPEG, PNG or WebP, checked by content). It survives metadata refreshes and the clear-covers tool; **Auto cover** removes it.
- **Continue playing** row on the Library home: the games you last played in the browser, per user.
- **Retro-neon animated sign-in screen** (switches itself off for reduced-motion users).
- **Gamepad navigation** for the whole interface: D-pad or stick to move, A select, B back, X play, Y search, LB/RB for previous/next, with an on-screen legend.
- **Browser play** for platforms with a core: per-user save states and in-game saves, a MAME best-effort cut-off year and a per-game on/off switch.
- **Fluid scaling** from 1080p to 4K, and infinite scroll in the library.
- **MAME support:** zip-only sources, a `-listxml` name list importer, strict cover matching, **Fetch metadata** that runs through the whole library, and an admin tool to clear covers by platform.
- **README screenshots** (`docs/screenshots`) and a rewritten user guide covering all of the above.
- **Backups** (Settings → Backups, admin only): download a backup any time, or schedule them (6 h / 12 h / daily / weekly, keep the newest N, choose the folder). Each backup is a single `.tar.gz` with a consistent database copy, the encryption key, every user's saves and a manifest; imported ROMs, covers and media are left out.
- **Previous / next arrows** in the game detail panel (and the ← / → keys) to step through the games without closing it. It follows the list you opened the game from: the library grid (loading more tiles as you go), the recently added row, or a collection.

### Security
- Login has a **Keep me signed in on this computer** box. Unticked, the session cookie disappears when the browser closes and the session also ends after 12 hours.
- **Idle timeout**: browser-only sessions sign out after 2 hours without activity (`GAMESAUCE_IDLE_MINUTES`); it can be enabled for persistent sessions too (`GAMESAUCE_IDLE_MINUTES_PERSISTENT`). Existing sessions stay persistent.

### Fixed
- The installer now prints the update command with its full path (`/usr/local/bin/game-sauce-update`), which `pct exec` needs.
- Refreshing the page now keeps you where you were: the same section, platform, search, filters, sort order and open Settings tile. (A fresh sign-in still starts on the Library home.)
- Signing out and back in now always lands on the Library, instead of the last view you had open (for example Settings).

### Deployment
- Prebuilt Docker image published to `ghcr.io/gamesauce-dev/game-sauce` on every push to `main` (see `docs/DEPLOYMENT.md` 3.4a).
- Proxmox one-command installer (`install/proxmox-lxc.sh`) and a ready-made compose file for existing Docker hosts (`install/docker-compose.ghcr.yml`).
- README status badges for tests, image build and licence.

## [0.1.0] - 2026-10-28 (first public release)

### Library and sources
- Scan folders **in place**: files are catalogued where they are and never moved, renamed or deleted.
- A platform is required for every source. Re-scans skip unchanged files, show a live
  **progress bar**, and clear a stale "missing" flag when a file is found again.
- One bad file no longer aborts a scan; failures are counted and reported with the first error.
- Add ROMs imports copies into `storage/`. Duplicate content is detected by SHA1.
- Library grid loads in pages as you scroll; **Select all** covers every ROM matching the filters.
- Collections: add and remove games, and a game can belong to several collections.

### Metadata
- Providers: ScreenScraper, TheGamesDB, IGDB, SteamGridDB (art fallback). Credentials are
  system-wide and admin-only. **Fetch metadata** now works through the whole library in one click.
- Manual match with a per-user default provider (star it in the dropdown).
- **MAME**: only `.zip` files are accepted. Import a MAME `-listxml` file under DAT files to turn
  short names (`sf2`) into real titles; title searches are strict so wrong covers are not applied.
- DAT verification (SHA1/CRC32 + size) with a have/want report. The "unverified" tile badge was removed.
- Admin tool to clear cover art for any platform.

### Play in the browser (EmulatorJS)
- Play button on tiles and in the detail panel for platforms that need no BIOS; fullscreen by default.
- **Per-user save states and in-game saves**, stored on the server, with a warning when a state was
  saved by a different EmulatorJS version.
- MAME is best effort: no Play button after 1990 by default (`GAMESAUCE_MAME_PLAY_MAX_YEAR`),
  and each game has its own on/off toggle.

### Accounts and admin
- Users with admin and member roles; sessions, audit log, in-app confirmation dialogs.
- Emulator guide with latest-release checks and an emulator vault.

### Interface
- Scales with screen size (fluid text size) from 1080p to 4K.
- Account bar under the logo with larger settings and sign-out buttons.

### Deployment
- Docker Compose, default host port **8765** (`HOST_PORT` to change). Proxmox notes in `docs/DEPLOYMENT.md`.
- MIT licensed.
