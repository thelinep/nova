#!/bin/bash
# Double-click: look up Ashtadhyayi sutras by number (1.1.1, or a range 1.1.1-1.1.10), find them by
# words, or look up a root in the Dhatupatha. Works without "Guru 1 - Set up" (it needs only Python 3).
cd "$(dirname "$0")/guru" || exit 1
PY=.venv/bin/python; [ -x "$PY" ] || PY=python3
SCRIPT=$(osascript -e 'choose from list {"Devanagari", "IAST", "Brahmi", "Kharoshthi", "Siddham"} with title "Look up a sutra" with prompt "Show sutras in which script?" default items {"Devanagari"}')
[ "$SCRIPT" = "false" ] && exit 0
SCRIPT=$(echo "$SCRIPT" | tr '[:upper:]' '[:lower:]')
while true; do
  Q=$(osascript -e 'text returned of (display dialog "A sutra number (1.1.1), a range (6.1.77-6.1.80), words from a sutra (इको यण), or dhatu भू for a root:" default answer "1.1.1" buttons {"Done", "Look up"} default button "Look up" with title "Look up a sutra")' 2>/dev/null) || break
  [ -z "$Q" ] && break
  echo; echo "──────── $Q"
  case "$Q" in
    dhatu\ *|धातु\ *) "$PY" -m guru dhatu "${Q#* }" ;;
    *) "$PY" -m guru sutra "$Q" --script "$SCRIPT" ;;
  esac
done
