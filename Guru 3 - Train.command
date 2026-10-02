#!/bin/bash
# Double-click: trains a Guru model on the Apple GPU. Keeps the Mac awake while it runs, saves as it goes,
# and can continue later from where it stopped. Times are rough and depend on the Mac.
cd "$(dirname "$0")/guru" || exit 1
[ -x .venv/bin/python ] || { echo "Run 'Guru 1 - Set up.command' first."; read -r -p "Press Return to close."; exit 1; }
[ -f data/train.bin ] || { echo "Run 'Guru 2 - Get corpus.command' first."; read -r -p "Press Return to close."; exit 1; }
SIZE=$(osascript -e 'choose from list {"nano (19M parameters, about 1 to 2 hours)", "mini (36M, about 5 to 8 hours)", "small (94M, a day or more)"} with title "Train Guru" with prompt "Which size?" default items {"nano (19M parameters, about 1 to 2 hours)"}')
[ "$SIZE" = "false" ] && exit 0
SIZE=${SIZE%% *}
LIMIT=$(osascript -e 'choose from list {"Until it is done", "30 minutes", "1 hour", "2 hours", "4 hours", "Overnight (10 hours)"} with title "Train Guru" with prompt "Stop after?" default items {"Until it is done"}')
[ "$LIMIT" = "false" ] && exit 0
case "$LIMIT" in "30 minutes") MIN=30;; "1 hour") MIN=60;; "2 hours") MIN=120;; "4 hours") MIN=240;; Overnight*) MIN=600;; *) MIN="";; esac
NAME=$(.venv/bin/python -c "from guru.config import PRESETS; print(PRESETS['$SIZE']['name'])")
ARGS=(--size "$SIZE")
[ -n "$MIN" ] && ARGS+=(--minutes "$MIN")
if [ -f "out/$NAME/last.pt" ]; then
  R=$(osascript -e 'button returned of (display dialog "A '"$NAME"' run already exists. Continue it, or start again from scratch?" buttons {"Start again", "Continue"} default button "Continue" with title "Train Guru")')
  [ "$R" = "Continue" ] && ARGS+=(--resume)
fi
echo "Training $NAME. Leave this window open; closing it stops training (progress is saved)."
caffeinate -i .venv/bin/python -m guru train "${ARGS[@]}"
echo; echo "Next: 'Guru 4 - Talk to Guru.command' to try it, 'Guru 5 - Add Guru to Ollama.command' to use it in Maataa Workstation."
read -r -p "Press Return to close."
