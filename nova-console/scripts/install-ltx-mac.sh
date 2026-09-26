#!/bin/bash
# NOVA — install LTX-2 (MLX) for local AI motion with sound on an Apple Silicon Mac.
#   bash scripts/install-ltx-mac.sh            # tool + only the weights Fast clips need (about 28 GB) + a tiny test clip
#   bash scripts/install-ltx-mac.sh --better   # also the files for Better (two-stage) clips (+19 GB)
#   bash scripts/install-ltx-mac.sh --no-test  # skip the test clip
#   LTX_DIR=~/somewhere bash scripts/install-ltx-mac.sh
# The weights repository holds about 60 GB of variants; NOVA downloads only the files it uses.
# Safe to run again.
set -euo pipefail
LTX_DIR="${LTX_DIR:-$HOME/ltx-2-mlx}"
MODEL="${LTX_MLX_MODEL:-dgrauet/ltx-2.3-mlx-q4}"
TEST=1; BETTER=""
for a in "$@"; do case "$a" in --no-test) TEST=0;; --better) BETTER=--better;; esac; done
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "LTX-2 (MLX) needs an Apple Silicon Mac."
free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
need=2
say "Installing LTX-2 into $LTX_DIR (about $need GB needed now, $free_gb GB free)"
[ "$free_gb" -ge "$need" ] || die "Not enough disk space ($free_gb GB free, about $need GB needed). Free space and run this again."

command -v git >/dev/null || die "git is missing. Run: xcode-select --install"
if ! command -v uv >/dev/null; then
  if command -v brew >/dev/null; then say "Installing uv (Python package manager)"; brew install uv
  else die "uv is needed: install Homebrew (https://brew.sh) or uv (https://docs.astral.sh/uv/), then run this again."; fi
fi

if [ -d "$LTX_DIR/.git" ]; then say "Updating ltx-2-mlx"; git -C "$LTX_DIR" pull --ff-only || echo "(could not update; keeping the current version)"
else say "Downloading ltx-2-mlx"; git clone --depth 1 https://github.com/dgrauet/ltx-2-mlx.git "$LTX_DIR"; fi
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$LTX_DIR"
say "Installing its Python environment"
uv sync --all-extras
[ -x .venv/bin/ltx-2-mlx ] || die "The ltx-2-mlx command was not created; see the messages above."
.venv/bin/ltx-2-mlx --help >/dev/null || die "ltx-2-mlx does not start; see the messages above."

say "Downloading only the weights NOVA uses"
WEIGHTS=$(LTX_MLX_MODEL="$MODEL" .venv/bin/python "$HERE/ltx-fetch-weights.py" $BETTER | tee /dev/stderr | sed -n 's/^LTX_MODEL_DIR=//p')
[ -n "$WEIGHTS" ] && [ -d "$WEIGHTS" ] || die "The weights were not downloaded (see above)."
echo "Weights in $WEIGHTS"

if [ $TEST = 1 ]; then
  say "Test clip"
  tmp=$(mktemp -d)
  if command -v ffmpeg >/dev/null; then ffmpeg -loglevel error -f lavfi -i "testsrc=size=512x512" -frames:v 1 "$tmp/still.png"
  else sips -s format png /System/Library/Desktop\ Pictures/*.heic --out "$tmp/still.png" >/dev/null 2>&1 || true; fi
  HF_HUB_OFFLINE=1 .venv/bin/ltx-2-mlx generate -p "slow push-in, soft wind" --image "$tmp/still.png" -H 256 -W 256 -f 9 --frame-rate 24 --seed 1 --model "$WEIGHTS" --distilled --low-ram -o "$tmp/test.mp4"
  [ -s "$tmp/test.mp4" ] && echo "Test clip OK: $tmp/test.mp4" || die "The test clip was not written."
fi

say "Done"
echo "Restart NOVA (npm start). In Media > Animate stills, AI motion uses LTX-2 on this Mac."
