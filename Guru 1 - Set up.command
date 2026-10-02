#!/bin/bash
# Double-click once: makes a private Python environment for Guru (guru/.venv) with PyTorch and the tokenizer.
# About 1 GB of disk. Safe to run again (it updates).
cd "$(dirname "$0")/guru" || exit 1
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
PY="$(command -v python3)"
[ -z "$PY" ] && { echo "Python 3 is not installed. Install it from python.org, then try again."; read -r -p "Press Return to close."; exit 1; }
FREE=$(df -g . | awk 'NR==2 {print $4}')
[ "$FREE" -lt 3 ] && { echo "Only $FREE GB free. Guru needs about 3 GB to set up and more for its corpus; free some space first."; read -r -p "Press Return to close."; exit 1; }
say "Making guru/.venv with $("$PY" --version)"
[ -d .venv ] || "$PY" -m venv .venv || { echo "Could not make the environment."; read -r -p "Press Return to close."; exit 1; }
.venv/bin/python -m pip install -q --upgrade pip
say "Installing PyTorch, SentencePiece and friends (a few minutes the first time)"
.venv/bin/python -m pip install -q -r requirements.txt || { echo "Install failed; see above."; read -r -p "Press Return to close."; exit 1; }
say "Checking"
.venv/bin/python - <<'PY'
import torch, sentencepiece
mps = torch.backends.mps.is_available()
print(f"PyTorch {torch.__version__} · Apple GPU (MPS): {'yes' if mps else 'no, training will use the CPU (much slower)'}")
PY
.venv/bin/python -m unittest discover -s tests 2>&1 | tail -3
.venv/bin/python -m guru sizes
echo; echo "Next: double-click 'Guru 2 - Get corpus.command'."
read -r -p "Press Return to close."
