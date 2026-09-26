#!/bin/bash
# Double-click to add an image upscale model (Real-ESRGAN x4plus, about 64 MB) to ComfyUI for NOVA's Upscale action.
cd "$(dirname "$0")/nova-console" || exit 1
bash scripts/add-upscale-model-mac.sh 2>&1 | tee "$HOME/Upscale-model-install.log"
echo; echo "Log saved to ~/Upscale-model-install.log. You can close this window."
