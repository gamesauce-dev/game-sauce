#!/bin/sh
# Start game-sauce on this computer (Linux / macOS). Run:  ./start.sh
# Options are passed on:  ./start.sh --lan   ./start.sh --no-open   ./start.sh --port 9000
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "game-sauce needs Node.js (version 20 or newer), and it is not installed."
  echo "  Easiest: download the 'LTS' version from https://nodejs.org and install it."
  echo "  On Ubuntu / Debian / Mint you can also install the 'nodejs' and 'npm' packages with your package manager;"
  echo "  then check that  node -v  shows 20 or higher."
  echo "Then run ./start.sh again."
  echo
  exit 1
fi
exec node scripts/start.mjs "$@"
