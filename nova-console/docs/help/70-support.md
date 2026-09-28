---
id: support
title: Get help and support
section: Help and support
order: 70
summary: Use the Help Center, the ? panel on every screen, and the support report that gathers versions, engine status and recent errors without your private content.
keywords: help center support report diagnostics copy save logs contact bug report what to include privacy redacted question mark panel
views: help
---
## Help inside NOVA

- **Help & Support** (System group, or **⌘K** → Help) opens this Help Center: guides, FAQ, troubleshooting and the support report, all searchable and all working offline.
- The **?** next to each view title opens a short help panel for that screen. **Read the full guide** opens the matching article here.
- A copy of all this help is in `nova-console/docs/site/index.html`, which opens in any browser without NOVA running.

@screen media/help.jpg "The Help Center inside NOVA."

@screen media/help-drawer.jpg "The ? panel on Agents, with a link to the full guide."

@video media/help-tour.mp4 "Searching help, opening a guide and checking the Support tab."

## Make a support report

1. Open **Help & Support → Support**.
2. Read the checks at the top: backend, Ollama, engines and tool servers. Many problems are solved there, and each red check links to its fix.
3. Press **Copy report** to copy it, or **Save report** to write it to a file in the NOVA Library `support` folder.
4. Read it before you send it, then add what you did, what you expected and what happened.

@screen media/help-support.jpg "The Support tab with its checks and report."

## What the report contains

- NOVA version, Node version, macOS version and chip.
- The size of the database and the number of records in each area (not their contents).
- Ollama status and installed model names; image, video, audio and transcription engine status; connected tool servers.
- The most recent failed runs from Execution History: what kind of run, when, and the error message, shortened.
- The end of the server log, if you tick **Include log tail**.

Your home folder is replaced with `~`. The report never includes chats, documents, prompts, media, passwords or tokens. Even so, read it before you share it.

## What else to include

- Whether you used the app, the portable folder or `npm start`.
- The screen, the exact action and roughly when it happened.
- A screenshot of the problem, with anything private removed.

Do not send `nova.db`, private documents or a full log without reading it first.

## Next steps

- [Troubleshooting](help:troubleshooting) lists common problems by area.
- [FAQ](help:faq) answers the questions people ask most.
