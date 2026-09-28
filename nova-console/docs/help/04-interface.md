---
id: interface
title: A tour of the interface
section: Getting started
order: 4
summary: The sidebar, top bar, command palette, inspector, status bar, per-screen help, list tools, and using NOVA in a narrow window or on a phone.
keywords: interface layout sidebar rail top bar command palette cmd k inspector status bar help search filter sort phone mobile narrow window keyboard
views:
---
## The sidebar

The sidebar on the left lists every screen, grouped by purpose. The button at the top left of the top bar folds it to icons. **New session** starts a conversation, and the search box filters your sessions list.

## The top bar

- **Command** (⌘K) opens the command palette: type part of a screen or action ("agents", "diagnostics", "new session") and press Enter.
- The **model pill** shows the model new messages use. Click it to change model.
- The **privacy pill** reads **LOCAL ONLY** while network access is off and the model runs locally, and changes when that is no longer true.
- The last button opens or closes the **inspector** on the right of the Console.

@screen media/command.jpg "The command palette jumps to any screen or action."

## The inspector

In the Console, the inspector shows what went into the last answer: **Context** (how the prompt budget was spent), **Sources** (retrieved passages), **Files**, **Retrieval**, **Inference** settings, **Runtime** and **Trace**. In narrower windows it slides over the conversation; close it with ×.

## The status bar

The strip at the bottom shows whether NOVA is local, CPU and memory use, GPU and VRAM where macOS reports them, the last generation speed (tokens per second), time to first token and how many jobs are queued.

## Help on every screen

- The **?** next to a screen's title opens a short explanation on the right, with **Read the full guide** to open the matching article in Help & Support.
- Some panels have their own **?** (Media's video, audio, filter and library panels).
- **Help & Support** in the System group has every guide, the FAQ, troubleshooting and the support report.

## Search, filter and sort

Every longer list (skills, sessions, models, documents, media, history, agents, tool servers) has a search box, a tag filter built from its badges (installed, running, failed…) and a sort. NOVA remembers your choices for each list.

## Narrow windows and phones

NOVA adapts to the window:

- Below about 1,180 pixels wide the Console's inspector becomes a drawer.
- Below about 820 pixels wide (a small window, or a phone opening `http://<your-mac>:8787` through a tunnel you set up yourself) the sidebar becomes a menu: press ☰ at the top left to open it, and it closes when you pick a screen. The sessions list opens from the button at the top right.

@screen media/phone-menu.jpg "At phone width the sidebar opens from the ☰ button."

> **Important** NOVA listens only on this computer. Do not expose port 8787 to other devices without adding your own authentication; NOVA has no login by design.
