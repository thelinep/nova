#!/bin/bash
# Double-click: switch GitHub CLI (gh) to the thelinep account, push, then switch back.
# Nothing is force-pushed. Your other projects keep using whichever account was active before.
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
TARGET=thelinep
if ! command -v gh >/dev/null; then
  echo "GitHub CLI (gh) is not installed. Install it with:  brew install gh"; echo "Then double-click this file again."; exit 1
fi
PREV=$(gh api user --jq .login 2>/dev/null)
echo "gh is currently using: ${PREV:-(not logged in)}"
if [ "$PREV" != "$TARGET" ]; then
  if gh auth status 2>&1 | grep -q "account $TARGET"; then
    gh auth switch --hostname github.com --user "$TARGET" || exit 1
  else
    echo; echo "Log in as '$TARGET' in the browser window that opens (use the code shown here)."
    gh auth login --hostname github.com --git-protocol https --web || { echo "Login cancelled."; exit 1; }
  fi
fi
NOW=$(gh api user --jq .login 2>/dev/null)
[ "$NOW" = "$TARGET" ] || { echo "Logged in as '$NOW', not '$TARGET'. Run this again and sign in as $TARGET."; exit 1; }
gh auth setup-git --hostname github.com
echo; echo "Pushing as $TARGET to $(git remote get-url origin)…"
git push origin codex/absorb-tlps-locations && git push origin master && OK=1
if [ -n "$PREV" ] && [ "$PREV" != "$TARGET" ]; then
  gh auth switch --hostname github.com --user "$PREV" >/dev/null 2>&1 && echo "Switched gh back to $PREV."
fi
echo; [ -n "$OK" ] && echo "== Done. GitHub is up to date." || echo "Push failed: see the message above."
git status -sb | head -1
echo "You can close this window."
