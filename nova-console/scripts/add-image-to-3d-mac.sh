#!/bin/bash
# Maataa — add "picture to 3D mesh" for Character Studio: TripoSR (MIT licence) in
# $NOVA_DATA_DIR/tools/triposr — a Python environment (PyTorch and friends, about 2 GB),
# the TripoSR code, its weights (about 1.7 GB) and the background remover (about 170 MB).
#   NOVA_DATA_DIR=~/path/to/data bash scripts/add-image-to-3d-mac.sh
# Safe to run again. Everything runs on this Mac.
set -euo pipefail
NOVA_DATA_DIR="${NOVA_DATA_DIR:-$(cd "$(dirname "$0")/.." && pwd)/data}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${NOVA_TRIPOSR_DIR:-$NOVA_DATA_DIR/tools/triposr}"
PINS=(torch==2.4.1 "numpy<2" "Pillow<11" einops==0.7.0 omegaconf==2.3.0 transformers==4.35.0 huggingface_hub==0.24.7 trimesh==4.0.5 PyMCubes==0.1.6 imageio "rembg==2.0.59" onnxruntime)
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }

free_gb=$(df -g "$HOME" 2>/dev/null | awk 'NR==2 {print $4}' || echo 99)
say "Installing picture to 3D mesh into $DIR (about 5 GB needed, $free_gb GB free)"
[ "${free_gb:-0}" -ge 5 ] || die "Not enough disk space."
mkdir -p "$DIR"; cd "$DIR"
rm -f .ready

say "Getting the TripoSR code"
if [ ! -f TripoSR/tsr/system.py ]; then
  rm -rf TripoSR TripoSR-main triposr.tar.gz
  if command -v git >/dev/null && git clone --depth 1 https://github.com/VAST-AI-Research/TripoSR.git TripoSR; then :; else
    rm -rf TripoSR
    curl -L --fail --progress-bar -o triposr.tar.gz https://codeload.github.com/VAST-AI-Research/TripoSR/tar.gz/refs/heads/main
    tar -xzf triposr.tar.gz && mv TripoSR-main TripoSR && rm -f triposr.tar.gz
  fi
fi
[ -f TripoSR/tsr/system.py ] || die "The TripoSR code did not download."

if command -v uv >/dev/null; then
  [ -x .venv/bin/python ] || uv venv --python 3.11 .venv
  say "Installing PyTorch and the TripoSR libraries"
  uv pip install --python .venv/bin/python "${PINS[@]}"
else
  PY=$(command -v python3.11 || command -v python3.10 || command -v python3.12 || true)
  [ -n "$PY" ] || die "Python 3.10-3.12 is missing. Install Homebrew (https://brew.sh), then: brew install uv"
  [ -x .venv/bin/python ] || "$PY" -m venv .venv
  say "Installing PyTorch and the TripoSR libraries"
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q "${PINS[@]}"
fi

say "Test run (downloads the weights and the background remover the first time)"
.venv/bin/python - <<'PY'
from PIL import Image, ImageDraw
im = Image.new('RGB', (512, 512), (255, 255, 255)); d = ImageDraw.Draw(im)
d.ellipse((176, 60, 336, 220), fill=(224, 172, 130)); d.rectangle((186, 220, 326, 400), fill=(40, 110, 200)); d.rectangle((196, 400, 316, 480), fill=(50, 50, 60))
im.save('warmup.png')
PY
TRIPOSR_DIR="$DIR" HF_HOME="$DIR/hf" .venv/bin/python "$HERE/image-to-mesh.py" --image warmup.png --out warmup.glb --resolution 64
[ -s warmup.glb ] || die "The test run did not make a mesh."
rm -f warmup.png warmup.glb
touch .ready

say "Done"
echo "In Maataa: Character Studio → 3D model → Scan → Make a 3D mesh."
