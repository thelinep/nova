#!/bin/bash
# Maataa — the one launcher. Double-click it and choose what to do.
# Every action runs one of the scripts in the launchers/ folder (you can still double-click those
# directly); this menu only finds them for you. Nothing here deletes anything.
ROOT="$(cd "$(dirname "$0")" && pwd)"
L="$ROOT/launchers"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
up(){ curl -s -m 2 -o /dev/null -w '%{http_code}' "$1" | grep -q '^2'; }
# choose "prompt" item1 item2 … → prints the chosen item, or nothing when cancelled
choose(){
  local prompt="$1"; shift
  local list=""; for i in "$@"; do list="$list, \"$i\""; done
  osascript -e "set c to choose from list {${list#, }} with title \"Maataa\" with prompt \"$prompt\" default items {\"$1\"}" -e 'if c is false then return ""' -e 'return item 1 of c' 2>/dev/null
}
run(){ echo; echo "──── $1"; MAATAA_CHAIN="${MAATAA_CHAIN:-}" bash "$L/$1.command"; }
start_maataa(){
  if ! up http://127.0.0.1:11434/api/tags && command -v ollama >/dev/null; then
    echo "Starting Ollama…"; (open -a Ollama 2>/dev/null || nohup ollama serve > "$HOME/ollama.log" 2>&1 &)
    for i in $(seq 1 20); do up http://127.0.0.1:11434/api/tags && break; sleep 1; done
  fi
  if ! up http://127.0.0.1:8787/api/health; then
    command -v node >/dev/null || { echo "Node is not installed (Maataa needs Node 22.5 or newer). Or install the Maataa app."; return 1; }
    cd "$ROOT/nova-console" || return 1
    [ -d node_modules ] || { echo "Installing Maataa's packages (first time only)…"; npm install --no-audit --no-fund >/dev/null 2>&1; }
    echo "Starting Maataa…"; nohup node --no-warnings server.js > "$HOME/NOVA-server.log" 2>&1 &
    for i in $(seq 1 40); do up http://127.0.0.1:8787/api/health && break; sleep 1; done
    cd "$ROOT" || return 1
  fi
  up http://127.0.0.1:8787/api/health || { echo "Maataa did not start. The log is in $HOME/NOVA-server.log"; return 1; }
}

while true; do
  C=$(choose "What would you like to do?" \
    "Open Maataa" \
    "Start coding (model and coding checks)" \
    "Install components (opens the Install page)" \
    "Build and install the Maataa app" \
    "Build the Maataa app only" \
    "Install the last built app into Applications" \
    "Check Maataa on this Mac" \
    "Media installers…" \
    "Guru…" \
    "Event directory…" \
    "Maataa AAI engine (set up)" \
    "Compare song engines" \
    "Rename local model to guru-maataa" \
    "Push to GitHub")
  case "$C" in
    "") break ;;
    "Open Maataa") start_maataa && open "http://127.0.0.1:8787/" ;;
    "Start coding (model and coding checks)") run "Maataa - Start coding" ;;
    "Install components (opens the Install page)") start_maataa && open "http://127.0.0.1:8787/#install" ;;
    "Build and install the Maataa app") MAATAA_CHAIN=1 run "Build NOVA app" && run "Install Maataa app" ;;
    "Build the Maataa app only") run "Build NOVA app" ;;
    "Install the last built app into Applications") run "Install Maataa app" ;;
    "Check Maataa on this Mac") run "Check NOVA on this Mac" ;;
    "Media installers…")
      M=$(choose "Media installers (the same ones the Install page runs)" "Install ComfyUI for NOVA" "Start ComfyUI for NOVA" "Add upscale model" "Add tensor view" "Add audio models" "Add ACE-Step 1.5" "Install Kokoro voices for NOVA" "Add multilingual speech model" "Install LTX-2 video for NOVA" "Add Wan video models")
      [ -n "$M" ] && run "$M" ;;
    "Guru…")
      G=$(choose "Guru" "Guru 0 - Fix PyTorch" "Guru 1 - Set up" "Guru 2 - Get corpus" "Guru 3 - Train" "Guru 4 - Talk to Guru" "Guru 5 - Add Guru to Ollama" "Guru 6 - Look up a sutra")
      [ -n "$G" ] && run "$G" ;;
    "Event directory…")
      E=$(choose "Event directory" "Build event directory" "Rebuild event directory" "Fill event directory gaps from Google" "Build event map")
      [ -n "$E" ] && run "$E" ;;
    "Maataa AAI engine (set up)") run "AAI - Set up" ;;
    "Compare song engines") run "Compare song engines" ;;
    "Rename local model to guru-maataa") run "Rename local model to guru-maataa" ;;
    "Push to GitHub") run "Push to GitHub" ;;
  esac
done
echo "Bye."
