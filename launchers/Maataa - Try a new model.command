#!/bin/bash
# Double-click: download one Ollama model, run Maataa's real-model checks on it, then keep or remove it.
# You can also pass the model name:  "./launchers/Maataa - Try a new model.command" gemma4:12b
# Nothing touches your projects. The download goes to Ollama's own folder (~/.ollama/models).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$ROOT/nova-console" || exit 1
up(){ curl -s -m 2 -o /dev/null -w '%{http_code}' "$1" | grep -q '^2'; }
command -v node >/dev/null || { echo "Node is not installed (Maataa needs Node 22.5 or newer)."; exit 1; }
command -v ollama >/dev/null || { echo "Ollama is not installed. Get it from https://ollama.com"; exit 1; }
M="$1"
[ -n "$M" ] || M=$(osascript -e 'text returned of (display dialog "Which Ollama model should be tried? (exact name from ollama.com/library)" default answer "gpt-oss:20b" with title "Maataa")' 2>/dev/null)
M=$(printf '%s' "$M" | tr -d '[:space:]')
[ -n "$M" ] || { echo "Nothing chosen."; exit 0; }
case "$M" in *[!A-Za-z0-9._:/-]*) echo "That does not look like a model name: $M"; exit 1;; esac
RAM_GB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
FREE_GB=$(df -g "$HOME" | awk 'NR==2 {print $4}')
echo "This Mac: ${RAM_GB} GB memory, ${FREE_GB} GB free disk."
if ! up http://127.0.0.1:11434/api/tags; then
  echo "Starting Ollama…"; (open -a Ollama 2>/dev/null || nohup ollama serve > "$HOME/ollama.log" 2>&1 &)
  for i in $(seq 1 20); do up http://127.0.0.1:11434/api/tags && break; sleep 1; done
fi
HAD=0; ollama list | awk 'NR>1 {print $1}' | grep -qx "$M" && HAD=1
if [ "$HAD" = 0 ]; then
  if [ "${FREE_GB:-0}" -lt 20 ]; then
    echo; echo "Only ${FREE_GB} GB is free. Models of this class are often 10-20 GB; the download may fail or fill the disk."
    read -r -p "Type yes to download anyway: " A; [ "$A" = "yes" ] || { echo "Stopped. Nothing was downloaded."; exit 0; }
  fi
  echo; echo "════ Downloading $M (this can take a long time)"
  ollama pull "$M" || { echo "The download failed. Check the exact name on ollama.com/library."; exit 1; }
fi
SIZE=$(ollama list | awk -v m="$M" '$1==m {print $3" "$4}')
echo; echo "════ Testing $M (${SIZE:-size unknown}); the first check is slow while the model loads"
SAFE=$(printf '%s' "$M" | tr '/:' '__'); mkdir -p data/checks
node --no-warnings scripts/validate-real-models.js "$M" --out "data/checks/real-models-$SAFE.json" 2>&1 | tee "$HOME/Maataa-try-model.log"
echo; echo "════ Result"; grep -F "passed for $M." "$HOME/Maataa-try-model.log" | tail -1
echo "Memory this model is using now:"; ollama ps 2>/dev/null | awk 'NR==1 || /./'
if [ "$HAD" = 0 ]; then
  K=$(osascript -e "button returned of (display dialog \"Keep $M on this Mac? (${SIZE:-several GB})\" buttons {\"Remove it\", \"Keep it\"} default button \"Keep it\" with title \"Maataa\")" 2>/dev/null)
  if [ "$K" = "Remove it" ]; then ollama rm "$M" && echo "Removed $M."; else echo "Kept $M. In Maataa press Models > Sync from Ollama to use it."; fi
fi
echo; echo "Details: nova-console/data/checks/real-models-$SAFE.json and ~/Maataa-try-model.log. You can close this window."
