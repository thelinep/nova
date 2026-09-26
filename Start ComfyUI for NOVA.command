#!/bin/bash
# Double-click to start ComfyUI for NOVA on http://127.0.0.1:8188. Close this window to stop it.
# --cpu-vae decodes on the CPU: Apple's GPU backend cannot run ACE-Step's music decoder
# ("Output channels > 65536 not supported at the MPS device"), and it costs only a few
# seconds for images and sound.
COMFY_DIR="${COMFY_DIR:-$HOME/ComfyUI}"
cd "$COMFY_DIR" || { echo "ComfyUI is not installed in $COMFY_DIR. Double-click 'Install ComfyUI for NOVA.command' first."; exit 1; }
exec ./.venv/bin/python main.py --listen 127.0.0.1 --port 8188 --cpu-vae
