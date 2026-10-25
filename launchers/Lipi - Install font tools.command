#!/bin/bash
# Double-click to install the font tools for the Lipi OS conjunct shape editor (fontTools, about 10 MB).
cd "$(dirname "$0")/../nova-console" || exit 1
bash scripts/install-font-tools-mac.sh 2>&1 | tee "$HOME/Lipi-font-tools-install.log"
echo; echo "Log saved to ~/Lipi-font-tools-install.log. You can close this window."
