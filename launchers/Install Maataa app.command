#!/bin/bash
# Double-click to put the most recently built Maataa Workstation app into /Applications.
# Build it first with "Build NOVA app" (or "Build and install the Maataa app" in Maataa.command).
# An older copy already in /Applications is moved to the Trash (not deleted) after you agree.
# The app keeps its data in ~/Library/Application Support/com.brahmini.nova-runtime, separate from
# Maataa started from the brahmini folder (nova-console/data); models in Ollama are shared.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/nova-console/packaging/dist"
DEST="/Applications/Maataa Workstation.app"
pause(){ [ -n "$MAATAA_CHAIN" ] && return; read -r -t 600 -p "Press Return to close." _; }
fail(){ echo; echo "✗ $1"; pause; exit 1; }
ask(){ osascript -e "button returned of (display dialog \"$1\" buttons {\"$2\", \"$3\"} default button \"$3\" with title \"Maataa\")" 2>/dev/null; }

ZIP=$(ls -t "$DIST"/Maataa-Workstation-*-mac-*.app.zip 2>/dev/null | head -1)
[ -n "$ZIP" ] || fail "No built app found in $DIST. Run \"Build NOVA app\" first."
NAME=$(basename "$ZIP" .app.zip)
echo "Newest build: $NAME ($(date -r "$ZIP" '+%d %b %Y %H:%M'))"
if [ -d "$DEST" ]; then
  R=$(ask "Replace the Maataa Workstation app in Applications with $NAME? The old copy goes to the Trash." "Cancel" "Replace")
  [ "$R" = "Replace" ] || exit 0
  osascript -e 'tell application "Maataa Workstation" to quit' >/dev/null 2>&1; sleep 2
  osascript -e "tell application \"Finder\" to delete POSIX file \"$DEST\"" >/dev/null || fail "Could not move the old app to the Trash. Quit Maataa Workstation and try again."
else
  R=$(ask "Install $NAME into Applications?" "Cancel" "Install")
  [ "$R" = "Install" ] || exit 0
fi
ditto -x -k "$ZIP" /Applications || fail "Could not unpack the app into /Applications."
[ -d "$DEST" ] || fail "The app was unpacked but not found at $DEST."
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
echo "✓ Installed: $DEST"
R=$(ask "Open Maataa Workstation now? (If Maataa is already running from the brahmini folder on port 8787, quit that first.)" "Later" "Open")
[ "$R" = "Open" ] && open "$DEST"
pause
