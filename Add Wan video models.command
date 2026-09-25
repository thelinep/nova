#!/bin/bash
# Double-click once about 25 GB is free: downloads the three Wan 2.2 files for AI motion into ~/ComfyUI.
cd "$(dirname "$0")/nova-console" || exit 1
bash scripts/install-comfyui-mac.sh --models-only --no-sdxl 2>&1 | tee -a "$HOME/ComfyUI-install.log"
echo; echo "Restart ComfyUI, then open NOVA > Media. You can close this window."
