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
- The available Python is 3.12.4 with PyTorch 2.3.1; `guru/requirements.txt`
  requires PyTorch 2.4 or newer. SentencePiece and `gguf` are not installed in
  the base environment (SentencePiece was added to a temporary test-only
  virtualenv for the full Guru unit suite).
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
  "artifact_path": "sources/source-archive.bin",
  "artifact_sha256": "",
  "attribution": "Required attribution text",
  "license": {
    "id": "LicenseRef-OwnerReviewedTerms",
    "text_uri": "https://or-local-immutable-license-text/",
    "text_path": "licenses/source-license.txt",
    "text_sha256": ""
  },
  "rights_review": {
    "status": "approved",
    "reviewer": "",
    "reviewed_at": "",
    "allowed_uses": ["train_sft", "evaluation"]
  },
  "task_hashes": {"stable-task-id": "canonical-task-sha256"}
}
```

Each source artifact and saved license text must be inside the source manifest
directory; Guru verifies both file hashes. Save the exact reviewed upstream
item bytes as a separate file under that directory too. Each task row
references one or more sources in `provenance.source_refs`, with the immutable
upstream `item_id`, `item_path` to those saved bytes, their computed SHA-256,
and a transformation description. Guru checks each item hash against the
saved bytes and rejects matching item hashes across rows, including across
different source IDs. A human reviewer still needs to establish that each
saved item is faithfully associated with the pinned source artifact. The
source's `task_hashes` binds its review to canonical task rows. A v1 release
corpus retains its existing `train` plus target-free `eval` requirement. A v2
release corpus requires all three splits: target-bearing `train`, target-bearing
`validation`, and target-free `eval`. Validation may support model selection and
tuning, but only `train` rows are ever copied into SFT. Give every task a
`leakage_group`; no project, issue family, duplicate prompt/rubric, or source
item may cross any split boundary. Do not mix schema versions in one release
corpus. The example manifest at
`data/coding/source-manifest.example.json` is intentionally empty and cannot
be used for release export.

`REVIEW_REQUIRED`, empty/mismatched digests, a missing reviewer, unresolved
license IDs, unreviewed sources, missing use permission, or an unmanifested
task fails release export before output files are created. `train_sft`,
`evaluation` and `release_weights` are separate permissions. A successful SFT
export proves source-record completeness and hash consistency only; it does
not settle legal questions or prove model quality. Resolve license and weight
distribution conditions with the authorized owner/reviewer; this project code
does not make legal determinations.

The `code-data` default `smoke` profile accepts only rows explicitly marked
`synthetic_fixture: true` and emits no release claim. Curated data requires the
explicit `release` profile and source manifest:

```sh
python -m guru code-data --profile release \
  --tasks data/coding/release/tasks.jsonl \
  --source-manifest data/coding/release/sources.json \
  --sft-out out/guru-code-sft.jsonl
```

Release mode exports only train targets (for both schemas) and emits a
`.provenance.json` sidecar bound to both the exact source manifest bytes and SFT
output bytes. V2 validation targets are available for validation workflows but
never enter the training pairs.
The `approved` status, reviewer identity, URI, revision, and license identifier
remain owner/reviewer assertions in the manifest; this local exporter does not
authenticate the reviewer or independently determine legal rights. Keep that
review evidence with the corpus.

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
