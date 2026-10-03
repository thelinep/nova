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
| 4. Independent Agent Studio | Dispatch independent agents for bounded coding work; turn each result into a validated proposal; keep every result pending human review; allow writes only through Maataa's approved batch flow | Not implemented. The current Studio reports agent and task evidence read-only and explains that dispatch/review are unavailable. The existing bridge returns plain text and completes tasks directly, so wiring it into code work now would bypass a trustworthy proposal-review state. |
| 5. Guru-Code capability release | Train, export and qualify a dedicated code model against representative held-out tasks | Open gate. There is no trained Guru-Code checkpoint or established coding capability in this checkout. Requires provenance- and license-reviewed data, adequate model/context capacity, training compute, execution-based correctness/security evaluations and Maataa qualification of the exact exported digest. |

## Independent Agent Studio acceptance gates

1. Define a structured agent result contract that contains a bounded summary and
   project-relative file proposals; reject malformed output, path escapes and
   output beyond declared size limits.
2. Convert agent proposals into the existing `workspaceChangeBatches`
   validation flow. An agent result must never write project files directly.
3. Add distinct pending-human-review, accepted, rejected and needs-revision
   states. Do not mark a successful agent result as approved or applied.
4. Require the existing local operator policy, active kill-switch state,
   assigned agent permissions and budget checks before dispatch; record
   cancellation, usage, provenance and audit evidence.
5. Make approvals bind to the reviewed proposal hashes. Any changed proposal
   must be validated and approved again.
6. Prove with unit and Playwright tests that agent output remains unwritten
   until validation and explicit approval, and that reject/revise, cancel,
   budget exhaustion, timeout, rollback and restart recovery fail safely.

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

## Validation evidence for this increment

- Fresh local runs on 2026-10-04, after the stale-response fix:
  - `npm test` in `nova-console`: 725 passed, 3 skipped, 0 failed (728 total).
  - `npm run test:ui` in `nova-console`: 56 passed, 1 skipped, 0 failed (57
    total), including delayed readiness and delayed proposal response coverage.
  - `python3 -m unittest discover -s tests -p 'test_coding.py' -v` in `guru`:
    7 passed.
  - Full Guru suite: 27 total, 23 passed, 2 skipped, 2 errored because
    `sentencepiece` is unavailable; both errors are tokenizer-dependent tests.
- The first Node run in the restricted sandbox failed local-listener tests with
  `EPERM`; the passing rerun had localhost access enabled. The first focused
  Playwright run caught an assertion-label mismatch in the new planning-race
  test; after correcting it, all focused tests passed.
- The browser run skipped one existing Ashtadhyayi integration test because
  its local Sanskrit engine is not installed. These counts are from current
  implementation-run output; the checked-in Oct 3 packaging log predates this
  increment and is not evidence for these results.
- Desktop and 390px screenshots were visually inspected during implementation.

The open gates above are required before calling the complete roadmap or a
Guru-Code release done.
