---
id: models
title: Models
section: Chat and knowledge
order: 11
summary: Sync models from Ollama, load and unload them, benchmark speed, and see which models passed Maataa's coding checks.
keywords: in memory ram estimate gpu example models demo unload memory warning models ollama sync load unload benchmark qualification quantization vision embedding pull
views: models
---
@screen media/models.jpg "Models synced from Ollama, with size, quantization and speed."

## Get models

Maataa uses the models you have in Ollama. To add one, pull it in Terminal, for example:

```
ollama pull llama3.2
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
```

Then press **Sync from Ollama** in **Models**. Maataa adds or updates a card for each model. The first sync after installing replaces Maataa's example models with your real ones.

## Load, unload and benchmark

- **Load** asks Ollama to keep the model in memory, so the first answer comes faster. **Unload** frees that memory.
- **Benchmark** runs a real generation and records time to first token and tokens per second.
- Values Ollama does not report (for example some GPU figures) show as unavailable rather than estimated.

### What the numbers mean

- **In memory** is what Ollama measures while a model is loaded. When it is not loaded, the card shows a **RAM estimate** worked out from the file size.
- **% on GPU** is how much of a loaded model sits on the GPU. On Apple silicon this is normally 100%.
- **Context** shows the window in use and the most the model supports.
- A loaded card says when Ollama will unload the model if it is not used again, normally after five minutes.
- Maataa refreshes all of this from Ollama each time it starts. **Sync from Ollama** refreshes it right away.

When more than one model is loaded, a note at the top says how much memory they use. **Unload all but…** frees memory for images and video.

**Renaming a model.** If you rename a model in Ollama (`ollama cp old new`, then `ollama rm old`), the next sync recognises it by its digest. Chats, agents, automations and saved profiles move to the new name, and its coding checks stay. The brahmini folder has **Rename local model to guru-maataa.command** for the local model that used to be called `maataa`.

**Example models.** Before Ollama is connected, Models shows a few example rows (Llama 3.1 8B, Mistral Nemo 12B, Qwen2.5 Coder 7B, Phi-3.5 Mini, Frontier Remote 70B). They are not on your Mac, and their numbers are not measured. Once real models are synced, the examples move into a closed **example models** section, are never shown as loaded, and **Remove examples** deletes them.

## Qualify for coding

Code plans (in chat and Local Workspace) and the improve-and-test loop only use models that passed Maataa's coding checks, so a model cannot quietly produce broken edits.

1. Press **Sync from Ollama** so the card knows the model's exact version (its digest).
2. Press **Qualify for coding** on the model's card.
3. Follow the trials in **Activity**. Each card shows **Coding checks: N of 6 passed**, and which failed.

There are six checks, and each runs three times. All 18 trials must pass:

| Check | Passes when the model… |
| --- | --- |
| one file | makes the exact edit asked for in one file |
| several files | edits two files in the right order |
| large folder | finds the right file among many large ones |
| asks when unclear | asks a question instead of guessing on a vague request ("Improve this") |
| stops on timeout | stops cleanly when time runs out, leaving nothing half-done |
| stops on cancel | stops cleanly when cancelled |

- The trials use temporary folders. Your projects are never touched.
- A run takes about 10–30 minutes, depending on the model and your Mac. **Cancel** in Activity stops it.
- Results belong to that exact model version. If you pull a newer version, qualify it again.
- Models of **3.2B parameters or smaller** (for example `llama3.2`) can only plan single-file changes, even when qualified.
- The results count towards step 2 of [the setup checklist](help:getting-started-checklist).

## Choosing a model

| For | Try |
| --- | --- |
| Everyday chat | `llama3.2`, `qwen2.5:7b` |
| Code changes, Build with Maataa | 7B or larger, for example `qwen2.5-coder:7b`, after **Qualify for coding** |
| Images in chat | `llama3.2-vision`, `llava` |
| Knowledge indexing | an embedding model such as `nomic-embed-text` |

Larger models answer better but need more memory and are slower. The status bar shows memory in use.
