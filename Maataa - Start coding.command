#!/bin/bash
# Double-click to start Maataa for talking and building apps with a local model:
#   1. starts Ollama and Maataa Workstation (NOVA) if they are not running;
#   2. makes sure a coding model is installed — qwen2.5-coder:7b (about 4.7 GB, Apache-2.0)
#      when there is room, otherwise it offers a model you already have;
#   3. approves ~/Maataa Projects as the folder new apps go into;
#   4. offers to run the 18 coding checks once for that exact model (about 10–30 minutes);
#   5. opens Coding Studio in your browser.
# Nothing is deleted. Your projects are only written after you approve a change in Maataa.
ROOT="$(cd "$(dirname "$0")" && pwd)"
NOVA="$ROOT/nova-console"
cd "$NOVA" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
pause(){ read -r -t 600 -p "Press Return to close." _; }
fail(){ echo; echo "✗ $1"; pause; exit 1; }
say(){ echo; echo "== $1"; }
up(){ curl -s -m 2 -o /dev/null -w '%{http_code}' "$1" | grep -q '^2'; }
ask(){ osascript -e "button returned of (display dialog \"$1\" buttons {\"$2\", \"$3\"} default button \"$3\" with title \"Maataa\")" 2>/dev/null; }
CODER="qwen2.5-coder:7b"
NEED_GB=9   # 4.7 GB model plus room for the Mac to keep working

say "1/5 Checking this Mac"
command -v node >/dev/null || fail "Node is not installed (Maataa needs Node 22.5 or newer)."
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' || fail "Node $(node -v) is too old; Maataa needs 22.5 or newer."
command -v ollama >/dev/null || fail "Ollama is not installed. Get it from https://ollama.com/download, then double-click this again."
[ -d node_modules ] || { echo "   Installing Maataa's packages (first time only)…"; npm install --no-audit --no-fund >/dev/null 2>&1 || fail "npm install failed. Check the network and try again."; }
FREE=$(df -Pk "$HOME" | awk 'NR==2{print int($4/1048576)}')
RAM=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
echo "   Node $(node -v) · ${RAM} GB memory · ${FREE} GB free disk"

say "2/5 Starting Ollama"
if ! up http://127.0.0.1:11434/api/tags; then
  (open -a Ollama 2>/dev/null || nohup ollama serve > "$HOME/ollama.log" 2>&1 &)
  for i in $(seq 1 30); do up http://127.0.0.1:11434/api/tags && break; sleep 1; done
fi
up http://127.0.0.1:11434/api/tags || fail "Ollama did not start. Open the Ollama app once, then try again."
echo "   Ollama is running."

say "3/5 Coding model"
MODEL=""
if ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$CODER"; then
  MODEL="$CODER"; echo "   $CODER is installed."
elif [ "${FREE:-0}" -ge "$NEED_GB" ]; then
  R=$(ask "Download $CODER (about 4.7 GB, Apache-2.0 licence) as Maataa's coding model? You have ${FREE} GB free." "Not now" "Download")
  if [ "$R" = "Download" ]; then ollama pull "$CODER" || fail "The download did not finish. Double-click this again to resume it."; MODEL="$CODER"; fi
else
  echo "   Only ${FREE} GB free; $CODER needs about ${NEED_GB} GB to download safely."
  echo "   Large items you could clear yourself: old .dmg installers and zip files that are already unpacked in Downloads."
fi
if [ -z "$MODEL" ]; then
  HAVE=$(ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -vE 'vision|embed|3\.2|1b|0\.5b' | head -1)
  [ -n "$HAVE" ] || fail "No suitable local model is installed. Free about ${NEED_GB} GB and double-click this again."
  R=$(ask "Use $HAVE, which is already installed? It works, but it is weaker at writing code than $CODER." "Cancel" "Use $HAVE")
  [ "$R" = "Use $HAVE" ] || exit 0
  MODEL="$HAVE"
fi
echo "   Using $MODEL."

say "4/5 Starting Maataa Workstation"
if ! up http://127.0.0.1:8787/api/health; then
  nohup node --no-warnings server.js > "$HOME/NOVA-server.log" 2>&1 &
  for i in $(seq 1 40); do up http://127.0.0.1:8787/api/health && break; sleep 1; done
fi
up http://127.0.0.1:8787/api/health || fail "Maataa did not start. The log is in $HOME/NOVA-server.log"
STATUS=$(node scripts/start-coding.js status "$MODEL")
echo "$STATUS" | grep -q '^ERROR=' && fail "$(echo "$STATUS" | sed -n 's/^ERROR=//p')"
FOLDER=$(echo "$STATUS" | sed -n 's/^PROJECTS_FOLDER=//p')
echo "   New apps go into: $FOLDER"

say "5/5 Coding checks for $MODEL"
if echo "$STATUS" | grep -q '^READY=yes'; then
  echo "   $MODEL has passed the coding checks."
else
  R=$(ask "Maataa lets a model write code only after this exact version passes 18 coding checks. Run them now? It takes about 10–30 minutes; you can watch them in Activity." "Later" "Run the checks")
  if [ "$R" = "Run the checks" ]; then
    node scripts/start-coding.js qualify "$MODEL" | sed -n 's/^QUALIFY_JOB=/   Started checks: /p'
    echo "   When Activity shows them finished, build your first app in Coding Studio."
  else
    echo "   You can run them later from Coding Studio (Run coding checks now)."
  fi
fi

open "http://127.0.0.1:8787/#codingstudio"
echo
echo "Maataa is open. Talk to it in Chat, or describe an app under Build a new app in Coding Studio."
echo "You can also say in Chat, for example: \"मेरे लिए एक टिप कैलकुलेटर ऐप बनाओ\"."
pause
