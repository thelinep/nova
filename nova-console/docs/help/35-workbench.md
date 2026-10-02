---
id: workbench
title: Workbench
section: Oversight
order: 35
summary: One page that shows what Maataa is running, what is waiting for your decision, what it may do, what broke and what it produced, with the kill switch.
keywords: workbench approvals quarantine connector approve deny jobs queued running cancel kill switch halt resume passphrase operator audit policies budgets pipeline agents status strip
views:
---
**Workbench** is the oversight page for Maataa's background work: jobs, agents, connectors and automatic fixes. Open it from **Workbench** in the sidebar, or click the status strip in the top bar. It refreshes every 3 seconds.

@screen media/workbench.jpg "Workbench: seven panels, each answering one question."

## The status strip

The strip next to the setup pill reads like **0 · 0 · 0 · kill: clear · 0**. In order:

1. jobs queued
2. jobs running
3. items waiting for your decision
4. the kill switch: **clear**, or **HALTED** in red
5. jobs finished

Hover over it for the same numbers in words, and click it to open Workbench. The dot turns red when Maataa is halted or something needs attention.

## The panels

| Panel | Question it answers | What you can do |
| --- | --- | --- |
| Now | What is running? Queued and running jobs, and when the next one starts. | **cancel** a running job |
| Waiting | What needs a decision? | **apply** or **discard** a quarantined change; **approve** or **deny** a connector action; review a policy refusal |
| Allowed | What may act? The kill switch, policies (active, revoked, expired) and budget use. | **halt** or **resume** Maataa |
| Failed | What broke? Failed and timed-out jobs, and recent automatic rollbacks. | — |
| Created | What was produced? Finished jobs, known-good versions and approved autonomy runs. | — |
| Pipeline | Recent verification runs and their result. | — |
| Agents | Agents from the multi-agent system, their tasks, budgets and escalations. | — |

A panel that has nothing to show says so. On a new install most panels are empty until background work runs. See [Built, not yet in the console](help:developer-preview) for which parts of Maataa put work here today.

## Your name in the audit trail

The first time you act in Workbench, Maataa asks for your name. It is written next to every decision (who cancelled, approved or halted, and why) and remembered on this computer. The **operator** pill shows it.

## Approvals

- A **quarantine** is a change Maataa set aside instead of keeping, for example after an automatic fix failed its checks. **apply** keeps it; **discard** drops it.
- A **connector action** is something a connector wants to do outside Maataa, such as opening a pull request on GitHub, that its policy says needs a person. **approve** runs it once; **deny** refuses it.
- A **policy denial** is a record that a policy refused something in the last hour. It is there to read; nothing needs doing.

Every decision asks you to confirm, and is written to the audit log.

## The kill switch

**halt** stops Maataa's background work at its next safe point:

- background jobs and autonomy runs
- agents in the multi-agent system
- the agent browser (it closes every open page)
- computer actions from chat (running commands, clicking, typing, changing files)

Chat itself keeps working, so you can still ask questions while Maataa is halted.

@screen media/workbench-halt.jpg "Halting asks why, and the first time, for a resume passphrase."

**resume** needs the **resume passphrase**, so something that halted Maataa cannot quietly undo it:

1. The first time you halt (or resume), Maataa asks you to choose a passphrase of at least 6 characters.
2. After that, **resume** asks for that passphrase and a reason.

Maataa keeps only a scrambled (hashed) copy of the passphrase, in the data folder. On a server you can set `NOVA_RESUME_CREDENTIAL` instead, before starting Maataa.

> **Important** Write the passphrase down. If you lose it, see "I lost the resume passphrase" in [Troubleshooting](help:troubleshooting).

## Related

- [Policies, budgets and rollback](help:safety-controls)
- [Agent Browser](help:agent-browser)
- [The setup checklist](help:getting-started-checklist)
