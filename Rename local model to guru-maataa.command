#!/bin/bash
# Double-click to rename the local Ollama model "maataa" to "guru-maataa", so the model no longer shares
# the platform's name (MAATAA). Ollama copies the name and then removes the old one; the model's weights
# are shared, so nothing is downloaded and no extra disk space is used. Safe to run again.
OLD="maataa:latest"; NEW="guru-maataa:latest"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
OLLAMA="$(command -v ollama || ls /usr/local/bin/ollama /opt/homebrew/bin/ollama /Applications/Ollama.app/Contents/Resources/ollama 2>/dev/null | head -1)"
if [ -z "$OLLAMA" ]; then echo "Ollama is not installed or not on this Mac's PATH. Open the Ollama app and try again."; read -r -p "Press Return to close."; exit 1; fi
if ! "$OLLAMA" list >/dev/null 2>&1; then echo "Ollama is not running. Open the Ollama app, then double-click this again."; read -r -p "Press Return to close."; exit 1; fi
has() { "$OLLAMA" list | awk 'NR>1 {print $1}' | grep -qx "$1"; }
if has "$NEW" && ! has "$OLD"; then say "Already done: $NEW is installed and $OLD is gone."; read -r -p "Press Return to close."; exit 0; fi
if ! has "$OLD"; then echo "There is no model called $OLD on this Mac, so there is nothing to rename."; read -r -p "Press Return to close."; exit 1; fi
say "Copying $OLD to $NEW"
"$OLLAMA" cp "$OLD" "$NEW" || { echo "The copy failed; nothing was changed."; read -r -p "Press Return to close."; exit 1; }
if [ "$("$OLLAMA" show "$NEW" --modelfile 2>/dev/null | grep -c FROM)" -lt 1 ]; then echo "$NEW does not look right; $OLD was kept."; read -r -p "Press Return to close."; exit 1; fi
say "Removing the old name $OLD (the weights stay, shared with $NEW)"
"$OLLAMA" rm "$OLD"
say "Done"
"$OLLAMA" list | awk 'NR==1 || $1 ~ /maataa/'
echo
echo "In Maataa Workstation press Models > Sync from Ollama (or restart the app): chats, agents and"
echo "profiles that used $OLD move to $NEW, and its coding checks stay, because the model is the same."
read -r -p "Press Return to close."
