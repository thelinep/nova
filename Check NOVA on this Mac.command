#!/bin/bash
# Double-click to run every NOVA media feature once on this Mac and report what works.
# Starts NOVA, ComfyUI and Ollama if they are not running (and leaves them running).
# Takes 15–40 minutes (LTX-2 and music are slow). Add --quick to skip those two:
#   open Terminal in the brahmini folder and run:  "./Check NOVA on this Mac.command" --quick
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/nova-console" || exit 1
up() { curl -s -m 2 -o /dev/null -w '%{http_code}' "$1" | grep -q '^2'; }
if ! up http://127.0.0.1:8787/api/health; then
  echo "Starting NOVA…"; nohup node --no-warnings server.js > "$HOME/NOVA-server.log" 2>&1 &
  for i in $(seq 1 30); do up http://127.0.0.1:8787/api/health && break; sleep 1; done
fi
if ! up http://127.0.0.1:8188/system_stats && ! up http://127.0.0.1:8000/system_stats && [ -x "$HOME/ComfyUI/.venv/bin/python" ]; then
  echo "Starting ComfyUI (log: ~/ComfyUI-check.log)…"; (cd "$HOME/ComfyUI" && nohup ./.venv/bin/python main.py --listen 127.0.0.1 --port 8188 > "$HOME/ComfyUI-check.log" 2>&1 &)
  for i in $(seq 1 90); do up http://127.0.0.1:8188/system_stats && break; sleep 2; done
fi
if ! up http://127.0.0.1:11434/api/tags && command -v ollama >/dev/null; then
  echo "Starting Ollama…"; (open -a Ollama 2>/dev/null || nohup ollama serve > "$HOME/ollama-check.log" 2>&1 &)
  for i in $(seq 1 20); do up http://127.0.0.1:11434/api/tags && break; sleep 1; done
fi
node scripts/check-on-mac.js "$@" 2>&1 | tee "$HOME/NOVA-check.log"
echo; echo "Report saved in nova-console/data/checks/latest.md (and ~/NOVA-check.log). You can close this window."
