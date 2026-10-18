#!/bin/bash
# Obspec Bridge — one-time setup for macOS. Double-click once: it installs the bridge as a
# background service that starts when you log in, so you never have to run anything again.
# To run it in this window instead:  node bridge/dist/cli.js run
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Obspec needs Node.js (18 or newer). Install it from https://nodejs.org and double-click again."
  read -n 1 -s -r -p "Press any key to close."; exit 1
fi
if [ ! -f bridge/dist/cli.js ]; then
  echo "First run — building the bridge…"; npm install --silent && npm run build --silent || { read -n 1 -s -r -p "Build failed. Press any key to close."; exit 1; }
fi
node bridge/dist/cli.js setup "$@"
echo
read -n 1 -s -r -p "Press any key to close this window."
