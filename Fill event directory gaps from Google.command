#!/bin/bash
# Double-click to search Google Maps for India's district x category gaps left by the open-data build
# (up to 300 searches per run, emptiest first), then rebuild the directory with the new listings.
# Stops on any Google access challenge and does not try to get around it. Run again to continue.
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/india-scraper-next" || exit 1
if [ ! -f data/event-directory/gaps-IN.json ]; then echo "Run \"Build event directory.command\" first."; exit 1; fi
if [ ! -d node_modules/puppeteer ] || [ ! -d node_modules/sqlite3 ]; then
  echo "Installing the collector's packages (uses your Google Chrome, no browser download)…"
  PUPPETEER_SKIP_DOWNLOAD=1 npm install --no-audit --no-fund || exit 1
fi
node --no-warnings scripts/event-directory/google-gaps.cjs --limit "${GAPS_LIMIT:-300}" 2>&1 | tee -a "$HOME/Brahmini-event-gaps.log"
VENV="$HOME/.brahmini-event-directory"
if [ -x "$VENV/bin/python" ]; then
  "$VENV/bin/python" scripts/event-directory/event_directory.py google && "$VENV/bin/python" scripts/event-directory/event_directory.py build
fi
echo; echo "You can close this window. Double-click again to continue with the next searches."
