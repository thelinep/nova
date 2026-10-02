---
id: voice-studio
title: Voice Studio
section: Create
order: 24
summary: Make characters with a personality, a face and a voice, give them to agents, or let NOVA speak as one. Blend Kokoro voices, use macOS voices, or voices from the VoiceStudio app, including your own cloned voice.
keywords: voice studio characters persona personality speaking style face avatar voice kokoro blend mix pitch speed macos voicestudio clone cloned voice agents speak as
views: voicestudio
---
**Voice Studio** (Create group) is where you give NOVA's agents a personality. A character has:

- a name and who they are, for example "Meera, a calm first assistant director"
- a **personality** and a way of speaking
- a **language** to answer in
- a **face**, drawn by ComfyUI
- a **voice**

@screen media/voice-studio.jpg "Voice Studio: characters on the left, the character's personality, face and voice on the right."

## Make a character

1. Press **New character** and fill in the name, who they are, their personality and how they speak.
2. Choose a voice (below), type something in the preview box and press **▶ Preview** to hear it.
3. Press **Create character**.
4. Press **Make a face**. NOVA starts ComfyUI if needed and draws a portrait from the description. **Remove face** clears it.

## Voices

| Voice | What you get | Needs |
| --- | --- | --- |
| **Kokoro blend** | Mix up to three Kokoro voices by share, for example 70% Heart and 30% Emma, to make a voice of your own without recording anyone. Voices in English (US and UK), Hindi, Spanish, French, Italian, Japanese, Portuguese and Chinese. | Kokoro voices (double-click **Install Kokoro voices for NOVA.command**, about 400 MB) |
| **macOS voice** | Any voice built into macOS | Nothing |
| **VoiceStudio** | Voice profiles from the VoiceStudio app, including designed and cloned voices, in 600+ languages | The VoiceStudio app running |

**Speed** (0.6× to 1.6×) and **Pitch** (six semitones down to six up) work with every voice. Pitch needs ffmpeg (`brew install ffmpeg`).

## VoiceStudio app

[VoiceStudio](https://github.com/debpalash/VoiceStudio) is a separate, free desktop app for cloning and designing voices. NOVA talks to it over its local service at `http://127.0.0.1:3900` and never sends text anywhere else.

1. Install VoiceStudio from its website and open it.
2. To use your own voice, clone it inside VoiceStudio. It asks for the speaker's permission and adds an inaudible watermark to everything it makes.
3. In NOVA, choose **VoiceStudio** as a character's voice and press **Refresh**; your voice profiles appear in the list.

> **Important** Only clone a voice you have the right to use: your own, or someone who has agreed. VoiceStudio's models have their own licences; check them before using voices commercially.

VoiceStudio is a separate program with its own licence (AGPL). NOVA does not include any of its code; it only uses its local service. If VoiceStudio uses another address, set `VOICESTUDIO_URL` before starting NOVA.

## Give a character to an agent

Tick the agents under **Agents that use this character** and press **Save**. When that agent runs, it starts from the character's personality, way of speaking and language, then its own instructions. Deleting a character returns its agents to their own instructions.

## Let NOVA speak as a character

Choose a character in **NOVA speaks as** at the top of Voice Studio. Replies read aloud (**Voice** under the message box, or the speaker button on a reply) then use that character's voice.

## What a character cannot change

A character changes tone and wording only. It never changes facts, safety rules, approvals or what an agent is allowed to do, and an agent asked whether it is an AI says so plainly.
