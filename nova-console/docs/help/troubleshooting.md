---
id: troubleshooting
title: Troubleshooting
---
## Starting NOVA

### The app will not open, or macOS says it is damaged or from an unidentified developer

The app is not notarized. Right-click it and choose **Open**, or go to **System Settings → Privacy & Security** and choose **Open Anyway**. If it still fails, open the portable folder's **Start NOVA.command** to see the error in Terminal.

### The window opens but stays blank or will not load

Wait a few seconds: the window appears once the server answers. If it stays blank, quit NOVA and open it again, then look at the end of `nova-runtime-server.log` in `~/Library/Application Support/com.brahmini.nova-runtime/`.

### "Port 8787 is busy" or the server exits straight away

Another NOVA is already running (the app, the portable folder or `npm start`). Quit it, or start browser mode with another port, for example `PORT=8790 npm start`.

### The bottom of the window or the chat box is cut off

Make the window a little larger. On narrow windows the rail and inspector slide over the page; press the menu button to open or close the rail.

## Models and chat

### "Ollama unavailable"

Start Ollama (open the Ollama app or run `ollama serve`), check `OLLAMA_HOST` if you changed it, then press **Sync from Ollama** in Models. Diagnostics shows **Ollama inference engine** as healthy when it is reachable.

### No models appear after syncing

Run `ollama list` in Terminal. If it is empty, pull a model, for example `ollama pull llama3.2`. Make sure NOVA and your Terminal use the same Ollama address.

### Chat will not use the model I picked

Pick a model synced from Ollama, not an example entry, and press **Load** if it needs loading. Check that **Demo mode** is off if you expect real replies.

### Replies are very slow

Use a smaller model, close heavy apps (ComfyUI video jobs use a lot of memory) and check memory in **Runtime**. The first reply after loading a model is always slower.

## Knowledge

### A document will not index

Check its status in Knowledge. Make sure an embedding model is available in Ollama, then retry. Use a text-based file; scanned images are not read.

### Answers ignore my documents

Attach the collection to the session and turn on **Retrieval**. Test the same question in Retrieval Lab to see which chunks come back.

## Images, video and audio

### "ComfyUI is not running" or image jobs fail at once

Open **Settings > Image engine**. If it says not installed, press **Install ComfyUI** (or choose its folder if it is somewhere other than `~/ComfyUI`). If **Start ComfyUI when needed** is off, turn it on or press **Start now**. If it says it stopped three times, press **Show log**: the last lines say why (often a missing Python package after an update; running the installer again fixes that).

### The first image takes much longer

That is ComfyUI starting (20–60 seconds). Turn on **Start with NOVA** in **Settings > Image engine** to have it ready in advance, at the cost of some memory.

### A video job was refused for low memory

NOVA stops heavy jobs rather than freeze your Mac. Close other large apps, pick a shorter length or lower resolution, or use Wan instead of LTX-2.

### Transcription is unavailable

Install whisper.cpp and ffmpeg (the audio setup scripts do this), then check again on **Help & Support → Support**.

### The voice sounds robotic

That is the built-in macOS voice. Install Kokoro with **Install Kokoro voices for NOVA.command** for natural voices.

### I cannot find a file NOVA made

Look in `~/Documents/NOVA Library` in that day's folder. If the item says it could not be saved there, check the folder in **Media → Library folder** and that the disk has space.

## Sources, computer and voice

### "Reading web pages needs network access" or a git clone is refused

Turn on **Settings > Privacy > Allow network access**. Private repositories need git to be signed in on this Mac already; NOVA never asks for passwords. A page that needs JavaScript or a sign-in may have no readable text.

### A folder was added but NOVA says it found no readable files

NOVA reads text files only and skips `node_modules`, `.git`, build folders and binary files, up to 600 files and about 12 MB. Add the subfolder that holds your notes or code.

### Computer is on but NOVA only talks

The model must support tools (for example `qwen2.5` or `llama3.1`); the steps above the reply say when it does not. Also check **Settings > Computer > Let NOVA use this Mac**.

### Clicks and typing do nothing

Allow NOVA Runtime (or Terminal in browser mode) in **System Settings > Privacy & Security > Accessibility**, then quit and reopen NOVA.

### Screenshots show only the desktop wallpaper

Allow NOVA Runtime (or Terminal) in **System Settings > Privacy & Security > Screen Recording**, then reopen NOVA.

### "Outside the approved folders"

Commands and file tools only work inside folders you added to the chat or approved in Local Workspace. NOVA normally asks for the folder itself (press **Allow this folder**); you can also add it with **+ > Add folder**, or type `add folder ~/Desktop` in the message box.

### "Could not check it visually" when building a page from an image

The check renders the page in a browser NOVA can find: Google Chrome, Chromium, Microsoft Edge or Brave. Install one (or set `NOVA_CHROME` to its path) and ask again.

### Text from an image has mistakes

Use a sharper or larger screenshot; tiny or blurred text is hard to read. On a Mac NOVA uses Apple's text recognition; if the support report shows "Text in images" as missing, install tesseract (`brew install tesseract`).

### The microphone does not work

Allow NOVA in **System Settings > Privacy & Security > Microphone**. Speaking needs whisper.cpp and a speech model (Help: Audio); recordings from Chrome also need ffmpeg (`brew install ffmpeg`).

## Agents, tools and workflows

### A skill or agent is blocked

Check that the skill is installed, the tool server is connected in **MCP Registry**, and no approval is waiting. Draft agents must pass a test run and be approved before use.

### A workflow is stuck

It is probably waiting at a sign-off step: open Workflows and press **Approve** or **Reject**. **Validate** shows steps that point at a missing agent or skill.

### An automation did not run

It must be **Enabled**, NOVA must be open at the time, and its model and collections must exist. Check its run history and the **Scheduler** check in Diagnostics.

## Workbench and oversight

### "No installed model is qualified" when NOVA plans code

Open **Models**, press **Sync from Ollama**, then **Qualify for coding** on a model of 7B or larger. Wait until Activity shows the run finished and the card says **6 of 6 passed**. See [Models](help:models#qualify-for-coding).

### There is no "Qualify for coding" button on a model

The card does not know the model's exact version yet. Press **Sync from Ollama** and look again. Remote models cannot be qualified.

### A model fails some coding checks

Small models often fail **several files**, **large folder** or **asks when unclear**. Try a larger coding model (for example `qwen2.5-coder:7b` or `14b`). Models of 3.2B parameters or smaller can only plan single-file changes anyway. You can run the checks again; every run is recorded.

### "Models at or below 3.2B are restricted to qualified single-file workflows"

The request needs changes to more than one file. Use a model larger than 3.2B, or ask for a change to one file.

### NOVA says it is halted and will not act on my computer

Someone pressed **halt** in Workbench. Open Workbench, check the reason under **Allowed**, and press **resume** with your resume passphrase when it is safe.

### Resume says the passphrase is not right

The passphrase is case-sensitive. On a server started with `NOVA_RESUME_CREDENTIAL`, that value is also accepted.

### I lost the resume passphrase

Quit NOVA fully. In NOVA's data folder (see [Settings, privacy and your data](help:settings-privacy#where-your-data-lives)), delete the file `.resume-passphrase`. It is hidden, so press ⇧⌘. in Finder to see it. Start NOVA again and press **resume**: it asks you to choose a new passphrase.

### "The agent browser needs Playwright"

This copy of NOVA was built without the browser driver. Rebuild the app with **Build NOVA app.command** (it downloads the driver once), or in browser mode run `npm install` in `nova-console`. Nothing else in NOVA needs it.

### "The agent browser uses the Chrome on this computer"

Install Google Chrome (or Edge, Brave or Chromium) in Applications, then open **Agent Browser** again. If Chrome is somewhere unusual, set `NOVA_AGENT_CHROME` to its program file before starting NOVA.

### The agent browser says it needs network access

Turn on **Settings > Privacy > Allow network access**. Pages on this computer (`localhost`, `127.0.0.1`) open without it.

### An agent page is refused, or looks broken

The website is not on the allowed list, or the page loads pictures, scripts or fonts from other websites. Open **Agent Browser**, look under **Blocked addresses**, and press **Allow** for the ones you trust.

### Neuron Factory says training is refused

**Macro** blueprints need **Approve macro job** first, and nothing trains while NOVA is halted (resume it in Workbench). An error about the training specification names the value that is out of range; the limits are in [Neuron Factory](help:neuron-factory#scale).

### The setup checklist will not reach 5 / 5

Step 2 needs a model that passed **Qualify for coding**. Step 5 needs a code change applied after its checks passed in Local Workspace, or an improve-and-test loop that ended with passing tests. See [The setup checklist](help:getting-started-checklist).

### The Workbench strip in the top bar shows "—"

NOVA could not read Workbench's state. It retries after 30 seconds. If it stays, open Workbench to see the error, and make a support report.

## Local Workspace

### "install" is refused

Turn on **Settings → Allow network access**, and make sure install is in the project's approved allowlist (**Add install and dev to allowlist**).

### A change batch will not apply or roll back

A file changed since the batch was checked or applied. Validate the batch again, or undo your own edit to that file, then retry.

## Disk and performance

### NOVA or the build script says there is not enough space

Packing needs about 3 GB free and video jobs need room for their output. Empty large downloads, old builds in `nova-console/packaging/dist/` or old items in your NOVA Library.

### Still stuck?

Open **Help & Support → Support**, make a support report and send it with a short description of what happened. See [Get help and support](help:support).
