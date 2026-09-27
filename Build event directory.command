#!/bin/bash
# Double-click to build the event venue & vendor directory from open map data
# (Overture Maps + OpenStreetMap) plus what Brahmini's Google Maps collectors already found.
# India by default; type another country code (AE, GB, US…) when asked. First run 30–90 minutes;
# running it again within a week reuses the downloads and only rebuilds (a few minutes).
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/india-scraper-next" || exit 1
read -r -t 20 -p "Country code [IN] (starts with IN in 20 s): " CC; echo; CC="$(echo "${CC:-IN}" | tr '[:lower:]' '[:upper:]')"
free=$(df -g "$HOME" | awk 'NR==2{print $4}')
if [ "${free:-0}" -lt 5 ]; then echo "Only ${free} GB free. The build needs about 5 GB of working space; free some and try again."; exit 1; fi
VENV="$HOME/.brahmini-event-directory"
if [ ! -x "$VENV/bin/python" ]; then echo "Setting up a small Python environment (DuckDB)…"; python3 -m venv "$VENV" || exit 1; fi
"$VENV/bin/pip" install -q --upgrade pip duckdb || exit 1
LOG="$HOME/Brahmini-event-directory-$CC.log"
echo "Log: $LOG"
"$VENV/bin/python" scripts/event-directory/event_directory.py all --country "$CC" 2>&1 | tee "$LOG"
if [ -f "data/event-directory/summary-$CC.md" ]; then
  echo; cat "data/event-directory/summary-$CC.md" | head -40
  echo; echo "== Done. Files are in india-scraper-next/data/event-directory (directory.db, event-directory-$CC.csv, summary-$CC.md)."
  open "data/event-directory"
fi
echo "You can close this window."
