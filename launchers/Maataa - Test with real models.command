#!/bin/bash
# Double-click: run Maataa's coding loop and text skills against a REAL local Ollama model.
# Pick a model from the list (or several). Nothing touches your projects: each check uses a temporary folder.
# Reports are saved in nova-console/data/checks/real-models-<model>.json and ~/Maataa-real-models.log
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$ROOT/nova-console" || exit 1
up(){ curl -s -m 2 -o /dev/null -w '%{http_code}' "$1" | grep -q '^2'; }
command -v node >/dev/null || { echo "Node is not installed (Maataa needs Node 22.5 or newer)."; exit 1; }
if ! up http://127.0.0.1:11434/api/tags; then
  command -v ollama >/dev/null || { echo "Ollama is not installed. Get it from https://ollama.com"; exit 1; }
  echo "Starting Ollama…"; (open -a Ollama 2>/dev/null || nohup ollama serve > "$HOME/ollama.log" 2>&1 &)
  for i in $(seq 1 20); do up http://127.0.0.1:11434/api/tags && break; sleep 1; done
fi
MODELS=$(curl -s http://127.0.0.1:11434/api/tags | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of JSON.parse(s).models||[])console.log(m.name)})' | grep -viE 'embed|whisper')
[ -n "$MODELS" ] || { echo "No models are installed in Ollama. Install one first, e.g.:  ollama pull llama3"; exit 1; }
LIST=$(printf '%s\n' "$MODELS" | sed 's/.*/"&"/' | paste -sd, -)
FIRST=$(printf '%s\n' "$MODELS" | grep -E '^maataa' | head -1); FIRST=${FIRST:-$(printf '%s\n' "$MODELS" | head -1)}
PICK=$(osascript -e "set c to choose from list {$LIST} with title \"Maataa\" with prompt \"Which models should be tested? (Cmd-click for several)\" default items {\"$FIRST\"} with multiple selections allowed" -e 'if c is false then return ""' -e 'set AppleScript'"'"'s text item delimiters to linefeed' -e 'return c as text' 2>/dev/null)
[ -n "$PICK" ] || { echo "Nothing chosen."; exit 0; }
mkdir -p data/checks; : > "$HOME/Maataa-real-models.log"; SUMMARY=""
while IFS= read -r M; do
  [ -n "$M" ] || continue
  SAFE=$(printf '%s' "$M" | tr '/:' '__')
  echo; echo "════ Testing $M (this can take several minutes)"
  if node --no-warnings scripts/validate-real-models.js "$M" --out "data/checks/real-models-$SAFE.json" 2>&1 | tee -a "$HOME/Maataa-real-models.log"; then
    SUMMARY="$SUMMARY\n  PASS  $M"; else SUMMARY="$SUMMARY\n  FAIL  $M"; fi
done <<< "$PICK"
echo; echo "════ Summary"; printf "$SUMMARY\n"
echo; echo "Details: nova-console/data/checks/ and ~/Maataa-real-models.log. You can close this window."
