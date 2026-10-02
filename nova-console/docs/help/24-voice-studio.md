---
id: voice-studio
title: Voice Studio
section: Create
order: 24
summary: Make characters with a personality, a face and a voice, give them to agents, or let Maataa speak as one. Blend Kokoro voices, use macOS voices, or voices from the VoiceStudio app, including your own cloned voice.
keywords: voice studio characters persona personality speaking style face avatar voice kokoro blend mix pitch speed macos voicestudio clone cloned voice agents speak as delivery emotion mood shout shouting whisper sing singing taunt taunting angry sad laugh cues
views: voicestudio
---
**Voice Studio** (Create group) is where you give Maataa's agents a personality. A character has:

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
4. Press **Make a face**. Maataa starts ComfyUI if needed and draws a portrait from the description. **Remove face** clears it.

## Voices

| Voice | What you get | Needs |
| --- | --- | --- |
| **Kokoro blend** | Mix up to three Kokoro voices by share, for example 70% Heart and 30% Emma, to make a voice of your own without recording anyone. Voices in English (US and UK), Hindi, Spanish, French, Italian, Japanese, Portuguese and Chinese. | Kokoro voices (double-click **Install Kokoro voices for NOVA.command**, about 400 MB) |
| **macOS voice** | Any voice built into macOS | Nothing |
| **VoiceStudio** | Voice profiles from the VoiceStudio app, including designed and cloned voices, in 600+ languages | The VoiceStudio app running |

**Speed** (0.6× to 1.6×) and **Pitch** (six semitones down to six up) work with every voice. Pitch needs ffmpeg (`brew install ffmpeg`).

## Delivery: emotion and mode

A character does not read every line the same way. **Delivery** decides how each part of a line is said: calm, warm, joyful, excited, sad, angry, shouting, whispering, taunting, fearful, laughing or singing.

| Setting | What it does |
| --- | --- |
| **Usual delivery** | How the character normally sounds. Left on Neutral, Maataa takes it from the personality: "gentle and motherly" sounds warm, "playful and sarcastic" taunts |
| **Let the personality choose the delivery for each sentence** | Your local model acts as voice director: it reads the character's personality and what each sentence means, and picks a delivery per sentence, so a scolding is said angrily and a secret is whispered. Without a model, Maataa goes by signs in the text: CAPITALS shout, "!!" sounds excited |

### Direct a line yourself

Write cues in the text, in square brackets or round ones. Everything after a cue is said that way, until the next cue:

> [warm] Come here, my child. [taunt] Did you really think you could hide? [pause] [sing] La la la…

Cues: `[shout]`, `[whisper]`, `[sing]`, `[taunt]`, `[laugh]`, `[angry]`, `[sad]`, `[joyful]`, `[excited]`, `[calm]`, `[warm]`, `[fearful]` and `[pause]` (a short silence). Words such as `(yells)`, `(sings)`, `(teasing)` or `(sighs)` work too. Click the cue chips under **Delivery** to add them to the preview box. Cues always win; the preview's delivery list sets the rest of the line.

After **▶ Preview**, Maataa shows the deliveries it used, for example "delivered as warm → taunting → singing".

### How it sounds

- **Kokoro and macOS voices** act each delivery out: each part is spoken at its own speed, then Maataa changes pitch and loudness and adds an effect, such as a compressor for shouting, a breathy filter for whispering, a wobble for taunting, and vibrato with a little room for singing. This needs ffmpeg (`brew install ffmpeg`); without it, a line is said in one delivery, using speed only.
- **VoiceStudio voices** also receive the delivery as an instruction ("speak shouting loudly"), which expressive voice models follow in their own way.
- These voices cannot really sing a melody: singing here is a sung-style reading. For a real song with music, use **Media > Audio > Song**.

## VoiceStudio app

[VoiceStudio](https://github.com/debpalash/VoiceStudio) is a separate, free desktop app for cloning and designing voices. Maataa talks to it over its local service at `http://127.0.0.1:3900` and never sends text anywhere else.

1. Install VoiceStudio from its website and open it.
2. To use your own voice, clone it inside VoiceStudio. It asks for the speaker's permission and adds an inaudible watermark to everything it makes.
3. In Maataa, choose **VoiceStudio** as a character's voice and press **Refresh**; your voice profiles appear in the list.

> **Important** Only clone a voice you have the right to use: your own, or someone who has agreed. VoiceStudio's models have their own licences; check them before using voices commercially.

VoiceStudio is a separate program with its own licence (AGPL). Maataa does not include any of its code; it only uses its local service. If VoiceStudio uses another address, set `VOICESTUDIO_URL` before starting Maataa.

## Give a character to an agent

Tick the agents under **Agents that use this character** and press **Save**. When that agent runs, it starts from the character's personality, way of speaking and language, then its own instructions. Deleting a character returns its agents to their own instructions.

## Let Maataa speak as a character

Choose a character in **Maataa speaks as** at the top of Voice Studio. Replies read aloud (**Voice** under the message box, or the speaker button on a reply) then use that character's voice and delivery, so an excited reply sounds excited.

## What a character cannot change

A character changes tone and wording only. It never changes facts, safety rules, approvals or what an agent is allowed to do, and an agent asked whether it is an AI says so plainly.
