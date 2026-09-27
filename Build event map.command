#!/bin/bash
# Double-click to build the event directory map and open it in your browser.
# First run: installs h3/numpy/scipy, downloads population hexagons (Kontur, ~150 MB once), measures how far people
# live from each core event trade, re-orders the Google gap searches, writes GIS files and the map data (10-20 min).
# Later runs just open the map, unless the directory was rebuilt since. Keep this window open while you use the map.
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/india-scraper-next" || exit 1
VENV="$HOME/.brahmini-event-directory"
if [ ! -x "$VENV/bin/python" ] || [ ! -f data/event-directory/directory.db ]; then
  echo "Run \"Build event directory.command\" first."; read -r -t 30 -p "Press Return to close." _; exit 1
fi
META=public/event-directory/data/meta.json
if [ "$1" = "--rebuild" ] || [ ! -f "$META" ] || [ data/event-directory/directory.db -nt "$META" ]; then
  FREE=$(df -Pk data/event-directory | awk 'NR==2{print int($4/1048576)}')
  if [ ! -f data/event-directory/raw/kontur-IN.gpkg ] && [ "${FREE:-0}" -lt 3 ]; then
    echo "Only ${FREE} GB free; the population download needs about 3 GB. Free some space and try again."; read -r -t 60 -p "Press Return to close." _; exit 1
  fi
  echo "== Installing map tools (h3, numpy, scipy)…"
  "$VENV/bin/python" -m pip install -q --upgrade h3 numpy scipy || exit 1
  LOG="$HOME/Brahmini-event-map.log"
  echo "== Building the map data (log: $LOG)…"
  "$VENV/bin/python" scripts/event-directory/geo.py 2>&1 | tee "$LOG"
  [ "${PIPESTATUS[0]}" -eq 0 ] || { echo "Map build failed; see $LOG"; read -r -t 600 -p "Press Return to close." _; exit 1; }
fi
PORT=8791
while lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT+1)); done
echo; echo "== Map: http://127.0.0.1:$PORT/event-directory/   (close this window to stop it)"
( sleep 1; open "http://127.0.0.1:$PORT/event-directory/" ) &
exec "$VENV/bin/python" -m http.server "$PORT" --bind 127.0.0.1 --directory public
