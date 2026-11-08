#!/bin/sh
# Removes the gamesauce:// link registration made by install-linux.sh. Your launcher.json is left alone.
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
rm -f "$APPS/gamesauce-launcher.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" || true
echo "The gamesauce:// link is no longer registered."
