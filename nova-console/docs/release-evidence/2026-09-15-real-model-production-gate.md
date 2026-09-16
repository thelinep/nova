# Real-model production gate — 2026-09-15

Scope: conversational code planning through the local Ollama service. This evidence does not approve or apply any generated source change.

## Gate controls

- The planner accepts only model records whose runtime is `ollama` and whose model name is present in the live `/api/tags` inventory.
- Before inference, `/api/show` must report `completion`, a chat template, and a context window of at least 4,096 tokens.
- Repository text is reduced to fit the reported context window with a 2,048-token output reserve and a 120,000-character ceiling.
- Planner requests use Ollama JSON mode, temperature zero, and a bounded 1,024-token generation.
- Every result stores the checked capabilities, context length, model family, parameter size, timestamp, presented-file count, and `demoMode: false`.
- Demo records are rejected by the code-planning API. Simulated loading, unloading, benchmarking, and chat replies require the user to enable Demo mode in Settings.

## Installed-model probe

Command: `npm run test:ollama-planner`

Checked at: `2026-09-15T04:54:02.282Z` against `http://127.0.0.1:11434`.

| Model | Reported capabilities | Context | Result | Source unchanged |
| --- | --- | ---: | --- | --- |
| `llama3:latest` | completion | 8,192 | passed | yes |
| `llama3.2:latest` | completion, tools | 131,072 | passed | yes |
| `maataa:latest` | completion, tools | 131,072 | passed | yes |

Each model received the same one-file request and returned a valid `workspace-change-proposal`. The probe verified that planning created a draft only and did not alter the fixture.

## Regression validation

- `npm test`: 53 passed.
- `npm run test:ui`: 11 passed, including a browser test proving Demo mode starts disabled and persists only after explicit opt-in.

The live probe establishes compatibility for this bounded fixture on this machine at the recorded time. It does not establish correctness for arbitrary repositories or approve generated patches; existing diff review, validation, and write approval gates still apply.

## Expanded behavioral validation

The stronger run at `2026-09-15T08:44:23.781Z` compared each proposed final file with an exact expected result rather than accepting any structurally valid draft. Raw replies, model digests, token counts, and failures are retained in `2026-09-15-expanded-model-results-final.json`.

| Model | Single file | Ordered multi-file | Ambiguous request | Large repository | Behavioral result |
| --- | --- | --- | --- | --- | --- |
| `llama3:latest` | passed | passed | failed | passed | 3/4 |
| `llama3.2:latest` | passed | failed | failed | failed | 1/4 |
| `maataa:latest` | passed | failed | failed | failed | 1/4 |

All models guessed a change for `Improve this.` instead of requesting clarification. The 3.2B models also returned malformed multi-file entries and created `const const limit = 3;` in the large-repository fixture. Therefore no installed model passes the expanded behavioral production gate for general conversational code planning.

Timeout and cancellation were then exercised during real Ollama generation at `2026-09-15T14:47:51.267Z`. All six model/fixture combinations passed and created no draft. Exact results are retained in `2026-09-15-expanded-model-interruptions.json`.

Deterministic regression tests additionally reject malformed JSON, wrong schemas, empty changes, truncated generations, missing or duplicate match text, changes with no effect, unpresented files, late responses after cancellation, and model attempts to override the approved workspace root. Large repositories prioritize filenames named in the request and record omitted-file scope.

## Ambiguity, repair, and semantic gates

The final follow-up run at `2026-09-15T15:45:19.426Z` added three controls:

- A deterministic ambiguity preflight requires an exact filename plus an intended outcome or supplied acceptance criterion before any Ollama call.
- The structured contract requires a summary, acceptance criteria, and complete exact-replacement fields. Invalid output receives one bounded repair attempt. NOVA persists the original response, repair response, validation errors, model, request, timestamps, and resulting proposal identifier in `workspacePlanningAttempts`.
- Successful drafts are applied in the isolated workspace copy. Request-named targets, exact replacements, removed source fragments, dependency order, and parser validity are checked there. Behavioral claims that cannot be proven through deterministic file inspection are marked for manual review.

Live outcome: `llama3:latest` passed all four behavioral fixtures. `llama3.2:latest` and `maataa:latest` passed single-file and ambiguity checks but their multi-file and large-repository output remained invalid after the one repair attempt. Overall: 8/12 passed. The failed outputs did not create proposals. Exact original and repair responses are retained in `2026-09-15-planner-gates-live-final.json`.
