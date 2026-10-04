# Guru-Code release intake and qualification

This document defines the evidence needed to move Guru-Code from experimental
plumbing to a model that Maataa can prefer for coding. It does not certify a
checkpoint. The current workspace has no Guru-Code weights, vetted code corpus,
or executed coding benchmark.

## Current local readiness audit

Observed on 2026-10-04 in this checkout and host:

- `guru/data/coding/tasks.jsonl` contains two synthetic Python training tasks
  and three synthetic, target-free Python evaluation tasks. They test data
  plumbing only.
- `guru/data/coding/model.json` records a null checkpoint, no capability claim,
  and no verified context length. No Guru `.pt`, safetensors, or GGUF artifact,
  prepared Guru tokenizer, or prepared token corpus is present in `guru/`.
- The available Python is 3.12.4 with PyTorch 2.2.2; `guru/requirements.txt`
  requires PyTorch 2.4 or newer. SentencePiece and `gguf` are not installed.
  The host is an Apple M3 Pro with Metal hardware, but the installed PyTorch
  reports MPS unavailable; CUDA is unavailable too. Hardware presence alone is
  not usable training capacity.
- Guru's configured nano, mini and small models have 512, 1024 and 1024 token
  contexts; base-1b has 2048. Only the 7b configuration reaches Maataa's
  current 4096-token minimum. Guru's own guide assigns 1b and 7b to rented GPU
  hardware or a GPU cluster.
- The local Ollama manifests inspected during the audit contain no Guru model.
  Existing non-Guru Ollama weights cannot be relabelled as Guru.

These observations are a local snapshot; rerun the checks after the owner
provides a training host or a model artifact.

## Required owner inputs

1. A code corpus whose owner or authorized reviewer has recorded source,
   license, permitted training uses, redistribution/weight conditions, and
   provenance for every source shard. A generic project-level license label is
   not enough when files have different origins.
2. A frozen train/validation/held-out split plan. Group related files and
   repositories together before splitting; keep held-out prompts and targets
   out of training, tuning, and prompt iteration.
3. A coding scope to target: languages, frameworks, project sizes, task types,
   and the behaviors that matter. Set scale and pass thresholds before looking
   at held-out results.
4. A Guru base checkpoint and tokenizer suitable for supervised tuning, plus
   training capacity for a model that supports at least 4096 context tokens.
   The current host does not meet this requirement with its installed runtime.
5. An approved evaluation runner that executes generated proposals in a
   disposable environment with no network access and no host/project mounts.
   The runner must impose time, memory, process and output limits and preserve
   raw per-case results. Never execute generated code in the Maataa process or
   against an approved project folder.

## Per-source intake record

Create one record per imported source shard (and retain a mapping from each
task to its source records):

```json
{
  "source_id": "replace-with-stable-id",
  "uri": "https://or-local-immutable-source/",
  "revision": "immutable-commit-or-release-id",
  "license_spdx": "REVIEW_REQUIRED",
  "license_text_sha256": "",
  "source_content_sha256": "",
  "retrieved_at": "YYYY-MM-DD",
  "transformation": "describe filtering and normalization, or none",
  "permitted_uses": {
    "training": false,
    "evaluation": false,
    "weight_redistribution": false
  },
  "review": {
    "status": "not-reviewed",
    "reviewer": "",
    "reviewed_at": "",
    "notes": ""
  }
}
```

`REVIEW_REQUIRED`, empty digests, a missing reviewer, or a false required use
must exclude the source from the corresponding dataset/export. Record
synthetic tasks distinctly; they may remain pipeline fixtures but do not count
toward capability evaluation. Resolve license and weight-distribution
conditions with the authorized owner/reviewer; this project code does not make
legal determinations.

## Evaluation and release evidence

Before training, publish a versioned benchmark plan with target-free tests for
each selected language and scope area. It should include ordinary changes,
multi-file consistency, bug fixes, test authoring, ambiguous requests,
regression cases, malformed/path-escape proposals, dependency and secret
handling, and adversarial instructions. Freeze hidden cases before training.

For every generated proposal, the evaluator should record:

- whether the required plan contract and paths validate;
- whether generated code parses and the existing project checks pass;
- results of task-specific tests in the approved disposable runner;
- regression and security checks, including attempted filesystem/network
  access, timeout, resource exhaustion, and prompt-injection cases;
- the exact prompt, model/checkpoint/tokenizer digests, runner image digest,
  command, exit status, bounded logs, and any manual adjudication.

Compare Guru with a predeclared baseline on the same hidden cases. Report
coverage, failures and uncertainty by language and task category, not only one
aggregate pass rate. Set minimum thresholds before seeing the outputs. A
passing data parser, SFT export, syntax check, Guru name, or Maataa workflow
qualification is not a substitute for executable correctness/security results.

## Artifact chain and Maataa binding

Fill `data/coding/release-manifest.example.json` into a separately versioned
release manifest only after each evidence artifact exists. The final chain must
bind:

1. source records and their frozen split-manifest digest;
2. repository commit, training code/dependency lock, tokenizer digest, base
   checkpoint digest, training configuration, seed, and raw training results;
3. resulting checkpoint, exported HF/GGUF artifacts, and exact Ollama model
   digest, with at least 4096 context verified through Ollama's live metadata;
4. frozen benchmark revision, execution-runner digest, raw outputs, per-case
   results and predeclared thresholds;
5. Maataa's 18-trial qualification record for that exact Ollama digest and the
   required capability workflow.

Maataa may label the model Guru-Code eligible only when the lineage manifest
and evaluation decision refer to the same immutable artifact that passes its
current digest-bound workflow qualification. Importing or renaming a model
alone must never change Guru readiness. Re-run model qualification whenever
the Ollama digest changes.

## Release checklist

- [ ] Owner-reviewed corpus sources, use rights and weight conditions recorded.
- [ ] Frozen, leakage-checked split manifest contains no held-out targets in
      training/tuning material.
- [ ] Training host, model size, tokenizer and context meet the predeclared
      coding scope; reproducible dependencies and recipe are pinned.
- [ ] Checkpoint and exports are hashed and reproducible from recorded inputs.
- [ ] Hidden executable correctness/security benchmark passes the thresholds
      fixed before training; baseline and per-case evidence are retained.
- [ ] Exact exported Ollama digest reports at least 4096 context and passes
      Maataa's 18-trial required-workflow qualification.
- [ ] Release manifest, limitations, data attribution and model card are
      complete; no unresolved source/weight rights are represented as cleared.

Until every item is evidenced, keep `coding_capability_established` false and
describe Guru-Code as experimental scaffolding.
