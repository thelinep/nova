#!/bin/bash
# NOVA — install Kokoro voices (Kokoro-82M, offline text to speech: English, Hindi and more).
#   bash scripts/install-kokoro-mac.sh
#   KOKORO_DIR=~/somewhere bash scripts/install-kokoro-mac.sh
# Puts a small Python environment and two model files (about 360 MB) in ~/kokoro. Safe to run again.
set -euo pipefail
KOKORO_DIR="${KOKORO_DIR:-$HOME/kokoro}"
BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
HERE="$(cd "$(dirname "$0")" && pwd)"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }

free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
say "Installing Kokoro voices into $KOKORO_DIR (about 1 GB needed, $free_gb GB free)"
[ "$free_gb" -ge 1 ] || die "Not enough disk space."
mkdir -p "$KOKORO_DIR"; cd "$KOKORO_DIR"

if command -v uv >/dev/null; then
  [ -x .venv/bin/python ] || uv venv --python 3.12 .venv
  say "Installing kokoro-onnx"
  uv pip install --python .venv/bin/python -U kokoro-onnx soundfile
else
  PY=$(command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3 || true)
  [ -n "$PY" ] || die "Python 3 is missing. Install Homebrew (https://brew.sh), then: brew install uv"
  [ -x .venv/bin/python ] || "$PY" -m venv .venv
  say "Installing kokoro-onnx"
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q -U kokoro-onnx soundfile
fi

for f in kokoro-v1.0.onnx voices-v1.0.bin; do
  if [ -s "$f" ]; then echo "$f already here"; else say "Downloading $f"; curl -L --fail --progress-bar -o "$f.part" "$BASE/$f" && mv "$f.part" "$f"; fi
done

say "Test"
printf 'Hello from NOVA.' > /tmp/nova-kokoro-test.txt
printf 'नमस्ते, मैं नोवा हूँ।' > /tmp/nova-kokoro-hi.txt
KOKORO_DIR="$KOKORO_DIR" .venv/bin/python "$HERE/kokoro-say.py" --text-file /tmp/nova-kokoro-test.txt --voice af_heart --lang en-us --out /tmp/nova-kokoro-test.wav
KOKORO_DIR="$KOKORO_DIR" .venv/bin/python "$HERE/kokoro-say.py" --text-file /tmp/nova-kokoro-hi.txt --voice hf_alpha --lang hi --out /tmp/nova-kokoro-hi.wav
command -v afplay >/dev/null && afplay /tmp/nova-kokoro-test.wav && afplay /tmp/nova-kokoro-hi.wav || true

say "Done"
echo "Restart NOVA (npm start). In Media > Audio, choose a Kokoro voice."
