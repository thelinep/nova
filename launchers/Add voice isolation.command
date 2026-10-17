#!/bin/bash
# Double-click to add voice isolation (Demucs, about 2.5 GB) for Maataa run from this folder.
# For the installed Maataa app, use Setup → Install → Voice isolation inside the app instead.
cd "$(dirname "$0")/../nova-console" || exit 1
bash scripts/add-voice-isolation-mac.sh 2>&1 | tee "$HOME/Voice-isolation-install.log"
echo; echo "Log saved to ~/Voice-isolation-install.log. You can close this window."
