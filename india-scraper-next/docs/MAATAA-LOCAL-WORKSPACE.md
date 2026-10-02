# Maataa local workspace

Brahmini's landing page now starts with model management and a local Maataa conversation workspace. The existing business collector remains below it, with direct links to Query Studio, collected planners, locations, and knowledge collection.

## Use

1. Run Ollama locally and start Brahmini on a loopback host.
2. Refresh installed models. `guru-maataa:latest` (the local model formerly called `maataa:latest`) is selected when installed. Load/unload controls manage memory residency; no model downloads or deletions are triggered.
3. Create a titled conversation and category. Send a prompt in conversation mode, or select “Design a district query”.
4. Review the generated name and template. Saving calls the existing Query Studio method API; it does not run a scrape or change the collector's frozen query.
5. Write an update or milestone linked to the conversation, save a draft, then publish it to the local journal. Publication is local, not internet deployment or a verified completion claim.

## Persistence and boundaries

- SQLite: `data/maataa/conversations.db` (ignored by Git). `MAATAA_DB_PATH` can isolate test data.
- Conversation categories, timestamps, prompts, model names, answers, failures, and publication records persist across reloads.
- Only successful recent turns (last eight) are sent as model context. Full saved history remains in SQLite.
- A pending turn prevents simultaneous inference in the same conversation. After four minutes, a stale pending turn is marked failed when another send begins.
- Failed prompts remain saved; they are not silently converted into AI replies.
- `/api/maataa` rejects non-loopback Host values. Writes also require a matching Origin. Run the app on loopback; this feature is not a multi-user authentication system.
- `OLLAMA_BASE_URL`, or the origin of the existing `OLLAMA_URL`, selects the server; only loopback endpoints are accepted. Default: `http://127.0.0.1:11434`.
- Installed models marked as remote/cloud, and models without conversation capability, are rejected before inference.
- Templates must include `{district}` and `{state}` and contain no other placeholders. Invalid model output becomes a retained failed turn.
- Conversations from other apps or historic Codex tasks are not automatically imported.

## Implementation

- `components/MaataaWorkspace.tsx` and its CSS module: landing surface.
- `app/api/maataa/route.ts`: loopback API and actions.
- `lib/maataa-store.cjs`: durable conversation and publication store.
- `lib/maataa-ai.cjs`: local model inventory, residency controls, chat, and validated query design.
- `tests/maataa.test.cjs`: persistence, concurrency, publication, query validation, local endpoint, and inference-contract tests.

Uses Ollama's documented [chat](https://docs.ollama.com/api/chat), [installed models](https://docs.ollama.com/api/tags), and [running models](https://docs.ollama.com/api/ps) APIs.

## Validation

Run `npm run test:maataa`, `npm test -- --runInBand`, and `BRAHMINI_NEXT_DIST_DIR=.next-maataa-final npm run build` from this application directory. Live inference needs an installed local completion model.

The existing `FloatingPlannerMap.tsx` had an invalid regular-expression literal and an unclosed JSX fragment. Those two syntax issues were repaired to unblock compilation; the map was not redesigned.
