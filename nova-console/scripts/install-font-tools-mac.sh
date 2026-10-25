#!/bin/bash
# Lipi OS — install the font tools the conjunct shape editor uses to rebuild the Maataa Lipi fonts.
#   bash scripts/install-font-tools-mac.sh
#   FONT_TOOLS_DIR=~/somewhere bash scripts/install-font-tools-mac.sh
# Puts a small Python environment with fontTools and brotli (about 10 MB) in ~/.maataa/fonttools. Safe to run again.
set -euo pipefail
DIR="${FONT_TOOLS_DIR:-$HOME/.maataa/fonttools}"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }

say "Installing font tools into $DIR"
mkdir -p "$(dirname "$DIR")"
if command -v uv >/dev/null; then
  [ -x "$DIR/bin/python" ] || uv venv --python 3.12 "$DIR"
  uv pip install --python "$DIR/bin/python" -U fonttools brotli
else
  PY=$(command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3 || true)
  [ -n "$PY" ] || die "Python 3 is missing. Install Homebrew (https://brew.sh), then: brew install uv"
  [ -x "$DIR/bin/python" ] || "$PY" -m venv "$DIR"
  "$DIR/bin/python" -m pip install -q --upgrade pip
  "$DIR/bin/python" -m pip install -q -U fonttools brotli
fi
"$DIR/bin/python" -c 'import fontTools, brotli; print("fontTools", fontTools.version)' || die "The check failed."
say "Done. In Lipi OS, open Conjunct editor and press Rebuild fonts."
