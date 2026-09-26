#!/bin/bash
# Double-click to add a multilingual speech-to-text model (whisper large-v3-turbo, about 575 MB),
# so NOVA can transcribe and translate Hindi and other languages, not just English.
cd "$(dirname "$0")/nova-console" || exit 1
bash scripts/add-whisper-model-mac.sh "$@" 2>&1 | tee "$HOME/Speech-model-install.log"
echo; echo "Log saved to ~/Speech-model-install.log. You can close this window."
