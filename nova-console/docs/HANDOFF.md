# NOVA handoff — 2026-09-25

Context for continuing NOVA work inside NOVA itself. Load this file into a knowledge collection so the local model can cite it.

## Repositories

- Code: https://github.com/thelinep/nova (branch `codex/absorb-tlps-locations` is current; `master`, `codex/nova-model-qualification`, `wortforfilms-fix-build-and-scripts` also pushed).
- Data: https://github.com/thelinep/brahmini-data, mounted as a git submodule at `india-scraper-next/data/tlps`. Clone with `--recurse-submodules`.
- Local path: `~/Documents/Repos/brahmini` (NOVA lives in `nova-console/`).

## What NOVA can do now

| Area | Where | Notes |
| --- | --- | --- |
| Session Summarizer skill | `skills/summarize.js`, `lib/skill-host.js` | Local Ollama only; cites `[S#]` passages; needs `session:read` |
| File create / delete / rename in change batches | `lib/workspace-changes.js` | Atomic apply, rollback, protected folders refused |
| New projects from templates | `lib/workspace-projects.js`, `lib/project-templates.js` | Node API, static site, React (Vite), Next.js |
| Package install and dev server | `lib/workspace-runner.js` | Install needs Settings > Privacy > Allow network access; dev bound to 127.0.0.1 |
| Development loop | `lib/dev-loop.js` | Plan, apply to private copy, test, retry (1-5 attempts); result is a batch you approve |
| Vision in chat, media store | `lib/media.js`, `server.js` | Images/audio/video detected from bytes; vision models only |
| Transcription | `lib/transcribe.js` | whisper.cpp + ffmpeg, afconvert fallback; audio and video |
| Image generation | `lib/image-gen.js` | Local ComfyUI on 8188 or 8000; recipe saved per image |
| Image to video | `lib/video-gen.js` | Camera moves/animatics via ffmpeg; AI motion via ComfyUI Wan 2.2 TI2V 5B |

Tests at handoff: `npm test` 127/127 (updated 2026-09-25) in `nova-console`; scraper Jest 133/133 and node tests 10/10.

## Known limits

- Plans are capped at 1,024 output tokens; keep requests to one or two named files.
- Only `llama3:latest` passed the four behavioral planning fixtures; `llama3.2` and `maataa` fail multi-file and large-repository plans. Unqualified models are not selected for those workflows.
- The development loop and summarizer have only been tested with a scripted model, not a real one.
- While a loop runs, the Local Workspace panel refreshes every 2 s and can clear text being typed elsewhere in that view.
- `npm run test:ui` (Playwright) and the Rust tests have not been run since these changes.

## Open work, in suggested order

1. Run `npm run test:all` and fix anything in the new Local Workspace panels.
2. Switch the seeded agents (`agt_research`, `agt_coder`, `agt_writer`) from demo models to `llama3:latest` so the two seeded workflows can run end to end.
3. Try the development loop on a small real task and record how the local model performs.
4. Raise the plan output cap and qualify a stronger coding model through `npm run test:ollama-planner`.
5. Replace the placeholder skills (`skl_translate`, `skl_pptx`) and the placeholder Browser MCP server, or remove them.
6. Release: bundle a Node sidecar, Developer ID signing, notarization, verified installer.

## Housekeeping pending

- Git cleanup in `~/Documents/Repos/brahmini`: delete tags `backup/pre-strip-*` and `backup/pre-split-*` and `refs/original/*`, then `git gc --prune=now` (about 669 MB down to a few MB). Everything is safely on GitHub.
- Run `git reset` in the Codex worktree at `~/.codex/worktrees/3c24` to clear a stale change.
