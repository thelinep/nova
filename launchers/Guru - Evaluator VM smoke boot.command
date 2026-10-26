#!/bin/bash
# Double-click to boot the Guru evaluator VM ONCE as a disposable run:
#   recover leftovers -> check the base image (SHA-256) -> fresh overlay -> boot with
#   no network, no shared folders, no QEMU monitor, 2 CPU / 4 GB, 15-minute limit
#   -> destroy the overlay and write a destruction receipt.
# The base image is only read, never changed. Nothing else is given to the VM.
# This is a smoke boot, NOT evaluator qualification. Runs and receipts: ~/.maataa/evaluator-vm-runs
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
pause(){ read -r -t 900 -p "Press Return to close." _; }
fail(){ echo; echo "✗ $1"; pause; exit 1; }

VMDIR="$HOME/Library/Application Support/Guru Evaluator VM"
RUNS="$HOME/.maataa/evaluator-vm-runs"
[ -d "$VMDIR" ] || fail "No evaluator VM folder at: $VMDIR"
QIMG=$(python3 -c 'import os,shutil;p=shutil.which("qemu-img");print(os.path.realpath(p) if p else "")')
QSYS=$(python3 -c 'import os,shutil;p=shutil.which("qemu-system-aarch64");print(os.path.realpath(p) if p else "")')
[ -x "$QIMG" ] && [ -x "$QSYS" ] || fail "QEMU is not installed (brew install qemu)."
FW="$(dirname "$QSYS")/../share/qemu/edk2-aarch64-code.fd"
[ -f "$FW" ] || fail "UEFI firmware not found next to QEMU: $FW"
FW=$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$FW")
PY=""; for c in /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 python3; do command -v "$c" >/dev/null && "$c" -c 'import sys;sys.exit(sys.version_info<(3,10))' && { PY="$c"; break; }; done
[ -n "$PY" ] || fail "Python 3.10 or newer is needed."

IMAGES=(); while IFS= read -r f; do IMAGES+=("$f"); done < <(find "$VMDIR" -maxdepth 2 -type f -name '*.qcow2' 2>/dev/null | sort)
[ ${#IMAGES[@]} -gt 0 ] || fail "No .qcow2 image found in $VMDIR"
echo "qcow2 images found in the evaluator VM folder:"; for f in "${IMAGES[@]}"; do echo "   $(du -h "$f" | cut -f1)  ${f#$VMDIR/}"; done
if [ ${#IMAGES[@]} -eq 1 ]; then BASE="${IMAGES[0]}"; else
  LIST=""; for f in "${IMAGES[@]}"; do LIST="$LIST, \"${f#$VMDIR/}\""; done
  PICK=$(osascript -e "set c to choose from list {${LIST#, }} with title \"Guru evaluator VM\" with prompt \"Which image is the clean base?\"" -e 'if c is false then return ""' -e 'return item 1 of c' 2>/dev/null)
  [ -n "$PICK" ] || exit 0; BASE="$VMDIR/$PICK"
fi
echo "Base image: ${BASE#$VMDIR/}"
mkdir -p "$HOME/.maataa"
cd "$ROOT/guru" || fail "guru folder missing"
"$PY" -m guru.evaluator_vm.smoke_cli --base "$BASE" --run-root "$RUNS" --qemu-img "$QIMG" --qemu-system "$QSYS" --firmware "$FW" --wall-seconds 900
CODE=$?
stty sane 2>/dev/null
echo; [ $CODE -eq 0 ] && echo "✓ VM booted and was destroyed; no run files or QEMU process left." || echo "✗ Smoke boot did not finish cleanly (see above)."
pause
