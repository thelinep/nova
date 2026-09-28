---
id: monitoring
title: Diagnostics, Runtime, Trace and History
section: Operations
order: 50
summary: Find out what is working and what is not. Diagnostics checks each part, Runtime shows the machine, Trace is the live feed and Execution History is the lasting record.
keywords: diagnostics health check runtime cpu memory gpu trace live feed execution history audit record failed run investigate status bar
views: diagnostics,runtime,trace,history
---
## Diagnostics

Open **Diagnostics** first whenever something fails. It checks each part separately, so you can tell a NOVA problem from an Ollama problem:

| Check | What it means |
| --- | --- |
| NOVA Runtime backend | The local server. If this fails, nothing else works. |
| Ollama inference engine | Needed for chat, embeddings, agents and automations. |
| Model loaded | A synced model is selected and ready. |
| Knowledge index | Your collections and their indexing state. |
| Privacy boundary | Whether anything can leave this computer. |
| Automation health and Scheduler | Enabled automations and the timer that runs them. |
| Telemetry loop and Trace buffer | The live counters and activity feed are updating. |

Image, video, audio and transcription engines are checked on the **Support** tab of [Help & Support](help:support).

Press **Run diagnostics** to check again. The command palette (**⌘K**) has **Run diagnostics** too.

@screen media/diagnostics.jpg "Diagnostics with every part checked."

## Runtime

**Runtime** shows the local service, CPU, memory and, where macOS reports it, GPU use. Some values (thermal state, video memory) are not available on every Mac; NOVA shows "unavailable" rather than guessing.

@screen media/runtime.jpg "Runtime showing the local service and machine resources."

## Trace

**Trace** is a live feed of recent activity: requests, tool calls, agent steps and approvals as they happen. Use it to watch a run in progress.

@screen media/trace.jpg "Trace, the live activity feed."

## Execution History

**Execution History** is the lasting record of inference, skills, agents, workflows, approvals and other actions. It is paged from the server, so it covers everything, not only what is on screen. Search, filter by status (for example **failed**) and open an entry to see its input, output, timing and error. A support report includes the most recent failed entries.

@screen media/history.jpg "Execution History filtered to failed runs."

## Status bar

The bar along the bottom shows the backend state, the loaded model and the privacy state (for example **LOCAL ONLY**) at a glance.
