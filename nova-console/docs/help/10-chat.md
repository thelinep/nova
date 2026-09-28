---
id: chat
title: Chat and sessions
section: Chat and knowledge
order: 10
summary: Talk to a local model, attach images, cite your documents, make media from chat, and keep conversations organised.
keywords: console chat message session fork snapshot export attach image vision retrieval citations profile stop pause commands slash image video song
views: console,sessions
---
@screen media/console.jpg "A conversation in the Console, with retrieved sources under the answer."

## Send a message

1. Press **New session** (or pick one on the left).
2. Check the model in the model pill at the top right. Click it to choose another synced model.
3. Type in the box at the bottom and press Enter (Shift+Enter adds a line). The answer streams in; the line under it shows time to first token, speed and length.
4. Press the pause button that replaces send to stop a long answer. The status line under the box shows each stage: prefill, generating, tool runtime, complete.

If the selected model is an example record, or Ollama is not running, NOVA says so instead of inventing a reply. **Settings > Demo mode** allows clearly labelled simulated replies for trying the interface.

## Options under the message box

- **Paperclip**: attach PNG, JPEG, WebP or GIF images. Reading images needs a vision model, for example `ollama pull llama3.2-vision` or `llava`, then sync models. A text-only model refuses images and says why.
- **Retrieval**: when on, NOVA searches your Knowledge collections for passages that match your message and gives them to the model. Cited passages appear as chips under the answer with their match score.
- **Profile** (Balanced and your saved profiles): switches temperature, top-p, top-k and repeat penalty in one click. The Inference tab of the inspector shows the exact values.

## Make media from chat

Ask in plain words ("make an image of…", "create a video of…", "write a song about…", "compose background music…", "generate a sound effect of…") or start with `/image`, `/video`, `/song`, `/music`, `/sfx` or `/voice`. NOVA answers with a card: **Generate** runs the job on this computer and shows the result in the chat; **Open in Media** fills in the right Media tab so you can change settings first. An image attached to the message becomes the starting picture. Songs are written by your local model first, then sung by ACE-Step. See [Audio, songs and transcripts](help:media-audio).

## Fork, snapshot and export

The three buttons at the top of a conversation:

- **Fork** copies the session so you can try a different direction without losing the original.
- **Snapshot** saves the session as it is now.
- **Export** saves the conversation as a file.

## Sessions

**Sessions** lists every conversation. Search, filter by tag, pin the ones you use most, archive old ones and delete what you no longer need. Pinned sessions stay at the top of the Console list. Each row shows the date, number of messages and the model's quantization (for example `Q4_K_M`).

@screen media/sessions.jpg "Sessions: search, tag, pin and archive conversations."

> **Tip** A local model can still be asked to use a tool. Before you use agents or workflows with sensitive files, check which tools they may call; see [Tools and approvals](help:tools-approvals).
