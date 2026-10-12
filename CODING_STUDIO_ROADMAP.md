# Maataa Coding Studio → Independent Agent Studio

This roadmap records the agreed first-release scope and current evidence. It is
not a claim that Guru-Code or autonomous agent execution is production-ready.
The Guru-Code execution path is decomposed into atomic work units, dependencies
and exit checks in [`guru/GURU_CODE_ATOMIC_PLAN.md`](guru/GURU_CODE_ATOMIC_PLAN.md).

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
requiring Ollama. The current Coding Studio remains Ollama-backed for model
inventory, metadata and qualification. Planning now goes through a
provider-neutral local generation contract, whose only implementation is the
numeric-loopback Ollama adapter; that seam does not yet provide an independent
Guru runtime.

Guru already has a checkpoint-to-Hugging-Face-to-GGUF export path using a
pinned llama.cpp converter, followed by Ollama import. A future runtime phase
can evaluate a direct llama.cpp backend first, then consider Apple-native
inference if it offers a verified benefit. Keep runtime choice separate from
model identity and qualification: records must bind the exact model artifact
digest, tokenizer, context, runtime version and tested capabilities. The
Ollama adapter can remain available for other local models.

The adapter currently rejects remote Ollama endpoints and HTTP redirects,
checks the selected digest before and after inference, and enforces the task's
context/output-token limits. Only adapters created by the approved in-process
transport factory are accepted; the runtime no longer has a custom-adapter
injection option. Ollama's chat API accepts a model name rather than an
immutable digest, so these checks detect an observed retag but cannot
atomically pin weights against a concurrent external model change. No direct
llama.cpp or Apple-native runtime is implemented. The current local micro
prototype cannot use the export path because it has a temporary byte tokenizer
and only 512 positions.

## Phases and status

### Current blocking gates

**Candidate-data rights and full qualification of the isolated evaluator
remain co-equal blockers** for corpus use and `exp-rd-vs-sft-001`. Teacher
admission is closed for the one Qwen2.5-Coder-7B entry recorded in
`guru/data/coding/teacher-registry.jsonl`; that approval does not admit the
candidate dataset. The owner has selected local qualified evaluation only,
external transmission denied, ephemeral-only transformed data, and private
local weights with no distribution. I7 enforcement blocks persistent corpus
assembly, data/tokenizer
transforms, `code-data`, `code-eval`, public file-based SFT, injected engines
on the public evaluator API, external Ollama export, and unsafe pickle-based
checkpoint loading. The CPU smoke route is limited to a fixed authored
synthetic fixture and temporary paths. The rights-bound case-runner scaffold
now uses data-only JSON call suites, keeps expected values in the outer
evaluator, and executes each candidate call in a separate child process;
synthetic tests confirm `os._exit(0)` cannot skip checks and report a pass,
duplicate JSON keys fail closed, and a candidate descendant cannot hold the
protocol pipe past the timeout. It still lacks production trusted providers
and disposable-worker qualification, and its function-call contract has not
been applied to real approved tasks.

The experiment's primary metric, `executable_correctness`, is still
**unmeasurable**. The offline evaluator checks proposal shape, paths and Python
syntax; Docker has only run synthetic probes, not generated proposals against
task tests. A fresh local Docker Desktop probe succeeded, but that persistent
workstation VM is not the required disposable Linux worker. Therefore
`tests_pass`, the experiment comparison and code-correctness claims remain
blocked. See the [Phase 5
execution packet](guru/CODING_PHASE5_EXECUTION_PACKET.md) and [evaluator
prequalification record](guru/CODING_PHASE5_EVALUATOR_QUALIFICATION_2026-10-05.md).

The quality apparatus now has a fail-closed `run_item_quality` orchestrator
and deterministic producers for all eight status slots. However, trusted
production evaluator and rights providers are not configured; TESTS and LICENSE
remain unavailable without their externally pinned evidence. Synthetic
provider-contract tests do not create an approved admission audit or qualify
the evaluator. Duplicate admission rows are rejected during preflight and
assembly. See the [atomic execution plan](guru/GURU_CODE_ATOMIC_PLAN.md) for
remaining integrity work.

| Immediate item | Status | Evidence / next action |
| --- | --- | --- |
| Preserve Guru-Code apparatus and direct test-environment files | **Done:** committed as `928a47b feat(guru): add corpus apparatus and CPU test setup`. | That commit includes the corpus, disclosure, quality and teacher-intake apparatus, `requirements-test.txt` and `CONTRIBUTING.md`. |
| Reconcile the tied-embedding parameter count | **Implemented in current code; recheck any older saved manifest before reuse.** | `guru/train.py` reports `raw_model.num_parameters()`; `guru/model.py` counts `model.parameters()`; the exporter omits the tied `lm_head.weight`. A fresh 64-wide, 516-token-vocabulary check confirmed that raw `state_dict` summation adds exactly one 33,024-element tied matrix. |
| Reproducible clean test environment | **Locked environment rechecked 2026-10-13 on this host.** Python 3.12.1 macOS arm64 venv `/private/tmp/guru-full-test-20261013` uses `guru/requirements-test-full.lock`; `uv pip check` passed for all 37 packages and the full suite passed 337 tests with 1 skipped. | The hash-checked full-suite lock covers PyTorch, SentencePiece, Transformers, PEFT and test dependencies. The smaller `guru/requirements-test.lock` remains for the apparatus subset. Cross-platform reproduction is not established by this macOS arm64 run. |
| Corpus split contract | **Aligned with the experiment draft.** The assembler now sorts unique task IDs by SHA-256 and assigns floor-based 80/10/remainder splits; examples for one task stay in one partition. | Two fresh tests cover exact membership/counts and task grouping. Source/repository/family/duplicate leakage grouping still needs to be added before a real corpus is frozen. |
| Enforce owner-selected I7 use scopes | **Implemented and locally verified; evaluator remains unqualified.** Local qualified evaluation only, no external transmission, ephemeral-only transformed data, and private-local weights with no distribution. Direct tokenizer training now fails before input reads or output creation. `item_decision` is pure; public generic audit writes reject `item_admission`, which the quality runner writes only after complete checks. | Fresh 2026-10-13 verification: hash-locked Guru suite 337 passed, 1 skipped; Maataa Node suite 782 passed, 1 skipped; UI Playwright 69 passed; Rust packaging tests 16 passed. Focused I7/quality and case-runner counts remain historical runs. UI model responses are simulated; no Guru capability claim follows. Python private helpers are conventions, not a same-process security boundary. |
| B3 abandoned-worker recovery | **Implementation pushed in `b76905f`; not evaluator-qualified.** Adds durable owner identity, serialized lifecycle/reaping, strict container labels/names, and thread-owned engine scopes. | Fresh 2026-10-13 full Guru suite: 337 passed, 1 skipped. Recovery tests mock Docker discovery/removal; a process-death test stubs the reaper. No actual abandoned container cleanup, daemon/host restart, or disposable Linux worker qualification was performed. |
| Local generation adapter seam | **Implemented and locally tested; Ollama remains the only implementation.** Planning and agent execution use a provider-neutral request/response contract. | Only the approved in-process factory can create accepted adapters; custom injection is removed. Remote endpoints and redirects are rejected; the selected digest is checked before/after generation; per-call usage and cancellation accounting are bounded. Fresh 2026-10-13 Maataa tests: 782 passed, 1 skipped; full UI Playwright: 69 passed; Rust packaging tests: 16 passed. The Ollama model-name API cannot pin a digest atomically. This does not qualify Guru or an alternate runtime. |

| Phase | Result | Status and evidence |
| --- | --- | --- |
| 0. Governed local project foundation | Explicitly approved roots, bounded context, proposal review, isolated checks, approval-gated apply/rollback, command allowlists and reviewed Git actions | Existing Maataa workspace services; reused by this Studio rather than adding another write path. |
| 1. Exact-model coding gate | Use a named Ollama model only when its current digest has passed the required coding workflow and clarification, timeout and cancellation controls | Implemented in `nova-console/lib/model-qualifications.js`, `nova-console/lib/code-planner.js` and the local generation adapter. Planning checks the digest at selection and around inference; Ollama's model-name API leaves a narrow concurrent-retag race that cannot be closed by this adapter alone. Explicit selection fails closed and never substitutes a model. |
| 2. Guru-Code data/evaluation foundation | Versioned task format, provenance fields, held-out fixture checks and evidence-bound quality plumbing | Plumbing implemented in `guru/data/coding/`, `guru/guru/coding.py` and `guru/CODING.md`. V1 retains train/eval; v2 adds target-bearing validation and requires all three splits for release. Mixed schema versions are rejected. Under I7, persistent corpus/tokenizer transforms, `code-data`, `code-eval`, corpus assembly and public file-based SFT are blocked; only fixed synthetic CPU smoke remains available. The v3 fail-closed data-only function-call protocol rejects duplicate JSON keys, keeps expected values outside candidate execution, and kills the candidate process group at timeout; these are synthetic contract tests, not qualification. It has no real approved task suites or production provider. An ephemeral real-data trainer does not exist. Checked-in examples remain synthetic fixtures, not a representative corpus or capability benchmark. |
| 3. One-project Coding Studio | Readiness check, selected model, bounded request, reviewable proposal, existing validation/approval/apply/rollback flow, Guru readiness and read-only team status | Implemented in `nova-console/public/index.html`; help is in `nova-console/docs/help/41-coding-studio.md`; deterministic browser coverage is in `nova-console/e2e/coding-studio.spec.js`. |
| 3b. App Builder and one-click start | Describe an app (any language) → template project → development loop with the selected qualified model → checked batch → approve/apply → run; chat requests to build an app open the same flow; `Maataa - Start coding.command` starts Ollama and Maataa, installs `qwen2.5-coder:7b` when disk allows, approves `~/Maataa Projects` and offers the coding checks | Implemented in `nova-console/lib/app-builder.js`, `/api/app-builder/*`, the Coding Studio panel and `routeAppBuildFromConversation`; unit/API tests in `tests/app-builder.test.js`, browser tests in `e2e/app-builder.spec.js`. No new write path: project creation, the dev loop and batch approval are the existing governed services. Guru-Code owner decisions are listed in `guru/decisions/README.md`. |
| 4. Independent Agent Studio | Dispatch independent agents for bounded coding work; turn each result into a validated proposal; keep every result pending human review; allow writes only through Maataa's approved batch flow | Implemented for one local operator and one approved project. The Studio has bounded dispatch/retry/cancel/review routes in `nova-console/server.js`; exact-model, scoped-policy and budget gates plus startup recovery in `nova-console/lib/coding-agent-runtime.js`; a coding-only job bridge and cancellation/halt propagation; digest-bound proposal acceptance that creates the batch transactionally only after human review. Acceptance creates a draft batch only: existing validation, separate approval, apply and rollback remain in Maataa Local Workspace. The UI now renders proposal code, review notes and state-specific actions. Failed tasks now expose retry only when the backend explicitly permits it, and retries require new bounded feedback and recheck halt, model, project, policy and budget gates. Generic agent endpoints and non-coding job kinds remain separate. Fresh 2026-10-13 verification: 69/69 full UI Playwright tests passed; Studio response flows remain simulated and do not qualify Guru. |
| 5. Guru-Code capability release | Train, export and qualify a dedicated code model against representative held-out tasks | **Open; not reached is the expected state given the gates below, not a separate failure.** No release-capable or exportable Guru-Code checkpoint exists. The tiny CPU training-path smoke run is not a coding checkpoint: its temporary byte tokenizer and 512-position context make it non-exportable and non-qualifying. One teacher entry is approved; the external synthetic shard remains quarantined with dataset/source rights and quality unresolved. The host has no usable MPS/CUDA training runtime; the 7B trainer still needs a tested memory strategy. A real-container evaluator prequalification passed on October 5, but full qualification on a disposable Linux worker/VM remains open, so executable correctness is still unmeasurable. GPU spend remains research/preparation only unless explicitly approved. See [`guru/CODING_PHASE5_EXECUTION_PACKET.md`](guru/CODING_PHASE5_EXECUTION_PACKET.md). |

## Standalone Guru-Code training and qualification sequence

This T1–T14 work sequence supports Product Phase 5; it is not a renumbering
of Product Phase 5 or a claim that every step belongs to the product-phase
list.

This sequence covers the full Guru-Code data, experiment, training and release
path. “Absorbing” an existing model must specify whether it is a student base,
a response/logit teacher, a live runtime tool, or a weight-merge input.
Multi-agent traces are candidate training evidence, not automatically correct
answers. The current v1/v2 task schema and exporter do not yet consume the new
separate multi-agent trajectory validator or store complete teacher lineage
in their released SFT sidecars. The trajectory format is a foundation, not an
admitted corpus.

| Step | Work and exit gate | Status |
| --- | --- | --- |
| T1 Scope and benchmark contract | Freeze the task mix, project-size limits, context requirement, per-target pass bars and baseline before examining held-out outcomes. The requested scope is 17 language/format targets plus Git tooling; Git is not a programming language. | Partial: inventory and samples are in [`guru/CODING.md`](guru/CODING.md) and [`guru/GURU_CODE_CHEAT_SHEET.md`](guru/GURU_CODE_CHEAT_SHEET.md). Parser/runtime coverage and pass bars are open. |
| T2 Holistic evidence schema | Version linked records for intent, acceptance criteria, immutable project/source context, files/symbols/dependencies, patch, explanation, commands, tests, raw results, revision/outcome, author/teacher IDs, digests, permission and leakage group. Keep Brahmi explanation separate from conventional code. | Foundation implemented as `guru-code-trajectory-v1` in `guru/guru/trajectories.py` with seven focused tests. It validates structure, lineage shapes, bounds, held-out target fields and split groups. It does not resolve references, prove rights or integrate with task validation, release manifests or SFT export. |
| T3 Existing-model inventory and roles | Inventory candidate pretrained student bases and candidate teachers separately. For each, record model/adapter digest, architecture, tokenizer, context, runtime/API, access mode, terms and intended use. Decide which model initializes Guru and which only supplies examples or feedback. | Owner selected `Qwen/Qwen2.5-Coder-1.5B-Instruct` at revision `ccb64f03a691be46ba6b4e4c91f396c247aa66c7` with LoRA/SFT on 2026-10-13. This is a candidate/method choice only: exact artifacts, permissions and model intake remain unverified; no download or training authorized. |
| T4 Rights and data-transmission review | Review base weights, teacher access, generated outputs, derived examples and student-weight distribution separately. Decide whether each task may be sent to an external teacher, including provider retention/training, confidentiality and residency conditions. | Structural permission fields, evidence references and role-specific approval requirements are validated; the validator does not resolve evidence or decide rights. Nothing is reviewed or approved. Do not send proprietary code or quarantined data to a teacher until input transmission, provider retention/training and residency terms are approved. |
| T5 Corpus collection and curation | Build approved original and external material across the frozen scope. Keep training, retrieval-only, evaluation-only and quarantine pools distinct. Pin source bytes and toolchain versions; deduplicate by task/repository/family; label quality, difficulty and provenance. | Open: existing examples are synthetic smoke fixtures; the downloaded shard is not admitted. |
| T6 Multi-agent trace generation | For approved tasks, record structured Planner → Coder → Tester → Reviewer → Supervisor turns. Capture role/model digests, prompt, context digest, message/action, patch, evaluator evidence, revision and human disposition. The schema's `SUPERVISOR` is an agent role; Maataa/operator adjudication is recorded separately as human adjudication. Agents propose; Maataa retains its separate validation, approval and write controls. | Record validation implemented, but no trace-generation integration. Do not train on unverified conversation text or consensus alone. |
| T7 Trace quality and adjudication | Check source permissions, duplicate/leakage groups, parser/compiler results, executable tests and security behavior. Set explicit acceptance thresholds, review sampling, conflict handling and rejection reasons; preserve failed attempts only with labels that prevent treating them as gold targets. | Review policy draft added to `guru/CODING_RELEASE.md`; numeric benchmark pass bars, reviewer sampling rates and real adjudication evidence remain open. **`executable_correctness` and `tests_pass` cannot be measured until the isolated evaluator gate passes; `exp-rd-vs-sft-001` cannot start without that gate.** |
| T8 Language toolchains and isolated evaluator | Pin parsers/compilers and task runners for each supported target. Prove a disposable evaluator has no host/project/credential mounts or egress and enforces resource, time and cleanup limits before running generated code. | **Partial prequalification only:** October 5 synthetic Docker probes passed network-none, no-mount, read-only-root, user/capability and resource-limit checks, including cancellation cleanup. The host is a persistent Docker Desktop VM, not a disposable worker. Host-restart recovery, startup reaping, complete local-service/peer isolation and durable per-case evidence remain open. No corpus row or generated proposal has been evaluated. Toolchains are not pinned; syntax evidence is Python-only. |
| T9 Leakage-safe splits | Group by repository, source item, task family, generated trajectory and duplicates before splitting. Freeze train, validation and target-free hidden evaluation; prevent teacher generation, prompt iteration and model selection from exposing held-out targets. | Partial: v1/v2 split validation exists, but holistic trace groups and a representative benchmark remain open. |
| T10 Training preflight | Validate the selected candidate's exact weights, tokenizer, permissions and context. Test memory strategy, reproducible dependencies, checkpoint/restart and an honest compute estimate before any paid run. | Candidate/method selected; model intake, weight/tokenizer digests and rights remain open. The offline CPU LoRA plumbing smoke is covered by the full hash-locked test environment (Torch 2.4.1, Transformers 4.45.2, PEFT 0.13.2); fresh 2026-10-13 complete suite: 337 passed, 1 skipped. The smoke uses random GPT-2 weights and synthetic token IDs, saves/reloads a temporary adapter and performs one adapter-only continuation step. It rejects a scratch root inside the Guru checkout before model setup, preventing a misconfigured `TMPDIR` from leaving smoke artifacts in the repository. It does not load Qwen weights or establish memory fit, trainer qualification, checkpoint qualification or coding capability. No GPU provisioning or spend is authorized. |
| T11 Baseline response distillation | Generate small candidate sets from reviewed teacher(s), verify and adjudicate them, then fine-tune the selected student with ordinary sequence SFT. Measure per-language/task changes against the declared baseline; stop on regressions. | Execution plan, blocked pre-registration template, report template and fail-closed decision/report utilities are prepared in [`guru/experiments/exp-rd-vs-sft-001/PLAN.md`](guru/experiments/exp-rd-vs-sft-001/PLAN.md). No experiment is pre-registered or started; candidate-data rights and full evaluator qualification remain blocking. Teacher admission is approved only for the registered Qwen digest. |
| T12 Multi-agent trajectory distillation | Compare compact role-tagged collaboration traces against the response-SFT baseline under the same student and frozen evaluation suite. Train on useful actions, checked changes and concise explanations; don’t require exposing private chain-of-thought. | Open; dependent on recorded traces, evaluator and base student. Research precedents include [MapCoder-Lite](https://aclanthology.org/2026.findings-eacl.346/) and [Chain-of-Agents](https://arxiv.org/abs/2508.13167), not a Guru capability guarantee. |
| T13 Advanced transfer experiments | Separately test student-on-policy teacher feedback, logits/hidden states, continued pretraining and weight merging. Require method-specific compatibility and permission checks; compare total teacher, review, training, evaluation and inference costs. Keep only repeatable gains. | Later experiments; not a launch prerequisite for the first response-SFT baseline. |
| T14 Exact artifact release | Hash base/student/tokenizer/training recipe and exports; verify runtime and at least 4096 context. Pass hidden executable correctness/security thresholds, then Maataa’s six exact-digest capabilities with three clean trials each (18 total). | **Not reached because prerequisites remain open; this is an expected gated state, not a separate failure.** No qualified Guru-Code artifact exists. |
## Roadmap to finished

The first finished release is **single-operator, one-approved-project,
Python-first Guru-Code** with conventional Python syntax, Brahmi comments and
explanations, and Maataa's existing human-review and write controls. The other
16 language/format targets and Git tooling remain roadmap targets until each
has its own pinned toolchain and qualified tests.

Before parallel execution, review and preserve the current roadmap, Phase 5
packet and evaluator report as a documentation-only change group. The
apparatus and direct test requirements are already preserved in commit
`928a47b`.

### Run these prerequisites in parallel

1. **Make the CPU test environment reproducible.** Create a clean virtualenv,
   install the documented test requirements, run the apparatus suite, and
   check in a transitive lockfile plus the result. The Anaconda run is a signal,
   not the reproducibility gate.
2. **Resolve teacher/data rights.** An authorized reviewer evaluates the exact
   TinyPython revision and artifact hash. Record training, evaluation,
   transformed-data retention and weight-release permissions separately. Admit
   the candidate only if the review passes; otherwise source an approved
   replacement. Keep all unapproved rows quarantined.
3. **Complete evaluator qualification.** Use an approved disposable Linux
   worker/VM. Implement startup reaping and durable case evidence; test host
   restart, crash, cancellation, local/peer service isolation and resource
   limits. Then run generated Python proposals against task tests and prove
   `executable_correctness` and `tests_pass` are computed from those results.
   Synthetic container probes alone do not close this gate.

### Then proceed through the evidence gates

4. **Admit and curate the corpus.** Pin source bytes and permissions, deduplicate
   by task and family, review quality, group related items before splitting,
   then freeze train, validation and hidden evaluation sets.
5. **Freeze the v1 benchmark and pre-register `exp-rd-vs-sft-001`.** Specify
   tasks, baseline, pass bars, evaluator image, random seeds and stop rules
   before opening hidden targets.
6. **Finish training preflight.** For the selected Qwen2.5-Coder-1.5B
   candidate, verify exact weight/tokenizer digests, rights and at least
   4,096-token context; test the compatible trainer, memory strategy,
   checkpoint/restart and local-capacity estimate. Choose an approved GPU
   worker and budget. Current authorization is research/preparation only; do
   not start paid compute without a spending decision.
7. **Run the response-distillation baseline.** Generate candidate answers only
   from an admitted teacher, independently execute tests, adjudicate results,
   then train and compare against the frozen baseline. Multi-agent trajectory
   distillation follows only after the response baseline, approved traces and
   evaluator are ready.
8. **Decide from held-out evidence.** Preserve per-case inputs, outputs,
   evaluator results, model and dataset digests, timing and cost. Stop on any
   rights, security, quality or capability gate failure.
9. **Export and qualify the exact artifact.** Hash weights, tokenizer and
   recipe; verify runtime loading and at least 4,096-token context; pass hidden
   executable-correctness and security thresholds; then complete six Maataa
   capabilities with three clean exact-digest trials each.
10. **Close the product release.** Connect the qualified digest to Coding
    Studio, run fresh Playwright coverage of proposal, review, task checks,
    cancellation and approval-gated apply/rollback, document limitations, and
    preserve the complete evidence chain.

### After the first finished release

- Add the remaining language and format targets one at a time with pinned
  parsers/runtimes, held-out tests and per-target thresholds.
- Compare multi-agent trajectory training against the response-SFT baseline.
- Develop the Ollama-independent runtime contract, evaluate direct llama.cpp,
  and qualify every exact model/runtime pair. Ollama can remain an adapter.
- Explore advanced transfer methods only after rights, compatibility and
  measured gains are established.

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

### Fresh verification on 2026-10-05

- `npm test`: **752 passed, 3 skipped, 0 failed** with loopback enabled for the
  server tests. The first restricted run failed 33 listener-bound tests with
  `EPERM`; the permitted local-listener rerun passed.
- `npm run test:ui`: **59 passed, 1 skipped, 0 failed**. All nine Coding Studio
  scenarios passed. The one skip is an existing optional Sanskrit-engine
  integration.
- `npm run demo:guru-code`: **1 passed**; the recorded proposal/review/apply/
  rollback scenario is synthetic and does not invoke a trained Guru model.
  The 1440×900 WebM is checked in at
  [`guru/demo/guru-code-playwright-demo-2026-10-05.webm`](guru/demo/guru-code-playwright-demo-2026-10-05.webm).
- `npm run test:rust`: **16 passed, 0 failed**.
- Guru's isolated Python 3.12.1 environment: **71 passed** across the
  disclosure, quality, corpus, teacher intake, evaluator-mock, trajectory and
  experiment-decision suites; `uv pip check` reports all 11 locked packages
  compatible.
- `git diff --check`: clean after the follow-up edits. These local tests do
  not close teacher-rights review, full disposable-evaluator qualification,
  leakage-safe corpus curation, approved training compute/budget, or exact
  model qualification. They do not establish a Guru coding-capability claim.
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
