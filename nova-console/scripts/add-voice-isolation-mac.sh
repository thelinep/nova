#!/bin/bash
# Maataa — add voice isolation (Demucs htdemucs, two stems: voice / everything else).
#   NOVA_DATA_DIR=~/path/to/data bash scripts/add-voice-isolation-mac.sh
# Puts a Python environment (PyTorch + Demucs, about 2 GB) and the htdemucs
# weights (about 80 MB) in $NOVA_DATA_DIR/tools/demucs. Safe to run again.
# Versions are pinned: newer torchaudio needs torchcodec to read and write audio,
# which Demucs 4.0.1 does not install.
set -euo pipefail
NOVA_DATA_DIR="${NOVA_DATA_DIR:-$(cd "$(dirname "$0")/.." && pwd)/data}"
DIR="${NOVA_DEMUCS_DIR:-$NOVA_DATA_DIR/tools/demucs}"
PINS=(torch==2.8.0 torchaudio==2.8.0 demucs==4.0.1 soundfile)
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }

free_gb=$(df -g "$HOME" 2>/dev/null | awk 'NR==2 {print $4}' || echo 99)
say "Installing voice isolation into $DIR (about 4 GB needed, $free_gb GB free)"
[ "${free_gb:-0}" -ge 4 ] || die "Not enough disk space."
mkdir -p "$DIR"; cd "$DIR"
rm -f .ready

if command -v uv >/dev/null; then
  [ -x .venv/bin/python ] || uv venv --python 3.12 .venv
  say "Installing PyTorch and Demucs"
  uv pip install --python .venv/bin/python "${PINS[@]}"
else
  PY=$(command -v python3.12 || command -v python3.11 || command -v python3.10 || true)
  [ -n "$PY" ] || die "Python 3.10-3.12 is missing. Install Homebrew (https://brew.sh), then: brew install uv"
  [ -x .venv/bin/python ] || "$PY" -m venv .venv
  say "Installing PyTorch and Demucs"
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q "${PINS[@]}"
fi

say "Test run (downloads the htdemucs weights the first time)"
export TORCH_HOME="$DIR/torch"
.venv/bin/python - <<'PY'
import math, struct, wave
with wave.open('warmup.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(44100)
    w.writeframes(b''.join(struct.pack('<hh', v, v) for v in (int(8000 * math.sin(2 * math.pi * 220 * i / 44100)) for i in range(44100 * 3))))
PY
rm -rf warmup-out
.venv/bin/python -m demucs --two-stems vocals -n htdemucs -o warmup-out warmup.wav
[ -s warmup-out/htdemucs/warmup/vocals.wav ] || die "The test run did not write a voice track."
rm -rf warmup-out warmup.wav
touch .ready

say "Done"
echo "In Maataa, open an audio or video item and choose Isolate voice…"
