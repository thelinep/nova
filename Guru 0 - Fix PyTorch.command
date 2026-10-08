#!/bin/bash
# Double-click to fix Guru's Python so training can use the Apple GPU (MPS).
# Two known problems on this Mac: PyTorch 2.3.1 (Guru needs 2.4 or newer), and MPS reported
# as unavailable — which usually means Python is the Intel (x86_64) build running under Rosetta.
# What it does: checks which Python Guru uses; if it is Intel and an Apple-silicon Python exists,
# it moves the old environment aside to guru/.venv-intel-old (nothing is deleted) and makes a new one;
# then installs Guru's requirements and checks that PyTorch sees the Apple GPU. Needs about 3 GB.
cd "$(dirname "$0")/guru" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
say(){ printf '\n\033[1m== %s\033[0m\n' "$*"; }
pause(){ read -r -t 600 -p "Press Return to close." _; }
fail(){ echo; echo "✗ $1"; pause; exit 1; }
arch_of(){ "$1" -c 'import platform; print(platform.machine())' 2>/dev/null; }

FREE=$(df -Pk . | awk 'NR==2{print int($4/1048576)}')
[ "${FREE:-0}" -ge 3 ] || fail "Only ${FREE} GB free; this needs about 3 GB. Free some space first."
[ "$(uname -m)" = arm64 ] || fail "This Mac reports $(uname -m). MPS needs an Apple-silicon Mac."

say "1/4 Which Python"
NATIVE=""
for p in /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3 /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 /usr/bin/python3 "$(command -v python3)"; do
  [ -x "$p" ] && [ "$(arch_of "$p")" = arm64 ] && { NATIVE="$p"; break; }
done
if [ -x .venv/bin/python ]; then
  echo "   guru/.venv uses $(.venv/bin/python --version 2>&1) for $(arch_of .venv/bin/python)."
  if [ "$(arch_of .venv/bin/python)" != arm64 ]; then
    [ -n "$NATIVE" ] || fail "guru/.venv is an Intel Python and no Apple-silicon Python was found. Install Python 3.12 from python.org (the universal installer) or with Homebrew, then double-click this again."
    say "Moving the Intel environment aside to guru/.venv-intel-old"
    mv -n .venv .venv-intel-old || fail "Could not move guru/.venv aside."
  fi
fi
if [ ! -x .venv/bin/python ]; then
  [ -n "$NATIVE" ] || fail "No Apple-silicon Python 3 was found. Install Python 3.12 from python.org (universal installer) or Homebrew, then try again."
  echo "   Making guru/.venv with $("$NATIVE" --version) ($NATIVE)"
  "$NATIVE" -m venv .venv || fail "Could not make guru/.venv."
fi

say "2/4 Installing PyTorch 2.4+ and Guru's requirements (several minutes)"
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q --upgrade "torch>=2.4" -r requirements.txt || fail "Install failed; see the messages above."

say "3/4 Checking the Apple GPU"
.venv/bin/python - <<'PY' || fail "PyTorch still does not see the Apple GPU. Send me the lines above."
import platform, sys, torch
print(f"   Python {sys.version.split()[0]} ({platform.machine()}) · PyTorch {torch.__version__}")
ok = torch.backends.mps.is_available()
print("   Apple GPU (MPS):", "yes" if ok else "no — built:", torch.backends.mps.is_built())
if ok:
    x = torch.ones(1024, 1024, device="mps"); print("   A test matrix multiply on the GPU worked:", float((x @ x).sum()) > 0)
sys.exit(0 if ok else 1)
PY

say "4/4 Guru's own tests"
.venv/bin/python -m unittest discover -s tests 2>&1 | tail -3
echo
echo "Done. Training can now use the Apple GPU ('Guru 3 - Train.command')."
echo "This fixes the local runtime only. A coding-capable Guru still needs a base model, cleared data"
echo "and GPU time — see guru/decisions/README.md."
pause
