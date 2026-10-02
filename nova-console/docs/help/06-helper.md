---
id: helper
title: The helper
section: Getting started
order: 6
summary: The face in the bottom right corner. Ask it how to do anything, hold its mic to talk, or let it walk you through a task step by step on screen.
keywords: helper companion assistant nova face ask how do i talk voice push to talk walkthrough show me tour guide notices character
views:
---
The face in the bottom right corner is NOVA's helper. Think of it as a colleague sitting next to you who knows NOVA well: ask it how to do something and it answers in a sentence or two, out loud if you like, and can show you the way.

@screen media/helper.jpg "Ask the helper; it answers from the help guides and offers to show you."

## Ask

- Click the face, type a question and press **Ask**, for example "how do I let NOVA change my code?".
- Or **hold the 🎙 button**, speak, and let go. Your voice is turned into text on this Mac (it needs whisper.cpp, like the microphone in chat). Talking while the helper is speaking cuts it off, as you would with a person.
- The helper knows which screen you are on, and answers from NOVA's own help guides. Under each answer, **From:** links to the guides it used.
- The face shows what it is doing: a red pulse while it listens, a turning ring while it thinks, and its mouth moves while it talks.

## Show me

When it helps, an answer ends with a button:

- **Show me** starts a walkthrough. NOVA opens the right screen, dims everything else and points at one control at a time with a short note (read aloud if you like). **Next**, **Back** and **Stop**, or press Esc.
- **Open …** goes to the screen it mentioned.

The chips under the conversation start walkthroughs directly: qualify a model for coding, make an image, let NOVA read a folder, let NOVA use this Mac, talk to NOVA, let agents open a website, give an agent a personality, and set up images.

@screen media/helper-tour.jpg "A walkthrough points at one control at a time."

## What it will not do

The helper explains and shows; it never presses buttons, changes settings or touches files itself. If it is not sure, it says so and suggests Help & Support. It runs on your local model, so an answer takes a second or two while the face shows it is thinking.

## Settings

Press ⚙ in the helper:

| Setting | What it does |
| --- | --- |
| Read answers aloud | Speak answers and walkthrough notes (on by default) |
| Tell me when something needs attention | Off by default. When on, the helper mentions only real changes: ComfyUI stopped and could not restart, NOVA was halted, or coding checks finished |
| Helper character | Use a [Voice Studio](help:voice-studio) character's name, face, personality and voice instead of Nova's |
| Hide the helper | Removes the face. Bring it back in **Settings > Helper** |
