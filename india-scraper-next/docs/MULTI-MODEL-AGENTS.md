# Multi-model agent layer (sketch)

A provider-adapter layer (`lib/providers/`), a skills registry
(`lib/skills/`), an MCP tool-calling client (`lib/mcp/`), a role-based router
(`lib/agent-router.ts`), and a workflow runner (`lib/agent-workflow.ts`) --
together, a way to run different kinds of agent work against whichever cloud
model fits, with automatic fallback, reusable prompt/tool bundles, real
external tool calls, and multi-step pipelines.

## Why this is a separate subsystem from Maataa

`lib/maataa-ai.cjs` (the local conversation workspace behind `app/api/maataa`)
is deliberately local-only: it calls a loopback Ollama instance and actively
rejects anything that looks like a cloud or remote model by name-sniffing and
checking Ollama model metadata. That's an intentional privacy/safety
invariant, not an oversight -- this layer does not touch that file, does not
weaken that check, and is not wired into that route. It exists for separate,
explicitly opt-in agent workflows that are allowed to reach the real
internet.

## Pieces

### Providers (`lib/providers/`)
- `types.ts` -- the shared `ProviderAdapter` contract (`isConfigured()`,
  `complete(request)`), now including a normalized tool-calling shape
  (`ToolSpec`, `ToolCall`, a `'tool'` chat role) on top of plain text.
- `{anthropic,openai,deepseek,gemini}.ts` -- one adapter per vendor, each a
  thin `fetch` wrapper (no new SDK dependency) that also translates tool
  specs/calls into that vendor's own function-calling format. Gemini has no
  real per-call id, so its adapter uses the function name as the id -- fine
  unless a role calls the same tool twice in one turn.
- `index.ts` -- registry (`getProvider`, `configuredProviders`).

### Skills (`lib/skills/`)
- `types.ts` -- a `Skill` is a prompt fragment plus, optionally, the tool
  names it expects to use.
- `index.ts` -- `SKILLS`: `district-domain-knowledge`,
  `event-planner-classification-rules`, `status-report-style`,
  `maataa-roadmap-context`, `repo-read-only-tools`. These are starting-point
  prompts, not tuned ones -- expect to rewrite them once a role is run
  against real labeled examples.

### MCP tool calling (`lib/mcp/`)
- `types.ts` / `stdio-client.ts` -- a from-scratch minimal MCP client (no
  `@modelcontextprotocol/sdk` dependency): spawns a server over
  `child_process`, speaks newline-delimited JSON-RPC 2.0, implements
  `initialize`, `tools/list`, `tools/call`.
- `registry.ts` -- `MCP_SERVERS` (currently one: `filesystem`, the official
  reference filesystem server scoped to this repo) and helpers to list/call
  tools across whichever servers a role names.

### Router (`lib/agent-router.ts`)
- `AGENT_ROLES` -- now 7: `code-gen`, `reasoning-writing`,
  `bulk-classification`, `vision-multimodal`, `district-query-design`,
  `roadmap-triage`, `status-report-writing`. Each names a provider fallback
  chain and, optionally, `skills` and `toolServers`.
- `completeAsAgent(role, messages)` -- loads the role's skills into its
  system prompt, gathers tools from its `toolServers` (narrowed by any
  skill-declared tool names), then loops: call the provider chain, and if the
  model asks for tool calls, run them via MCP and feed results back, up to
  `MAX_TOOL_ROUNDS` (6) rounds before giving up. Returns a `toolTrace` of
  every call made, alongside the usual provider/attempt bookkeeping.

### Workflows (`lib/agent-workflow.ts`)
- `runWorkflow(workflow, initialContext)` -- runs an ordered list of steps,
  each one an agent-role call whose output feeds the next step's input via a
  shared context object; a step can be skipped conditionally (`shouldRun`),
  and a failed step stops the pipeline rather than continuing with a missing
  input.
- `WORKFLOWS['district-collection-health-report']` -- one concrete example:
  triage the raw `status.json` into plain findings (`bulk-classification`
  role), then draft a narrative report from those findings
  (`status-report-writing` role). The same kind of output this project's
  "status matrix" work produced by hand earlier.

## Env vars this introduces (none exist yet -- add to `.env.local`)

| Var | Used by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | anthropic.ts | required to enable that provider |
| `ANTHROPIC_MODEL` | anthropic.ts | optional override, default `claude-sonnet-4-5` |
| `ANTHROPIC_FAST_MODEL` | agent-router.ts | optional override for the `bulk-classification` fallback |
| `OPENAI_API_KEY` | openai.ts | required to enable that provider |
| `OPENAI_MODEL` / `OPENAI_CODE_MODEL` | openai.ts / agent-router.ts | optional overrides |
| `DEEPSEEK_API_KEY` | deepseek.ts | required to enable that provider |
| `DEEPSEEK_MODEL` | deepseek.ts | optional override, default `deepseek-chat` |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | gemini.ts | required to enable that provider |
| `GEMINI_MODEL` | gemini.ts | optional override, default `gemini-2.0-flash` |

An adapter with no key set reports `isConfigured() === false` and the router
skips it -- nothing crashes if only one or two keys are ever filled in.

**Model name caution:** the defaults above are illustrative placeholders, not
verified current model IDs -- confirm each vendor's current model slug in
their own docs before relying on a default rather than setting the `*_MODEL`
env var explicitly.

**MCP caution:** the `filesystem` server entry runs via `npx -y
@modelcontextprotocol/server-filesystem`, which needs npm registry access the
first time it runs (to fetch the package) -- it will simply fail to start (and
be skipped, same as an unconfigured provider) in a fully offline environment
until that package is available locally.

## Status

Sketch only. Not imported from any route, script, or component yet. No new
package.json dependency was added. Typechecked standalone with the project's
own `tsconfig.json` settings; none of this was run against a live API key or
a live MCP server from this environment -- outbound network to the model
vendors is blocked from the sandbox that designed this, and `npx` package
fetches were not attempted either.

## Wiring it in next (not done yet)

A new route (e.g. `app/api/agents/route.ts`) calling `completeAsAgent(role,
messages)` or `runWorkflow(WORKFLOWS[id], context)`, mirroring
`app/api/maataa/route.ts`'s existing POST/try-catch/`{error: message}` shape,
is the natural next step. Add an `AGENT_ROLES` entry for each new kind of
agent work, and a `SKILLS` entry for any prompt fragment more than one role
should share.
