---
id: faq
title: Frequently asked questions
---
## About NOVA

### What is NOVA?

A private AI workspace that runs on your Mac: chat with local models, search your own documents, make images, video and audio, and build agents and workflows. See [Welcome to NOVA](help:welcome).

### Is NOVA cloud-hosted? Does my data leave my computer?

No. NOVA's server listens only on `127.0.0.1`, and Ollama is local by default. Data leaves only if you turn on **Allow network access** and use something that needs it, load a remote model, or copy material out yourself. The privacy badge in the status bar tells you which state you are in. See [Settings, privacy and your data](help:settings-privacy).

### Does NOVA include a model?

No. Install Ollama, pull a model (for example `ollama pull llama3.2`), then press **Sync from Ollama** in Models. See [Models](help:models).

### Can I use NOVA without Ollama?

You can open NOVA, look around and use the media engines, but chat, document search, agents, evaluations and automations need a model from Ollama.

### Does NOVA need the internet?

Only to install things (Ollama models, ComfyUI, packages) and for features you point at the web, such as the collector. Everyday chat, search and media work offline.

### Are the records I see real?

Some screens start with labelled examples so you can see how they work. A synced model, an indexed document, a connected tool server and a finished run in Execution History are the proof that a feature is working on your Mac.

## Chat and knowledge

### How do I make NOVA answer from my documents?

Add them to a collection in Knowledge, wait for indexing to finish, then attach the collection to your session and turn on **Retrieval**. Answers then cite the passages they used. See [Knowledge and Retrieval Lab](help:knowledge).

### Which files can I add to Knowledge?

Plain text, Markdown, HTML and other supported text documents. Scanned images without text are not read.

### Why are search results poor?

Check the chunks in Retrieval Lab. Clean up the source, split very long documents and ask more specific questions. An embedding model must be available in Ollama.

### Can I branch a conversation?

Yes. **Fork** copies the session so you can try another direction; **Snapshot** saves its current state. Both are in the command palette (**⌘K**).

### Can I give NOVA a folder, a web page or a git repository to read?

Yes. Press **+** under the message box and choose **Add folder**, **Add files**, **Add web page** or **Add git repo**, or drag files onto the chat. NOVA reads it once and answers from it, naming the files it used. See [Add sources, live steps, computer and voice](help:conversation).

### Can NOVA read code or text from a screenshot?

Yes. Add the image and ask, for example, "extract the code". NOVA reads the exact text with text recognition on this Mac and gives it to the model, so even text-only models can work with it. See [Add sources, live steps, computer and voice](help:conversation).

### Can NOVA turn a screenshot or design into a web page?

Yes. Attach it and ask "build this as a web page". NOVA writes the HTML, checks it in a sandboxed browser against your image, fixes the differences (up to three tries) and shows both side by side with **Open page** and **Copy HTML**.

### Can I keep typing while NOVA is answering?

Yes. Your next message is queued and answered as soon as the current reply finishes. Replies in different chats, and folders being read, run at the same time; the list icon at the top shows them all.

### Does NOVA remember things about me?

Only what you ask it to. Say "remember that …", or press the brain on a reply. Notes are listed in **Settings > Memory**, where you can delete them. "Forget …" removes matching notes.

## Making things

### What do I need for images, video and audio?

ComfyUI for images, songs and sound effects (install it from **Settings > Image engine**; NOVA starts it when needed, so you never start it yourself), LTX-2 or Wan for AI video, Kokoro for better voices and whisper.cpp for transcripts. Each has a double-click installer in the brahmini folder. See [Images](help:media-images).

### Where are the files NOVA makes?

In `~/Documents/NOVA Library`, one folder per day, with a `.json` recipe next to each file so you can make it again. Change the folder in **Media → Library folder**.

### Will a video job freeze my Mac?

NOVA checks free memory before heavy jobs and refuses or lowers settings if there is not enough. Close other large apps for long videos. See [Video](help:media-video).

### Can I edit an image or video after it is made?

Yes. **Filters** applies looks, crops, speed changes and fades as a new item; the original is kept. Boards and the Timeline arrange and join clips. See [Boards, Timeline and Library](help:boards-library).

## Agents, workflows and tools

### Can NOVA build agents on its own?

Yes. **Build with NOVA** on Agents drafts an agent from a description. Drafts must pass a test run and be approved by you before they can be used. See [Agents](help:agents).

### What is the difference between an agent and a workflow?

An agent decides its own steps to reach a goal using the tools you allow. A workflow is a fixed line of steps (agents, skills, tools and sign-offs) that runs the same way every time. See [Workflows](help:workflows).

### Why does NOVA ask for approval?

Tools can read files, run commands or change things. NOVA asks before a tool acts, following the approval policy of each tool server. See [Tools and approvals](help:tools-approvals).

### Can NOVA publish, send or delete things by itself?

Only if you give an agent or workflow a tool that can, and approve it. Put a sign-off step before anything that publishes, sends, deletes or changes files.

### Can NOVA control my computer?

Only in chats where you turn on **Computer**, and only after you approve each action. It can run commands in approved folders, open apps, files and links, look at the screen and click or type, use the clipboard, and create, move or rename files. It never deletes (Move to Trash can be undone) and refuses administrator and disk-erasing commands. See [Add sources, live steps, computer and voice](help:conversation).

### Can agents have their own personality and voice?

Yes. **Voice Studio** makes characters with a personality, a way of speaking, a face and a voice. Blend Kokoro voices, use a macOS voice, or use the VoiceStudio app for cloned voices. Give a character to an agent, or let NOVA speak as one. See [Voice Studio](help:voice-studio).

### Can NOVA speak in my own voice?

Yes, through the free VoiceStudio app: clone your voice there (it asks for permission and watermarks what it makes), then choose it as a character's voice in Voice Studio. Only clone voices you have the right to use. See [Voice Studio](help:voice-studio#voicestudio-app).

### Can I talk to NOVA instead of typing?

Yes. Hold the microphone button under the message box while you speak. whisper.cpp transcribes you on this Mac. Turn on **Voice** to hear replies read aloud.

### Can automations run on a schedule?

Yes. Automations run on a timer while NOVA is open. Workflow schedules are not wired up yet; run a workflow from an automation instead. See [Automations and evaluations](help:automations).

### Can NOVA change my code?

Only in folders you approve in Local Workspace, and only after you review and apply each change batch. Every batch can be rolled back. Planning code needs a model that passed **Qualify for coding** in Models. See [Local Workspace and projects](help:workspace).

## Oversight

### What is Workbench?

One page that shows NOVA's background work: what is running, what waits for your decision, what it may do, what broke and what it produced. It has the kill switch. See [Workbench](help:workbench).

### Why are most Workbench panels empty?

They fill as background work runs: jobs, connectors, agents of the multi-agent system and autonomy runs. Several of these are not started from the console yet, so on a new install Workbench is mostly quiet. See [Built, not yet in the console](help:developer-preview).

### What does the kill switch stop?

Background jobs, autonomy runs, multi-agent agents, the agent browser and computer actions from chat. Chat keeps working. Resuming needs the resume passphrase you choose the first time. See [Workbench](help:workbench#the-kill-switch).

### Why does NOVA say my model is not qualified to plan code?

Code plans and the improve-and-test loop only use models that passed NOVA's coding checks. Open **Models** and press **Qualify for coding** on the model, then wait for the 18 trials to finish. See [Models](help:models#qualify-for-coding).

### What does "setup: 3 / 5" mean?

How many of five setup steps this computer has done. Click it to see the rest. See [The setup checklist](help:getting-started-checklist).

### Can NOVA work with GitHub?

A GitHub connector is built. It can read repositories, issues, pull requests and checks, and open or merge a pull request, each one checked by a policy and approved in Workbench. It is not started from the console yet. See [Built, not yet in the console](help:developer-preview).

### Are tokens I give NOVA safe?

Connector tokens are stored encrypted (AES-256-GCM) in the secrets vault. The key is a file in NOVA's data folder that only your user account can read, and a token is never shown again after you save it.

### What is the Neuron Factory?

A screen for training very small, single-purpose models on your Mac: a tiny neural network from your examples, or a simulated quantum circuit. You check each result's quality and approve it. It does not change your Ollama models. See [Neuron Factory](help:neuron-factory).

### What is the agent browser?

A separate, locked-down browser that agents use, limited to the websites you allow, with every action recorded. **Agent Browser** in the sidebar shows the allowed websites, open pages, activity and blocked addresses, and lets you try a page yourself. It does not use your own browser profile or your sign-ins. See [Agent Browser](help:agent-browser).

## Data and settings

### Where is my data stored?

The app keeps its database and log in `~/Library/Application Support/com.brahmini.nova-runtime/`. Browser mode uses `nova-console/data/` unless `DATA_DIR` is set.

### How do I back up NOVA?

Quit NOVA, then copy the data folder and your NOVA Library. Restore with NOVA closed.

### How do I delete my data?

Delete single items in their views, or use **Settings → Reset workspace data** to delete everything in the database. Back up first; a reset cannot be undone.

### Can I use NOVA in Hindi?

Yes. **Settings → Interface language → हिन्दी** switches the interface. The **Translate** skill translates your text into Hindi or other languages.

### Does NOVA work on a phone or small window?

The console adjusts to narrow windows: the menu button opens the side rail and the inspector slides over the page. NOVA itself still runs on your Mac.

## The app

### Why does macOS say the app cannot be opened?

The app is not signed with an Apple Developer ID or notarized. Right-click it and choose **Open**, or allow it in **System Settings → Privacy & Security**. See [The desktop app and portable pack](help:desktop-app).

### Do I need to install Node?

Not for the packed app or portable folder: they carry their own. Browser mode needs Node 22.5 or newer.

### Is the app ready to give to other people?

It works on Macs you trust, but it is not notarized, so each person has to approve it the first time. A public release needs Developer ID signing and notarization.

### How do I update NOVA?

Pull the latest code and double-click **Build NOVA app.command**, then replace the app in Applications. Your data stays in its own folder and is kept.

### Is there an assistant that can show me how to use NOVA?

Yes: the face in the bottom right corner. Ask it anything about NOVA by typing or holding its mic, and press **Show me** for a step-by-step walkthrough on screen. It explains and points; it never changes anything itself. See [The helper](help:helper).

### Where do I get more help?

Open **Help & Support → Support** to check each part and make a support report. See [Get help and support](help:support).
