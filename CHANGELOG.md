# Changelog

All notable changes to game-sauce. Newest first. Dates are `YYYY-MM-DD`.

## [Unreleased]

### Security
- **Upload library upgraded:** multer 1.x to 2.5 (the 1.x line has known vulnerabilities and is no longer patched). It handles ROM, cover, DAT and backup uploads; behaviour is unchanged and all tests pass. `npm audit` now reports no problems in the shipped dependencies.
- **Cross-site request check:** requests that change data are refused when the browser says they came from another website or address (CSRF). Scripts and `curl` are unaffected. Behind a reverse proxy set `GAMESAUCE_TRUST_PROXY=1`, or list the address in `GAMESAUCE_ALLOWED_ORIGINS`.
- **Rate limiting:** each signed-in user is capped at 900 requests a minute, with tighter caps for metadata lookups, downloads, uploads and backup/restore (`GAMESAUCE_RATE_LIMIT`, 0 = off). Cover art and the health check are never counted. Returns `429` with `Retry-After`.
- Login has a **Keep me signed in on this computer** box. Unticked, the session cookie disappears when the browser closes and the session also ends after 12 hours.
- **Idle timeout**: browser-only sessions sign out after 2 hours without activity (`GAMESAUCE_IDLE_MINUTES`); it can be enabled for persistent sessions too (`GAMESAUCE_IDLE_MINUTES_PERSISTENT`). Existing sessions stay persistent.

### Added
- **Duplicate finder** (Settings → Duplicate finder, admin): groups the different versions of one game on a platform (USA, Europe, Japan, revisions; arcade clones are grouped under their parent using the MAME name list), suggests one copy to keep (DAT-verified first, a favourite is protected, then region and revision), and offers **Hide the others**. Reversible: nothing is deleted and no file is touched. Platform filter and paging included.
- **Downloads per person:** each member can be set to Default, Always allowed or Never (Settings → User accounts). It beats the server-wide switch, takes effect immediately, and is audited. Admins can always download.
- **Proxmox installer** now explains the Console tab's `login:` prompt (the container has no root password on purpose; use `pct enter <id>`).
- **Health page** (Settings → Health, admin): database integrity, disk space, source folders reachable, last scan, backups (none, stale, failed), providers, encryption key location, and a **Copy report** button with no secrets, tokens or folder paths.
- **ARM64 Docker image:** the published image is now multi-architecture (amd64 and arm64: Raspberry Pi 4/5, ARM servers).
- **CONTRIBUTING.md** with what the project will and won't accept, how to run it and test it.
- **New README screenshots** drawn from an invented demo library with original cover art (no real box art), including the Health page.
- **Let members download ROM files** switch (Settings → User accounts). Off by default: members can browse and play in the browser, and the Download button is hidden for them; admins always can. Refused downloads are not counted, and changes are audited.
- **Reset password** for admins on every other user (Settings → User accounts): sets a new password, signs that user out everywhere and clears any sign-in lockout. A built-in Generate and Copy makes a strong one. The password is never written to the activity log.
- **More tiles in the home boxes:** the *Continue playing* and *Recently added* boxes now show as many games as fit on their one line (up to 12 and 16) instead of a fixed 6 and 9.
- **Proxmox LXC installer is now documented up front:** README has a "Option P" deployment section with the one-line command, the settings table and day-to-day commands; the "experimental" label is gone now that it has been run on real hardware.
- **Controller layout:** Nintendo-style pads (Switch Pro, many 8BitDo) now have A on the right button and B at the bottom, picked automatically from the controller's name. **Settings → Controller** lets you force Xbox or Nintendo layout.
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

### Changed
- **Calmer Library home:** *Continue playing* and *Recently added* each sit in their own neon rounded box on a single line (no scroll bar), with a white divider before the main grid. Short windows start with the boxes collapsed.

### Fixed
- **Duplicate finder no longer pairs different volumes, discs or numbered sequels.** Two games whose file names differ by a number (Volume 2 / Volume 3, Disc 1 / Disc 2, Part 1 / Part 2, Game 3 / Game 4) or a roman numeral (II / III) are kept apart even when a metadata provider gave them the same title. Regional and revision copies of the same volume are still found.
- **Removing a source did nothing:** the Remove popup's buttons never closed it or acted. It now shows its own buttons, and Cancel, Escape and clicking outside all close it.
- **Disable on a source** now works, and toggles back to Enable (it always sent "disable" before, so a disabled source could not be re-enabled from the button).
- A real cover no longer lets the initials placeholder show through it.
- The controller focus ring on the first row of the Library grid is no longer cut off at the top.
- The animated sign-in background now shows after signing out too, not only after a page refresh.
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
