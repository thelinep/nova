#!/bin/bash
# Double-click once: installs Maataa AAI's derivation engine (Vidyut's prakriya engine, MIT licence,
# about 3 MB) into Maataa Workstation's own folder. Nothing else on this Mac changes. Safe to run again.
# You can also press "Install derivation engine" in Maataa Workstation › Maataa AAI.
cd "$(dirname "$0")" || exit 1
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
PY="$(command -v python3)"
[ -z "$PY" ] && { echo "Python 3 is not installed. Run: xcode-select --install, then try again."; read -r -p "Press Return to close."; exit 1; }
DEST="$HOME/Library/Application Support/com.brahmini.nova-runtime/aai/venv"
say "Making the AAI environment with $("$PY" --version)"
mkdir -p "$(dirname "$DEST")"
[ -x "$DEST/bin/python" ] || "$PY" -m venv "$DEST" || { echo "Could not make the environment."; read -r -p "Press Return to close."; exit 1; }
say "Installing the derivation engine (vidyut 0.4.0)"
"$DEST/bin/python" -m pip install -q --disable-pip-version-check vidyut==0.4.0 || { echo "Install failed; see above."; read -r -p "Press Return to close."; exit 1; }
say "Checking: deriving भवति from भू"
echo '{"op":"tinanta","code":"01.0001","lakara":"Lat"}' | "$DEST/bin/python" nova-console/lib/aai_prakriya.py | "$DEST/bin/python" -c "
import json,sys; d=json.load(sys.stdin)
print('Derived', d['forms'][0]['text'], 'in', len(d['forms'][0]['steps']), 'steps, each citing its sutra.' if d.get('ok') else d)"
echo; echo "Done. Open Maataa Workstation › Maataa AAI › Derivation."
read -r -p "Press Return to close."
