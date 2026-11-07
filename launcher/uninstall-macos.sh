#!/bin/sh
# Removes the helper app made by install-macos.sh. Your launcher.json is left alone.
APP="$HOME/Applications/game-sauce launcher.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -d "$APP" ] && "$LSREGISTER" -u "$APP" 2>/dev/null
rm -rf "$APP"
echo "The gamesauce:// link is no longer registered."
