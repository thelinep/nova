#!/bin/bash
# Double-click to install ComfyUI and the models NOVA uses (about 13 GB; the Wan video models are skipped until there is more space).
# Safe to run again: it skips finished steps and resumes downloads.
cd "$(dirname "$0")/nova-console" || exit 1
bash scripts/install-comfyui-mac.sh --no-wan 2>&1 | tee "$HOME/ComfyUI-install.log"
echo; echo "Log saved to ~/ComfyUI-install.log. You can close this window."
