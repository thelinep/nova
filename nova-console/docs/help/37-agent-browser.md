---
id: agent-browser
title: The agent browser
section: Oversight
order: 37
summary: A separate, locked-down browser that agents use to open web pages, read them and fill them in, limited to allowed websites and recorded step by step.
keywords: agent browser browser service sandbox allowlist allowed websites egress domains download upload screenshot halt playwright profiles
views:
---
The agent browser is how NOVA's agents use websites. It is not your browser and it does not use your sign-ins. Each agent gets its own empty browser profile in NOVA's data folder.

It is different from two other browsers in NOVA:

- **Provider Browser** (Capabilities) is a window *you* use to sign in to AI providers.
- **Build a page from an image** checks pages in a browser with no network at all.

## What it can do

Open a page, click, type, read text, wait for something to appear, take a screenshot, download a file, upload a file, and close the page.

## What keeps it safe

- **Allowed websites only.** Every address the page tries to load, including images and scripts, is checked. Anything not on the allowed list, or not granted to that agent, is blocked and recorded.
- **Downloads and uploads need approval** every time, with the exact file named.
- **Every action is recorded:** pages opened, clicks, typing and blocked addresses. What was typed is stored only as a fingerprint (hash), not as text.
- **The kill switch closes it.** **halt** in Workbench closes every open agent page at once, and no new page opens until NOVA is resumed.
- Set `NOVA_BROWSER=0` before starting NOVA to turn the agent browser off completely.

## Requirements

The agent browser uses Playwright and its Chromium. They come with NOVA's source folder (`npm install` in `nova-console`), but not with the desktop app. In the app, asking for an agent page answers "The agent browser needs Playwright". Everything else in NOVA works without it. The support report shows whether it is available.

## Where it is used today

Agents in the multi-agent system and developer tools reach it through NOVA's local `/browser/…` service. The console's own agents and chat do not use it yet. See [Built, not yet in the console](help:developer-preview).
