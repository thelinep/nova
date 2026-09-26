#!/bin/bash
# Double-click to add sound-effect (Stable Audio Open) and music (ACE-Step) models to ComfyUI. About 13 GB.
cd "$(dirname "$0")/nova-console" || exit 1
bash scripts/install-comfyui-mac.sh --models-only --no-sdxl --no-wan --audio 2>&1 | tee -a "$HOME/ComfyUI-install.log"
echo; echo "Restart ComfyUI, then open NOVA > Media > Text to audio. You can close this window."
