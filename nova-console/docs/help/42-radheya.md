---
id: radheya
title: Radheya (राधेय), the self-learning Kanban
section: Local Workspace
order: 42
summary: A Kanban board whose cards are worked by you, the local model, the observable agent browser or an online agent, and which learns from its own events. Only you move a card to Done, with evidence.
keywords: radheya राधेय kanban board cards wip limit backlog ready doing review done blocked local model ollama browser query search online agent openai anthropic evidence notes self-learning transformer baseline training round approve rollback
views: radheya
---
Radheya is a Kanban board that learns from the work done on it. Open **Radheya** under Workspace in the sidebar.

## The board

Cards move through six columns: **Backlog, Ready, Doing, Review, Done** and **Blocked**. Add a card with a title and, optionally, a description of what should be done. Select a card to edit it, move it, run it, and see its notes and evidence.

WIP limits stop a column from overfilling. By default Doing holds 3 cards and Review holds 5. Change the limits in **Board settings**; 0 means no limit.

## Who works a card

Under **Who works it**, choose one of four workers:

- **Person**: you do the work yourself.
- **Local model**: the Ollama model you choose answers the card. Nothing leaves the computer.
- **Browser**: the agent browser opens a page, or a search if you type one, and reads it. Choose a local model as well, and it answers the card from the page text, quoting the line it used.
  - The browser opens only sites listed under **Sites this card may open**, or sites already on the Agent Browser allow-list.
  - It needs Settings › Privacy › Allow network access.
  - Every page, request and screenshot is logged in the Agent Browser log.
- **Online agent**: an OpenAI-compatible or Anthropic endpoint you set up in Board settings. Your API key is kept in the encrypted local vault.
  - A card is sent only when you tick **May use an online agent** on it, and only with network access on.
  - The audit log keeps a hash of what was sent, never the text.

Press **Run with…** to start a run. The card moves to Doing while the run works. When it finishes:

- the answer is added as a note;
- a run record (with the SHA-256 of the output) is added as evidence;
- a browser run also adds its screenshot as evidence;
- the card moves to Review.

At most two cards run at a time. A halted Maataa runs nothing.

## Done needs you and evidence

Only a person can move a card to Done. The card must come from Review and carry at least one piece of evidence: a run record, a browser screenshot, or a link you add. Notes, including the answers agents write, are not evidence.

## How Radheya learns

Every create, move, assignment, note, evidence item and run is recorded as an event. Two learners predict what happens next to each card:

- **Baseline:** counts of past events. It is shown at once on every card. It gives:
  - the likely next column;
  - the chance that a run fails;
  - how long cards usually stay in the current column, against how long this one has been there.
- **Learned model:** a small transformer that reads a card's recent events. Its predictions are marked ◆ once you approve it.

**Run a training round** to train the current transformer shape and a few neighbouring shapes: wider, narrower, more heads, one more layer, or a longer context. Each is scored on cards held out from training, and the result is shown next to the baseline.

A shape is recommended only when all of these hold:

- there are at least 200 training events;
- there are at least 30 held-out predictions;
- its held-out loss beats both the baseline and the active model by 2%.

Even then, nothing is used until you press **Approve**. **Roll back the learned model** returns to the previous one, or to the baseline. **Download events** saves the event log as NDJSON.

With a small board the learned model will usually not be recommended. That is expected: work more cards and run another round.
