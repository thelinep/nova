#!/bin/bash
# Lipi OS — install the OCR tools that read Brahmi from new images (onnxruntime, OpenCV, NumPy; about 80 MB).
#   bash scripts/install-lipi-ocr-mac.sh            # reading only
#   bash scripts/install-lipi-ocr-mac.sh --train    # also PyTorch, for retraining the model (about 700 MB more)
# Puts a Python environment in ~/.maataa/lipi-ocr. Safe to run again.
set -euo pipefail
DIR="${LIPI_OCR_DIR:-$HOME/.maataa/lipi-ocr}"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }
PKGS="onnxruntime opencv-python-headless numpy pillow"
[ "${1:-}" = "--train" ] && PKGS="$PKGS torch onnx fonttools brotli"
say "Installing the Lipi OCR tools into $DIR"
mkdir -p "$(dirname "$DIR")"
if command -v uv >/dev/null; then
  [ -x "$DIR/bin/python" ] || uv venv --python 3.12 "$DIR"
  uv pip install --python "$DIR/bin/python" -U $PKGS
else
  PY=$(command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3 || true)
  [ -n "$PY" ] || die "Python 3 is missing. Install Homebrew (https://brew.sh), then: brew install uv"
  [ -x "$DIR/bin/python" ] || "$PY" -m venv "$DIR"
  "$DIR/bin/python" -m pip install -q --upgrade pip
  "$DIR/bin/python" -m pip install -q -U $PKGS
fi
"$DIR/bin/python" -c 'import onnxruntime, cv2, numpy; print("onnxruntime", onnxruntime.__version__, "opencv", cv2.__version__)' || die "The check failed."
say "Done. In Lipi OS, open Brahmi gallery and use Read Brahmi."
