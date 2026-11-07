#!/bin/sh
# Registers the gamesauce:// link for the current user (desktop environments that follow the freedesktop standard),
# so the "Play locally" button in game-sauce can start the launcher. Undo with: sh uninstall-linux.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js 18 or newer is needed and was not found. Install it first, then run this again." >&2
  exit 1
fi

APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS"
cat > "$APPS/gamesauce-launcher.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=game-sauce launcher
Comment=Opens ROMs from game-sauce in your local emulator
Exec="$NODE" "$HERE/gamesauce-launcher.mjs" %u
Terminal=false
NoDisplay=true
MimeType=x-scheme-handler/gamesauce;
DESKTOP

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" || true
xdg-mime default gamesauce-launcher.desktop x-scheme-handler/gamesauce

echo "Done. gamesauce:// links now start $HERE/gamesauce-launcher.mjs"
echo "Next: set up ~/.gamesauce/launcher.json (the first Play locally click creates a template). See docs/LOCAL-LAUNCH.md."
