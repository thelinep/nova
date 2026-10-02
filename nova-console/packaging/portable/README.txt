Maataa Workstation (portable)

Double-click "Start Maataa.command". It starts Maataa with the Node runtime in this
folder and opens http://127.0.0.1:8787 in your browser. Close the Terminal
window to stop it.

Data is kept in ~/Library/Application Support/com.brahmini.nova-runtime, the
same place the Maataa Workstation app uses, so the app and this folder share
sessions, models, agents and media records.

Maataa needs Ollama for chat and agents, and ComfyUI (and the other engines set
up by the "Install … for Maataa" scripts in the brahmini folder) for images,
video and audio. The user guide is in docs/NOVA_USER_GUIDE.md.

Built for Apple silicon Macs (arm64). Unsigned: if macOS blocks it, right-click
"Start Maataa.command" and choose Open.
