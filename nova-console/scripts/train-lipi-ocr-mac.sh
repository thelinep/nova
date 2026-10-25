#!/bin/bash
# Lipi OS — retrain the Brahmi OCR model on this Mac from synthetic lines.
#   bash scripts/train-lipi-ocr-mac.sh [LINES] [EPOCHS]     (defaults: 120000 lines, 6 epochs; a few hours)
# The model goes to NOVA's data folder (models/lipi-ocr), and Maataa uses it from then on.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${LIPI_OCR_DIR:-$HOME/.maataa/lipi-ocr}"
LINES="${1:-120000}"; EPOCHS="${2:-6}"
APPDATA="$HOME/Library/Application Support/com.brahmini.nova-runtime"
# the app's data folder when the app is installed, otherwise the repo's (both are read by the matching server)
if [ -z "${DATA_DIR:-}" ]; then if [ -d "$APPDATA" ]; then DATA_DIR="$APPDATA"; else DATA_DIR="$HERE/data"; fi; fi
OUT="$DATA_DIR/models/lipi-ocr"; WORK="$DATA_DIR/models/lipi-ocr-work"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
"$DIR/bin/python" -c 'import torch, onnx, onnxruntime, cv2' 2>/dev/null || bash "$HERE/scripts/install-lipi-ocr-mac.sh" --train
cd "$HERE/tools/lipi-ocr"
[ -f maataa-lipi-brahmi.ttf ] || "$DIR/bin/python" -c "from fontTools.ttLib import TTFont; f=TTFont('$HERE/public/fonts/lipi/maataa-lipi-brahmi.woff2'); f.flavor=None; f.save('maataa-lipi-brahmi.ttf')"
mkdir -p "$OUT" "$WORK"
say "Making $LINES synthetic Brahmi lines"
"$DIR/bin/python" make_data.py "$WORK/train" "$LINES"
"$DIR/bin/python" make_data.py "$WORK/val" 2000 1 99
say "Training ($EPOCHS epochs)"
"$DIR/bin/python" train.py --data "$WORK/train" --val "$WORK/val" --out "$OUT/lipi-brahmi-ocr.onnx" --epochs "$EPOCHS"
[ "$DATA_DIR" = "$APPDATA" ] && [ -d "$HERE/data" ] && mkdir -p "$HERE/data/models/lipi-ocr" && cp "$OUT"/lipi-brahmi-ocr.* "$HERE/data/models/lipi-ocr/"
say "Done. Maataa now reads Brahmi with your model ($OUT). The training images in $WORK can be deleted."
