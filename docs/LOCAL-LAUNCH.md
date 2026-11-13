# Play locally: open a game in an emulator installed on your PC

The **Play locally** button (the small monitor icon in a game's details window) sends that game to an emulator you
have installed on the computer you are browsing from. The ROM stays on your server; a temporary copy is downloaded,
the emulator opens it, and **the copy is deleted when you close the emulator**.

It needs a small program, the **launcher**, on the PC you play on. The server runs somewhere else (a container, a NAS),
so it cannot start programs on your PC itself; the launcher is the part that can.

```
 browser ──click──▶ game-sauce server        "here is a one-time token for this game"
    │
    └── opens  gamesauce://launch?...  ──▶  OS starts the launcher on your PC
                                               │ 1. downloads the ROM with the token (temp folder)
                                               │ 2. runs YOUR emulator with the ROM path
                                               │ 3. waits for it to close, deletes the copy
```

## Set it up (once per PC)

You need **Node.js 18 or newer** on that PC (the game-sauce server already needs it, so a PC that runs the server
from `start.bat` has it).

1. Get the `launcher` folder onto the PC: in game-sauce press **Settings, My account, Play on this PC, Download the launcher** (a zip with a READ ME FIRST), or copy the `launcher` folder from this repository (or use the whole repository).
2. Register the `gamesauce://` link:
   - **Windows:** double-click `launcher\install-windows.bat`. No administrator rights are needed.
   - **Linux:** `sh launcher/install-linux.sh`
   - **macOS:** `sh launcher/install-macos.sh` (builds a small hidden helper app in `~/Applications`, because macOS only passes custom links to apps).
3. Click **Play locally** on any game. The first time there is no config, so the launcher creates a template at
   `~/.gamesauce/launcher.json` (Windows: `C:\Users\<you>\.gamesauce\launcher.json`) and tells you.
4. Edit that file (see below), then click **Play locally** again. Your browser asks once whether to open the
   launcher; tick "always allow".

## The desktop app already has it

If you use the game-sauce desktop app (Windows or Linux), the launcher is built in and the `gamesauce://` link is registered for you the first time the app runs, so you can skip "Set it up" above. Right-click the tray icon and choose **Set up emulators…** to open the setup page below. (An existing launcher that you registered yourself keeps being used. On a Mac, run `sh launcher/install-macos.sh` once; the entry is in the game-sauce menu.)

## The easy way: the setup page

Instead of writing the file by hand, press **⚙ Set up emulators** in the cover carousel (Library bar → Carousel). The launcher
opens a small page **on your own PC** (it only listens on that computer, behind a secret key, and closes itself): add your
game-sauce address, choose a platform, press **Browse…** to pick the emulator's program, and press **Save**. It shows
"found" or "not found" beside each program, keeps the old file as `launcher.json.bak`, and **Save and tell game-sauce** lets
the server know which platforms this PC can start. From a terminal you can open the same page with
`node gamesauce-launcher.mjs --configure`.

## Check my PC (and what the carousel shows)

The carousel only shows games you can start from where you sit: games that play in the browser, plus every game of a
platform that has an emulator set up here. The server cannot read `launcher.json`, so the launcher reports it: press
**Check my PC** in the carousel (or save from the setup page with "Save and tell game-sauce"). Only the platform names go to the
server, never a path or a command, and a program that is not at the path in the file is left out. Until a PC has reported,
the carousel shows every game (nothing is known yet). What is wrong inside an emulator's own settings cannot be checked from
here: that stays with you. The list is kept per account, so if you play from several PCs it is the list of the last PC that reported.

## The config file

```json
{
  "servers": ["http://192.168.1.50:3000"],
  "emulators": {
    "snes": { "command": "C:\\Emulators\\Snes9x\\snes9x-x64.exe", "args": ["{rom}"] },
    "gba":  { "command": "C:\\Emulators\\mGBA\\mGBA.exe" },
    "nes":  { "command": "C:\\Emulators\\RetroArch\\retroarch.exe",
              "args": ["-L", "C:\\Emulators\\RetroArch\\cores\\fceumm_libretro.dll", "{rom}"] }
  }
}
```

- **`servers`**: the game-sauce addresses the launcher may download from, exactly as you type them in the browser
  (`http://host:port`). A link pointing anywhere else is refused. This is a safety check, so the launcher does not add
  addresses by itself.
- **`emulators`**: one entry per platform, keyed by the platform's slug (`nes`, `snes`, `gb`, `gbc`, `gba`,
  `genesis`, `ps1`, `ps2`, `n64`, `gamecube`…; the slugs are shown under Settings > Platforms).
  - `command`: full path to the emulator program.
  - `args`: its arguments. `{rom}` becomes the path of the downloaded ROM and `{romdir}` its folder. If you leave
    `{rom}` out, the ROM path is added at the end. Leave `args` out entirely for "just the ROM".
  - `deleteOnExit`: `true` by default. Set `false` to keep the copy (see the next section).

Config tips (it is a JSON file, so it is strict):
- Every address and path goes inside **one pair** of double quotes, and each item in a list is separated by a comma.
- In Windows paths write each backslash twice (`"C:\\Emulators\\mGBA\\mGBA.exe"`) or use forward slashes (`"C:/Emulators/mGBA/mGBA.exe"`). Do not put quotes inside the quotes, even if the path has spaces.
- Each argument is its own string: `["--fullscreen", "--pause-menu-exit"]`, not `["--fullscreen --pause-menu-exit"]`.

The emulator is only ever started from this file, as a program plus a list of arguments, never through a shell and
never from anything in the link. The server and the web page never learn where your emulators are.

## What happens to the ROM

The copy lives in a fresh folder under your system's temporary directory, named `gamesauce-launch-…`, and is deleted
as soon as the emulator process ends, including when the emulator fails to start. If the launcher itself is killed
(a crash, a power cut), the next launch removes any of its folders older than a day.

Things to know:

- **Emulators that hand over and exit straight away** (some launcher scripts, a Flatpak or a Store app) look to the
  launcher as if the game ended at once, so the copy would be deleted while you are still playing. Point `command` at
  the real emulator program instead, or set `"deleteOnExit": false` for that platform and clear the temporary
  folder yourself.
- **Saves.** Where saves go is decided by the emulator, not the launcher. Most keep them in their own folders, which
  is safe. Some write them **next to the ROM**, and here the ROM is the temporary copy. So that nothing is lost, anything
  the emulator wrote into the temporary folder besides the ROM (battery saves such as `.srm`, save states) is **copied to
  `~/.gamesauce/rescued/<game>-<time>/`** before the folder is deleted, and the launcher log says so. Better still, set the
  emulator to use a fixed save folder (look for "save directory", "save files", "next to the ROM"). To test an emulator: start a
  game, save, and look in your temporary folder (`%TEMP%` on Windows) for a `gamesauce-launch-...` folder; a `.srm`,
  `.sav` or `.state` file in it means that emulator saves next to the ROM. The launcher does not sync saves back to the
  server; the browser player does, this does not.
- **One file per game.** The launcher downloads the one file the library has for the game, so games made of several
  files (a `.bin` plus a `.cue`, a folder) will not open properly. Use single-file formats for discs (`.chd`, `.iso`).
- **Zipped games (.zip, .7z, .rar).** For **Xbox 360 and PS3** (Xenia and RPCS3 cannot open an archive) the launcher unpacks the game in its temporary folder first, deletes the archive to save room, and gives the emulator the file that starts the game: an `.iso` if there is one, otherwise `default.xex` (Xbox 360) or the game folder's `EBOOT.BIN` (PS3). Everything is deleted when the emulator closes, as always. For any other platform the archive is passed as it is (most emulators open a zip themselves); to unpack for one, choose **zip: unpack** on its line in the setup page, or write `"unpack": true` in `launcher.json`. **zip: as is** (`"unpack": false`) turns it off for Xbox 360 and PS3.
  - **What does the unpacking.** 7-Zip when it is installed (it opens `.7z`, `.zip` and `.rar`; get it from 7-zip.org). Otherwise the system's `tar` (Windows 10 and later, macOS) or `unzip` (Linux, `.zip` only). If none can, the launcher says so. If 7-Zip is somewhere unusual, set `"sevenZip": "D:/Tools/7z.exe"` at the top level of `launcher.json`.
  - **Room and time.** The temporary folder has to hold the whole unpacked game (tens of GB for a PS3 or Xbox 360 title), and a big game takes a while to unpack every time. Point `GAMESAUCE_LAUNCHER_TMP` at a fast drive with room if the system drive is small.
  - **Quick launch (keep the game for next time).** Unpacking a big game on every launch is slow, so a platform can keep its games on this PC: tick **quick launch** on its line in the setup page (or `"quickLaunch": true`). The game is downloaded (and unpacked) into a cache folder instead of a temporary one and is kept when the emulator closes; the next launch of the same game starts the emulator at once, with no download. If the game changes on the server (its size or date), the kept copy is replaced. Each platform can have its own cache folder (a big drive for PS3, say; empty means the shared one); the shared folder defaults to `~/.gamesauce/cache`, and `"cacheDir"` in `launcher.json` sets either. Each folder is limited (**Limit per folder**, `"cacheLimitGb"`, default 100, 0 for no limit): when it is full the games played longest ago are removed first, never the one you just played or one that is open. The setup page lists what is kept, with **Empty cache** and a **Remove** for each game. Saves an emulator wrote next to a kept game stay with it, and are copied to `~/.gamesauce/rescued` before the game is removed. The launcher only ever deletes games folders it made itself (they carry a tag file inside a `gamesauce-cache` folder), so a wrong path cannot delete anything else. The game's size and date are sent with the Play link, so use a game-sauce server of this version or newer.
  - **Xbox Live Arcade packages** (the extensionless hex-named files under a `000D0000` folder; see the Library's `.xbla` games) are single files and are handed to the emulator with no extension. Games on Demand (`00007000`) are a package plus a `.data` folder and cannot be played this way unless you put the whole folder in an archive.
  - **A game that does not start from the usual file.** Add `"launchFile": "**/default.xex"` (a pattern, or a list of them) to that platform in `launcher.json`; it wins over the rules above.
- **Windows `.bat`/`.cmd` files** cannot be used as `command`; use the `.exe`.
- **macOS apps** are folders ending in `.app`; point `command` at the program inside, for example
  `/Applications/mGBA.app/Contents/MacOS/mGBA`.

## Example configs

Use these as a starting point. The paths are examples: use your own, with `/` or doubled `\\` backslashes. The platform names
are the short names under Settings > Platforms. Emulators change their command-line options between versions, so if one does
not behave, run it with `--help` or check its documentation. Each argument is its own string.

Windows:

```json
{
  "servers": ["http://192.168.1.50:8765"],
  "emulators": {
    "nes":      { "command": "C:/Emulators/RetroArch/retroarch.exe",
                  "args": ["-f", "-L", "C:/Emulators/RetroArch/cores/fceumm_libretro.dll", "{rom}"] },
    "snes":     { "command": "C:/Emulators/Snes9x/snes9x-x64.exe", "args": ["{rom}"] },
    "gba":      { "command": "C:/Emulators/mGBA/mGBA.exe", "args": ["-f", "{rom}"] },
    "nds":      { "command": "C:/Emulators/melonDS/melonDS.exe", "args": ["{rom}"] },
    "gamecube": { "command": "C:/Emulators/Dolphin/Dolphin.exe", "args": ["-b", "-e", "{rom}"] },
    "wii":      { "command": "C:/Emulators/Dolphin/Dolphin.exe", "args": ["-b", "-e", "{rom}"] },
    "wiiu":     { "command": "C:/Emulators/Cemu/Cemu.exe", "args": ["-f", "-g", "{rom}"] },
    "ps1":      { "command": "C:/Emulators/DuckStation/duckstation-qt-x64-ReleaseLTCG.exe",
                  "args": ["-batch", "-fullscreen", "--", "{rom}"] },
    "ps2":      { "command": "C:/Emulators/PCSX2/pcsx2-qt.exe", "args": ["-batch", "-fullscreen", "--", "{rom}"] },
    "psp":      { "command": "C:/Emulators/PPSSPP/PPSSPPWindows64.exe",
                  "args": ["--fullscreen", "--pause-menu-exit", "{rom}"] }
  }
}
```

- **RetroArch** runs many systems, but each needs the right *core* (`-L` and the path to that core's file in RetroArch's
  `cores` folder): `fceumm` for NES, `snes9x` for SNES, `genesis_plus_gx` for Mega Drive, and so on. Add one entry per
  platform, changing only the core. Install the cores from inside RetroArch first.
- **Dolphin** `-b` hides the main window and runs just the game; `-e` names the game to open.
- **DuckStation and PCSX2** need their BIOS files set up once in their own settings. The `--` marks the end of the options.
- **If you already use LaunchBox**, point `command` at the same emulators it uses; nothing about them changes.

Linux (examples):

```json
"snes": { "command": "/usr/bin/snes9x-gtk", "args": ["{rom}"] },
"gba":  { "command": "/usr/bin/mgba-qt", "args": ["-f", "{rom}"] },
"nes":  { "command": "/usr/bin/retroarch", "args": ["-L", "/usr/lib/libretro/fceumm_libretro.so", "{rom}"] }
```

macOS (point `command` at the program inside the `.app`):

```json
"gba": { "command": "/Applications/mGBA.app/Contents/MacOS/mGBA", "args": ["{rom}"] }
```

Flatpak and Snap emulators run in a sandbox that usually cannot see your system temporary folder, so they may not find the ROM.
Either use a normal install of that emulator, or set the environment variable `GAMESAUCE_LAUNCHER_TMP` to a folder
the sandbox can reach.

## Who can use it

Playing locally gives the PC the whole ROM file, so it follows the **download** rule exactly: admins, and members whose
download setting allows it. Play-only accounts do not get it. The server hands out a token only to someone signed in
who may download; a token is for one game, works once, and expires after two minutes.

Each launch is recorded in the download log as its own kind (`launch`), so it does not count towards "most downloaded".

## When nothing happens

- The launcher writes what it did to `~/.gamesauce/launcher.log` and shows a message box (Windows) or notification
  (macOS, or Linux with `notify-send`) when something is wrong.
- **Nothing opens at all**: the `gamesauce://` link is not registered on this PC, or the browser blocked the prompt.
  Run the install script again, and check the browser's site settings for "open links with apps".
- **"not listed under servers"**: add the server's address to `servers`, written exactly as in the address bar.
- **"No emulator is set"**: add an entry for that platform's slug.
- **Behind a reverse proxy or a different hostname**: the address in `servers` must be the one in your browser's address
  bar, because that is what the web page passes on.

To remove it: `launcher\uninstall-windows.bat`, `sh launcher/uninstall-linux.sh` or `sh launcher/uninstall-macos.sh`. Your config file is left alone.

## Skip the browser's "Open game-sauce launcher?" question

Your browser asks this itself, so game-sauce cannot restyle it or switch it off. Chrome and Edge show an
"Always allow" tick box only on **secure** sites (HTTPS, or `localhost`). A server reached over plain `http://` on your
network never gets the tick box, so the question comes back every time. Three ways round it:

1. **Serve game-sauce over HTTPS.** Then the tick box appears, once per browser. With Tailscale this is
   `tailscale serve`, but then the PC must be running Tailscale to reach that address, even at home.
2. **Pre-approve the address on this PC (Windows, Chrome and Edge).** Right-click `launcher\allow-in-browser-windows.bat`,
   choose **Run as administrator**, and type your game-sauce address exactly as in the browser's address bar (for example
   `http://192.168.1.50:8765`). It sets the browsers' `AutoLaunchProtocolsFromOrigins` policy for the `gamesauce` link
   from that one address only, and keeps any entries already there. Restart the browser and check `chrome://policy` or
   `edge://policy`. Notes: it needs administrator rights, applies to every user of the PC, and makes the browser show
   "managed by your organization". Undo with `allow-in-browser-windows.bat remove` (same address). Run it again for a second
   address.
3. **Firefox** has its own policy of the same name (a `policies.json` file; see Mozilla's enterprise documentation).
   Firefox needs the full origin (`http://host:port`) and has no wildcard.

## For developers

- Server: `POST /api/roms/:id/launch` (signed in, download rule) returns `{ token, expires_in, platform, title, ext }`;
  `GET /api/launch/:token` (token is the credential, no session) streams the file once. Code: `src/lib/launch.js`.
- Launcher: `launcher/gamesauce-launcher.mjs`, no dependencies. Tests: `tests/launch.test.js` run the real launcher
  against a real server with a stand-in emulator.
