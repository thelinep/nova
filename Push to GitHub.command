#!/bin/bash
# Double-click to push this repository to GitHub (origin): the working branch and master.
# Uses your Mac's saved GitHub login. Nothing is force-pushed.
cd "$(dirname "$0")" || exit 1
echo "Pushing codex/absorb-tlps-locations and master to $(git remote get-url origin)…"
git push origin codex/absorb-tlps-locations && git push origin master && echo && echo "== Done. GitHub is up to date." || echo "Push failed: see the message above (a login prompt or 'non-fast-forward' needs you)."
git status -sb | head -1
echo "You can close this window."
