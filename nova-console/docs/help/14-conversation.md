---
id: conversation
title: Add sources, live steps, computer and voice
section: Chat and knowledge
order: 14
summary: Give NOVA a folder, files, a web page or a git repo to read, watch what it is doing step by step, let it use your Mac with your approval, and talk to it out loud.
keywords: add folder add file add url web page git repo clone source attach drag drop steps activity parallel queue computer run command open app screenshot click type clipboard approval allow deny voice microphone talk read aloud speak memory remember forget edit resend regenerate react pin follow-up
views: console
---
Chat in NOVA works like talking to a colleague who can read what you hand them, show you what they are doing, and, when you allow it, use your computer.

@screen media/conversation.jpg "A reply grounded in a folder of shoot notes, with its steps above it."

## Add something for NOVA to read

Press **+** under the message box:

| Choice | What NOVA does |
| --- | --- |
| **Add files** | Reads documents, code, CSV, PDF (needs `pdftotext`), Word, PowerPoint and Excel text. Images go to the model as pictures (needs a vision model). |
| **Add folder** | Reads the text files in a folder and its subfolders, skipping `node_modules`, `.git`, build folders and binary files. It never changes the folder. |
| **Add web page** | Fetches the page and keeps its readable text. Needs **Settings > Allow network access**. |
| **Add git repo** | Clones the latest commit (`https://github.com/owner/repo`, `owner/repo`, or the path of a repository on this Mac) and reads it, with its recent history. Remote repositories need network access. |
| **Look at my screen** | Turns on Computer and asks NOVA to take a screenshot and describe it. |

You can also drag files onto the conversation, or paste a link: NOVA offers to read the page or repository.

Ask "scan and report" (or review, audit, check) about an added folder or repository and NOVA also runs its read-only scan (code health, security signals, tests, documentation gaps, duplicate files and git changes) and writes the report from the findings, citing files. Nothing in the folder is changed.

Each thing you add appears as a chip above the message box. While it is being read the chip shows what is happening; when it is ready, ask about it. NOVA picks the passages that match your question and names the files it used under the answer. Remove a chip with **×**. **Inspector > Files** lists what was read.

@screen media/conversation-add.jpg "The + menu."

## See what NOVA is doing

Above each reply, a steps panel shows every step as it happens: reading your sources, searching knowledge, thinking, each computer action and its result, writing the reply, with timings. When the reply is done it folds into one line ("Worked for 4 s · 5 steps"); click it to open it again.

The **list icon** in the top bar opens **Activity**: everything running across all chats, such as replies, folders being read and repositories being cloned. Several things can run at once. Stop any of them there. The badge shows how many are running, and turns red when NOVA is waiting for your OK.

You do not have to wait: type the next message while NOVA is answering and it is **queued**, then answered straight after.

@screen media/activity.jpg "Activity: every running task, and actions waiting for approval."

## Let NOVA use your computer

Turn on **Computer** under the message box. It is off in every new chat. NOVA can then:

- **Run commands** in a terminal, inside approved folders: folders you added to this chat and folders approved in Local Workspace.
- **Open** a web link, an app or a file, or show a file in Finder.
- **See and control the screen**: take a screenshot, click, type, press keys and scroll. Reading screenshots needs a vision model.
- **Use the clipboard**, and **list, read, create, move and rename files** in approved folders. It never deletes; **Move to Trash** goes through Finder, so you can put the file back.

If NOVA needs a folder that is not approved yet (for example your Desktop), it asks for it right in the chat: **Allow this folder** approves it and NOVA carries on. You can also type `add folder ~/Desktop` (or `/folder Desktop`, `/url …`, `/git …`) in the message box instead of using the + menu.

Before every action NOVA shows exactly what it wants to do and waits:

- **Allow** does it once.
- **Allow for this chat** allows that kind of action for the rest of the conversation.
- **Deny** tells NOVA not to, and it asks what you would prefer instead.

Some things are always refused: administrator (`sudo`) commands, erasing disks, deleting your home folder, shutting down, and downloading and running a script in one step.

@screen media/computer-approval.jpg "NOVA asks before running a command."

@video media/conversation.mp4 "Adding a folder, asking about it, and approving a command."

The model must support tools, for example `qwen2.5`, `llama3.1` or `mistral-nemo`. If it does not, NOVA answers anyway and says why it could not act.

**Settings > Computer** can turn computer use off everywhere, turn off screen control, or let read-only actions (looking at files, the screen or the clipboard) run without asking. On macOS, clicking and typing need **System Settings > Privacy & Security > Accessibility**, and screenshots of other windows need **Screen Recording**. Allow NOVA Runtime, or Terminal when you use browser mode.

## Talk and listen

- **Hold the microphone** while you speak and let go to send. Or click it once, speak, and click again. whisper.cpp turns your words into text on this Mac. **Settings > Send right after I speak** decides whether it sends straight away.
- **Voice** reads every reply aloud, using Kokoro voices when installed, else the macOS voice. The **speaker** on any reply reads just that one.

## Edit, retry, react, pin

Hover a message for its buttons:

- **Your message:** ✏ edit it and resend (the later replies are replaced), or copy it.
- **A reply:** copy, read aloud, regenerate, 👍 / 👎, pin (pinned replies are listed under Inspector > Files), remember, or save to Knowledge.
- **Follow-ups:** after a reply NOVA suggests three short follow-ups; click one to send it.

## Memory

Say "remember that I shoot on an FX3" and NOVA saves it; "forget the FX3" removes it. The **brain** button on a reply saves a note from it. NOVA reads your notes at the start of every chat. See, add and delete them in **Settings > Memory**. Nothing is saved unless you ask.
