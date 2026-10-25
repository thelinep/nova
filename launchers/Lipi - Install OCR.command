#!/bin/bash
# Double-click to install the Lipi OS Brahmi OCR tools (about 80 MB).
cd "$(dirname "$0")/../nova-console" || exit 1
bash scripts/install-lipi-ocr-mac.sh 2>&1 | tee "$HOME/Lipi-Install-OCR.log"
echo; echo "Log saved to ~/Lipi-Install-OCR.log. You can close this window."
