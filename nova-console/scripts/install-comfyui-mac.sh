#!/bin/bash
# NOVA — install ComfyUI on an Apple Silicon Mac, plus the models NOVA uses:
#   SDXL base 1.0 checkpoint (image generation)       ~6.9 GB
#   Wan 2.2 TI2V 5B, umt5 fp16 text encoder, Wan VAE   ~22 GB (AI motion)
#
#   bash scripts/install-comfyui-mac.sh              # everything
#   bash scripts/install-comfyui-mac.sh --no-wan     # skip the video models
#   bash scripts/install-comfyui-mac.sh --models-only
#   COMFY_DIR=~/Documents/ComfyUI bash scripts/install-comfyui-mac.sh
#
# Safe to run again: finished steps are skipped and interrupted downloads resume.
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-$HOME/ComfyUI}"
WAN=1; SDXL=1; APP=1
for arg in "$@"; do case "$arg" in --no-wan) WAN=0;; --no-sdxl) SDXL=0;; --models-only) APP=0;; *) echo "Unknown option: $arg"; exit 2;; esac; done

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }

[ "$(uname -s)" = Darwin ] || die "This script is for macOS."
[ "$(uname -m)" = arm64 ] || die "This script is for Apple Silicon (M1 or later)."

need_gb=2; [ $APP = 1 ] && need_gb=$((need_gb + 6)); [ $SDXL = 1 ] && need_gb=$((need_gb + 7)); [ $WAN = 1 ] && need_gb=$((need_gb + 23))
mkdir -p "$COMFY_DIR"
free_gb=$(df -g "$COMFY_DIR" | awk 'NR==2 {print $4}')
say "Installing into $COMFY_DIR (about ${need_gb} GB needed, ${free_gb} GB free)"
[ "$free_gb" -ge "$need_gb" ] || die "Not enough disk space. Free some space or set COMFY_DIR to a bigger drive."

if [ $APP = 1 ]; then
  command -v git >/dev/null || die "git is missing. Run: xcode-select --install"
  PY=""
  for c in python3.13 python3.12 /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12; do command -v "$c" >/dev/null 2>&1 && { PY="$(command -v "$c")"; break; }; done
  if [ -z "$PY" ]; then
    command -v brew >/dev/null || die "Python 3.12 or 3.13 is needed. Install Homebrew (https://brew.sh), then run this again."
    say "Installing Python 3.13 with Homebrew"
    brew install python@3.13
    PY=/opt/homebrew/bin/python3.13
  fi
  echo "Python: $PY ($("$PY" --version))"

  if [ -d "$COMFY_DIR/.git" ]; then say "Updating ComfyUI"; git -C "$COMFY_DIR" pull --ff-only || echo "(could not update; keeping the current version)"
  elif [ -f "$COMFY_DIR/main.py" ]; then say "ComfyUI already present (not a git checkout); keeping it"
  else
    say "Downloading ComfyUI"
    tmp="$COMFY_DIR.clone-$$"; git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git "$tmp"
    shopt -s dotglob; mv "$tmp"/* "$COMFY_DIR"/; rmdir "$tmp"; shopt -u dotglob
  fi

  cd "$COMFY_DIR"
  [ -x .venv/bin/python ] || { say "Creating Python environment"; "$PY" -m venv .venv; }
  VPY="$COMFY_DIR/.venv/bin/python"
  "$VPY" -m pip install --upgrade pip wheel >/dev/null
  if ! "$VPY" -c "import torch" 2>/dev/null; then
    say "Installing PyTorch (nightly, as ComfyUI recommends for Apple Silicon)"
    "$VPY" -m pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cpu \
      || { echo "Nightly failed; installing the stable release"; "$VPY" -m pip install torch torchvision torchaudio; }
  fi
  say "Installing ComfyUI requirements"
  "$VPY" -m pip install -r requirements.txt
  "$VPY" -c "import torch; print('PyTorch', torch.__version__, '| Apple GPU (MPS):', torch.backends.mps.is_available())"

  cat > "$COMFY_DIR/start-comfyui.command" <<START
#!/bin/bash
# Double-click to start ComfyUI for NOVA (http://127.0.0.1:8188). Close this window to stop it.
cd "$COMFY_DIR" && exec ./.venv/bin/python main.py --listen 127.0.0.1 --port 8188
START
  chmod +x "$COMFY_DIR/start-comfyui.command"
fi

fetch() { # url dest-folder file-name minimum-bytes
  local url="$1" dir="$COMFY_DIR/models/$2" name="$3" min="$4"
  mkdir -p "$dir"
  if [ -f "$dir/$name" ] && [ "$(stat -f %z "$dir/$name")" -ge "$min" ]; then echo "Already have $2/$name"; return; fi
  say "Downloading $2/$name"
  curl -L --fail --retry 5 --retry-delay 5 -C - -o "$dir/$name.part" "$url"
  [ "$(stat -f %z "$dir/$name.part")" -ge "$min" ] || die "$name looks incomplete; run the script again to resume."
  mv "$dir/$name.part" "$dir/$name"
}

HF=https://huggingface.co
[ $SDXL = 1 ] && fetch "$HF/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors" checkpoints sd_xl_base_1.0.safetensors 6000000000
if [ $WAN = 1 ]; then
  fetch "$HF/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors" vae wan2.2_vae.safetensors 500000000
  fetch "$HF/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors" diffusion_models wan2.2_ti2v_5B_fp16.safetensors 9000000000
  fetch "$HF/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp16.safetensors" text_encoders umt5_xxl_fp16.safetensors 10000000000
fi

say "Done"
echo "Start ComfyUI: double-click $COMFY_DIR/start-comfyui.command (or run it in Terminal)."
echo "Then open NOVA > Media: it finds ComfyUI on http://127.0.0.1:8188 by itself."
