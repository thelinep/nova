#!/bin/bash
# NOVA — add ACE-Step 1.5 (turbo) to ComfyUI: better singing, 50+ lyric languages incl. Hindi, faster.
# Files (about 10 GB): diffusion model, two Qwen text encoders (0.6B + 1.7B, the 18 GB-Mac-friendly pair) and the VAE.
#   bash scripts/add-acestep15-mac.sh
#   COMFY_DIR=~/somewhere/ComfyUI bash scripts/add-acestep15-mac.sh
# Safe to run again; interrupted downloads resume.
set -euo pipefail
COMFY_DIR="${COMFY_DIR:-$HOME/ComfyUI}"
BASE="https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }
[ -d "$COMFY_DIR/models" ] || die "ComfyUI is not in $COMFY_DIR. Install it first (Install ComfyUI for NOVA.command) or set COMFY_DIR."
free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
say "Adding ACE-Step 1.5 to $COMFY_DIR (about 10 GB; $free_gb GB free)"
[ "$free_gb" -ge 13 ] || die "Not enough disk space: about 13 GB free is needed ($free_gb GB now)."
if [ -d "$COMFY_DIR/.git" ]; then
  say "Updating ComfyUI (ACE-Step 1.5 needs a recent version)"
  git -C "$COMFY_DIR" pull --ff-only || echo "(could not update ComfyUI; keeping the current version)"
  [ -x "$COMFY_DIR/.venv/bin/python" ] && "$COMFY_DIR/.venv/bin/python" -m pip install -q -r "$COMFY_DIR/requirements.txt" || true
fi
get() { # folder file
  mkdir -p "$COMFY_DIR/models/$1"
  local dest="$COMFY_DIR/models/$1/$2"
  if [ -s "$dest" ]; then echo "$2 is already installed."; return; fi
  say "Downloading $2"
  curl -L --fail -C - --progress-bar -o "$dest.part" "$BASE/$1/$2" && mv "$dest.part" "$dest"
}
get diffusion_models acestep_v1.5_turbo.safetensors
get text_encoders qwen_0.6b_ace15.safetensors
get text_encoders qwen_1.7b_ace15.safetensors
get vae ace_1.5_vae.safetensors
say "Done"
echo "Restart ComfyUI (Start ComfyUI for NOVA.command) and NOVA. Songs now use ACE-Step 1.5; ACE-Step 1 stays available."
