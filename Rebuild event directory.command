#!/bin/bash
# Double-click to rebuild the event directory from what is already downloaded (no Overture/OSM downloads):
# re-reads Brahmini's Google results, re-classifies, merges duplicates, assigns districts and writes the reports.
# Takes a few minutes. Use "Build event directory.command" to download fresh data.
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/india-scraper-next" || exit 1
VENV="$HOME/.brahmini-event-directory"
if [ ! -x "$VENV/bin/python" ]; then echo "Run \"Build event directory.command\" once first."; exit 1; fi
LOG="$HOME/Brahmini-event-directory-rebuild.log"
{ "$VENV/bin/python" scripts/event-directory/event_directory.py google && "$VENV/bin/python" scripts/event-directory/event_directory.py build && "$VENV/bin/python" scripts/event-directory/event_directory.py items >/dev/null; } 2>&1 | tee "$LOG"
echo; sed -n '1,4p' data/event-directory/summary-IN.md
echo; echo "== Done. See india-scraper-next/data/event-directory (summary-IN.md, districts-IN.csv). You can close this window."
