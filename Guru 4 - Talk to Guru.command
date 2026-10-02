#!/bin/bash
# Double-click: give Guru the start of a text and see how it continues (base models continue text;
# they do not chat). Guru-Panini scores the Devanagari it writes.
cd "$(dirname "$0")/guru" || exit 1
[ -x .venv/bin/python ] || { echo "Run 'Guru 1 - Set up.command' first."; read -r -p "Press Return to close."; exit 1; }
SIZES=$(.venv/bin/python -c "
import os; from guru.config import PRESETS, LOCAL_SIZES
print(', '.join('\"'+s+'\"' for s in LOCAL_SIZES if os.path.exists(os.path.join('out', PRESETS[s]['name'], 'best.pt'))))")
[ -z "$SIZES" ] && { echo "No trained Guru yet. Run 'Guru 3 - Train.command' first."; read -r -p "Press Return to close."; exit 1; }
SIZE=$(osascript -e "choose from list {$SIZES} with title \"Talk to Guru\" with prompt \"Which Guru?\"")
[ "$SIZE" = "false" ] && exit 0
while true; do
  TEXT=$(osascript -e 'text returned of (display dialog "Start a text for Guru to continue:" default answer "भारतस्य इतिहासः" buttons {"Done", "Continue it"} default button "Continue it" with title "Talk to Guru")' 2>/dev/null) || break
  [ -z "$TEXT" ] && break
  echo; echo "──────── $TEXT"
  .venv/bin/python -m guru ask "$TEXT" --size "$SIZE" --tokens 150
done
