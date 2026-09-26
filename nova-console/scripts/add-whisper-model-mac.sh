#!/bin/bash
# NOVA — add a multilingual speech-to-text model for whisper.cpp, so Hindi and other languages can be
# transcribed and translated (the English-only ggml-base.en model understands English only).
#   bash scripts/add-whisper-model-mac.sh           # large-v3-turbo, 5-bit (about 575 MB): best quality for its size
#   bash scripts/add-whisper-model-mac.sh --small   # small (about 470 MB): lighter and faster, less accurate
# Safe to run again.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$HERE/data/models/whisper"
BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }
files=(ggml-large-v3-turbo-q5_0.bin ggml-small.bin)
[ "${1:-}" = "--small" ] && files=(ggml-small.bin)
free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
[ "$free_gb" -ge 2 ] || die "Not enough disk space ($free_gb GB free)."
mkdir -p "$DIR"; cd "$DIR"
for f in "${files[@]}"; do
  if [ -s "$f" ]; then echo "$f is already installed."; got=1; break; fi
  say "Downloading $f into $DIR"
  if curl -L --fail --progress-bar -o "$f.part" "$BASE/$f"; then mv "$f.part" "$f"; got=1; break
  else rm -f "$f.part"; echo "Could not download $f; trying the next one."; fi
done
[ "${got:-0}" = 1 ] || die "No model could be downloaded. Check the internet connection and try again."
command -v whisper-cli >/dev/null || echo "Note: whisper.cpp itself is not installed yet: brew install whisper-cpp"
say "Done"
echo "Restart NOVA (npm start). In Media, choose the spoken language on an item (or Detect), then Transcribe or Translate."
