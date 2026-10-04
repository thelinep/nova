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

## Future: Ollama-independent Guru runtime

The future direction is to let Maataa Workstation run Guru locally without
requiring Ollama. The current Coding Studio remains Ollama-backed: model
inventory, chat, planning and exact-digest qualification call the Ollama
runtime directly.

Guru already has a checkpoint-to-Hugging-Face-to-GGUF export path using a
pinned llama.cpp converter, followed by Ollama import. A future runtime phase
can evaluate a direct llama.cpp backend first, then consider Apple-native
inference if it offers a verified benefit. Keep runtime choice separate from
model identity and qualification: records must bind the exact model artifact
digest, tokenizer, context, runtime version and tested capabilities. The
Ollama adapter can remain available for other local models.

This direction needs a shared local-runtime contract for discovery, metadata,
load/unload, chat and streaming, cancellation, context reporting, resource
status and digest identity; Maataa's planner, agent runtime and qualification
suite must consume that contract instead of assuming Ollama. It is not
implemented yet. The current local micro prototype cannot use this export path
because it has a temporary byte tokenizer and only 512 positions.

## Phases and status

| Phase | Result | Status and evidence |
| --- | --- | --- |
| 0. Governed local project foundation | Explicitly approved roots, bounded context, proposal review, isolated checks, approval-gated apply/rollback, command allowlists and reviewed Git actions | Existing Maataa workspace services; reused by this Studio rather than adding another write path. |
| 1. Exact-model coding gate | Use a named Ollama model only when its current digest has passed the required coding workflow and clarification, timeout and cancellation controls | Implemented in `nova-console/lib/model-qualifications.js` and `nova-console/lib/code-planner.js`; explicit selection fails closed and preserves automatic selection when no model is named. |
| 2. Guru-Code data/evaluation foundation | Versioned task format, provenance fields, train-only SFT export and target-free held-out fixture checks | Plumbing implemented in `guru/data/coding/`, `guru/guru/coding.py` and `guru/CODING.md`. V1 retains train/eval; v2 adds target-bearing validation and requires all three splits for release. Mixed schema versions are rejected. The checked-in examples remain synthetic smoke fixtures, not a representative corpus or capability benchmark. |
| 3. One-project Coding Studio | Readiness check, selected model, bounded request, reviewable proposal, existing validation/approval/apply/rollback flow, Guru readiness and read-only team status | Implemented in `nova-console/public/index.html`; help is in `nova-console/docs/help/41-coding-studio.md`; deterministic browser coverage is in `nova-console/e2e/coding-studio.spec.js`. |
| 4. Independent Agent Studio | Dispatch independent agents for bounded coding work; turn each result into a validated proposal; keep every result pending human review; allow writes only through Maataa's approved batch flow | Implemented for one local operator and one approved project. The Studio has bounded dispatch/retry/cancel/review routes in `nova-console/server.js`; exact-model, scoped-policy and budget gates plus startup recovery in `nova-console/lib/coding-agent-runtime.js`; a coding-only job bridge and cancellation/halt propagation; digest-bound proposal acceptance that creates the batch transactionally only after human review. Acceptance creates a draft batch only: existing validation, separate approval, apply and rollback remain in Maataa Local Workspace. The UI now renders proposal code, review notes and state-specific actions. Generic agent endpoints and non-coding job kinds remain separate. Full gate evidence is recorded below after the current complete run. |
| 5. Guru-Code capability release | Train, export and qualify a dedicated code model against representative held-out tasks | **Open.** No release-capable or exportable Guru-Code checkpoint exists. A tiny CPU training-path smoke run has since completed, but its temporary byte tokenizer and 512-position context make it non-exportable and non-qualifying. The external synthetic shard remains quarantined with source/teacher rights and quality unresolved. The host has no usable MPS/CUDA training runtime; the 7B trainer still needs a tested memory strategy. A Docker evaluator scaffold exists, but no isolated evaluator is qualified. Close the staged work breakdown below before training or release. GPU spend remains research/preparation only unless explicitly approved. See [`guru/CODING_PHASE5_EXECUTION_PACKET.md`](guru/CODING_PHASE5_EXECUTION_PACKET.md). |

## Guru-Code holistic data and model-learning roadmap

This is the work breakdown for open Phase 5. “Absorbing” an existing model
must specify whether it is a student base, a response/logit teacher, a live
runtime tool, or a weight-merge input. Multi-agent traces are candidate
training evidence, not automatically correct answers. The current v1/v2 task
schema and exporter do not yet consume the new separate multi-agent
trajectory validator or store complete teacher lineage in their released SFT
sidecars. The trajectory format is a foundation, not an admitted corpus.

| Step | Work and exit gate | Status |
| --- | --- | --- |
| 5.1 Scope and benchmark contract | Freeze the task mix, project-size limits, context requirement, per-target pass bars and baseline before examining held-out outcomes. The requested scope is 17 language/format targets plus Git tooling; Git is not a programming language. | Partial: inventory and samples are in [`guru/CODING.md`](guru/CODING.md) and [`guru/GURU_CODE_CHEAT_SHEET.md`](guru/GURU_CODE_CHEAT_SHEET.md). Parser/runtime coverage and pass bars are open. |
| 5.2 Holistic evidence schema | Version linked records for intent, acceptance criteria, immutable project/source context, files/symbols/dependencies, patch, explanation, commands, tests, raw results, revision/outcome, author/teacher IDs, digests, permission and leakage group. Keep Brahmi explanation separate from conventional code. | Foundation implemented as `guru-code-trajectory-v1` in `guru/guru/trajectories.py` with seven focused tests. It validates structure, lineage shapes, bounds, held-out target fields and split groups. It does not resolve references, prove rights or integrate with task validation, release manifests or SFT export. |
| 5.3 Existing-model inventory and roles | Inventory candidate pretrained student bases and candidate teachers separately. For each, record model/adapter digest, architecture, tokenizer, context, runtime/API, access mode, terms and intended use. Decide which model initializes Guru and which only supplies examples or feedback. | Blank intake template and structural validator added in `guru/data/coding/model-intake.example.json` and `guru/guru/model_intake.py`. No candidate inventory or admitted base/student/teacher. |
| 5.4 Rights and data-transmission review | Review base weights, teacher access, generated outputs, derived examples and student-weight distribution separately. Decide whether each task may be sent to an external teacher, including provider retention/training, confidentiality and residency conditions. | Structural permission fields, evidence references and role-specific approval requirements are validated; the validator does not resolve evidence or decide rights. Nothing is reviewed or approved. Do not send proprietary code or quarantined data to a teacher until input transmission, provider retention/training and residency terms are approved. |
| 5.5 Corpus collection and curation | Build approved original and external material across the frozen scope. Keep training, retrieval-only, evaluation-only and quarantine pools distinct. Pin source bytes and toolchain versions; deduplicate by task/repository/family; label quality, difficulty and provenance. | Open: existing examples are synthetic smoke fixtures; the downloaded shard is not admitted. |
| 5.6 Multi-agent trace generation | For approved tasks, record structured Planner → Coder → Tester → Reviewer → Supervisor turns. Capture role/model digests, prompt, context digest, message/action, patch, evaluator evidence, revision and human disposition. Agents propose; Maataa retains its separate validation, approval and write controls. | Record validation implemented, but no trace-generation integration. Do not train on unverified conversation text or consensus alone. |
| 5.7 Trace quality and adjudication | Check source permissions, duplicate/leakage groups, parser/compiler results, executable tests and security behavior. Set explicit acceptance thresholds, review sampling, conflict handling and rejection reasons; preserve failed attempts only with labels that prevent treating them as gold targets. | Review policy draft added to `guru/CODING_RELEASE.md`; numeric benchmark pass bars, reviewer sampling rates and real adjudication evidence remain open. |
| 5.8 Language toolchains and isolated evaluator | Pin parsers/compilers and task runners for each supported target. Prove a disposable evaluator has no host/project/credential mounts or egress and enforces resource, time and cleanup limits before running generated code. | Target catalog and a Docker CLI evaluator scaffold are added. No toolchains are pinned; Docker daemon/VM hardening, payload format, adversarial isolation tests and cleanup guarantees are not qualified. Do not use this scaffold to execute generated code yet. Existing syntax evidence is Python-only. |
| 5.9 Leakage-safe splits | Group by repository, source item, task family, generated trajectory and duplicates before splitting. Freeze train, validation and target-free hidden evaluation; prevent teacher generation, prompt iteration and model selection from exposing held-out targets. | Partial: v1/v2 split validation exists, but holistic trace groups and a representative benchmark remain open. |
| 5.10 Training preflight | Select an approved base checkpoint with the required tokenizer/context. Test memory strategy, reproducible dependencies, checkpoint/restart and an honest compute estimate before any paid run. | Open. The local CPU smoke run demonstrates only a tiny training path; current host/runtime does not meet the release requirement. No GPU provisioning or spend is authorized by this roadmap. |
| 5.11 Baseline response distillation | Generate small candidate sets from reviewed teacher(s), verify and adjudicate them, then fine-tune the selected student with ordinary sequence SFT. Measure per-language/task changes against the declared baseline; stop on regressions. | Execution plan, blocked pre-registration template, report template and fail-closed decision/report utilities are prepared in [`guru/experiments/exp-rd-vs-sft-001/PLAN.md`](guru/experiments/exp-rd-vs-sft-001/PLAN.md). No experiment is pre-registered or started; all prerequisites remain blocking. |
| 5.12 Multi-agent trajectory distillation | Compare compact role-tagged collaboration traces against the response-SFT baseline under the same student and frozen evaluation suite. Train on useful actions, checked changes and concise explanations; don’t require exposing private chain-of-thought. | Open; dependent on recorded traces, evaluator and base student. Research precedents include [MapCoder-Lite](https://aclanthology.org/2026.findings-eacl.346/) and [Chain-of-Agents](https://arxiv.org/abs/2508.13167), not a Guru capability guarantee. |
| 5.13 Advanced transfer experiments | Separately test student-on-policy teacher feedback, logits/hidden states, continued pretraining and weight merging. Require method-specific compatibility and permission checks; compare total teacher, review, training, evaluation and inference costs. Keep only repeatable gains. | Later experiments; not a launch prerequisite for the first response-SFT baseline. |
| 5.14 Exact artifact release | Hash base/student/tokenizer/training recipe and exports; verify runtime and at least 4096 context. Pass hidden executable correctness/security thresholds, then Maataa’s six exact-digest capabilities with three clean trials each (18 total). | Open; no qualified Guru-Code artifact exists. |
| 6. Ollama-independent runtime | After an eligible model exists, implement a shared runtime contract, evaluate direct llama.cpp first, keep Ollama as an adapter, and qualify every exact model/runtime pair. Consider Apple-native inference only if it shows a verified benefit. | Future; not implemented. |

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

The fresh 2026-10-04 host audit found no Guru-Code checkpoint or admitted code
corpus; one external Python shard has since been fetched into quarantine only.
The M3 Pro host has Metal hardware, but its installed PyTorch 2.3.1
reports MPS unavailable; the Guru requirements specify PyTorch 2.4 or newer.
SentencePiece and the GGUF Python package are absent. Guru's nano/mini/small
configurations have only 512/1024/1024 tokens and base-1b has 2048; only its
7b configuration meets Maataa's current 4096-token minimum. The existing
`tasks.jsonl` and separate invented starter file together contain only six
train and five held-out synthetic examples. They validate plumbing, not
capability. The detailed intake and release evidence contract is in
`guru/CODING_RELEASE.md`, with a deliberately incomplete machine-readable
template in `guru/data/coding/release-manifest.example.json`. Closing these
gates requires owner-provided rights-reviewed data and a suitable training
host, followed by executable evaluation and Maataa's separate 18-trial
exact-digest qualification on the real exported artifact.

## Validation evidence for this increment

- Fresh local runs on 2026-10-04 for this branch's current Maataa working tree:
  - `npm run test:all` after the Guru-Code demo addition: Node **752 passed, 3 skipped, 0
    failed**; Playwright **59 passed, 1 skipped, 0 failed**; Rust **16 passed,
    0 failed**. The browser skip is the existing Ashtadhyayi/Sanskrit engine
    integration that needs an optional local engine.
  - The full Playwright run passed all **9 Coding Studio scenarios** and the
    Guru-Code demo recording, including
    agent review, stale readiness, delayed responses, and 390px keyboard use.
    The earlier focused agent review subset passed 4/4: accepted
    proposal through separate validation, approval, apply and rollback;
    revision/retry/cancel/reject without a new batch; stale readiness keeps
    writes gated; and every sidebar view opens without a script error.
  - Focused runtime/bridge budget accounting tests: 28 passed, 0 failed;
    successful runs charge measured tokens and one pre-dispatch job, while
    failed/cancelled runs settle one bounded token reservation.
  - The current Guru coding data/export suite passes **28/28**, covering v1
    compatibility, v2 target-bearing validation, train-only export, all-split
    release requirements, mixed-schema rejection, reviewed source item byte
    hashes, leakage checks, duplicate-key and non-standard-number rejection,
    no-clobber output, and interrupted sidecar recovery.
  - New trajectory, model-intake, evaluator and experiment-decision Python
    tests pass **37/37**. The full Guru suite now runs **87 tests**: **83 passed, 2 skipped,
    2 errored** because `sentencepiece` is absent in the current base Python
    environment. Those errors are in existing tokenizer-dependent tests. The
    two skipped tests require optional integrations. These CPU tests and
    synthetic benchmark do not verify 7B CUDA capacity or certify a coding
    model.
  - `npm run demo:guru-code` generated a 1440×900 WebM from the simulated
    proposal/review/apply/rollback UI flow. It exercises no Guru-Code model.
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
No approved corpus or training resource has been delivered; one downloaded
synthetic candidate shard remains in local quarantine. The release path remains
open. The exporter verifies consistency and recorded review fields, while
reviewer authority and source-to-archive association still require human
review evidence.

An original four-train/two-eval synthetic starter corpus is now in
`guru/data/coding/invented-starter-v1.jsonl`; it is smoke-only and does not
close the data gate. External dataset candidates and current cloud compute
pricing are inventoried in `guru/CODING_CORPUS_AND_COMPUTE_PLAN.md`. The plan
finds that Guru's from-scratch 7B trainer needs a memory-capacity pass before
any paid multi-week training reservation.

The synthetic trainer benchmark has only been smoke-tested on CPU and makes no
capacity claim. A Docker CLI evaluator scaffold and mock-only lifecycle tests
now exist, but Docker is not running on this host and no reviewed image,
daemon/VM configuration, adversarial isolation suite, or evaluator integration
is proven. Existing Maataa validation commands still run with local workstation
access. Until Phase 5's rights, training-capacity, isolated evaluation and
exact-digest gates are passed, the roadmap remains open and Guru-Code is not
releasable.
