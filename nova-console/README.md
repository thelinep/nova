# NOVA Runtime

The local backend for the NOVA Console prototype — Phase 1 of its roadmap
("Real inference core"), actually built rather than just planned.

This replaces the browser-only prototype's simulated IndexedDB/timer-based
behavior with a real local Node process: real SQLite persistence, real
streaming completions from a local [Ollama](https://ollama.com) daemon,
real model load/unload/benchmark, and real CPU/RAM/GPU telemetry. The
frontend it serves (`public/index.html`) is the same NOVA Console UI —
same 17 views, same look — with its data layer and the Console/Models/
Runtime views wired to this backend instead of to IndexedDB.

**Zero npm dependencies.** Everything here runs on what Node 22.5+ ships
built in: `node:sqlite` for storage, the global `fetch` for talking to
Ollama, and `node:http` for the server itself. There is nothing to
`npm install` and nothing that can fail to compile on your machine.

## Prerequisites

- **Node.js 22.5 or newer.** Check with `node -v`. `node:sqlite` is an
  experimental-but-stable module that shipped in 22.5; this project needs it.
- **[Ollama](https://ollama.com)**, installed and running (`ollama serve`,
  or just open the Ollama app), with at least one model pulled
  (`ollama pull llama3.1:8b`, or any model you like).

You can run this without Ollama running — the Console falls back to the
same simulated reply generator the original prototype used, and Models/
Runtime show "Ollama not connected" / "Unavailable" honestly instead of
pretending. But the point of Phase 1 is the real path, so for the full
experience, start Ollama first.

## Run it

```
node server.js
```

(or `npm start`, which is the same thing). Then open:

```
http://127.0.0.1:8787/
```

That's it — one process serves both the console UI and its API. No build
step, no separate frontend dev server.

## What's real now vs. what's still simulated

Real, as of this build:

- **Persistence.** Every store (sessions, models, preferences, trace
  events, etc.) is in SQLite at `data/nova.db`, not IndexedDB. Restart the
  process and everything is still there.
- **Chat completions.** Console's Send button streams a real completion
  from Ollama (`POST /api/chat`, proxied through `/api/chat/stream`) when
  the active session's model is an Ollama model and Ollama is reachable.
  TTFT and tok/s in the message stats and the status bar are measured from
  the real response, not jittered math.
- **Model lifecycle.** "Sync from Ollama" in the Models view pulls your
  actually-installed models from `ollama list` and replaces the seeded
  demo entries. Load/Unload call Ollama's real preload/evict API. Benchmark
  runs one real generation and computes tok/s and TTFT from Ollama's own
  `eval_count`/`eval_duration` counters.
- **Telemetry.** CPU and RAM in the Runtime view and status bar come from
  `os.cpus()`/`os.totalmem()` deltas — real, every 1.4s. GPU/VRAM is read
  via `nvidia-smi` when present, or `system_profiler` on macOS for the
  unified-memory pool size; where neither is available it's shown as
  **Unavailable**, not faked.

Still out of scope for Phase 1 (later roadmap phases, not this build):

- Knowledge/RAG retrieval is still the original simulated chunk-picker —
  Console's "searching collections" step doesn't hit a real vector index.
- Automations, Evaluations, Skills, MCP Registry, Agents, and Workflows
  are unchanged from the prototype (still simulated/seeded data).
- Thermal and KV-cache-occupancy readouts in the Runtime view are shown as
  **Unavailable** rather than invented — neither Ollama's API nor Node
  exposes either in a portable way.
- If the active session's model isn't an Ollama model (the seeded
  `llama.cpp`/`MLX`/remote demo entries), or Ollama isn't reachable, chat
  falls back to the original simulated reply path — messages generated
  this way are labeled "simulated" in the UI so it's never ambiguous which
  path produced a given reply.

## Configuration

Environment variables, all optional:

| Variable      | Default                      | Meaning                          |
|---------------|-------------------------------|-----------------------------------|
| `PORT`        | `8787`                        | HTTP port for the console + API  |
| `OLLAMA_HOST` | `http://127.0.0.1:11434`      | Where Ollama's API is listening  |
| `DATA_DIR`    | `./data`                      | Where `nova.db` is written        |

Example: `PORT=9000 OLLAMA_HOST=http://127.0.0.1:11434 node server.js`

## Troubleshooting

- **Diagnostics view shows "NOVA Runtime backend" failing.** You're
  probably opening `public/index.html` directly as a `file://` URL instead
  of through the server. Always go through `http://127.0.0.1:8787/`.
- **Diagnostics shows "Ollama inference engine" failing, or Models says
  0 models.** Ollama isn't running, or is running on a different
  host/port. Start it (`ollama serve`), confirm `curl http://127.0.0.1:11434/api/tags`
  returns JSON, and set `OLLAMA_HOST` if it's not on the default port.
- **A chat message comes back labeled "simulated" even though Ollama is
  running.** The active session's model isn't one of the Ollama-backed
  entries — open Models, click "Sync from Ollama", then switch the
  session to one of the models that appears with `ollama · GGUF` as its
  runtime/format, and Load it.
- **`node:sqlite` error on startup / `DatabaseSync is not a constructor`.**
  Your Node version predates 22.5. Upgrade Node (`nvm install 22`, or
  whatever your Node version manager's equivalent is).

## Project layout

```
server.js            entry point — HTTP routing, wires everything together
lib/db.js            SQLite storage (one table per frontend "store"), incl. real cursor pagination
lib/ollama.js         Ollama HTTP client (status, load/unload, benchmark, chat streaming/tool-calling)
lib/telemetry.js      real CPU/RAM via os, best-effort GPU via nvidia-smi/system_profiler
lib/knowledge.js       real embedding-backed retrieval (Phase 2)
lib/mcp.js, lib/mcp-manager.js   real MCP child-process servers + approval gating (Phase 3)
lib/skill-runner.js, lib/skill-worker.js   sandboxed real skill execution (Phase 3)
lib/agent-loop.js      real tool-calling agent loop (Phase 4)
lib/workflow-engine.js  real, restart-resilient workflow run engine (Phase 4)
lib/eval-bench.js       fixed benchmark + real scoring for Evaluations (Phase 5)
lib/exec-log.js         shared logExecution()/uid() helper (Phase 5)
lib/scheduler.js        real automations scheduler + event receiver (Phase 5)
skills/                real skill entrypoints (codelint, filesearch, webfetch)
public/index.html     the NOVA Console frontend (served statically)
packaging/             desktop packaging — see packaging/README.md for the honest Tauri/Electron account
data/                 SQLite database lives here (created on first run, gitignored)
```

This README describes Phase 1's own scope in detail; the codebase has
since moved through Phases 2-5 of the roadmap (real retrieval, real MCP/
skills, real agents/workflows, and Phase 5's real Automations/Evaluations/
Diagnostics/Trace-History-pagination/privacy-gating plus desktop
packaging). See the published roadmap artifact for the full phase-by-phase
status and each phase's own honestly-documented deviations.

## Desktop packaging

`node packaging/launch.js` (or `npm run launch`) starts the server and
opens it in your default browser — the one packaging path that actually
runs today. `packaging/electron/` and `packaging/tauri/` hold real,
standards-correct desktop-app config that has never been built in this
project's sandboxes (both npm and crates.io are registry-blocked here).
See `packaging/README.md` for the full account.
