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
| Image to video | `lib/video-gen.js` | Camera moves/animatics via ffmpeg; AI motion via ComfyUI Wan 2.2 TI2V 5B; last-frame continuation and clip joining |
| Local AI motion with sound | `lib/video-ltx.js`, `scripts/install-ltx-mac.sh` | LTX-2.3 MLX q4 via ltx-2-mlx CLI; default engine; Wan 2.2 kept as option. Not yet run on the Mac (needs ~30 GB free) |
| Library folder + skill-output history | `lib/library.js` | Generated media, transcripts and skill outputs mirrored to ~/Documents/NOVA Library/<day>/ with recipe .json; `skillOutputs` store; tests set NOVA_LIBRARY_DIR to a temp folder |
| Memory guard rails | `lib/heavy-jobs.js` | One heavy job at a time; unload Ollama/ComfyUI models first; Wan blocked under 32 GB; LTX capped on 16 GB |
| Translate, Export to Slides | `skills/translate.js`, `skills/pptx.js` | Real on local Ollama; old simulated records upgraded in place |
| Browser Automation MCP | `mcp-servers/browser-server.js` | Headless Chromium via Playwright; needs web access on; approval per call |
| Real-model checks | `scripts/validate-real-models.js` | `npm run test:real-models [-- model]`: dev loop x2, summarize, translate, slides, shot list |

Tests at handoff: `npm test` 134 pass, 1 skipped where Chromium is absent (updated 2026-09-25) in `nova-console`; scraper Jest 133/133 and node tests 10/10.

## Known limits

- Plans default to 2,048 output tokens (`NOVA_PLAN_MAX_TOKENS`, 256-8192).
- Only `llama3:latest` passed the four behavioral planning fixtures; `llama3.2` and `maataa` fail multi-file and large-repository plans. Unqualified models are not selected for those workflows.
- The development loop and text skills are verified against scripted models; `npm run test:real-models` checks them on a real one and has not been run on the Mac yet.
- While a loop runs, the Local Workspace panel refreshes every 2 s and can clear text being typed elsewhere in that view.
- `npm run test:ui` (Playwright) and the Rust tests have not been run since these changes.

## Open work, in suggested order

1. Run `npm run test:all` and fix anything in the new Local Workspace panels.
2. Switch the seeded agents (`agt_research`, `agt_coder`, `agt_writer`) from demo models to `llama3:latest` so the two seeded workflows can run end to end.
3. Run `npm run test:real-models` with llama3:latest and with a stronger coding model; qualify the better one through `npm run test:ollama-planner`.
4. Character reference for consistent keyframes (continuity beyond last-frame chaining).
5. Release: bundle a Node sidecar, Developer ID signing, notarization, verified installer.

## Housekeeping pending

- Git cleanup in `~/Documents/Repos/brahmini`: delete tags `backup/pre-strip-*` and `backup/pre-split-*` and `refs/original/*`, then `git gc --prune=now` (about 669 MB down to a few MB). Everything is safely on GitHub.
- Run `git reset` in the Codex worktree at `~/.codex/worktrees/3c24` to clear a stale change.
