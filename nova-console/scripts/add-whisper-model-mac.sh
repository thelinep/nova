#!/bin/bash
# NOVA — add a multilingual speech-to-text model for whisper.cpp, so Hindi and other languages can be
# transcribed and translated (the English-only ggml-base.en model understands English only).
#   bash scripts/add-whisper-model-mac.sh           # large-v3-turbo, 5-bit (about 575 MB): best quality for its size
#   bash scripts/add-whisper-model-mac.sh --small   # small (about 470 MB): lighter and faster, less accurate
# Safe to run again.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# Two places read speech models: the NOVA app (its own data folder) and NOVA started from this folder
# (npm start / Start NOVA.command). The model is downloaded once and linked into both, using no extra space.
APP_DIR="$HOME/Library/Application Support/com.brahmini.nova-runtime/models/whisper"
DIR="$HERE/data/models/whisper"
BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }
# Puts file $1 from folder $2 into folder $3 as well: a hard link (no extra space), else a copy.
share() { [ -s "$3/$1" ] && return 0; mkdir -p "$3"; ln "$2/$1" "$3/$1" 2>/dev/null || cp "$2/$1" "$3/$1"; echo "$1 is now also in $3"; }
files=(ggml-large-v3-turbo-q5_0.bin ggml-small.bin)
[ "${1:-}" = "--small" ] && files=(ggml-small.bin)
mkdir -p "$DIR" "$APP_DIR"
# Models already downloaded in one place (including the English model) go to the other.
for f in "$DIR"/ggml-*.bin; do [ -s "$f" ] && share "$(basename "$f")" "$DIR" "$APP_DIR"; done
for f in "$APP_DIR"/ggml-*.bin; do [ -s "$f" ] && share "$(basename "$f")" "$APP_DIR" "$DIR"; done
cd "$DIR"
for f in "${files[@]}"; do
  if [ -s "$f" ]; then echo "$f is already installed."; got=1; break; fi
  free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
  [ "$free_gb" -ge 2 ] || die "Not enough disk space ($free_gb GB free)."
  say "Downloading $f into $DIR"
  if curl -L --fail --progress-bar -o "$f.part" "$BASE/$f"; then mv "$f.part" "$f"; share "$f" "$DIR" "$APP_DIR"; got=1; break
  else rm -f "$f.part"; echo "Could not download $f; trying the next one."; fi
done
[ "${got:-0}" = 1 ] || die "No model could be downloaded. Check the internet connection and try again."
command -v whisper-cli >/dev/null || echo "Note: whisper.cpp itself is not installed yet: brew install whisper-cpp"
say "Done"
echo "The NOVA app and NOVA from this folder can now use it; no restart is needed. Hold the helper's mic, or in Media choose the spoken language on an item (or Detect), then Transcribe or Translate."
