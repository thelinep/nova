# Handover — brahmini / Maataa Workstation

Last updated: 2026-11-12 (by Claude, session https://claude.ai/code/session_018RmhsDQ34Afq56shZmemVL)

**हिंदी सार (Hemant के लिए):** चरण 1 का काम पूरा है और GitHub पर push हो चुका है (`a59c09c`)।
अगले agent को यह फ़ाइल पढ़कर काम शुरू करना है। तीन फ़ैसले आपसे बाक़ी हैं (नीचे "Open decisions")।

---

## 1. Owner and how to talk to him
- Hemant (Vesahe Film Solutions). Writes Hindi / Hinglish. **Reply in plain, layman-friendly Hindi.**
- He runs launchers himself and pastes Terminal output back. Give him a launcher to double-click rather than shell commands where possible.

## 2. Repo, branch, pushing
- Mac path: `/Users/vesahe/Documents/Repos/brahmini`. GitHub: `thelinep/nova`.
- Working branch: **`codex/absorb-tlps-locations`** (pushed, in sync at `a59c09c`). `master` also pushed by the launcher.
- **Push only via `launchers/Push to GitHub as thelinep.command`** (switches `gh` to the `thelinep` account; the default account `wortforfilms` gets 403).
- Do **not** commit `nova-console/e2e/settings-privacy-state.spec.js` (untracked, not ours).
- If you work from a sandbox/VM on the connected folder: deletes are blocked, so git leaves `.git/HEAD.lock` / `index.lock` behind. Move them aside (`mv .git/HEAD.lock .git/stale-HEAD-lock-$(date +%s)`) or ask for delete permission. Use `TMPDIR=$HOME/t` for tests if `/tmp` is full.
- Commit style: conventional (`feat(x): …`, `fix(x): …`), plain-language body.

## 3. What the projects are
- `nova-console/` — **Maataa Workstation**: Node 22, zero-dependency `server.js`, UI in `public/index.html`, logic in `lib/`, skills in `skills/`, tests `tests/*.test.js` (node:test), Playwright e2e in `e2e/`, Tauri packaging.
- `guru/` — Python package; tests `pytest tests` (use a venv; e.g. `/tmp/gv`).
- `launchers/` + `Maataa.command` — double-click menus for Hemant.
- Roadmap doc (Claude Docs): https://claude.ai/artifact/GmMLLgradavjyngPpVS3Cx — tabs: Roadmap, License list, Phase 1 kit, Investor readiness.

## 4. Test status (2026-11-12)
- nova-console: `node --test tests/*.test.js` → 890 tests, 880 pass, 9 skipped, **1 known fail**: agent-browser test #33 needs Chromium (fails only in VMs without it).
- guru: 494 pass, 5 skipped, **1 VM-only flaky**: `tests/test_model_artifact_inspector.py::test_same_size_rewrite_with_mtime_restore_is_rejected` (Linux VM has coarse ctime; passes on the Mac). The earlier "7 failing" guru tests all pass now — no code change was needed.
- Real-model checks: `launchers/Maataa - Test with real models.command` (runs `nova-console/scripts/validate-real-models.js`: loop, summarize, translate, translate-glossary, slides, shotlist, shotlist-hindi, vision, 11 Indian languages). `launchers/Maataa - Try a new model.command` pulls + checks + keep/remove.

## 5. Local models (Mac: 18 GB RAM, ~11 GB disk free)
| Model | Status |
|---|---|
| `maataa` (Llama 3.2 + system prompt) | fast English work; Llama 3.2 Community License |
| `qwen3.5:9b-q4_K_M` | **recommended main model** (pending Hemant's OK). 11/11 Indic, vision, Apache 2.0. Needs the glossary for name spelling. Skills send `think:false`. |
| `gemma4:12b-it-q4_K_M` | good but slow, ~8 GB; removal pending Hemant's OK |
| removed | llama3.2-vision (broken on Ollama ≥0.30), qwen2.5-coder:7b, gpt-oss:20b (flaky under memory pressure) |
- Ollama 0.40.x. Prefer `-q4_K_M` tags: plain tags may pull MLX builds (slower; no `format:'json'` → we fall back to plain text in `lib/ollama.js`).
- Embeddings: default `nomic-embed-text` (`lib/knowledge.js`, env `EMBED_MODEL`).

## 6. What was done recently (newest first)
- Workspace panel keeps typed text/focus/caret across the 2 s dev-loop refresh (`keepTypedInput` in `public/index.html`).
- Chat **Think** button (`thinkToggleBtn`); thinking models answer without thinking by default (`lib/chat-turn.js`, `lib/skill-host.js` `modelThinks`).
- Translate: phonetic name rules + **glossary** input + one correction round (`skills/translate.js`).
- Indian-language detection by script (`lib/indic-lang.js`); voice replies use a matching voice (`lib/voice-chat.js`).
- Print/PDF view for saved skill outputs (`lib/print-view.js`, `GET /api/skill-outputs/:id/print`).
- Shot list per screenplay scene, ≥3 shots, Hindi headings (`skills/shotlist.js`); slide count check (`skills/pptx.js`); summary citation repair (`skills/summarize.js`).
- Launchers: push as thelinep, real-model tests, try-a-new-model (auto-updates Ollama, MLX warning).

## 7. Open decisions (ask Hemant)
1. Make `qwen3.5:9b-q4_K_M` the main model? If yes → update roadmap doc tabs "License list" and "Phase 1 kit".
2. Remove `gemma4` (~8 GB)?
3. Build a **Settings name-glossary** (saved once, applied to every translation)?
4. (Latest ask) Coding / folder-understanding models: proposed adding two checks to `validate-real-models.js` — (a) answer a question from a file, (b) edit a file via a tool call — then compare `qwen3.5:9b` vs `ministral-3:8b` (~6 GB, reliable tool calls), and `nomic-embed-text` vs `qwen3-embedding:0.6b` (multilingual, code). Raise `num_ctx` to ~32k for coding (not more on 18 GB). Big coders (qwen3-coder:30b, devstral) do not fit this Mac.

## 8. Next phases
See the roadmap doc. Phase 1 (services + film-toolkit pilot) is done in code; business items (3 service clients, pilot project choice) are Hemant's.
