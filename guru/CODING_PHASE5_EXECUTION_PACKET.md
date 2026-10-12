# Guru-Code Phase 5 Execution Packet

Status refreshed 2026-10-13: **not release-ready. One Qwen2.5-Coder-7B teacher
entry is approved in `data/coding/teacher-registry.jsonl`; this does not admit
the TinyPython dataset or any other candidate corpus. Candidate-data rights,
full disposable-evaluator qualification, approved training compute, a
full-corpus training run, and exact-digest qualification of a Guru-trained
checkpoint remain open.**
The tiny synthetic CPU smoke and evaluator prequalification probes are recorded
separately; neither is a coding checkpoint or candidate evaluation. Current
provider prices are planning snapshots and must be rechecked before any launch.

### Fresh local verification (2026-10-13)

- The full hash-locked Guru suite returned **365 passed, 1 skipped in 21.25s**
  under the Python 3.12.4 macOS arm64 environment. The new D3 recipe suite
  returned **18 passed**. The full Maataa `npm test` rerun with loopback access
  returned **782 passed, 1 skipped, 0 failed**; the full Playwright suite
  returned **69 passed in 2.2 minutes**; Rust packaging tests returned
  **16 passed, 0 failed**. Playwright exercised simulated model responses,
  not Guru checkpoint inference.
- The bounded random-Qwen2 LoRA smoke now saves/restores adapter weights,
  optimizer, scheduler, global step, sampler position and CPU RNG. Its resumed
  adapter parameters and logits exactly match an uninterrupted synthetic run;
  focused tests returned **10 passed**. This does not train or qualify the
  selected Qwen2.5-Coder checkpoint.
- A draft-only selected-student recipe is checked in at
  `experiments/recipes/qwen25_coder_15b_lora_sft.v1.json`, canonical hash
  `6de60f1cb224dd06fec5462e48bb255e5056910145bca526c01784865aaa39b7`.
  Its candidate hyperparameters are unqualified. The validator reports **11
  launch blockers**, including missing exact base/tokenizer digests, approved
  training data, validation suite and qualified evaluator, model/data/compute
  approval, and run authorization. No weights were downloaded and no training
  ran.
- Fresh `preflight c_rd` remains blocked with
  `{"blockers":["missing admission audit"],"ready":false,"warnings":[]}`.
  The missing audit is real; no empty or synthetic admission was created.

### Earlier local integration evidence (2026-10-12)

- B3 abandoned-worker recovery implementation is integrated and pushed in
  `b76905f`. It adds a durable per-checkout owner token, a serialized lifecycle
  lock, exact managed/owner label and name checks, startup reaping, and
  thread-owned engine scopes; the evaluator configuration digest includes the
  recovery version. Fresh focused evaluator/case-runner tests passed **43**;
  the fresh clean-environment full Guru suite passed **328, 1 skipped in
  30.48s**. Recovery coverage uses mocked Docker inventory/removal. A process
  death test releases the lock but stubs the reaper; no real orphan cleanup,
  Docker daemon restart, host restart, disposable Linux worker, or candidate
  code execution was performed. This is implementation evidence, not B1–B8
  evaluator qualification.
- Fresh `preflight c_rd` remains blocked with
  `{"blockers":["missing admission audit"],"ready":false,"warnings":[]}`.
  No empty audit or synthetic admission was created. The preflight blocker is
  still downstream of real rights evidence and qualified evaluator results.

- D4 synthetic CPU SFT resume smoke is integrated as `0bab8d2`. Independent
  review covered tokenized-data identity, recipe budget/cadence, CPU RNG resume,
  model-mode restoration and fail-closed DDP/MPS behavior. Its 24 smoke tests
  pass; the random-init run remains synthetic plumbing, not a coding model.
- I10 assembly-time provenance replay is integrated as `41892e0`; its
  readiness-CLI input gap was independently identified and closed in `0da40aa`.
  CLI flags now accept the item file, task/source manifests and digest pins.
  The pins establish consistency against supplied bytes, not authenticity or
  rights.
- Independent review of I9 commit `459ac93` found no must-fix issues. It confirms
  task/source/artifact linkage against caller-supplied manifest pins; it does
  not establish authenticity or rights approval.
- Previous full suite before B3 recovery implementation, after the I7
  enforcement and follow-up bypass fixes:
  `/private/tmp/guru-full-test-20261012/bin/python -m pytest tests -q`
  returned **319 passed, 1 skipped in 26.12s** from a clean Python 3.12.4
  macOS arm64 environment installed from the new hash-checked
  `requirements-test-full.lock`. `uv pip check` found all 34 locked packages
  compatible. The focused I7/quality suite returned **95 passed, 1 warning in
  1.81s**. The separate `requirements-test.lock` remains the smaller apparatus
  subset lock; the full-suite result does not establish cross-platform
  reproduction.
- After evaluator protocol hardening, `python -m pytest
  tests/test_evaluator_case_runner.py -q` returned **21 passed in 10.49s**.
  Added checks reject duplicate object keys in test-suite JSON and prove that
  a candidate descendant holding inherited output pipes is killed with its
  process group at timeout. A detached descendant also cannot keep the case
  runner blocked; Docker container removal remains its final cleanup boundary.
  This is local synthetic contract evidence, not qualification of the
  disposable evaluator or its isolation boundary.
- Fresh targeted Coding Studio/App Builder Playwright run passed **13 tests in
  46.6 seconds**. It uses simulated model responses; it is not exact-model
  qualification.
- The first full UI Playwright run exposed two Local Workspace fixture issues.
  The fixture path is now stable across Playwright config/worker processes, and
  a fresh complete run passed **66/66 tests in 2.2 minutes**. This verifies UI
  workflows; its model responses are simulated and do not qualify Guru.
- The prior full Maataa `npm test` rerun after Playwright fixture
  synchronization passed **768 tests, 1 skipped, 0 failed in 95.5 seconds**.
  A fresh run during this evidence refresh passed **768 tests, 1 skipped,
  0 failed in 118.70 seconds**. An initial sandboxed rerun hit loopback
  `EPERM`; the elevated reruns passed.
- Fresh `preflight c_rd` still returns
  `{"blockers":["missing admission audit"],"ready":false,"warnings":[]}`.
  No empty audit or synthetic admission was created.

- Evaluator evidence contract: `5f24668`.
- Item-bound quality decisions, duplicate-decision rejection and corpus teacher
  lineage binding: `d1bd36d`, `6981a0f`, `244d6f3`.
- Deterministic quality checks and tri-state report: `7177e61`, `e374e96`,
  `b4461aa`; fail-closed item-quality orchestration and digest-covered audit
  validation: `224c862`, `925f72a`, `3a678f1`.
  Synthetic provider-contract tests exercise complete PASS and measured FAIL
  flows through audit, preflight and assembly. Normal operation still has no
  production evaluator or rights provider, so TESTS and LICENSE remain
  UNAVAILABLE and no real admission audit has been generated.
- The earlier focused quality/evaluator/corpus/intake/rights suites passed
  **124 tests**. The pre-integration Guru suite passed **212 tests, 1 skipped,
  5 warnings** in the existing Anaconda environment. A clean full-dependency
  venv/lock has not been verified.
- The earlier Maataa Coding Studio and App Builder Playwright specs passed **13
  tests in 53.1 seconds**, using simulated model responses. The test saved
  `/private/tmp/guru-code-playwright-demo.webm`; this is UI workflow evidence,
  not exact-model qualification or a live Guru-Code demo.
- Fresh `preflight c_rd` still returns only `missing admission audit`; no empty
  audit or synthetic admission was created. Docker is available as persistent
  Docker Desktop on macOS, not the required disposable Linux evaluator worker.
- Maataa's active database records a fresh **18/18** coding-workflow pass for
  local `qwen2.5:7b`, exact Ollama digest
  `845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e`, on
  2026-10-12. It passed three trials each for single-file, multi-file,
  large-context, clarification, timeout and cancellation. This is Maataa
  workflow qualification on temporary fixtures; it is not code-correctness or
  Guru-checkpoint evidence. The distinct `qwen2.5-coder:7b` digest
  `dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364`
  remains at 15/18, with three multi-file failures. No Guru-Code checkpoint
  exists.

## Current hard blockers

**Candidate-data rights and full evaluator qualification are the co-equal
blockers for the candidate corpus and `exp-rd-vs-sft-001`.** Teacher admission
is closed for the single registry entry noted above. That approval does not
resolve dataset provenance or rights, and does not qualify the evaluator.

Teacher-derived `c_rd` assembly and the experiment remain blocked until these
gates close; independent rights-cleared human-authored SFT curation can proceed
under its own provenance and evaluator requirements. The experiment's primary
metric, `executable_correctness`, is currently
**unmeasurable**. The offline `code-eval` path checks proposal shape, relative
paths, Python syntax and shallow fixture rubrics; it does not run generated
proposals against task tests. The October 5 Docker prequalification ran only
synthetic isolation probes. It did not measure `tests_pass` or code
correctness. This blocks the experiment, quality-gate test claims and any
coding-capability claim until a fully qualified isolated evaluator can execute
the actual task tests and preserve their results.

## Decision summary

| Gate | Current evidence | Next action |
| --- | --- | --- |
| Teacher admission | One approved local Qwen2.5-Coder-7B-Instruct record, with `may_train`, Apache-2.0, model digest, reviewer and timestamp, is present in `data/coding/teacher-registry.jsonl`. | Keep this approval scoped to the recorded teacher entry and output rights. Re-review if the digest, access method, license or intended use changes. |
| Training-data rights | TinyPython card declares Apache-2.0; local pinned revision has no separate license file. Source card says the fetched rows were generated by Qwen2.5-Coder-7B-Instruct and warns about teacher terms. | Keep quarantined. Obtain a written owner/authorized-reviewer decision for this exact source's training and evaluation eligibility; project policy independently prohibits external transmission, persistent transformed-data retention, and weight distribution. |
| Isolated evaluator and experiment metric | Real-container prequalification passed on 2026-10-05 using synthetic probes only. The offline evaluator does not execute generated proposals against task tests, so `executable_correctness` and `tests_pass` remain unmeasurable. | Complete full isolation qualification on an approved disposable Linux worker/VM, then demonstrate task-test execution and durable per-case evidence before any experiment run. |
| Data quality | 99,904 rows; 65,017 excess duplicate task-description rows beyond the first occurrence and 54,541 excess duplicate code rows. The card reports structural checks, one train split and no exhaustive semantic validation. | Deduplicate and group by seed/family; independently execute tests only after an isolated runner passes its security gate; create grouped train/validation/hidden-evaluation splits. |
| Training capacity | Current 7B trainer is unsharded FP32; estimated parameter, gradient and Adam-state memory is about 106 GiB per rank before activations. This Mac has no usable CUDA runtime. | Implement and test sharding, reduced-precision training and activation checkpointing before renting any GPU. |
| GPU resource | Lambda lists a 1× H100 SXM option at $4.29/GPU-hour. No account was accessed or resource launched. | Proposed bounded pilot: at most four hours ($17.16 before tax), with a proposed $25 all-in ceiling. Use an existing owner-controlled account only; terminate the instance by four hours, attach no persistent filesystem, and do not launch until the owner confirms account and total cap. Recheck region availability, tax and price at launch. |
| Guru qualification | Qwen2.5:7b runtime workflow is qualified for its exact installed digest, but no Guru-trained checkpoint exists. Browser tests for Coding Studio use mocks. | Train/export a Guru artifact only after upstream gates pass, verify its digest and context, then qualify that exact artifact in Maataa. |

### Owner-selected I7 use-scope policy

The owner explicitly selected `guru-use-scope-i7-v1`:

| Use | Project scope | Enforcement and remaining boundary |
| --- | --- | --- |
| Evaluation | Local qualified evaluator only | Evaluator qualification evidence must declare `execution_scope: local`; source record must independently set `allow_evaluation=true`. The evaluator itself is still unqualified, so execution remains blocked. |
| Provider transmission | Denied externally | The remote/API disclosure gate denies transmission regardless of teacher license or disclosure-record settings. Local model use does not grant source-data rights. |
| Transformed-data retention | Ephemeral only | Source rights still record retention separately. Persistent corpus assembly, corpus/tokenizer transforms, `code-data`, and file-based SFT are disabled. A fixed authored synthetic CPU plumbing smoke runs only under temporary paths; no ephemeral real-data trainer exists yet. |
| Weight distribution | No distribution; private local checkpoints only | Release manifest and generated model card state distribution disabled. Local format conversion creates a private local artifact; the repository has no external weight-publishing path. |

None of these project decisions approves a source. Each exact source still needs
its own evidence-backed rights decision, and teacher license/output rights do
not imply evaluation, transmission, retention or distribution permission.
The I7 implementation enforces the choices in the disclosure gate, quality
checks, corpus preflight/assembly, data/tokenizer APIs, CLI `code-data`,
`code-eval`, and public file-based SFT entry points. `guru teach` rejects
before reading `--pairs` or generating `--panini` data; `train(..., sft=...)`
rejects before model or output initialization. The public evaluator primitive
requires an explicit local Docker endpoint and no longer accepts injected
engines; each created probe container also explicitly disables logging. Smoke
resume loads weights-only checkpoints. The only SFT smoke route accepts its
byte-exact authored fixture, CPU, and temporary-only paths. Direct tokenizer
training is denied before reads/writes; item-admission audits are emitted only
through the complete runner path via a typed private writer. This controls the
supported repository API; Python underscore privacy is not a security boundary
against hostile code in the same process. Fresh focused I7/quality tests pass
95; the full Guru suite passes 319, skips 1. The rights- and
qualification-bound case-runner remains a scaffold: it now accepts only
nonempty versioned JSON function-call suites, keeps expected values in the
outer runner, and executes each candidate call in a separate child process.
Synthetic tests show candidate `os._exit(0)` cannot skip checks and report a
pass, duplicate JSON keys are rejected, and attached or detached child
processes cannot keep the case runner blocked past the timeout. No trusted production provider
exists, no real approved task suites are wired, and no disposable worker is
qualified. No ephemeral real-data trainer exists, so transformed real data
cannot currently be admitted or persisted, and local evaluation permission
remains unused until the isolated evaluator is qualified.

### Immediate repository and record corrections

- The Guru-Code apparatus and direct CPU test requirements are already
  committed in `928a47b feat(guru): add corpus apparatus and CPU test setup`.
  A fresh Python 3.12.1 virtualenv installed from the new hash-checked
  `requirements-test.lock`; all 71 CPU apparatus, evaluator-mock, trajectory
  and experiment-decision tests passed, and `uv pip check` found all 11 locked
  packages compatible. This is local reproducibility evidence, not yet a
  clean-machine/CI portability result. See `CONTRIBUTING.md`.
- The parameter-count source path already counts unique model parameters:
  `guru/train.py` records `raw_model.num_parameters()`, implemented with
  `sum(p.numel() for p in model.parameters())`; `guru/export.py` excludes
  `lm_head.weight` when embeddings are tied. A fresh tied-embedding check
  reproduced the reported 33,024 difference as exactly one 64 × 516 embedding
  matrix. The model is not thereby shown to be wrong; regenerate or correct any
  saved run manifest that naively summed tied `state_dict` entries before
  reusing it.
- Earlier follow-up edits to this packet, the roadmap, corpus split
  implementation/tests, test-environment instructions and evaluator report
  were committed and pushed in `245a708`. The current I8 changes are integrated
  locally in `224c862`, `925f72a` and `3a678f1`; the branch has not been pushed.

## Rights review: TinyPython candidate

The locally preserved artifact is the Qwen small shard at immutable revision
`1b1ecba91d931ffe5d97d22300ea370499432d3b`, SHA-256
`7793c3288a95d128614dff8bdfcfecc431ffffe245a7a8f51331ac0bedb46e80`, with
99,904 rows. Its adjacent quarantine record has the pinned card snapshot and
review counts. See `data/coding/quarantine/README.md` and
`data/coding/quarantine/candidate-intake.json`.

The pinned card declares Apache-2.0 and identifies Qwen2.5-Coder-7B-Instruct as
the teacher. The pinned file listing has no separate `LICENSE`; the generic
Apache text saved locally is a reference copy, not a license file shipped by
the dataset. The teacher's model license is Apache-2.0, but that fact alone does
not establish the dataset publisher's rights to every output or exclude
third-party material. The current public dataset page has changed since the
pinned artifact was fetched, so evaluate this exact hash and revision rather
than the current floating page. Sources: the
[TinyPython card](https://huggingface.co/datasets/BertilBraun/TinyPython), the
[Qwen model license](https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct/blob/main/LICENSE),
and the [Apache-2.0 text](https://www.apache.org/licenses/LICENSE-2.0).

Before admission, the data owner or authorized reviewer must record a named
review and answer each item:

- Does the dataset publisher own or have authority to license this exact
  revision and all included task/code rows?
- Does the Apache-2.0 declaration apply to the complete pinned shard, including
  generated output, with no excluded or third-party-origin material?
- Is internal and commercial supervised training allowed?
- May the rows be transformed, deduplicated, retained, and shared with the
  training/evaluation service provider?
- May weights trained on these rows be distributed, and what attribution,
  NOTICE, removal, or downstream terms apply?
- Is local retention of this exact artifact permitted?

Record `train_sft`, `evaluation`, and `release_weights` permissions separately
in the source manifest. Until that review is recorded, the shard remains
quarantined and excluded from every training/evaluation/export path.

Microsoft CABRA is a possible held-out evaluation candidate only after
pinning and reviewing its exact artifacts, schemas, leakage boundaries and
sensitive-content handling. Its card declares CDLA-Permissive-2.0 and describes
synthetic tasks/tests, while also framing the benchmark for research and
calling for further validation for commercial or real-world use. It is not a
substitute for the Guru training corpus. See the
[CABRA card](https://huggingface.co/datasets/microsoft/CABRA) and
[CDLA-Permissive-2.0](https://cdla.dev/permissive-2-0/).

A new Maataa/Brahmini-authored synthetic corpus has clearer provenance if
contributors assign rights explicitly. It still needs target tests, independent
quality review, deduplication, grouped splits, and enough examples for the
intended scope; `invented-starter-v1.jsonl` has four train and two target-free
smoke examples. Combined with the original smoke tasks, the repository still
has only six train and five held-out synthetic examples in total.

## Training resource: prepare without provisioning

Do not run the current 7B recipe on an 80 GB GPU. The current unsharded FP32
trainer needs roughly 106 GiB per rank for parameters, gradients and Adam
moments before activations. The 7B preset targets a 140-billion-token
from-scratch run; the candidate shard is neither approved nor remotely large
enough to establish that token budget.

The current [Lambda instance price table](https://lambda.ai/instances) lists
1-GPU H100 SXM instances at $4.29 per GPU-hour before applicable tax. A
four-hour ceiling is `1 GPU × 4 hours × $4.29 = $17.16` before tax. The
project has set a conditional **US$25 total cap including tax** for a bounded
resource preflight, preferring `asia-south-1` if the instance type is offered
and available, using an existing owner-controlled account only. Lambda
bills by the minute while an instance is running and billing ends only when
the instance is terminated ([billing details](https://docs.lambda.ai/on-demand-cloud/billing/)).
Shutdown policy: terminate the instance no later than four hours, attach no
persistent filesystem, and do not launch if account availability, region
capacity, current price or tax would exceed the cap. This is not approval to
launch now: rights, evaluator qualification and a compatible trainer must pass
first. No Lambda account was accessed and no instance was launched.

For scale only, NVIDIA reports 9,927 unpadded tokens/second/GPU for its 7B
BF16/FSDP2 OpenGenome2 recipe on 48 H100s. Linear projection to eight H100s
would put 140B tokens near 490 hours; Lambda's current 8-GPU rate gives about
$15.6k in GPU time, or about $31.3k at twice that runtime. This is an
illustration across a different model, dataset and stack, not a forecast or
training plan. It excludes data engineering, storage, restarts, evaluation and
tax. See [NVIDIA's measured recipe](https://docs.nvidia.com/bionemo-recipes/latest/main/recipes/recipes/opengenome2_llama_native_te/).

The sequence before a GPU launch is: implement the memory strategy; exercise
checkpoint save/restart and optimizer state locally where possible; run unit
and distributed tests; receive rights approval; confirm the corpus and token
budget; verify account, price and region against the approved cap; then run the
capped pilot and terminate on limit or failure.

## Isolated evaluator design and acceptance tests

Use a disposable Linux worker or VM with one fresh container per task. Build the
evaluation runtime into a pinned image before evaluation; install no packages
and allow no network during a case. Do not mount the approved project,
workstation home, dependency directory, credential store, Docker socket or any
other host path. Stage a bounded snapshot into the container through a
controlled copy/API, never a bind mount. The evaluated process gets a
non-privileged UID/GID, read-only root filesystem, bounded ephemeral scratch,
no capabilities, no-new-privileges, a restrictive seccomp profile, CPU/memory/
swap/PID quotas, an external wall-clock timeout and capped output. The runner
collects per-case exit/signal/timeout/resource data, kills and removes the
container on every outcome, and cleans up abandoned containers on startup.

Keep the container-runtime control socket and worker credentials outside every
evaluated process. Treat a container as one layer of isolation and keep it
inside a disposable Linux VM for the local workstation deployment. Docker's
[security guidance](https://docs.docker.com/engine/security/),
[bind-mount documentation](https://docs.docker.com/engine/storage/bind-mounts/),
[rootless mode](https://docs.docker.com/engine/security/rootless/), and
[container-run reference](https://docs.docker.com/reference/cli/docker/container/run/)
are relevant to implementation. Context7's current Docker documentation was
also consulted for network isolation, mounts, and resource controls.

Before the runner may evaluate dataset rows or generated proposals, the test
suite must demonstrate:

1. no egress and no access to host, worker or other local services; document
   that container-local loopback can remain available under Docker network-none
   mode, and prove it cannot reach the harness or another task;
2. no reads/writes to host paths, project roots, dependency directories,
   credentials or runtime socket;
3. process/PID, memory, CPU, scratch-disk, output and wall-time limits;
4. cancellation, evaluator crash and host restart all kill/reap the worker;
5. every run uses a fresh empty environment and leaves no files or processes;
6. raw results preserve case ID, image digest, input digest, command, exit
   status, stdout/stderr digest, resource-limit events and cleanup outcome.

Only synthetic adversarial probes have been executed in a real Docker container;
no dataset row or generated proposal has been evaluated. The local prequalification
is evidence for the container limits, not a completed evaluator security gate.
The remaining checks above must pass on a disposable Linux worker/VM; mocked
Docker CLI tests alone do not satisfy this gate.

## Exact-model qualification

After an artifact is trained and exported, register its exact SHA-256/model
digest with Maataa. Verify its actual tokenizer/chat template, runtime load,
and context of at least 4,096 tokens. The qualification plan requires six
capabilities with three clean trials each: single-file edits, multi-file edits,
large context, clarification, timeout and cancellation. Preserve raw prompts,
responses, proposals, evaluator results, exact runtime/model digest, timing and
control-flow evidence. Any timeout, cancellation or unsafe-output failure
blocks eligibility. Mocked browser tests exercise the UI and gate plumbing;
they do not qualify a real model.

## Requested external decisions

1. Name the data-rights reviewer/owner and return the completed TinyPython
   review, or reject it and supply an approved replacement.
2. The owner has selected no weight distribution: Guru-Code checkpoints and
   exports remain private local artifacts under I7.
3. Choose an approved disposable Linux evaluator host/runtime. The local Docker
   Desktop daemon is now running and the recorded container prequalification
   passed, but this persistent workstation VM is not the approved disposable
   host required for the full gate.
4. Before any future launch, confirm an existing owner-controlled Lambda
   account and H100 availability in `asia-south-1` or another approved region. The conditional cap
   is $25 total including applicable tax, with a four-hour hard stop and
   instance termination. No account was accessed; do not create an account or
   add billing information as part of this work. If the cap cannot be met,
   defer the pilot.
