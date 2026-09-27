#!/bin/bash
# NOVA Runtime (portable). Double-click to start NOVA and open it in your browser.
# Uses the Node runtime inside this folder and keeps data in the same place as the NOVA app:
#   ~/Library/Application Support/com.brahmini.nova-runtime
# Close this window (or press Ctrl-C) to stop NOVA.
DIR="$(cd "$(dirname "$0")" && pwd)"
export DATA_DIR="${DATA_DIR:-$HOME/Library/Application Support/com.brahmini.nova-runtime}"
PORT="${PORT:-8787}"
URL="http://127.0.0.1:$PORT"
mkdir -p "$DATA_DIR"
if curl -fsS -m 2 "$URL/api/health" >/dev/null 2>&1; then
  echo "NOVA is already running at $URL"; open "$URL"; exit 0
fi
xattr -dr com.apple.quarantine "$DIR" 2>/dev/null
echo "Starting NOVA (data: $DATA_DIR)…"
PORT="$PORT" "$DIR/node/bin/node" --no-warnings "$DIR/server.js" &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT INT TERM
for _ in $(seq 1 60); do
  curl -fsS -m 1 "$URL/api/health" >/dev/null 2>&1 && { echo "NOVA is running at $URL"; open "$URL"; break; }
  kill -0 $PID 2>/dev/null || { echo "NOVA stopped while starting; see the messages above."; exit 1; }
  sleep 0.5
done
wait $PID
