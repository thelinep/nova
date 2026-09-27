NOVA Runtime (portable)

Double-click "Start NOVA.command". It starts NOVA with the Node runtime in this
folder and opens http://127.0.0.1:8787 in your browser. Close the Terminal
window to stop it.

Data is kept in ~/Library/Application Support/com.brahmini.nova-runtime, the
same place the NOVA Runtime app uses, so the app and this folder share
sessions, models, agents and media records.

NOVA needs Ollama for chat and agents, and ComfyUI (and the other engines set
up by the "Install … for NOVA" scripts in the brahmini folder) for images,
video and audio. The user guide is in docs/NOVA_USER_GUIDE.md.

Built for Apple silicon Macs (arm64). Unsigned: if macOS blocks it, right-click
"Start NOVA.command" and choose Open.
