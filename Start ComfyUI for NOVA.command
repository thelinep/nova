#!/bin/bash
# Double-click to start ComfyUI for NOVA on http://127.0.0.1:8188. Close this window to stop it.
COMFY_DIR="${COMFY_DIR:-$HOME/ComfyUI}"
cd "$COMFY_DIR" || { echo "ComfyUI is not installed in $COMFY_DIR. Double-click 'Install ComfyUI for NOVA.command' first."; exit 1; }
v=$(sw_vers -productVersion); major=${v%%.*}; rest=${v#*.}; minor=${rest%%.*}
if [ "$major" -lt 15 ] || { [ "$major" -eq 15 ] && [ "${minor:-0}" -lt 1 ]; }; then
  echo "Note: on macOS $v, music (ACE-Step) cannot decode on the Apple GPU. Update to macOS 15.1 or later for music."
fi
exec ./.venv/bin/python main.py --listen 127.0.0.1 --port 8188
