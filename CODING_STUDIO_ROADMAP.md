# Maataa Coding Studio → Independent Agent Studio

This roadmap records the agreed first-release scope and current evidence. It is
not a claim that Guru-Code or autonomous agent execution is production-ready.

## Product decisions

- Coding Studio starts with one approved local project and one bounded task.
- It is a task, proposal and review surface, not a full source-code editor.
- Maataa owns project reads, validation, writes, commands and Git delivery.
- A model choice is exact: Maataa must use the selected installed Ollama
  version or stop with a blocker. It cannot silently substitute a model.
- Code syntax and identifiers stay conventional. Brahmi comments and
  explanations are experimental and separate from programming syntax.
- Guru remains a separate model-development package. Coding Studio does not
  depend on Brahmini Knowledge Collector.
- The current product note assumes one local operator; shared projects and
  multi-user collaboration are outside this release.

## Phases and status

| Phase | Result | Status and evidence |
| --- | --- | --- |
| 0. Governed local project foundation | Explicitly approved roots, bounded context, proposal review, isolated checks, approval-gated apply/rollback, command allowlists and reviewed Git actions | Existing Maataa workspace services; reused by this Studio rather than adding another write path. |
| 1. Exact-model coding gate | Use a named Ollama model only when its current digest has passed the required coding workflow and clarification, timeout and cancellation controls | Implemented in `nova-console/lib/model-qualifications.js` and `nova-console/lib/code-planner.js`; explicit selection fails closed and preserves automatic selection when no model is named. |
| 2. Guru-Code data/evaluation foundation | Versioned task format, provenance fields, train-only SFT export and target-free held-out fixture checks | Implemented in `guru/data/coding/`, `guru/guru/coding.py` and `guru/CODING.md`. The data is five tiny synthetic examples, not a representative corpus or capability benchmark. |
| 3. One-project Coding Studio | Readiness check, selected model, bounded request, reviewable proposal, existing validation/approval/apply/rollback flow, Guru readiness and read-only team status | Implemented in `nova-console/public/index.html`; help is in `nova-console/docs/help/41-coding-studio.md`; deterministic browser coverage is in `nova-console/e2e/coding-studio.spec.js`. |
| 4. Independent Agent Studio | Dispatch independent agents for bounded coding work; turn each result into a validated proposal; keep every result pending human review; allow writes only through Maataa's approved batch flow | Implemented for one local operator and one approved project. The Studio has bounded dispatch/retry/cancel/review routes in `nova-console/server.js`; exact-model, scoped-policy and budget gates plus startup recovery in `nova-console/lib/coding-agent-runtime.js`; a coding-only job bridge and cancellation/halt propagation; digest-bound proposal acceptance that creates the batch transactionally only after human review. Acceptance creates a draft batch only: existing validation, separate approval, apply and rollback remain in Maataa Local Workspace. The UI now renders proposal code, review notes and state-specific actions. Generic agent endpoints and non-coding job kinds remain separate. Full gate evidence is recorded below after the current complete run. |
| 5. Guru-Code capability release | Train, export and qualify a dedicated code model against representative held-out tasks | Open gate. There is no trained Guru-Code checkpoint or established coding capability in this checkout. Requires provenance- and license-reviewed data, adequate model/context capacity, training compute, execution-based correctness/security evaluations and Maataa qualification of the exact exported digest. |

## Independent Agent Studio acceptance gates

1. Define a structured agent result contract that contains a bounded summary and
   project-relative file proposals; reject malformed output, path escapes and
   output beyond declared size limits. **Implemented and consumed by the
   Coding Studio result handler.**
2. Convert agent proposals into the existing `workspaceChangeBatches`
   validation flow. An agent result must never write project files directly.
   **Implemented; acceptance records a draft batch and task/model/draft digest
   linkage in one transaction.**
3. Add distinct pending-human-review, accepted, rejected and needs-revision
   states. Do not mark a successful agent result as approved or applied.
   **Implemented, including explicit revision request and retry actions.**
4. Require the existing local operator policy, active kill-switch state,
   assigned agent permissions and budget checks before dispatch; record
   cancellation, usage, provenance and audit evidence.
   **Implemented with scoped coding-worker policy, halt/cancellation signals,
   exact model digest checks, bounded usage accounting and audit events.**
5. Make approvals bind to the reviewed proposal hashes. Any changed proposal
   must be validated and approved again.
   **Implemented through the existing batch approval hash checks; accepting an
   agent result does not approve or apply the batch.**
6. Prove with unit and Playwright tests that agent output remains unwritten
   until validation and explicit approval, and that reject/revise, cancel,
   budget exhaustion, timeout, rollback and restart recovery fail safely.
   **Covered by focused runtime/API/bridge/job tests and Coding Studio browser
   flows; see fresh full-suite evidence below.**

## Guru-Code release gates

- Expand beyond synthetic fixtures with a rights-reviewed, provenance-recorded
  code corpus and a representative target-free evaluation suite.
- Support the context size and model capability required by Maataa's coding
  workflows; document the exact training recipe and exported artifact digest.
- Evaluate generated code by running isolated tests and security checks, not
  only JSON shape, syntax and expected names.
- Qualify the exact exported Ollama digest through Maataa before showing it as
  eligible for code planning.
- Never treat SFT export success, an example-set pass or a model's `Guru-Code`
  label as proof of capability.

The fresh 2026-10-04 host audit found no Guru-Code checkpoint or encoded code
corpus. The M3 Pro host has Metal hardware, but its installed PyTorch 2.2.2
reports MPS unavailable; the Guru requirements specify PyTorch 2.4 or newer.
SentencePiece and the GGUF Python package are absent. Guru's nano/mini/small
configurations have only 512/1024/1024 tokens and base-1b has 2048; only its
7b configuration meets Maataa's current 4096-token minimum. The two training
examples and three held-out synthetic examples validate plumbing, not
capability. The detailed intake and release evidence contract is in
`guru/CODING_RELEASE.md`, with a deliberately incomplete machine-readable
template in `guru/data/coding/release-manifest.example.json`. Closing these
gates requires owner-provided rights-reviewed data and a suitable training
host, followed by executable evaluation and Maataa's separate 18-trial
exact-digest qualification on the real exported artifact.

## Validation evidence for this increment

- Fresh local runs on 2026-10-04 after the complete-runner fixes:
  - `npm run test:all` in `nova-console`: Node **752 passed, 3 skipped, 0
    failed**; Playwright **58 passed, 1 skipped, 0 failed**; Rust **16 passed,
    0 failed**. The browser skip is the existing Ashtadhyayi/Sanskrit engine
    integration that needs an optional local engine.
  - The new focused agent review Playwright scenarios pass 4/4: accepted
    proposal through separate validation, approval, apply and rollback;
    revision/retry/cancel/reject without a new batch; stale readiness keeps
    writes gated; and every sidebar view opens without a script error.
  - Focused runtime/bridge budget accounting tests: 28 passed, 0 failed;
    successful runs charge measured tokens and one pre-dispatch job, while
    failed/cancelled runs settle one bounded token reservation.
  - Current Guru coding exporter checks pass 22/22, including reviewed source
    item byte hashes, held-out split presence, leakage rejection, duplicate-key
    and non-standard-number rejection, no-clobber output, and interrupted
    sidecar recovery. The current full Guru run reports 38 passed, 2 skipped,
    and 2 tokenizer-dependent errors because `sentencepiece` is unavailable;
    this does not certify a model.
- The first Node run in the restricted sandbox failed local-listener tests with
  `EPERM`; the passing rerun had localhost access enabled. The first focused
  Playwright run caught an assertion-label mismatch in the new planning-race
  test; after correcting it, all focused tests passed.
- The browser run skipped one existing Ashtadhyayi integration test because
  its local Sanskrit engine is not installed. These counts are from current
  implementation-run output; the checked-in Oct 3 packaging log predates this
  increment and is not evidence for these results.
- Desktop and 390px screenshots were visually inspected during implementation.

The refreshed 2026-10-04 exporter checks verify the bytes of each saved source
item snapshot and reject corpora without both train and held-out eval rows.
Owner-provided corpus files and training resources have not yet been delivered;
the release path remains open. The exporter verifies consistency and recorded
review fields, while reviewer authority and source-to-archive association still
require human review evidence.

An original four-train/two-eval synthetic starter corpus is now in
`guru/data/coding/invented-starter-v1.jsonl`; it is smoke-only and does not
close the data gate. External dataset candidates and current cloud compute
pricing are inventoried in `guru/CODING_CORPUS_AND_COMPUTE_PLAN.md`. The plan
finds that Guru's from-scratch 7B trainer needs a memory-capacity pass before
any paid multi-week training reservation.

The open gates above are required before calling the complete roadmap or a
Guru-Code release done.
