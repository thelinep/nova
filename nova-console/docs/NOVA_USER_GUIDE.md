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

### Agents and workflows

An **Agent** combines a model, instructions, allowed skills, and available MCP tools. A **Workflow** connects agents and other nodes into a repeatable sequence.

Start with a small, low-risk task:

1. Confirm the model is reachable.
2. Give the agent only the skills it needs.
3. Run the agent and monitor Trace and Execution History.
4. Add it to a workflow only after its single-run result is reliable.

Workflows are restart-resilient, but a restart cannot make an unavailable model, disconnected MCP server, rejected approval, or invalid input succeed. Treat any publishing, deletion, or external-effect node as a review point.

### Start a new project

In **Local Workspace**, use **New project** to start an app from a template. Choose an approved parent folder, a project name (lowercase letters, numbers, dashes or underscores), an optional title, and a template:

| Template | What you get | Install needed |
| --- | --- | --- |
| Node API | JSON API on Node's built-in HTTP server, with a health route and tests | No |
| Static website | HTML, CSS and JavaScript, a local preview server, and a build step | No |
| React app (Vite) | React single-page app | Yes, before `dev` or `build` |
| Next.js app | Next.js App Router project in JavaScript | Yes, before `dev` or `build` |

**Preview files** lists every file that would be written, without touching disk. **Create project** then builds the project in a hidden staging folder, runs `git init` on branch `main`, and moves it into place in one step, so a failure never leaves a half-made folder. If your git `user.name` and `user.email` are set, NOVA also makes an initial commit. The new folder is approved automatically, so you can scan it, draft changes, and run its tests straight away. Every template's `npm test` works before anything is installed. NOVA does not download packages during this step.

### Local Workspace code changes

In **Local Workspace**, approve a project folder first. NOVA can then draft code changes, either from a chat request or from JSON you enter. A change batch can hold up to 50 operations:

- **edit**: replace one exact text region in an existing file
- **create**: add a new file with its full content; the file must not exist yet
- **delete**: remove an existing file
- **rename**: move an existing file to a path that does not exist yet

Every path must stay inside the approved folder. NOVA refuses paths through symbolic links and anything inside `.git`, `node_modules`, `dist`, `build`, `target`, `.next`, `coverage`, or `.cache`. Each file can appear in only one operation per batch.

Validation runs the whole batch in a copy under NOVA's data folder, so your folder is untouched until you approve. After approval, **Apply atomically** writes every operation or none of them: if one fails, the ones already applied are undone. **Roll back batch** restores every file and removes any folders the batch created. Rollback is refused if any affected file changed after the batch was applied.

For chat requests, name the file you want created, for example "Create src/date.js that exports formatDate". Model output is limited to 1,024 tokens per plan, so ask for small files or split larger features into several requests.

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
