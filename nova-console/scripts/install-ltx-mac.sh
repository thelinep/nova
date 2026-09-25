#!/bin/bash
# NOVA — install LTX-2 (MLX) for local AI motion with sound on an Apple Silicon Mac.
#   bash scripts/install-ltx-mac.sh            # install the tool, then a tiny test clip (downloads the weights)
#   bash scripts/install-ltx-mac.sh --no-test  # install the tool only; weights download on the first clip
#   LTX_DIR=~/somewhere bash scripts/install-ltx-mac.sh
# The 4-bit weights and their text encoder download on first use from Hugging Face; allow about 30 GB.
# Safe to run again.
set -euo pipefail
LTX_DIR="${LTX_DIR:-$HOME/ltx-2-mlx}"
MODEL="${LTX_MLX_MODEL:-dgrauet/ltx-2.3-mlx-q4}"
TEST=1; [ "${1:-}" = "--no-test" ] && TEST=0
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "LTX-2 (MLX) needs an Apple Silicon Mac."
free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
need=$([ $TEST = 1 ] && echo 30 || echo 5)
say "Installing LTX-2 into $LTX_DIR (about $need GB needed now, $free_gb GB free)"
[ "$free_gb" -ge "$need" ] || die "Not enough disk space ($free_gb GB free, about $need GB needed). Free space and run this again."

command -v git >/dev/null || die "git is missing. Run: xcode-select --install"
if ! command -v uv >/dev/null; then
  if command -v brew >/dev/null; then say "Installing uv (Python package manager)"; brew install uv
  else die "uv is needed: install Homebrew (https://brew.sh) or uv (https://docs.astral.sh/uv/), then run this again."; fi
fi

if [ -d "$LTX_DIR/.git" ]; then say "Updating ltx-2-mlx"; git -C "$LTX_DIR" pull --ff-only || echo "(could not update; keeping the current version)"
else say "Downloading ltx-2-mlx"; git clone --depth 1 https://github.com/dgrauet/ltx-2-mlx.git "$LTX_DIR"; fi
cd "$LTX_DIR"
say "Installing its Python environment"
uv sync --all-extras
[ -x .venv/bin/ltx-2-mlx ] || die "The ltx-2-mlx command was not created; see the messages above."
.venv/bin/ltx-2-mlx --help >/dev/null || die "ltx-2-mlx does not start; see the messages above."

if [ $TEST = 1 ]; then
  say "Test clip (first run downloads the $MODEL weights; this can take a while)"
  tmp=$(mktemp -d)
  if command -v ffmpeg >/dev/null; then ffmpeg -loglevel error -f lavfi -i "testsrc=size=512x512" -frames:v 1 "$tmp/still.png"
  else sips -s format png /System/Library/Desktop\ Pictures/*.heic --out "$tmp/still.png" >/dev/null 2>&1 || true; fi
  .venv/bin/ltx-2-mlx generate -p "slow push-in, soft wind" --image "$tmp/still.png" -H 256 -W 256 -f 9 --seed 1 --model "$MODEL" --distilled --low-ram -o "$tmp/test.mp4"
  [ -s "$tmp/test.mp4" ] && echo "Test clip OK: $tmp/test.mp4" || die "The test clip was not written."
fi

say "Done"
echo "Restart NOVA (npm start). In Media > Animate stills, AI motion uses LTX-2 on this Mac."
