---
id: welcome
title: Welcome to Maataa
section: Getting started
order: 1
summary: What Maataa is, how the screen is organised, and what stays on your computer.
keywords: overview introduction about local private offline nova renamed maataa workstation name
views:
---
Maataa Workstation is a workspace for local AI. You chat with models that run on your computer, search your own documents, make images, video and audio, run skills and tools, build agents and workflows, and change code in folders you approve. Maataa's server listens only on `127.0.0.1:8787`, so nothing on your network can reach it.

> **Note** Maataa Workstation used to be called NOVA. It is the same app with the same data: your sessions, models, knowledge, characters and evidence are where they were. NOVA is still its engineering name, so you will see it in file names such as **Build NOVA app.command**. The helper keeps the name Nova.

@screen media/console.jpg "The Console: sessions on the left, the conversation in the middle, the inspector on the right."

## How Maataa is organised

The sidebar groups every screen by what you do there:

| Group | Screens | What they are for |
| --- | --- | --- |
| Create | Image, Video, Audio, Voice Studio, Boards, Timeline, Library | Making media on this computer, arranging it and cutting it together |
| Workspace | Console, Sessions, Local Workspace | Chatting with models, and changing code in approved folders |
| Intelligence | Models, Knowledge, Retrieval Lab | The models you have, your documents, and testing search over them |
| Operations | Automations, Evaluations, Workbench, Agent Browser | Scheduled runs, model comparisons, oversight of background work, and the browser agents use |
| Capabilities | Skills, MCP Registry, Agents, Workflows, Neuron Factory, Collector, Capability Graph, Provider Browser | What models may do, and the guard rails around it |
| System | Runtime, Trace, Git Updates, Execution History, Diagnostics, Settings, Help & Support | Seeing what happened and keeping Maataa healthy |

Read [A tour of the interface](help:interface) for the top bar, the command palette and the status bar. The face in the bottom right corner is [the helper](help:helper): ask it how to do anything, or let it walk you through a task.

## Oversight

[Workbench](help:workbench) shows what Maataa is running in the background, what waits for your decision and what broke, and has the **kill switch** that stops it all. The **setup** pill in the top bar counts [five steps](help:getting-started-checklist) from a fresh install to work Maataa has checked.

## What stays on your computer

- Your conversations, documents, media, settings and history are stored in a local database and in ordinary files on this computer.
- Models run through Ollama on this computer. Image, video and audio models run in ComfyUI or local tools on this computer.
- Maataa uses the network only when you turn on **Settings > Privacy > Allow network access**, for example to install packages or let the browser tool open a web page. The pill in the top bar says **LOCAL ONLY** while that is off.
- Tools that can change things (files, git, the browser) ask for your approval, and agents and workflows follow the same rules.
- Background work follows [policies and budgets](help:safety-controls), and **halt** in Workbench stops it at once.

> **Tip** Some records in a new install are examples that show how a screen works (a few sessions, agents and workflows). A model synced from Ollama, an indexed document, a connected tool server and a finished run in Execution History are the signs that something is really working.

## Where to go next

1. [Install and start Maataa](help:install)
2. [First steps](help:first-steps): check everything works, sync your models and send a first message
3. [The setup checklist](help:getting-started-checklist)
4. [Chat and sessions](help:chat)
