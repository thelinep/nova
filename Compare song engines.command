#!/bin/bash
# Double-click to make the same English and Hindi song with ACE-Step 1 and ACE-Step 1.5 and compare them.
# (Re)starts NOVA and ComfyUI when they are not running or are older than the files on disk. Takes 10–30 minutes.
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/nova-console" || exit 1
up() { curl -s -m 3 -o /dev/null -w '%{http_code}' "$1" | grep -q '^2'; }
start_nova() { echo "Starting NOVA…"; nohup node --no-warnings server.js > "$HOME/NOVA-server.log" 2>&1 & for i in $(seq 1 30); do up http://127.0.0.1:8787/api/health && break; sleep 1; done; }
# A NOVA started before this update has no compare route: restart it.
if up http://127.0.0.1:8787/api/health; then
  code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' -X POST -H 'Origin: http://127.0.0.1:8787' -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8787/api/audio/music-compare)
  if [ "$code" = "404" ]; then echo "Restarting the older NOVA…"; kill $(lsof -ti tcp:8787 -sTCP:LISTEN) 2>/dev/null; sleep 2; start_nova; fi
else start_nova; fi
# ComfyUI must know the ACE-Step 1.5 nodes (it was updated by "Add ACE-Step 1.5"): restart it if not.
if up http://127.0.0.1:8188/system_stats && ! curl -s -m 5 "http://127.0.0.1:8188/object_info/EmptyAceStep1.5LatentAudio" | grep -q 'EmptyAceStep1.5'; then
  echo "Restarting ComfyUI so it loads ACE-Step 1.5…"; kill $(lsof -ti tcp:8188 -sTCP:LISTEN) 2>/dev/null; sleep 3
fi
if ! up http://127.0.0.1:8188/system_stats && [ -x "$HOME/ComfyUI/.venv/bin/python" ]; then
  echo "Starting ComfyUI (log: ~/ComfyUI-check.log)…"; (cd "$HOME/ComfyUI" && nohup ./.venv/bin/python main.py --listen 127.0.0.1 --port 8188 > "$HOME/ComfyUI-check.log" 2>&1 &)
  for i in $(seq 1 90); do up http://127.0.0.1:8188/system_stats && break; sleep 2; done
fi
node scripts/compare-songs.js 2>&1 | tee "$HOME/NOVA-song-compare.log"
echo; echo "Report saved in nova-console/data/checks/songs-compare.md. Listen to both versions in NOVA: Media > Library. You can close this window."
