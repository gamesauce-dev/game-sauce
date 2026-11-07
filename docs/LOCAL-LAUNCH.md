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

1. Copy the `launcher` folder from this repository to the PC (or use the whole repository).
2. Register the `gamesauce://` link:
   - **Windows:** double-click `launcher\install-windows.bat`. No administrator rights are needed.
   - **Linux:** `sh launcher/install-linux.sh`
   - **macOS:** `sh launcher/install-macos.sh` (builds a small hidden helper app in `~/Applications`, because macOS only passes custom links to apps).
3. Click **Play locally** on any game. The first time there is no config, so the launcher creates a template at
   `~/.gamesauce/launcher.json` (Windows: `C:\Users\<you>\.gamesauce\launcher.json`) and tells you.
4. Edit that file (see below), then click **Play locally** again. Your browser asks once whether to open the
   launcher; tick "always allow".

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
- **Saves.** Keep each emulator's save and save-state folders in their usual place (they are not in the temporary
  folder, so nothing is lost). The launcher does not sync saves back to the server; the browser player does, this does not.
- **Zipped ROMs** are passed to the emulator as they are. Use an emulator that opens zips, or store those games unzipped.
- **Windows `.bat`/`.cmd` files** cannot be used as `command`; use the `.exe`.
- **macOS apps** are folders ending in `.app`; point `command` at the program inside, for example
  `/Applications/mGBA.app/Contents/MacOS/mGBA`.

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

## For developers

- Server: `POST /api/roms/:id/launch` (signed in, download rule) returns `{ token, expires_in, platform, title, ext }`;
  `GET /api/launch/:token` (token is the credential, no session) streams the file once. Code: `src/lib/launch.js`.
- Launcher: `launcher/gamesauce-launcher.mjs`, no dependencies. Tests: `tests/launch.test.js` run the real launcher
  against a real server with a stand-in emulator.
