#!/bin/bash
# Double-click to install Kokoro voices (natural offline text to speech: English, Hindi and more). About 400 MB.
cd "$(dirname "$0")/nova-console" || exit 1
bash scripts/install-kokoro-mac.sh 2>&1 | tee "$HOME/Kokoro-install.log"
echo; echo "Log saved to ~/Kokoro-install.log. You can close this window."
