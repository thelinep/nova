#!/bin/bash
# Double-click to retrain the Lipi OS Brahmi OCR model on this Mac (several hours; installs PyTorch the first time).
cd "$(dirname "$0")/../nova-console" || exit 1
bash scripts/train-lipi-ocr-mac.sh 2>&1 | tee "$HOME/Lipi-Train-OCR.log"
echo; echo "Log saved to ~/Lipi-Train-OCR.log. You can close this window."
