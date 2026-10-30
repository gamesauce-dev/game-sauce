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
- **System entries:** BIOS, device and computer/console entries can be marked **System**. They stay in game-sauce and stay downloadable, but leave the main Library and are skipped by Fetch metadata. A new **⚙ System** filter lists them, and there Select all, Hide, Unhide, Collection and **Back to library** all work. Admins can also mark any selection **Mark as System** in Select mode. The Game names (CSV) tool marks them from `is_bios`, `is_device`, and an `is_arcade` column (a filled value that is not *yes* means not arcade; for MAME, add `yes` when the machine's `<input>` has `coins`). A machine with `is_arcade` = yes is always kept as a game, even if it is also flagged BIOS or device (the CPS3 sets share a BIOS yet are playable). The old *hide* option is still there as a second tick box.
- **Favourites warning before deleting:** if anyone has the game as a favourite, deleting it (one game or a bulk delete) asks first and names who ("This is a favourite of anna, ben"), with *Delete anyway*.
- **Duplicate finder: ties and legend.** When nothing separates the copies it says "No clear winner: check both" instead of suggesting one, and a one-line legend explains the green outline, the padlock and the tie mark.
- **Library tiles:** the favourite and hide icons are the same, larger size (and always visible on touch screens), drawn clearly instead of text symbols.
- **Lock** (admin): a padlock in the game detail's **More** menu and on every copy in the Duplicate finder. A locked game is protected from every kind of deletion and preferred in the duplicate finder until you unlock it. Locked games wear a green padlock badge on their tile, and their Delete button looks disabled with the reason in its tip.
- **Game names (CSV) can hide BIOS and device entries:** if the CSV has `is_bios` and/or `is_device` columns (`yes` marks a row), a tick box (on by default) hides those games when you apply the names. Preview shows how many there are. Hidden games are skipped by Fetch metadata, so BIOS and device files stop showing up as failed matches; they can be brought back from the Hidden filter.
- **Lock switch in the Duplicate finder:** every copy has a padlock (it was a star). Starring a copy makes it the one to keep and overrides the automatic suggestion (star several to keep several); the choice is saved and respected on every re-run, and **Hide the others** never hides a copy you starred. A starred copy is also **protected from deletion** (single delete, bulk delete, *Remove source + ROMs* and the orphan purge) until you switch the star off.
- **Hide in Select mode:** with games selected (one, several, or *Select all*), a **Hide** button sits beside Collection and Delete, in the top bar and in the selection bar. Nothing is deleted. When you are looking at the *Hidden* filter it reads **Unhide** and brings the selection back.
- **Game names (CSV)** (Settings, admin): pair each ROM file name with a proper game name from your own CSV (columns are selectable; defaults `rom_name` and `short_game_name`), pick a platform, **Preview** the renames, then **Apply**. Built for romsets such as FinalBurn Neo or MAME whose file names (`sf2ue.zip`) no cover database understands; afterwards **Fetch metadata** can find their covers. Works for any platform; files on disk are never touched.
- **Animated logo:** the "-sauce" gradient flows in a seamless loop (no jump), a bright band rolls fully across the name every few seconds, and the text glow pulses in vivid colour. The logo itself breathes gently (a slow swell of glow and size) instead of flashing. Switched off automatically for people who ask their system for reduced motion.
- **Profile pictures:** everyone can upload their own picture (Settings → Profile picture). It is cropped square and shrunk to 256 px in the browser, checked by content on the server (JPEG, PNG or WebP, max 1 MB; no SVG), shown next to your name in the menu and in the user list, and stored in the database so backups carry it. Only you can change yours; every signed-in person can see the household's pictures.
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
- **Duplicate finder shows where each copy lives:** the source name and full file path appear under each copy, so two entries with the same file name (for example one in a `fbneo` folder and one in a `mame` folder) can be told apart at a glance.
- **Hiding a game is now personal.** Hide (a tile, the detail window, Select mode, the duplicate finder's *Hide the others*) only changes what *you* see; other people still see the game, and the Hidden filter lists only your own hidden games. Hides made before this update were handed to the first admin, so nothing changes for them and nothing leaks to others. **System** is now the system-wide way to tuck things away: only an admin can mark or unmark a game as System, and System games are hidden from everyone's library (and skipped by Fetch metadata) but stay downloadable. The Game names (CSV) tool therefore marks BIOS/device/non-arcade entries as System (its separate *hide* option is gone). Also fixed: the *hidden* veil on a tile no longer blocks the unhide button.
- **Previous / count / next** controls moved under the cover art in the game detail, as wide as the art and a little smaller.
- **Fetch metadata keeps running when you refresh or close the page.** It is now a job on the server (Stop button included) instead of being driven by the browser. A progress box at the bottom right shows how far it has got, on every page, and reappears after a refresh. One run at a time; admin only.
- **LIBRARY in the menu always shows the whole library:** clicking it clears any platform you had selected and scrolls the grid back to the top.
- **Sidebar platform groups line up:** group headers (ARCADE, ATARI…) now start at the same left edge as the platforms under them, with the arrow sitting above the colour dots.
- **Settings header stays put:** the title and the tile menu are pinned to the top while the open module scrolls underneath, so you can always jump to another section. The tiles are more compact to leave room.
- **Sidebar menu redesigned:** UPPERCASE bold white labels, new drawn icons (library, collections, sources, add ROMs, emulators), an accent bar on the current page, and a smaller gap under the user box.
- **Calmer Library home:** *Continue playing* and *Recently added* each sit in their own neon rounded box on a single line (no scroll bar), with a white divider before the main grid. Short windows start with the boxes collapsed.
- **Game detail window:** the previous / next / count controls are squared green tiles centred above the cover, the cover is smaller, and the action buttons are now icon-only with a hover tip (download, play, favourite, collection, browser-play switch, hide, refresh metadata, upload cover, delete).

### Fixed
- **Favourites are now truly per person.** One user starring a game used to star it for everyone, because the star was also written to a shared flag that the tiles read. Tiles, the Favourites filter, the home-page count and the detail window now read only your own favourites, and starring or un-starring changes only yours. (Stars set before this fix are still in each person's own list; the old shared flag is simply no longer read.)
- **Phone layout:** on small screens (phones, foldables like the Surface Duo) there was no way to open the menu. A top bar with a menu button now slides the sidebar in (it closes when you choose a page or platform, tap outside, or press Escape), and the game detail window fills the screen with larger touch-sized buttons.
- **Duplicate finder star can now be switched off on any copy**, including the suggested one: the star shows only your own choice (on = you pinned it, off = automatic), so clicking it toggles cleanly. The suggestion keeps its green outline.
- **Game detail window actions redesigned for touch:** Download, Play and Favourite stay as large buttons; everything else (Keep, collection, browser-play switch, hide, refresh, upload cover) is in a **More** menu with text labels and short explanations, and Delete stands apart. One row at any width, no hover needed (works on an iPad).
- **The Library keeps your place:** hiding a game, refreshing its metadata, favouriting it or changing it in the detail window no longer throws the grid back to the top. It reloads the tiles you had loaded and returns to the same scroll position. Changing a filter or pressing LIBRARY still starts from the top.
- **MAME: Fetch metadata after a CSV names import now works, and tries IGDB first.** Names applied from the Game names (CSV) tool are now recorded as trusted MAME names (previously title-based providers skipped MAME games unless a `-listxml` list was imported). For arcade romsets the order is ScreenScraper, then IGDB, then TheGamesDB, so an exhausted TheGamesDB quota no longer holds the lookup up.
- **Settings → Platforms:** the **Add platform** button stays in view under the pinned header while you scroll the list.
- **A newly picked cover shows straight away:** after choosing a match in *Identify this game*, the old cover could stay on screen (the browser kept its cached copy for a day). Cover links now change whenever the image does.
- **Disc and bracket tags are left out of metadata searches:** `[Disc 1]`, `(Disc 2 of 3)`, `- Disc 1`, `[CD2]` and stray `[!]`-style tags are removed before a provider is asked, so every disc of a game finds the same entry.
- **Fetch metadata with a platform selected only covers that platform** (the progress box names it). With no platform selected it runs over the whole library as before.
- **Sources on your own platforms now scan into them:** a folder added to a platform you created used to be scanned into "Other" (so the platform stayed empty and missing from the sidebar), and files with a custom extension were skipped. Existing ROMs filed under Other can be re-filed, or remove the source with its ROMs and add it again.
- **Add a folder no longer jumps** when you open the folder browser: the page keeps room for its scroll bar, and the Browse button keeps its label (it highlights while open and toggles the browser) instead of changing to "Hide browser".
- **Custom platforms now work everywhere:** adding a source (or uploading / re-filing a ROM) with a platform you created yourself was refused with "Platform is required". The check only knew the built-in list; it now accepts any platform in the library.
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
