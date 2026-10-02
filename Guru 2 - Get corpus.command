#!/bin/bash
# Double-click: gathers Guru's training text and prepares it (tokenizer + token files).
# Choice: open Wikipedia in Sanskrit, Hindi and English (about 600 MB of text kept) plus your texts,
# or only your own texts in guru/data/my_texts (.txt, .md, .fountain).
cd "$(dirname "$0")/guru" || exit 1
[ -x .venv/bin/python ] || { echo "Run 'Guru 1 - Set up.command' first."; read -r -p "Press Return to close."; exit 1; }
CHOICE=$(osascript -e 'choose from list {"Wikipedia (Sanskrit, Hindi, English) + my texts", "Only my texts (guru/data/my_texts)"} with title "Guru corpus" with prompt "What should Guru learn from?" default items {"Wikipedia (Sanskrit, Hindi, English) + my texts"}')
[ "$CHOICE" = "false" ] && exit 0
mkdir -p data/my_texts
FREE=$(df -g . | awk 'NR==2 {print $4}')
if [[ "$CHOICE" == Wikipedia* ]]; then
  [ "$FREE" -lt 4 ] && { echo "Only $FREE GB free; downloading and extracting Wikipedia needs about 4 GB at peak (the downloads are deleted after extraction)."; read -r -p "Press Return to close."; exit 1; }
  .venv/bin/python -m guru corpus --langs sa,hi,en || { read -r -p "Press Return to close."; exit 1; }
else
  .venv/bin/python -m guru build || { read -r -p "Press Return to close."; exit 1; }
fi
.venv/bin/python -m guru tokenizer && .venv/bin/python -m guru encode
echo; echo "Your own texts count three times as much as Wikipedia. The Ashtadhyayi (3,983 sutras) and the Dhatupatha are always included."; echo "Add more to guru/data/my_texts any time and run this again."
echo "Next: double-click 'Guru 3 - Train.command'."
read -r -p "Press Return to close."
