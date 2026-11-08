# game-sauce desktop app

game-sauce in its own window, with a proper installer. It does two jobs, and remembers which one you chose:

- **Run game-sauce on this computer.** The server is built into the app (the same program as the portable download), so there is nothing else to install. Your library and accounts are kept in `game-sauce-data` in your home folder, the same place the portable download uses, so you can move between the two without losing anything. Tick *Let phones, TVs and other computers on my home network use it too* to share it.
- **Connect to a game-sauce server.** Already running game-sauce on Docker, Unraid or another PC? Type its address (for example `http://192.168.1.20:8765`) and the window opens it.

The first time you run it on this computer, the account that was made for you is shown once in the app: copy it, then change the password under Settings. Closing the window stops the built-in server.

**The menu.** On a Mac, **game-sauce → Switch server…** and **Open my data folder** are in the menu at the top of the screen. On Windows and Linux there is no menu bar in the window: a small icon in the tray (the notification area, bottom right on Windows) has the same entries, plus **Open game-sauce** and a line saying where game-sauce is running (for example `On your network: http://192.168.1.20:8765`, the address to type on your phone or TV). Click the icon to bring the window back. On some Linux desktops (GNOME) a tray icon needs the *AppIndicator* extension.

**The address.** On this computer game-sauce uses `http://127.0.0.1:8765`, or the next free port (8766, 8767…) if something else is already using 8765.

## Install

Download the installer for your system from the project's *Releases* page: Windows (`.exe`, installs for you only, no administrator rights), Apple Silicon Mac (`.dmg`), Linux (`.deb` or `.AppImage`). Windows may warn that the app is from an unknown publisher the first time (choose *More info*, then *Run anyway*); on a Mac, right-click it and choose *Open*.

## Building it yourself

Needs Node 22+, [Rust](https://rustup.rs) and the Tauri prerequisites for your system (on Windows, the C++ build tools).

```bash
cd desktop
npm install
npm run build        # stages the server, then builds the installer in src-tauri/target/release/bundle
npm run dev          # a development window (run  npm run prepare-server  once first)
```
