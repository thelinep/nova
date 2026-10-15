---
id: install
title: Install and start Maataa
section: Getting started
order: 2
summary: The desktop app, the portable folder and browser mode, what each needs, and where Maataa keeps your data.
keywords: install setup download start launch requirements ollama node dmg app portable npm start
views: install
---
There are three ways to run Maataa. They all run the same server and the same console.

| Way | Best for | How to start |
| --- | --- | --- |
| Desktop app | Everyday use | Open **Maataa Workstation.app** |
| Portable folder | Running without installing, or on another Mac | Double-click **Start NOVA.command** in the folder |
| From the brahmini folder | Your own checkout | Double-click **Maataa.command** and choose **Open Maataa** |
| Browser mode | Developing Maataa itself | `npm start` in `nova-console`, then open `http://127.0.0.1:8787/` |

## One launcher: Maataa.command

The brahmini folder has one launcher, **Maataa.command**. Double-click it for a menu:

- **Open Maataa**: starts Ollama and Maataa if needed, then opens the console.
- **Start coding**: makes sure a coding model is there and offers the coding checks.
- **Install components**: opens the Install page (below).
- **Build and install the Maataa app**: builds a fresh app from this folder and puts it in Applications.
- Submenus for media installers, Guru and the event directory, plus the Maataa AAI set-up, the self-check and Push to GitHub.

Every item runs a script in `brahmini/launchers`; you can still double-click those directly.

## The Install page

Open **Install** in the sidebar (under System). It lists everything optional: Ollama and the local models, ComfyUI and its image, sound and video models, Kokoro voices, the multilingual speech model, LTX-2 video, the AAI engine, the agent browser and, when Maataa runs from the brahmini folder, Guru's Python.

For each one it shows:

- whether it is installed, partly installed or missing;
- how much it downloads and how much free disk it needs;
- why it can't be installed yet, for example it needs ComfyUI first, more memory than this Mac has, or more free space.

**Install** runs the same installer the launchers use, one at a time, as an Activity job with a log; models are pulled through Ollama with progress. For a local model, **Run the coding checks** starts its 18 checks. Nothing is removed.

## What you need

- **A Mac with Apple silicon** for the packed app and portable folder. Both carry their own Node runtime, so you do not need to install Node for them. Browser mode needs Node 22.5 or newer.
- **Ollama** for chat, embeddings, evaluations and automations. Install it from ollama.com, then pull at least one model, for example `ollama pull llama3.2`. Maataa opens without Ollama, but anything that needs a model reports that Ollama is unavailable.
- **Optional engines** for media: ComfyUI for images, songs and sound effects (install it from **Settings > Image engine**; Maataa starts and stops it for you); LTX-2 for AI video; whisper.cpp for transcripts; Kokoro for better voices. Each installs from the **Install** page in Maataa, or with a double-click installer in brahmini/launchers. See [Images](help:media-images), [Video](help:media-video) and [Audio, songs and transcripts](help:media-audio).

## The desktop app

1. Open **Maataa Workstation.app**. Maataa starts its local server first, then shows the Console.
2. The first time, macOS may block it because the app is not notarized. Open **System Settings > Privacy & Security** and choose **Open Anyway**, or right-click the app and choose **Open**.
3. Closing Maataa also stops its server. A Maataa icon in the menu bar can show, hide or refresh the window.

To make a fresh copy of the app, the dmg and the portable folder from the source, see [The desktop app and packing](help:desktop-app).

## Browser mode

From the `nova-console` folder:

```
npm start
```

Then open `http://127.0.0.1:8787/`. Use that address rather than opening `public/index.html` directly. Optional settings:

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | `8787` | Another local port for Maataa |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama on another local address |
| `DATA_DIR` | `./data` | Where browser mode keeps its database |
| `NOVA_LIBRARY_DIR` | `~/Documents/NOVA Library` | Where Maataa saves what it makes |

## Where Maataa keeps your data

| Running as | Database and log |
| --- | --- |
| Desktop app or portable folder | `~/Library/Application Support/com.brahmini.nova-runtime/` |
| Browser mode | `nova-console/data/` (or `DATA_DIR`) |

The folder holds `nova.db` (the database) and, for the app, `nova-runtime-server.log`. Everything Maataa makes is also saved as ordinary files in `~/Documents/NOVA Library`. Do not edit or delete `nova.db` while Maataa is running. The app and browser mode keep separate data, so sessions from one do not appear in the other.

> **Important** Back up the data folder only while Maataa is closed, and keep backups private: they contain your conversations, documents and history.
