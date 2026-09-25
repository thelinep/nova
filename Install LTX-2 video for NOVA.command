#!/bin/bash
# Double-click to install LTX-2 (local AI motion with sound). Needs about 30 GB free for the tool, weights and a test clip.
cd "$(dirname "$0")/nova-console" || exit 1
bash scripts/install-ltx-mac.sh 2>&1 | tee "$HOME/LTX-install.log"
echo; echo "Log saved to ~/LTX-install.log. You can close this window."
