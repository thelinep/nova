# NOVA Runtime user guide

NOVA Runtime is a local desktop workspace for working with local language models, documents, automations, tools, agents, and workflows. The desktop app runs the NOVA server on your computer and opens the NOVA Console. Its local service listens only on `127.0.0.1:8787`.

This guide describes the current application, including where a screen contains example records or a capability has a deliberate limitation.

## Before you begin

The desktop app currently needs the following on the Mac where it runs:

- Node.js 22.5 or later. The desktop shell starts NOVA's server with the installed `node` command.
- Ollama for model-backed chat, embedding, model management, evaluations, and automations. NOVA can open without Ollama, but model-dependent actions will report that Ollama is unavailable.
- At least one locally installed Ollama model. For example, pull a model using Ollama before opening NOVA.

NOVA stores its desktop data in:

```
~/Library/Application Support/com.brahmini.nova-runtime/
```

That folder contains the SQLite database (`nova.db`) and the server log (`nova-runtime-server.log`). Do not edit the database while NOVA is running.

## Start NOVA

### Desktop app

Open **NOVA Runtime.app**. Wait for the Console window to appear. The app starts its local service before the window loads. Closing the window normally also stops that service.

If macOS blocks an ad-hoc-signed build, use Finder to open the app and approve it in **System Settings → Privacy & Security**. This build is not notarized.

### Browser development mode

From the `nova-console` directory, run:

```
npm start
```

Then open `http://127.0.0.1:8787/`. Use this address rather than opening `public/index.html` directly.

Optional settings:

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | `8787` | Change NOVA's local HTTP port. |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Point NOVA at an Ollama service on a different local address. |
| `DATA_DIR` | `./data` | Store NOVA's SQLite database somewhere else in browser-development mode. |

## First-time setup

1. Open **Diagnostics** and confirm that **NOVA Runtime backend** is healthy.
2. Confirm that Ollama is running. In **Models**, select **Sync from Ollama**. The installed models should appear in the registry.
3. Select a synced Ollama model for a session, then load it if the model requires loading.
4. Create a small knowledge collection and add a plain-text, Markdown, HTML, or supported document file. Wait for indexing to finish.
5. Run a test query in **Retrieval Lab**. This verifies that your embedding model and collection work together.

Do these steps before enabling scheduled automations or asking an agent to use tools.

## Using the Console

### Sessions and chat

Use **Sessions** to create, organize, pin, archive, or filter local conversations. Open a session and write a message in the Console composer. The status area reports the active model and activity state.

When the selected session uses a synced, reachable Ollama model, NOVA streams its response from Ollama. If the selected model is only a seeded example or the local Ollama service cannot be reached, NOVA labels the result or error honestly; do not treat example records as a completed model configuration.

Keep confidential material on the local machine. A local model can still be instructed to call an enabled tool, so review tool permissions before using an agent or workflow with sensitive files.

### Models

The **Models** view is the local model registry.

- **Sync from Ollama** reads models installed in Ollama and adds or updates their profiles.
- **Load** and **Unload** ask Ollama to preload or evict a local model.
- **Benchmark** runs a real local generation and records first-token latency and token throughput where Ollama provides the underlying counters.

Model cards can show properties that Ollama does not expose. NOVA displays those as unavailable rather than estimating them. GPU information is best effort: CPU and memory are local measurements, while GPU/VRAM availability depends on the operating system and installed tools.

### Knowledge

Use **Knowledge** to make local document collections.

1. Create a collection and give it a clear purpose, such as “Product requirements”.
2. Add documents to the collection.
3. Allow NOVA to split the text into chunks and create embeddings through Ollama.
4. Check the document status and chunk count before relying on it in a query or automation.

Deleting a document removes it from the collection and its local retrieval index. Keep an original copy elsewhere if it matters.

### Retrieval Lab

**Retrieval Lab** is the place to inspect retrieval before you use it in a prompt or automation.

- Select a collection and enter a query.
- Review candidate chunks, their similarity ranking, source document, and token estimate.
- Enable hybrid reranking when you want NOVA to combine lexical and vector signals. The current hybrid mode uses BM25 plus vector ranking fused with reciprocal-rank fusion; it is not a cross-encoder reranker.

Use this view to discover missing, poorly chunked, or irrelevant source material. Retrieval quality is tied to the local embedding model and the contents of the collection.

### Automations

Automations are local scheduled or event-driven model runs.

1. Create an automation. New automations start as **Draft**.
2. Set its prompt, trigger, model, and knowledge collections.
3. Use **Run now** to test it.
4. Review its run history and output.
5. Enable it only after the test behaves as intended.

An enabled automation may run after NOVA restarts if it is due. Disable it or return it to Draft before changing its model, prompt, permissions, or source collection. Failed and cancelled runs remain visible in the run history.

### Evaluations

Use **Evaluations** to compare local models against NOVA's fixed benchmark datasets.

Start an evaluation only after syncing the intended model from Ollama. Compare completed rows side by side; accuracy, latency, and throughput are meaningful only when both runs use comparable model settings and the same dataset. A score is an evaluation result, not a general guarantee of model safety or factual accuracy.

### Skills

Skills are capability modules that declare the MCP tools and permissions they need. NOVA includes local skills such as file search, web fetch, code linting, and session summarizing.

The Session Summarizer condenses the active session, or text you paste into its card, using a local Ollama model. Every sentence cites the numbered source messages or passages it came from, and ids the model invents are removed. It reads a session only while its `session:read` permission is granted, and it refuses API or demo models. In workflows, a summarize step summarizes the previous step's output. Long input is summarized in parts and then combined, up to 200,000 characters.

- Inspect the permission list before enabling a skill.
- Enable or disable skills from the registry.
- Use the skill's health check and manual run controls before attaching it to an agent.
- Review the audit trail and Execution History after use.

A skill only receives the capabilities that its declared tool calls and connected MCP server allow. Some displayed example skills are not wired to a real implementation; NOVA shows those limitations instead of simulating a successful run.

### MCP Registry and approvals

The **MCP Registry** manages local tool servers. Connecting a supported server starts a local child process and performs a stdio protocol handshake.

Before calling a tool:

1. Confirm the server is **Connected**.
2. Read the tool description and input schema.
3. Review the server's approval policy.
4. Approve only the specific request you intend to allow.

Approval requests are deliberate controls. Declining an approval prevents that tool call. Disconnect a server when it is no longer required; MCP child processes do not survive a NOVA restart and must reconnect.

**Browser Automation** is a real headless Chromium (through the Playwright that NOVA's tests already use). It connects only while Settings > Privacy > **Allow network access** is on, asks for approval on each call by default, and opens only http and https addresses. Tools: open a page, read its text, list links, click, type into a field, and take a screenshot. If it reports that Chromium could not start, run `npx playwright install chromium` in `nova-console`.

### Agents and workflows

An **Agent** combines a model, instructions, allowed skills, and available MCP tools. A **Workflow** connects agents and other nodes into a repeatable sequence.

Start with a small, low-risk task:

1. Confirm the model is reachable.
2. Give the agent only the skills it needs.
3. Run the agent and monitor Trace and Execution History.
4. Add it to a workflow only after its single-run result is reliable.

Workflows are restart-resilient, but a restart cannot make an unavailable model, disconnected MCP server, rejected approval, or invalid input succeed. Treat any publishing, deletion, or external-effect node as a review point.

### Media: images, video, audio and transcripts

Open **Media** in the sidebar. Everything here runs on your computer, and each item keeps the settings that made it.

Tabs along the top separate the tools: **Image**, **Video**, **Audio**, **Transcribe**, **Edit** (filters) and **Library**. Each tab shows its own tool and only the matching library items (the Library tab shows everything and the library folder setting). NOVA remembers the last tab. **Animate** on an image jumps to Video; **Filters** on any item jumps to Edit. The panel on the right holds the helpers for the current tab: how it works, what still needs installing, prompt presets (click a chip to add it to the prompt) and that tab's recent jobs, with **Cancel** for running ones.

- **Images in chat.** Use the paperclip in the composer, or **Actions ▾ > Attach to chat** on a library image, to add PNG, JPEG, WebP or GIF images to your next message. Reading images needs a vision model, for example `ollama pull llama3.2-vision` or `ollama pull llava`, then sync models. A text-only model is refused with a message saying so.
- **Image generation (ComfyUI).** To install it, double-click `Install ComfyUI for NOVA.command` in the brahmini folder (ComfyUI in `~/ComfyUI` plus the SDXL base checkpoint, about 13 GB); later, `Add Wan video models.command` adds the AI-motion files (about 22 GB). Start it with `Start ComfyUI for NOVA.command` in the brahmini folder. Start ComfyUI on this computer. NOVA finds it on port 8188 (manual install) or 8000 (ComfyUI Desktop); set `COMFYUI_URL` for any other local port. Only local addresses are accepted. Choose a checkpoint, size, steps, CFG, seed and sampler, then **Generate**. Each image is saved with its prompt, negative prompt, checkpoint and seed; **Reuse settings** loads them back.
- **Image to image.** In **Generate an image**, set **Start from** to a library image (or **Upload image**), describe the change, and set **Change** (0.1 keeps it close, 0.9 reimagines it). It uses the same SDXL checkpoint through ComfyUI; the source is scaled to about one megapixel first.
- **Text to audio.** In **Voice, sound effects, music**:
  - **Voice** reads text aloud with any voice installed on your Mac (System Settings > Accessibility > Spoken Content > System voice > Manage Voices adds more, including Hindi). Instant; good for scratch VO and read-throughs.
  - **Sound effect** uses Stable Audio Open through ComfyUI, up to 47 seconds ("monsoon rain on a tin roof, distant thunder").
  - **Text to song.** Choose **Song / music**, describe the idea (a story, scene or feeling), pick the lyrics language (English, Hindi in Roman or Devanagari letters, Hinglish, Punjabi, Urdu) and length, and press **Write lyrics**: a local model writes a title, a style line and [verse]/[chorus]/[bridge] lyrics. Edit anything, then **Generate** to have ACE-Step sing it. To sing your own lyrics, paste them in the Lyrics box instead. How well ACE-Step sings a given language varies; English and Roman-letter lyrics are the safest start.
  - **Music** uses ACE-Step through ComfyUI: style tags plus optional lyrics, up to 4 minutes. It needs macOS 15.1 or later (older macOS cannot decode it on the Apple GPU).
  Sound effects and music need `Add audio models.command` in the brahmini folder (about 13 GB).
- **Image to video.** Press **Animate** on any image in the library, or **Upload stills to animate**, to add shots in **Animate stills**. Two engines:
  - **Camera moves** (needs ffmpeg). Pick a push in, pull out, pan or tilt and a length for each shot, reorder them, choose a size (16:9, 2.39:1 scope, 1:1, 9:16) and frame rate, then **Render**. One shot makes a clip; several make an animatic joined in order. Renders in seconds, no AI model.
  - **AI motion with LTX-2** (default, Apple Silicon only). The first shot and your prompt (describe motion and sound, e.g. "waves crash, gulls call") go to LTX-2 running on this Mac through MLX, and the clip comes back with sound. Install it by double-clicking `Install LTX-2 video for NOVA.command` in the brahmini folder. The weights repository holds about 60 GB of variants, but the installer downloads only what NOVA uses: about 28 GB for **Fast** clips (the distilled model, its shared parts and the Gemma text encoder). It first clears unfinished or unused LTX-2 downloads and checks there is room. For **Better** clips run `bash scripts/install-ltx-mac.sh --better` in nova-console (another 19 GB). NOVA never lets LTX-2 start a download on its own. Clips are 1–8 seconds at up to 960×544; **Fast** uses the distilled model, **Better** the two-stage one. Set `LTX_MLX_BIN` or `LTX_MLX_MODEL` if you installed elsewhere or want another weights pack.
  - **Memory safety.** Image and video models share the Mac's memory. NOVA runs one image or video job at a time, unloads Ollama chat models (and ComfyUI's models, before LTX-2) when a job starts, keeps LTX-2 to 480p, 5 seconds and low-RAM mode on 16 GB Macs, and does not start Wan 2.2 on Macs with less than 32 GB (it can freeze and restart the Mac; `NOVA_ALLOW_WAN_LOW_RAM=1` overrides). Avoid running other heavy apps during a clip.
  - **AI motion with Wan 2.2** (choose it in the AI motion list; ComfyUI + Wan 2.2 5B, no sound). The first shot and your motion prompt go to your local ComfyUI, and the picture itself moves. ComfyUI needs three files: `wan2.2_ti2v_5B_fp16.safetensors` in `models/diffusion_models`, `umt5_xxl_fp16.safetensors` in `models/text_encoders` (the fp8 version does not run on Apple Silicon), and `wan2.2_vae.safetensors` in `models/vae`, from the Comfy-Org repackaged Wan 2.1/2.2 repositories on Hugging Face (about 21 GB together). NOVA lists whatever is missing. Clips are 1 to 5 seconds at 24 fps; on a Mac start at 480p and 2 seconds, because each second can take several minutes.
  - **Continuity.** **Continue from last frame** on a clip saves its final frame as a still and adds it as the next shot, so the next AI motion clip starts exactly where the last one ended. **Add to join** on clips, in order, then **Join clips** to make one video. Keeping the same character across unrelated shots still depends on your keyframes showing the same character.
  Videos play in the library, can be downloaded, and keep a recipe (shots and moves, or prompt, seed, steps and models). MP4 and MOV uploads are accepted too.
- **Transcription (whisper.cpp).** Install `brew install whisper-cpp ffmpeg` (if ffmpeg will not install, NOVA uses the `afconvert` tool built into macOS for WAV, AIFF, MP3, M4A and FLAC) and put a model file such as `ggml-base.en.bin` in `nova-console/data/models/whisper` (or set `WHISPER_MODEL`). Upload audio (WAV, MP3, M4A, OGG, FLAC or WebM) or video (MP4, MOV; needs a working ffmpeg), choose a Knowledge collection if you want the transcript searchable, and click **Transcribe**. Transcripts carry timestamps like `[00:01:02]`.
- **Spoken language.** Each item has a language list next to **Transcribe**: pick the language spoken, or **Language: detect**. The English model (`ggml-base.en.bin`) understands English only; for Hindi, Urdu, Punjabi, Tamil and other languages double-click `Add multilingual speech model.command` in the brahmini folder (whisper large-v3-turbo, about 575 MB; `--small` for a lighter one). NOVA then uses the English model for English (faster) and the multilingual one for everything else, and records the detected language on the transcript.

### Create: the sidebar group for making things

The **Create** group at the top of the sidebar opens **Image**, **Video** and **Audio** (the matching Media tabs), **Boards**, **Timeline** and **Library**.

#### Actions on library items

Every library card has an **Actions ▾** menu. The original is never changed; each action makes a new item with its recipe.

- **Images:** **Edit area…** and **Remove object…** open a brush: paint over the area, then either describe what should be there (Replace with a prompt; **Change** 0.3 keeps it close, 1 repaints it fully) or let NOVA fill it with matching background (Remove). Only the painted pixels change. **Expand background…** puts the picture on a bigger frame (16:9, 2.39:1 scope, 9:16, more room on every side…) and paints the new area to match. These use SDXL in ComfyUI with the checkpoint and LoRA chosen in the Image tab. **Upscale…** makes a 2x or 4x copy: with an upscale model in ComfyUI (double-click `Add upscale model.command` in the brahmini folder for Real-ESRGAN, about 64 MB) it adds real detail; otherwise it is a high-quality resize with ffmpeg. Upscales are limited to 8192 pixels on the long side. Also: **Image to image**, **Attach to chat**.
- **Video:** **Continue from last frame**, **Add to join**, **Translate…**, **Enhance speech…**, **Transcribe**.
- **Audio:** **Enhance speech…**, **Translate…**, **Transcribe**.
- **Everything:** **Add to board…**, **Add to timeline…**, **Filters**, **Download**.

**Enhance speech** cleans dialogue with ffmpeg: rumble and hiss filters, noise reduction, gentle compression and loudness levelling to -16 LUFS. **Light** keeps the room sound; **Strong** is for noisy location sound. On video only the sound is redone.

**Translate** transcribes the speech (whisper.cpp; choose the **Spoken** language or Detect — an existing transcript in that language is reused, otherwise NOVA transcribes again), translates each line with your local Ollama model, then either **dubs** it — every line spoken in the new language at the time the original line starts, over the original sound turned down (or off) — or, for video, adds **subtitles**: burned into the picture when your ffmpeg has libass, otherwise as a subtitle track you switch on in the player (QuickTime: View > Subtitles; Homebrew's ffmpeg has no libass). The translated subtitles (.srt) are always kept in the recipe. Languages include Hindi, English, Bengali, Marathi, Tamil, Telugu, Gujarati, Punjabi, Urdu and major world languages; a dub needs a voice for that language (Kokoro has English, Hindi, Spanish, French, Italian, Portuguese, Japanese and Chinese; add macOS voices in System Settings > Accessibility > Spoken Content > System voice > Manage Voices). There is no lip sync, and long lines are sped up (at most 1.6x) to fit.

#### Style and character LoRAs

In the Image tab, **Style / character** picks a LoRA file from `ComfyUI/models/loras` (restart ComfyUI after adding one) and **Strength** sets how strongly it applies (0.6–0.9 is typical). It is used by text to image, image to image, Edit area, Remove object and Expand, and recorded in each recipe. A LoRA trained on one character is the most reliable way to keep that character consistent across shots; training your own is not built in yet.

#### Better voices: Kokoro

Double-click `Install Kokoro voices for NOVA.command` in the brahmini folder (about 400 MB in `~/kokoro`). Kokoro-82M runs offline and sounds far more natural than the built-in macOS voices; it has English (US and UK), Hindi and several other languages. Kokoro voices appear first in the Voice list and are used automatically for dubs in those languages.

#### Text to video

In the Video tab, with no shots added, **AI motion** becomes **Make video from prompt**: LTX-2 makes the whole clip, with sound, from the prompt alone. Add a shot to animate a still instead.

#### Boards

Mood boards, look books and character sheets. **New board**, then add **From library** (images and clips), **Upload**, **Note** or **Colour**. Drag items to arrange them, drag the bottom-right corner to resize, double-click a note to edit it (Escape or clicking away finishes), and use × to remove an item from the board. Boards save automatically and point at library items (nothing is copied). **Save as image** renders the board as a PNG into the library.

#### Timeline

Cut a scene. The **Picture** track plays clips and stills in order; **Voice**, **Music** and **Effects** tracks hold sound that starts at a time you choose. **Add clips** and **Add sound** pick from the library, or use **Add to timeline…** on a library item. Click a block to trim it (**In**/**Out**), set a still's **Seconds**, a clip's own **Clip sound** level, or a sound's **Starts at**, **Level** and fades. Drag picture blocks to reorder them and sound blocks to move them in time. Choose the frame size and frame rate, then **Export MP4**: every shot is fitted to the frame (letterboxed, never stretched) and the sound is mixed; the result lands in the library with a recipe listing every shot and sound.

#### Chat that can make things

In the Console, ask for media in plain words — "make an image of…", "create a video of…", "write a song about…", "compose background music…", "generate a sound effect of…" — or start with a command: `/image`, `/video`, `/song`, `/music`, `/sfx`, `/voice`. NOVA answers with a card instead of a chat reply: **Generate** runs the job on this Mac and shows the result in the chat; **Open in Media** fills the prompt in the right tab so you can adjust settings first. An image attached to the message is used as the starting picture (image to image, or image to video). Songs are written by your local model first, then sung by ACE-Step.

### Helpers in every view

- **Search, filter and sort.** Every list (skills, sessions, models, documents, media, history, agents, tool servers and more) has a search box, a filter built from its tags (installed, generated video, running, failed…) and a sort. Your choices are remembered per list in this browser.
- **Help.** The **?** next to each view title opens a help panel on the right; **Close** or changing view hides it. In Media, the right-hand helper panel is always open.
- **Prompt presets.** In Media's helper panel (image, motion, sound-effect and song prompts) and under prompts elsewhere, click a chip (shot size, lens, light, style, camera move, ambience, genre, instrument, mood, tempo…) to add it to the prompt. Negative-prompt chips add common things to avoid.

### Filters for images, video and audio

Press **Filters** on any library item, or use the **Looks, crop, speed, fades** panel in Media. Images and video: looks (black & white, warm, cool, teal & orange, vintage, high contrast, faded film), film grain, vignette, crop to 16:9, 2.39:1, 4:3, 1:1, 4:5 or 9:16, and resize. Video and audio: speed 0.5×–2×, fade in and out, trim, loudness normalising; video can also have its sound removed. The original is kept; the result is a new item with its settings in the recipe.

### Library folder: everything NOVA makes, as files

Every image and video NOVA generates, every transcript and every skill output (Treatment, Shot List, Call Sheet, Translate, Slides, Summarizer) is also saved as an ordinary file in **~/Documents/NOVA Library**, one folder per day, e.g. `2026-09-26/1432 marine drive dusk (ltx).mp4`. Next to each file is a `.json` recipe (prompt, model, seed, source image, settings), so the item can be found in Finder, backed up with Time Machine or copied to a drive, and reproduced later. Your own uploads are not copied.

Change the folder in **Media > Library folder** (or set `NOVA_LIBRARY_DIR` before `npm start`). **Copy earlier items** copies things made before the library existed. Saving to the library never stops a job; if a copy fails, the item says so.

Skills keep a full **History** of their outputs (not just the last one) on their card in **Skills**, newest first, with Copy and the library file for each.

### Pre-production skills

**Treatment Writer**, **Shot List** and **Call Sheet** are in **Skills**. Paste a brief, notes, schedule or script pages, or leave the box empty to use the open chat. Each runs on a local Ollama model, returns a structured result shown as Markdown (tables for shot lists and call sheets), and writes "TBC" for facts that are not in the source, such as addresses or hospital details. They can also run as workflow steps, taking the previous step's output as input.

**Translate** turns pasted text or the open chat into another language (type it in **Translate into**, for example Hindi). Formatting, names and screenplay layout are kept; long text is translated in pieces, up to about 12,000 characters per run. In a workflow, name the language on the step, for example "Translate to Hindi".

**Export to Slides** turns notes, a brief or the open chat into a deck with speaker notes. The result is Marp Markdown: **Save deck.md**, then open it with the Marp extension for VS Code or `npx @marp-team/marp-cli deck.md --pptx` to get PowerPoint or PDF.

### Start a new project

In **Local Workspace**, use **New project** to start an app from a template. Choose an approved parent folder, a project name (lowercase letters, numbers, dashes or underscores), an optional title, and a template:

| Template | What you get | Install needed |
| --- | --- | --- |
| Node API | JSON API on Node's built-in HTTP server, with a health route and tests | No |
| Static website | HTML, CSS and JavaScript, a local preview server, and a build step | No |
| React app (Vite) | React single-page app | Yes, before `dev` or `build` |
| Next.js app | Next.js App Router project in JavaScript | Yes, before `dev` or `build` |

**Preview files** lists every file that would be written, without touching disk. **Create project** then builds the project in a hidden staging folder, runs `git init` on branch `main`, and moves it into place in one step, so a failure never leaves a half-made folder. If your git `user.name` and `user.email` are set, NOVA also makes an initial commit. The new folder is approved automatically, so you can scan it, draft changes, and run its tests straight away. Every template's `npm test` works before anything is installed. NOVA does not download packages during this step.

### Install packages and run the dev server

Controlled commands only run after you approve an allowlist for the project's Git repository. Two actions support day-to-day app development:

- **install** runs `npm ci` (when `package-lock.json` exists) or `npm install` in the project folder. It downloads packages, so it only runs while **Settings > Privacy > Allow network access** is on. Package install scripts (such as `postinstall`) are skipped unless you tick **allow install scripts** for that run.
- **dev** runs the project's `dev` script (or `start`) in the project folder, bound to `127.0.0.1`, so changes you apply show up straight away. NOVA shows the server's address when it appears in the output, streams the log live, and keeps one dev server per project. **Stop dev server** ends it, and NOVA stops every dev server when it quits.

Install and dev run in the background, and the output panel updates every second. Tests and builds still run in a separate copy of the project, and they reuse the project's installed packages. Projects approved before this version can add the new actions with **Add install and dev to allowlist**.

### Development loop

The **Development loop** in Local Workspace keeps trying a change until the project's tests pass. Describe the change (name the file, for example "Fix src/math.js so add returns the sum of both numbers"), pick a local Ollama model and a maximum number of attempts (1 to 5, default 3), then **Start loop**. The project's `test` command must be allowlisted.

NOVA works in a private copy of the project, with the installed packages linked in:

1. It runs the tests once to record the starting point.
2. It asks the model for a plan, applies it to the copy, checks new or changed JSON and JavaScript files for syntax errors, and runs the tests.
3. If the tests fail, or the plan could not be applied, NOVA sends the failing output back to the model and tries again with the copy as it now stands.

Each attempt's plan, operations and test output stay visible. When the tests pass, NOVA turns the net change into a normal change batch and runs its safe checks. **Review the prepared batch** takes you to it, and nothing in your project changes until you approve and apply it. If the attempts run out, no batch is prepared. If you edit one of the affected files while the loop runs, the loop stops with a conflict instead of overwriting your edit. **Cancel loop** stops it at any point, and a loop that was running when NOVA quit is marked interrupted.

### Local Workspace code changes

In **Local Workspace**, approve a project folder first. NOVA can then draft code changes, either from a chat request or from JSON you enter. A change batch can hold up to 50 operations:

- **edit**: replace one exact text region in an existing file
- **create**: add a new file with its full content; the file must not exist yet
- **delete**: remove an existing file
- **rename**: move an existing file to a path that does not exist yet

Every path must stay inside the approved folder. NOVA refuses paths through symbolic links and anything inside `.git`, `node_modules`, `dist`, `build`, `target`, `.next`, `coverage`, or `.cache`. Each file can appear in only one operation per batch.

Validation runs the whole batch in a copy under NOVA's data folder, so your folder is untouched until you approve. After approval, **Apply atomically** writes every operation or none of them: if one fails, the ones already applied are undone. **Roll back batch** restores every file and removes any folders the batch created. Rollback is refused if any affected file changed after the batch was applied.

For chat requests, name the file you want created, for example "Create src/date.js that exports formatDate". Model output is limited to 2,048 tokens per plan by default; set `NOVA_PLAN_MAX_TOKENS` (up to 8192) before `npm start` to allow more, at the cost of fewer files fitting in the model's context. Small, named changes still work best.

### Provider Browser

Use **Provider Browser** to open Codex, Claude, Gemini, Perplexity, or another HTTPS provider in a separate NOVA-owned browser window. This is useful when a task needs a provider-specific account alongside your local NOVA workspace.

- Select a provider card, or enter an HTTPS address.
- Sign in directly in the provider page. NOVA does not collect or store that provider’s password, session, or API key.
- The provider page stays separate from NOVA sessions, local knowledge, MCP tools, agents, and automations. Copy or export material deliberately when you want to move it between systems.
- The browser accepts HTTPS pages and local development pages at `http://localhost` or `http://127.0.0.1`.

### Capability Graph, Runtime, Trace, and Execution History

- **Capability Graph** shows the configured relationships among models, skills, MCP servers, agents, and workflows.
- **Runtime** shows local service status and available CPU, memory, and best-effort GPU information.
- **Trace** is a live operational feed for recent activity.
- **Execution History** is the durable record for inference, skills, agents, workflows, approvals, and other recorded actions. Use it for investigation and repeatability; it is paged from the backend rather than limited to the current screen.

### Diagnostics and Settings

Open **Diagnostics** first when anything fails. It distinguishes the NOVA backend from the Ollama service and local capability health.

Use **Settings** for workspace preferences. Configuration stored in NOVA is local. Changing a preference does not change the system-level Ollama installation or model files.

## Privacy and data handling

NOVA's service binds to loopback only. Its database, knowledge collections, execution history, and server log stay on the local machine unless you deliberately configure a tool or model integration that sends data elsewhere.

Review these points before adding sensitive material:

- Ollama requests go to the configured `OLLAMA_HOST`; the default is local loopback.
- A web-fetch skill can fetch the URL you supply. Do not use it with internal or credential-bearing addresses.
- A filesystem MCP server can access only what its own policy permits, but that policy should still be reviewed before approval.
- Exported or copied material leaves NOVA's local store once another application receives it.

Back up the application-data directory only with the app fully closed. Restore it only to a compatible NOVA build, and keep backups protected as they can contain chat, documents, and execution records.

## Support and troubleshooting

### Gather support information

When reporting an issue, include:

1. NOVA version and whether you used the desktop app or `npm start`.
2. macOS version and `node --version`.
3. Whether Ollama was running and the result of `ollama list`.
4. The affected view, exact action, and time of the failure.
5. The relevant lines from `~/Library/Application Support/com.brahmini.nova-runtime/nova-runtime-server.log`.
6. A screenshot of Diagnostics and the affected Execution History entry, after removing confidential information.

Do not send `nova.db`, private source documents, model prompts, access tokens, or full logs without reviewing their contents.

### Common problems

| Problem | What to do |
| --- | --- |
| NOVA window opens but content will not load | Open Diagnostics. Quit NOVA, then reopen it. Check the server log. |
| “Ollama unavailable” | Start Ollama, verify its configured host, then sync models again. |
| No models appear after sync | Confirm `ollama list` shows a model and that NOVA is using the same local Ollama host. |
| Chat cannot use the selected model | Select a model synced from Ollama and load it if required. |
| A document does not index | Check its status in Knowledge, verify Ollama is available for embeddings, then retry with a supported text-based file. |
| Retrieval results are poor | Inspect chunks in Retrieval Lab, improve the source document, and test a more specific query. |
| Skill or agent is blocked | Check Skills, MCP connection state, and any pending approval request. |
| Automation did not run | Confirm it is Enabled, its trigger is valid, its model and collections are available, and review its run history. |
| Desktop app will not launch | Confirm Node 22.5+ is installed, then inspect `nova-runtime-server.log`. macOS may require approval for this unsigned build. |
| Port 8787 is busy | Stop the other local NOVA server or start browser mode with a different `PORT`. |

## Frequently asked questions

### Is NOVA cloud-hosted?

No. The default runtime is local and binds to `127.0.0.1`. Ollama is also local by default. A configured external tool or a changed `OLLAMA_HOST` can change where data is sent.

### Does NOVA include a model?

No. Install and pull models with Ollama, then use **Sync from Ollama** in NOVA.

### Can I use NOVA without Ollama?

You can open the console and inspect local configuration, but model-backed chat, embeddings, evaluation, and scheduled generation require a reachable Ollama model.

### Are all records shown in the Console live?

No. The application includes seeded examples to explain its interface. A synced Ollama model, indexed document, connected MCP server, completed execution, and Diagnostics status are the evidence that a particular capability is live on your machine.

### Where is my data stored?

In the local SQLite database. The desktop build uses `~/Library/Application Support/com.brahmini.nova-runtime/nova.db`; browser-development mode defaults to `nova-console/data/nova.db` unless `DATA_DIR` is set.

### Can I delete data?

You can remove documents, collections, sessions, and configured records through their respective views. Back up data first if it matters. Do not delete an active database file while NOVA is running.

### Why is a metric unavailable?

NOVA only displays values exposed by the platform or Ollama. For example, thermal state and some GPU/VRAM metrics may be unavailable on a particular machine.

### Why does NOVA ask for approval?

MCP tools can read files, run commands, or perform other meaningful actions. NOVA requires the connected server's approval policy to allow a request rather than silently performing it.

### Can NOVA publish or send data automatically?

Only if you configure a tool or workflow with that capability and approve the relevant action. Review all tool permissions and workflow nodes before enabling an automation.

### Is the desktop app ready for public distribution?

Not yet. The current app is ad-hoc signed, relies on an installed Node runtime, and has not been notarized. A public release needs a bundled Node sidecar, Developer ID signing, notarization, and a verified installer.

## For administrators

Before deploying NOVA to other users, validate the target device with a real Ollama model, a sample collection, a controlled MCP call, an agent run, and an automation run. Record the Node version, model identifiers, data location, ownership and backup policy, and the approval policy for every installed tool server. Do not present a local test as evidence of shared authentication, managed deployment, or centralized governance.
