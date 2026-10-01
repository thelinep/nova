# NOVA Runtime

NOVA Runtime is a local AI workspace for chats, Ollama-backed models, document retrieval, MCP tools and approvals, sandboxed skills, agents, workflows, automations, evaluations, diagnostics, and a native Provider Browser.

For setup and day-to-day operation, read the [NOVA Runtime user guide](docs/NOVA_USER_GUIDE.md). Desktop packaging and distribution status are documented in [packaging/README.md](packaging/README.md).

## Current capability status

The implementation spans Phases 1–6:

- SQLite-backed local sessions, models, preferences, operational records, and execution history.
- Ollama model sync, streaming chat, embeddings, model lifecycle actions, and benchmark data.
- Local knowledge ingestion, chunking, vector retrieval, and hybrid reranking.
- Local MCP child servers with approval policies, plus sandboxed skills.
- Server-driven agent loops and restart-resilient workflow runs with explicit approval nodes.
- Scheduled and document-event automations, fixed evaluations, telemetry, diagnostics, Tauri desktop packaging, Provider Browser, and integration coverage.
- Managed background neuron-training jobs, artifact quality evaluation and approval gates, encrypted local connector secrets, reviewed GitHub pull-request delivery, and fail-closed release evidence gates.

Some records are seeded examples until a model is synced, a collection is indexed, or an MCP server is connected. Unsupported integrations report their real state instead of simulating completion.

## Requirements

- Node.js 22.5 or later.
- Ollama with one or more locally installed models for model-backed chat, embeddings, evaluations, and automations.

## Run locally

```bash
npm start
```

Open `http://127.0.0.1:8787/`. NOVA binds to loopback only.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Local NOVA HTTP port. |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama service address. |
| `DATA_DIR` | `./data` | SQLite database location. |

## Test suites

```bash
npm test          # HTTP and Phase 6 integration suite
npm run test:ui   # Playwright Console and Provider Browser interactions
cd packaging/tauri && CARGO_NET_OFFLINE=true cargo test --offline
```

The test suites cover the HTTP boundary, local-access checks, knowledge ingestion and retrieval, MCP approval-gated filesystem calls, sandboxed skills, agent completion, workflow approvals, scheduler recovery, Tauri startup helpers, and browser UI interactions.

## Project layout

```text
server.js                    local HTTP/API server
lib/                          SQLite, Ollama, knowledge, MCP, skills, agents, workflows, scheduler
skills/                       locally runnable skill entrypoints
mcp-servers/                  local filesystem and Git MCP servers
public/index.html             NOVA Console frontend
tests/                        Node HTTP and integration tests
e2e/                          Playwright UI tests
packaging/tauri/              verified macOS Tauri desktop shell
docs/NOVA_USER_GUIDE.md       user guide, support, and FAQs
```

## Distribution boundary

The current macOS app builds and runs locally, but it is ad-hoc signed and relies on a system Node installation. Public distribution still requires a bundled Node sidecar, Developer ID signing, notarization, and a verified installer.

NOVA's release check remains fail-closed until it has current recorded evidence for tests, an artifact manifest, code signing, notarization, a clean install, and an update manifest. A local test pass is not release approval.
