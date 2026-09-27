#!/bin/bash
# Double-click to add ACE-Step 1.5 (better singing, Hindi and 50+ languages) to ComfyUI for NOVA. About 10 GB.
cd "$(dirname "$0")/nova-console" || exit 1
bash scripts/add-acestep15-mac.sh 2>&1 | tee "$HOME/ACE-Step-1.5-install.log"
echo; echo "Log saved to ~/ACE-Step-1.5-install.log. You can close this window."
