---
id: install
title: Install and start NOVA
section: Getting started
order: 2
summary: The desktop app, the portable folder and browser mode, what each needs, and where NOVA keeps your data.
keywords: install setup download start launch requirements ollama node dmg app portable npm start
views:
---
There are three ways to run NOVA. They all run the same server and the same console.

| Way | Best for | How to start |
| --- | --- | --- |
| Desktop app | Everyday use | Open **NOVA Runtime.app** |
| Portable folder | Running without installing, or on another Mac | Double-click **Start NOVA.command** in the folder |
| Browser mode | Developing NOVA itself | `npm start` in `nova-console`, then open `http://127.0.0.1:8787/` |

## What you need

- **A Mac with Apple silicon** for the packed app and portable folder. Both carry their own Node runtime, so you do not need to install Node for them. Browser mode needs Node 22.5 or newer.
- **Ollama** for chat, embeddings, evaluations and automations. Install it from ollama.com, then pull at least one model, for example `ollama pull llama3.2`. NOVA opens without Ollama, but anything that needs a model reports that Ollama is unavailable.
- **Optional engines** for media: ComfyUI for images, songs and sound effects; LTX-2 for AI video; whisper.cpp for transcripts; Kokoro for better voices. Each has a double-click installer in the brahmini folder. See [Images](help:media-images), [Video](help:media-video) and [Audio, songs and transcripts](help:media-audio).

## The desktop app

1. Open **NOVA Runtime.app**. NOVA starts its local server first, then shows the Console.
2. The first time, macOS may block it because the app is not notarized. Open **System Settings > Privacy & Security** and choose **Open Anyway**, or right-click the app and choose **Open**.
3. Closing NOVA also stops its server. A NOVA icon in the menu bar can show, hide or refresh the window.

To make a fresh copy of the app, the dmg and the portable folder from the source, see [The desktop app and packing](help:desktop-app).

## Browser mode

From the `nova-console` folder:

```
npm start
```

Then open `http://127.0.0.1:8787/`. Use that address rather than opening `public/index.html` directly. Optional settings:

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | `8787` | Another local port for NOVA |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama on another local address |
| `DATA_DIR` | `./data` | Where browser mode keeps its database |
| `NOVA_LIBRARY_DIR` | `~/Documents/NOVA Library` | Where NOVA saves what it makes |

## Where NOVA keeps your data

| Running as | Database and log |
| --- | --- |
| Desktop app or portable folder | `~/Library/Application Support/com.brahmini.nova-runtime/` |
| Browser mode | `nova-console/data/` (or `DATA_DIR`) |

The folder holds `nova.db` (the database) and, for the app, `nova-runtime-server.log`. Everything NOVA makes is also saved as ordinary files in `~/Documents/NOVA Library`. Do not edit or delete `nova.db` while NOVA is running. The app and browser mode keep separate data, so sessions from one do not appear in the other.

> **Important** Back up the data folder only while NOVA is closed, and keep backups private: they contain your conversations, documents and history.
