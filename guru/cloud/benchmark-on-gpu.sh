#!/usr/bin/env bash
# Run on a rented Linux GPU machine, ONLY after decision D4 in guru/decisions/README.md is approved.
# It measures; it does not train a model. For each preset it runs a fixed number of synthetic
# optimizer steps with `guru train --benchmark-steps` and saves throughput and peak GPU memory, which
# the compute plan needs before any long run is priced. Nothing is uploaded anywhere.
#
#   git clone https://github.com/thelinep/nova.git && cd nova && git checkout codex/absorb-tlps-locations
#   bash guru/cloud/benchmark-on-gpu.sh            # presets: base-1b (default)
#   SIZES="base-1b 7b" STEPS=20 bash guru/cloud/benchmark-on-gpu.sh
#
# Then copy guru/cloud/results/ back to the Mac and commit it as evidence.
set -euo pipefail
cd "$(dirname "$0")/.."
SIZES="${SIZES:-base-1b}"
STEPS="${STEPS:-10}"
SEQ="${SEQ:-}"   # empty = each preset's own context (base-1b 2048, 7b 4096)
OUT="cloud/results/$(date -u +%Y%m%dT%H%M%SZ)-$(hostname -s)"
mkdir -p "$OUT"

command -v nvidia-smi >/dev/null || { echo "No NVIDIA GPU found; this script is for a rented GPU machine."; exit 1; }
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv | tee "$OUT/gpus.csv"
NGPU=$(nvidia-smi -L | wc -l)

python3 -m venv .venv-gpu
.venv-gpu/bin/python -m pip install -q --upgrade pip
.venv-gpu/bin/python -m pip install -q -r requirements.txt
.venv-gpu/bin/python -c "import torch,sys;print('torch',torch.__version__,'cuda',torch.version.cuda,'gpus',torch.cuda.device_count());sys.exit(0 if torch.cuda.is_available() else 1)" | tee "$OUT/torch.txt"
git rev-parse HEAD > "$OUT/commit.txt" 2>/dev/null || true

for SIZE in $SIZES; do
  echo "== $SIZE · $STEPS synthetic steps · sequence ${SEQ:-preset} · $NGPU GPU(s)"
  EXTRA=(); [ -n "$SEQ" ] && EXTRA=(--benchmark-seq-len "$SEQ")
  LOG="$OUT/$SIZE.log"
  if [ "$NGPU" -gt 1 ]; then
    .venv-gpu/bin/torchrun --nproc_per_node "$NGPU" -m guru train --size "$SIZE" --benchmark-steps "$STEPS" "${EXTRA[@]}" 2>&1 | tee "$LOG" || echo "   $SIZE did not complete (see $LOG; the 7B preset is expected not to fit until sharding exists)."
  else
    .venv-gpu/bin/python -m guru train --size "$SIZE" --benchmark-steps "$STEPS" "${EXTRA[@]}" 2>&1 | tee "$LOG" || echo "   $SIZE did not complete (see $LOG)."
  fi
done
echo "Results are in guru/$OUT. Copy them back and commit them; then shut the machine down so billing stops."
