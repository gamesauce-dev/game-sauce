# Try game-sauce on your own computer

No server, no Docker, no settings to edit. About five minutes, most of it waiting for a download.

game-sauce is a small program that runs on your computer and shows your game collection in your web
browser. It does not change or move your game files, and nothing leaves your computer.

## 1. Install Node.js (once)

game-sauce runs on **Node.js** (version 20 or newer). Check whether you already have it:

```
node -v
```

If that prints `v20` or higher, skip to step 2. Otherwise:

- **Easiest on any system:** download the **LTS** version from <https://nodejs.org> and install it.
- **Linux:** your package manager may have it too (look for the packages `nodejs` and `npm`), but
  distribution versions are often too old, so check that `node -v` shows 20 or higher afterwards.

## 2. Get game-sauce

On the project page (<https://github.com/gamesauce-dev/game-sauce>) press the green **Code** button,
then **Download ZIP**. Unzip it somewhere you will find it again, for example your home folder.

## 3. Start it

Open the unzipped `game-sauce` folder.

- **Linux / macOS:** open a terminal in that folder and run

  ```
  ./start.sh
  ```

  If it says "permission denied", run `chmod +x start.sh` once and try again.

- **Windows:** double-click **`start.bat`**.

The first time, it installs what it needs (about a minute), starts game-sauce, and opens your browser.
**Look for the box that shows your first username and password.** It appears only once, so copy it
(sign in as `admin`, then change the password under the gear icon, then *My account*).

> If the install stops with an error about building something, your computer is missing the usual
> build tools. On Ubuntu, Debian and Mint, install the packages `build-essential` and `python3`
> (as administrator), then run `./start.sh` again. On Fedora, install "Development Tools".

## 4. Add your games

1. In the sidebar choose **Sources**, then **Add folder**.
2. Pick the folder that holds the games for **one** console (for example your PlayStation 2 folder).
   If the folder is named after the console (`ps2`, `snes`, `fbneo`...), the platform is already chosen.
3. Check the platform, press **Add and scan**. Your games appear in the **Library**.

Repeat for each console. One folder per console keeps things tidy.

## Everyday use

- **Start it again:** run `./start.sh` (or double-click `start.bat`) the same way. Your library and
  accounts are still there.
- **Stop it:** press `Ctrl+C` in the window, or close the window.
- **Where your data is:** in a folder called `game-sauce-data` in your home folder, kept apart from the
  program on purpose. To update game-sauce, download the newer ZIP, unzip it, and start it. Your library
  is not touched. To back up, copy that `game-sauce-data` folder (or use *Settings > Maintenance > Backups*).
- **Other devices on your home network** (a phone, a tablet): start it with `./start.sh --lan` and open
  the address it prints on that device. Only do this on a network you trust.

## Options

| | |
|---|---|
| `--lan` | let other devices on your network connect (default: this computer only) |
| `--port 9000` | use a different port (default 8765; it picks the next free one if it is busy) |
| `--no-open` | don't open the browser automatically |
| `--data /some/folder` | keep your data somewhere else |

## When something goes wrong

- **"node: command not found"** means Node.js is not installed yet (step 1).
- **The page does not open:** copy the address from the box in the window into your browser.
- **Something else:** the window prints what went wrong. The most useful thing to send is that text.

For a server, a NAS, Docker or Proxmox, see the [Deployment guide](DEPLOYMENT.md) and the README.
