#!/bin/bash
# Maataa — add webcam capture for Character Studio: MediaPipe face and body tracking models
# (Apache-2.0, about 9 MB) into $NOVA_DATA_DIR/tools/mediapipe. Tracking runs locally in Maataa.
set -euo pipefail
NOVA_DATA_DIR="${NOVA_DATA_DIR:-$(cd "$(dirname "$0")/.." && pwd)/data}"
DIR="$NOVA_DATA_DIR/tools/mediapipe"
BASE="https://storage.googleapis.com/mediapipe-models"
mkdir -p "$DIR"; cd "$DIR"
get() { if [ -s "$2" ]; then echo "$2 already here"; else echo "== Downloading $2"; curl -L --fail --progress-bar -o "$2.part" "$BASE/$1" && mv "$2.part" "$2"; fi; }
get "face_landmarker/face_landmarker/float16/1/face_landmarker.task" face_landmarker.task
get "pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task" pose_landmarker_lite.task
for f in face_landmarker.task pose_landmarker_lite.task; do [ "$(wc -c < "$f")" -gt 1000000 ] || { echo "Stopped: $f looks incomplete."; rm -f "$f"; exit 1; }; done
echo "Done. In Maataa: Character Studio → 3D model → Capture."
