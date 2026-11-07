#!/bin/sh
# Registers the gamesauce:// link for the current user on macOS, so the "Play locally" button in game-sauce can
# start the launcher. macOS only hands custom links to an app, so this builds a tiny hidden helper app in
# ~/Applications that forwards each link to the launcher. Undo with: sh uninstall-macos.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js 18 or newer is needed and was not found. Install it first, then run this again." >&2
  exit 1
fi
# The paths go inside an AppleScript string, so refuse the two characters that would break it.
case "$NODE$HERE" in
  *\"*|*\\*) echo "The path to node or to this folder contains a quote or backslash; move the folder and try again." >&2; exit 1 ;;
esac

APP="$HOME/Applications/game-sauce launcher.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
mkdir -p "$HOME/Applications"
rm -rf "$APP"

WORK="$(mktemp -d)"
SRC="$WORK/launcher.applescript"
cat > "$SRC" <<APPLESCRIPT
on open location theURL
	-- Run in the background (the launcher waits for the emulator, which can take hours) and return at once.
	do shell script (quoted form of "$NODE") & " " & (quoted form of "$HERE/gamesauce-launcher.mjs") & " " & (quoted form of theURL) & " >/dev/null 2>&1 &"
end open location
APPLESCRIPT
osacompile -o "$APP" "$SRC"
rm -rf "$WORK"

PLIST="$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
"$PB" -c "Set :CFBundleIdentifier dev.gamesauce.launcher" "$PLIST" 2>/dev/null || "$PB" -c "Add :CFBundleIdentifier string dev.gamesauce.launcher" "$PLIST"
"$PB" -c "Add :LSUIElement bool true" "$PLIST" 2>/dev/null || true   # no Dock icon
"$PB" -c "Add :CFBundleURLTypes array" \
      -c "Add :CFBundleURLTypes:0 dict" \
      -c "Add :CFBundleURLTypes:0:CFBundleURLName string game-sauce launcher" \
      -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
      -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string gamesauce" "$PLIST"

# Editing the plist invalidated the signature osacompile made; sign it again (ad hoc, for this Mac only).
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
"$LSREGISTER" -f "$APP"

echo "Done. gamesauce:// links now start $HERE/gamesauce-launcher.mjs"
echo "Next: set up ~/.gamesauce/launcher.json (the first Play locally click creates a template). See docs/LOCAL-LAUNCH.md."
echo "The first time, macOS or your browser may ask whether to open \"game-sauce launcher\": allow it."
