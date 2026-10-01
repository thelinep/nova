---
id: desktop-app
title: The desktop app and portable pack
section: Desktop app
order: 60
summary: Build NOVA Runtime.app, the disk image and the portable folder with one double-click, open an unsigned build, use the menu bar item and know where the app keeps its data.
keywords: desktop app build nova app command tauri dmg zip portable folder start nova command unsigned gatekeeper privacy security menu bar tray bundled node dist
---
## Build the app

Double-click **Build NOVA app.command** in the brahmini folder. It:

1. Runs the unit tests (on temporary data) and stops if any fail.
2. Downloads the official Node runtime from nodejs.org, checks its checksum and bundles it, so the app runs on Macs without Homebrew or Node.
3. Builds **NOVA Runtime.app** with Tauri (needs Rust from rustup.rs; it installs the Tauri tool the first time).
4. Makes a `.dmg` disk image when macOS allows it.
5. Makes a portable folder and checks that it starts.

Everything lands in `nova-console/packaging/dist/`, named like `NOVA-Runtime-<version>-<commit>-mac-arm64`, with a build log and a test log. Packing needs about 3 GB free; the script stops early if there is less.

| File | Use |
| --- | --- |
| `….dmg` | Open it and drag NOVA Runtime to Applications |
| `….app.zip` | The same app, zipped |
| `…-portable.tar.gz` | A folder that runs NOVA in your browser, no install |

## Open an unsigned build

The app is not signed with an Apple Developer ID or notarized, so it is for your own Macs and people you trust. The first time, right-click the app and choose **Open**, or allow it in **System Settings → Privacy & Security**.

## Using the app

The app starts NOVA's server first and opens the window once the server answers. The **menu bar item** has **Show NOVA**, **Hide NOVA**, **Refresh workspace** and **Quit NOVA**. **Hide NOVA** keeps it running in the menu bar. Quitting the app (**Quit NOVA** or ⌘Q) also stops the server.

## Portable folder

Unpack the `.tar.gz` and double-click **Start NOVA.command**. It starts NOVA with the Node runtime inside the folder and opens `http://127.0.0.1:8787` in your browser. Close the Terminal window to stop it. It uses the same data folder as the app, so both see the same sessions and media.

## Browser development mode

From `nova-console`, run `npm start` and open `http://127.0.0.1:8787/`. Optional settings:

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | `8787` | Change the local port |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Use Ollama at another address |
| `DATA_DIR` | `./data` | Keep the database somewhere else |
| `NOVA_LIBRARY_DIR` | `~/Documents/NOVA Library` | Where made files are saved |

## What the app does not include

Ollama, ComfyUI and the media engines are separate. Install them with the "Install … for NOVA" scripts; **Check NOVA on this Mac.command** reports what is missing.

The app also leaves out two developer tools. Everything else works without them:

- **The agent browser** needs Playwright, which comes with the source folder (`npm install` in `nova-console`). See [The agent browser](help:agent-browser).
- **Proof checking** in the correctness pipeline needs Dafny (`brew install dafny`). See [Built, not yet in the console](help:developer-preview).

The support report shows whether each one is available.
