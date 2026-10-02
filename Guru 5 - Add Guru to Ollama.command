#!/bin/bash
# Double-click: exports a trained Guru (Hugging Face folder → GGUF) and adds it to Ollama as guru-maataa-<size>,
# so Maataa Workstation lists it after Models > Sync from Ollama. Optionally makes it THE guru-maataa.
cd "$(dirname "$0")/guru" || exit 1
[ -x .venv/bin/python ] || { echo "Run 'Guru 1 - Set up.command' first."; read -r -p "Press Return to close."; exit 1; }
OLLAMA="$(command -v ollama || ls /usr/local/bin/ollama /opt/homebrew/bin/ollama /Applications/Ollama.app/Contents/Resources/ollama 2>/dev/null | head -1)"
[ -z "$OLLAMA" ] && { echo "Ollama is not installed."; read -r -p "Press Return to close."; exit 1; }
"$OLLAMA" list >/dev/null 2>&1 || { echo "Ollama is not running. Open the Ollama app and try again."; read -r -p "Press Return to close."; exit 1; }
SIZES=$(.venv/bin/python -c "
import os; from guru.config import PRESETS, LOCAL_SIZES
print(', '.join('\"'+s+'\"' for s in LOCAL_SIZES if os.path.exists(os.path.join('out', PRESETS[s]['name'], 'best.pt'))))")
[ -z "$SIZES" ] && { echo "No trained Guru yet. Run 'Guru 3 - Train.command' first."; read -r -p "Press Return to close."; exit 1; }
SIZE=$(osascript -e "choose from list {$SIZES} with title \"Add Guru to Ollama\" with prompt \"Which Guru?\"")
[ "$SIZE" = "false" ] && exit 0
NAME=$(.venv/bin/python -c "from guru.config import PRESETS; print(PRESETS['$SIZE']['name'])")
PATH="$(dirname "$OLLAMA"):$PATH" .venv/bin/python -m guru export --size "$SIZE" --ollama "$NAME" || { read -r -p "Press Return to close."; exit 1; }
R=$(osascript -e 'button returned of (display dialog "'"$NAME"' is in Ollama.\n\nAlso make it THE guru-maataa (guru-maataa:latest)? The current guru-maataa (built on Llama 3.2) will be kept as llama-guru-maataa." buttons {"Not now", "Make it guru-maataa"} default button "Not now" with title "Guru")')
if [ "$R" = "Make it guru-maataa" ]; then
  has() { "$OLLAMA" list | awk 'NR>1 {print $1}' | grep -qx "$1"; }
  if has "guru-maataa:latest" && ! has "llama-guru-maataa:latest"; then
    "$OLLAMA" cp guru-maataa:latest llama-guru-maataa:latest && echo "Kept the Llama-based model as llama-guru-maataa."
  fi
  "$OLLAMA" cp "$NAME:latest" guru-maataa:latest && echo "guru-maataa is now our own $NAME."
fi
"$OLLAMA" list | awk 'NR==1 || $1 ~ /guru/'
echo; echo "In Maataa Workstation press Models > Sync from Ollama."
read -r -p "Press Return to close."
