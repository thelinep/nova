#!/bin/bash
# Double-click with Maataa open: adds the media gap cards (voice isolation, video upscale, speech to speech, …)
# to the Radheya board. Safe to run again; cards already there are skipped.
cd "$(dirname "$0")/../nova-console" || exit 1
NODE=$(command -v node || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -1)
[ -n "$NODE" ] || { echo "Node is missing (brew install node)."; exit 1; }
"$NODE" scripts/radheya-add-cards.js scripts/radheya-media-gap-cards.json
echo; echo "You can close this window."
