#!/bin/bash
# Double-click to turn on NOVA's live Tensor view for songs and sounds.
# Links NOVA's small ComfyUI add-on (nova-console/comfy/nova_tensor_view) into ~/ComfyUI/custom_nodes,
# then restarts ComfyUI and NOVA if they are running an older version. Images need nothing extra.
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/nova-console" || exit 1
up() { curl -s -m 3 -o /dev/null -w '%{http_code}' "$1" | grep -q '^2'; }
COMFY="$HOME/ComfyUI"
if [ ! -d "$COMFY/custom_nodes" ]; then echo "ComfyUI was not found in ~/ComfyUI. Install it first (Install ComfyUI for NOVA.command)."; exit 1; fi
ln -sfn "$ROOT/nova-console/comfy/nova_tensor_view" "$COMFY/custom_nodes/nova_tensor_view"
echo "Linked the tensor view add-on into $COMFY/custom_nodes."
# NOVA: restart one that predates the live route.
if up http://127.0.0.1:8787/api/health && ! up http://127.0.0.1:8787/api/comfy/live; then
  echo "Restarting the older NOVA…"; kill $(lsof -ti tcp:8787 -sTCP:LISTEN) 2>/dev/null; sleep 2
fi
if ! up http://127.0.0.1:8787/api/health; then
  echo "Starting NOVA (log: ~/NOVA-server.log)…"; nohup node --no-warnings server.js > "$HOME/NOVA-server.log" 2>&1 &
  for i in $(seq 1 30); do up http://127.0.0.1:8787/api/health && break; sleep 1; done
fi
# ComfyUI: restart so it loads the add-on.
if up http://127.0.0.1:8188/system_stats && ! curl -s -m 5 http://127.0.0.1:8188/object_info/NovaTensorView | grep -q NovaTensorView; then
  echo "Restarting ComfyUI so it loads the add-on…"; kill $(lsof -ti tcp:8188 -sTCP:LISTEN) 2>/dev/null; sleep 3
fi
if ! up http://127.0.0.1:8188/system_stats && [ -x "$COMFY/.venv/bin/python" ]; then
  echo "Starting ComfyUI (log: ~/ComfyUI-check.log)…"; (cd "$COMFY" && nohup ./.venv/bin/python main.py --listen 127.0.0.1 --port 8188 > "$HOME/ComfyUI-check.log" 2>&1 &)
  for i in $(seq 1 90); do up http://127.0.0.1:8188/system_stats && break; sleep 2; done
fi
if curl -s -m 5 http://127.0.0.1:8188/object_info/NovaTensorView | grep -q NovaTensorView; then
  echo "== Done. Generate an image or a song in NOVA and watch it in the Tensor view (bottom right)."
  open "http://127.0.0.1:8787/" 2>/dev/null
else
  echo "ComfyUI did not load the add-on. See ~/ComfyUI-check.log (search for nova_tensor_view)."
fi
echo "You can close this window."
