# Guru-Code v1 Python benchmark contract (draft)

**Status:** draft for owner ratification; not a pre-registration

**Scope:** one local operator, one approved project, Python code with Brahmi comments/explanations; conventional Python syntax

**Data status:** no candidate corpus admitted

**Evaluator status:** full disposable-evaluator qualification remains open

This contract narrows the first Guru-Code capability claim. It does not make
the current synthetic fixtures a benchmark, authorize corpus use, authorize
teacher requests, or qualify any model. Changes after owner ratification must
be versioned before hidden evaluation targets are used.

## 1. Intended claim

The first release may claim only that one exact, locally runnable Guru-Code
artifact can complete the task strata below under the frozen evaluator and
Maataa's approval-gated project workflow. It may not imply support for all
Python projects, other languages, autonomous writes, production deployment, or
general software engineering.

## 2. Task population and strata

The complete candidate pool must contain at least **500 validator-clean,
small, executable Python tasks** before freezing the experiment split. Every
task needs a deterministic task test and a source/provenance record. Group by
repository, source, task family, near-duplicate and trajectory lineage before
splitting. Explanations and Brahmi-comment tasks may be included as secondary
measures, but do not count as executable-correctness cases unless they also
have a deterministic behavioral test.

Proposed minimum composition for the 500-task pool:

| Stratum | Minimum | Required evidence |
| --- | ---: | --- |
| Bug fixes | 100 | Reproduces the stated defect before the patch; passes the frozen regression test after it. |
| Feature additions | 100 | Acceptance tests fail on the starter and pass on an accepted implementation. |
| Refactors with behavior preservation | 75 | Frozen behavior tests pass before and after; the requested structural change is independently checked. |
| Multi-file changes | 100 | Tests require correct interaction across at least two project files. |
| Test/tooling tasks | 75 | A task-specific test or supported tool command has a deterministic expected result. |
| Security-sensitive coding tasks | 50 | Security tests cover the stated boundary; every critical prohibited behavior is a hard failure. |
| **Total** | **500** | Each task appears in exactly one primary stratum. |

These counts are a proposal, not owner-approved quotas. A task may have secondary
tags, but its primary stratum is assigned before splitting. Record task size,
changed-file count, dependency count, and test duration so the benchmark cannot
silently grow beyond the qualified context and resource envelope.

## 3. Split and hidden evaluation contract

1. Deduplicate and assign leakage groups before split assignment.
2. Freeze at least 500 eligible task IDs and their source/group digests.
3. Apply the existing deterministic task-ID split: sort unique UTF-8 task IDs
   by SHA-256 bytes (task ID breaks a digest tie), then allocate floor(80% N)
   to train, floor(10% N) to validation, and the remainder to test.
4. Keep all rows in one leakage group in the same partition. If group-aware
   assignment changes the exact 80/10/10 counts, record the deterministic
   group-level algorithm and resulting counts before any teacher generation.
5. Maintain a separate `guru-eval-v1` executable suite with its own pinned
   digest. It must include target-free held-out tasks and security cases; no
   hidden prompt, target, expected patch, or test oracle may enter teacher
   prompts, training, prompt tuning, or checkpoint selection.
6. Freeze train, validation and hidden-evaluation manifests, all source hashes,
   and the evaluator image digest in the signed pre-registration. Any change
   creates a new contract/pre-registration version.

The existing assembler's task-level split test is useful plumbing, but it does
not yet implement repository/family/trajectory leakage grouping or the separate
hidden executable evaluation suite. Those remain explicit implementation
gates.

## 4. Metrics and proposed acceptance bars

The experiment's registered comparison remains the hypothesis in `PLAN.md`:
response distillation must improve executable correctness by at least **+0.02
absolute** over matched SFT-only training, under its matched-seed, security and
cost rules. That is an experiment decision threshold, not by itself a release
threshold.

The following absolute release bars are **proposals only** and require owner
approval before any hidden results are observed:

| Measure | Proposed bar | Decision behavior |
| --- | --- | --- |
| Strict proposal parsing and allowed relative paths | 100% of evaluated proposals | Any malformed or escaping path fails that case; no path waiver. |
| Primary executable correctness | At least 80% overall and 70% in every primary stratum | Report raw numerator/denominator and confidence interval; an aggregate pass cannot hide a failed stratum. |
| Critical security violations | Zero | Any confirmed critical violation blocks release regardless of average correctness. |
| Evaluator integrity and evidence completeness | 100% of cases have valid, digest-linked evidence | Missing, timed-out-without-status, or unverifiable evidence is not a pass. |
| Maataa exact-model qualification | Six required capabilities, three clean trials each | Must run on the exact exported digest; mocks and tag aliases do not count. |

Also report per-stratum correctness, syntax/parse rate, test pass rate, security
rate, failure categories, task coverage, confidence intervals, latency, peak
memory, context length and exclusions. Never substitute language-model judge
scores for executable task evidence.

## 5. Task and runtime envelope

Initial v1 work is Python only and must fit the exact model's qualified context.
The evaluator contract must pin:

- OCI image digest, operating-system base and Python interpreter build;
- pytest and every installed dependency version/hash;
- fixed argv, working directory and environment allowlist;
- CPU, memory, PID, temporary-disk, output and wall-clock limits;
- no network, credentials, host filesystem, Docker socket or project-parent
  mounts; a fresh disposable workspace per case;
- startup cleanup, cancellation and daemon/host-restart recovery behavior;
- machine-readable per-case evidence schema and retention location.

Do not write a floating image tag as a pin. Until a disposable Linux host and
image are selected and independently inspected, toolchain pinning and
qualification are **open**.

## 6. Brahmi behavior boundary

Brahmi comments and explanations are secondary language behavior for v1.
Identifiers, keywords, punctuation and executable Python syntax remain
conventional. Score Brahmi separately for meaning preservation, truthful
explanation and correct code reference. A Brahmi explanation cannot compensate
for failing executable tests, and a language model judge alone cannot certify
its factual correctness.

## 7. Required owner decisions

Before this contract becomes frozen, the owner must record:

- approval or changes to the 500-task minimum and stratum quotas;
- approval or changes to the proposed absolute release bars;
- accepted scope and project/context/resource limits;
- whether Brahmi behavior is an informational measure or a release gate;
- owner name, approval reference and timestamp.

These approvals do not grant dataset rights, teacher-input transmission rights,
GPU spending, or approval to release weights; those remain separate records.

## 8. Exit checklist for A1–A4

- [ ] A1: owner and engineering ratify v1 scope and project/context limits.
- [ ] A2: owner ratifies task strata and counts; the corpus meets them.
- [ ] A3: owner ratifies correctness/security thresholds and stop rules before
  hidden targets are opened.
- [ ] A4: disposable evaluator image, interpreter, packages and invocation are
  digest-pinned and independently checked.

Until all four checks are evidenced, this document remains a draft and
`exp-rd-vs-sft-001` remains blocked.
