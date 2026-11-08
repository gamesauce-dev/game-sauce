# Package managers

The entries here point at the files on each GitHub Release, so the release has to exist first. They are written by a script from the release's own `SHA256SUMS`:

```bash
node scripts/make-package-manifests.mjs          # the version in package.json (the release must be published)
```

It writes `install/packages/winget/<version>/`, `install/packages/scoop/game-sauce.json` and `install/packages/homebrew/Casks/game-sauce.rb`. Commit them, then send each one where it goes. **Nothing is submitted for you:** each of these is a step you take, once, on an account of yours.

| For | Manager | Installs | Where the entry goes |
|---|---|---|---|
| Windows | **winget** | the desktop app (installs for you only) | a pull request to `microsoft/winget-pkgs` |
| Windows | **Scoop** | the portable download | your own bucket repository |
| Apple Silicon Mac | **Homebrew** | the desktop app | your own tap repository |
| Unraid | **Community Applications** | the Docker image | the Unraid forum's submission thread |

## winget

First time: fork `microsoft/winget-pkgs`, copy `install/packages/winget/<version>/` to `manifests/g/gamesauce-dev/game-sauce/<version>/` in your fork, and open a pull request. Its checks run automatically and a person reviews it within days. Later releases are one command with Microsoft's helper (`winget install wingetcreate`):

```bash
wingetcreate update gamesauce-dev.game-sauce --version <version> --urls https://github.com/gamesauce-dev/game-sauce/releases/download/v<version>/game-sauce_<version>_x64-setup.exe --submit
```

People then run `winget install gamesauce-dev.game-sauce`. The installer is not signed yet, so Windows may still show its "unknown publisher" warning. You can check the files locally with `winget validate --manifest install/packages/winget/<version>`.

## Scoop

Create a repository called `scoop-game-sauce` on GitHub and put `install/packages/scoop/game-sauce.json` in its `bucket/` folder. People then run:

```bash
scoop bucket add game-sauce https://github.com/gamesauce-dev/scoop-game-sauce
scoop install game-sauce
```

The manifest has `checkver` and `autoupdate`, so Scoop's own tooling can keep the bucket current. Without a bucket it also works straight from the file (it will not update by itself that way): `scoop install https://raw.githubusercontent.com/gamesauce-dev/game-sauce/main/install/packages/scoop/game-sauce.json`.

## Homebrew

Create a repository called `homebrew-game-sauce` and put `install/packages/homebrew/Casks/game-sauce.rb` in its `Casks/` folder. People then run:

```bash
brew install --cask gamesauce-dev/game-sauce/game-sauce
```

The cask clears the "downloaded from the internet" mark after installing, because the app is not signed or notarised yet. (Homebrew's own main cask list asks for signed apps, which is why this is a tap of your own.) Removing the app with `--zap` removes only its settings, never the library in `game-sauce-data`.

## Unraid Community Applications

The template is `install/unraid/game-sauce.xml` and already works by hand (see [UNRAID.md](UNRAID.md)). To be listed in the Community Applications store, post it in the *Application submission* thread of the Unraid forum (Community Applications section), with a support thread of your own for the app; the maintainers add it after a check.

## Linux

The release carries a `.deb` (Debian, Ubuntu, Mint, Raspberry Pi OS) and portable `.tar.gz` bundles for x64 and arm64: download and install or unpack. A proper apt repository is possible later.
