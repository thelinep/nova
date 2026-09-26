#!/bin/bash
# NOVA — add an image upscale model to ComfyUI (Real-ESRGAN x4plus, about 64 MB).
#   bash scripts/add-upscale-model-mac.sh
#   COMFY_DIR=~/somewhere/ComfyUI bash scripts/add-upscale-model-mac.sh
set -euo pipefail
COMFY_DIR="${COMFY_DIR:-$HOME/ComfyUI}"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }
[ -d "$COMFY_DIR/models" ] || die "ComfyUI is not in $COMFY_DIR. Install it first (Install ComfyUI for NOVA.command) or set COMFY_DIR."
mkdir -p "$COMFY_DIR/models/upscale_models"; cd "$COMFY_DIR/models/upscale_models"
f=RealESRGAN_x4plus.pth
if [ -s "$f" ]; then echo "$f is already installed."
else say "Downloading $f"; curl -L --fail --progress-bar -o "$f.part" "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/$f" && mv "$f.part" "$f"; fi
say "Done"
echo "Restart ComfyUI (Start ComfyUI for NOVA.command). In NOVA, Actions > Upscale now uses $f."
echo "You can also drop other upscale models (for example 4x-UltraSharp.pth) into $COMFY_DIR/models/upscale_models."
