# Guru Coding Corpus and Compute Plan

Status: **starter authored; external corpus and paid compute not acquired**.
This is a candidate plan, not source-rights approval or a model release.

## Corpus design

Keep three data lanes distinct:

1. **Guru base pretraining**: raw code/text sequences for the Guru tokenizer and
   `train.bin`/`val.bin` stream. The current 7B preset targets 140B tokens.
2. **Guru-Code instruction tuning**: Maataa proposal tasks whose answers are
   structured plans (`summary`, project-relative `files`, and `tests`). The
   current exporter writes only train answers to Guru's prompt/answer format.
3. **Capability evaluation**: target-free hidden requests, executed in a
   disposable evaluator. Do not use these prompts or targets during training,
   tuning, or manual prompt selection.

Proposed first scope is Python-only and one-project changes: pure functions,
bug fixes, input validation, safe path handling, tests, small multi-file edits,
and explicit uncertainty when a task lacks context. For an evidence-bearing
pilot, aim for 2,000 reviewed train tasks, 250 target-bearing validation tasks,
and 250 frozen target-free test tasks, grouped by source project and task
family before splitting. These counts are an initial collection target, not a
claim that they guarantee capability. Review every target against executable
tests before admitting it.

The current `guru-code-task-v1` format supports only `train` and target-free
`eval`; it cannot represent target-bearing validation. Before collecting a
release corpus, add a versioned schema for `validation`, separate files for
train/validation/hidden evaluation, and exporter rules that never copy
validation or hidden targets into SFT. Keep the existing `tasks.jsonl` and
`invented-starter-v1.jsonl` marked synthetic smoke fixtures.

## Invented starter corpus

`data/coding/invented-starter-v1.jsonl` contains four original train examples
and two target-free evaluation examples. It covers strict parsing, pagination,
stable deduplication, byte formatting, dictionary merge, and chunked iteration.
The examples are authored in this repository, have no external source files,
and are marked `synthetic_fixture: true`. Use them to test the pipeline and
proposal format only; they are too few and too simple to support any capability
claim. Train targets receive schema and Python syntax checks in the Guru tests.

## External corpus candidates collected for review

- [`OLMo-Coding/starcoder-python-instruct`](https://huggingface.co/datasets/OLMo-Coding/starcoder-python-instruct) is an accessible Python instruction
  dataset listed at about 1.26M rows and Apache-2.0 at the Hub. Its examples
  retain StarCoder/The Stack provenance and source-code metadata. The dataset
  card's Apache label does not override The Stack's source-level terms. That
  corpus requires honoring each original repository license and attribution,
  tracking source revisions and removal requests; approve each item's exact
  training, evaluation and weight-distribution uses before fetch/release.
  Candidate only; do not place it in a release export until those records are
  reviewed.
  A visible revision is `5bcafbc`; resolve it to a full commit SHA before
  acquisition.
- [`bigcode/starcoderdata`](https://huggingface.co/datasets/bigcode/starcoderdata) describes a much larger code pretraining set, but is
  gated. Access requires accepting terms that preserve original repository
  licenses and attribution and require keeping removal updates current. It is
  not an unattended downloader target.
- [`Qwen/Qwen2.5-Coder-1.5B`](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B) lists Apache-2.0 and is a possible separate
  experimental baseline. Guru's current trainer cannot import its weights:
  Guru trains its own architecture/tokenizer from scratch and only exports
  outward to Llama-compatible formats. Using Qwen as Guru would require an
  explicit model-lineage and trainer redesign, followed by a separate review.

The external dataset and model have **not** been downloaded. No item-level
review or permission to publish weights has been asserted by this plan.

## Training-resource feasibility

The current Guru 7B recipe is a from-scratch job with a 140B-token budget and
4,096-token sequences; it is not a low-cost fine-tune of an existing code model.
Using the conventional `6 × parameters × tokens` estimate gives about
`5.88e21` training FLOPs before evaluation, data processing and recovery work.

As checked on 2026-10-04, Lambda's [self-serve price table](https://lambda.ai/instances)
lists an 8× H100 SXM node at $3.99 per GPU-hour, or $31.92 per node-hour before
taxes. NVIDIA's [OpenGenome2 Llama 3 recipe](https://docs.nvidia.com/bionemo-recipes/latest/main/recipes/recipes/opengenome2_llama_native_te/)
reports 9,927 unpadded tokens/second/GPU for a 7B BF16/FSDP2 run on 48 H100s
with sequence packing and roughly 4K-token average inputs. Assuming that rate
scales linearly to 8 GPUs gives about 490 hours for 140B tokens, or around
$15.6k at the Lambda node price. This is a planning illustration: the NVIDIA
run used a different model/data path, 48 GPUs, sequence packing and FSDP2; it
does not measure Guru's code or promise 8-GPU scaling. Data preparation,
retries, evaluation, storage and tax add cost. Obtain a live quote and benchmark
Guru before making a purchase decision.

**Do not rent the full run yet.** `guru/guru/train.py` uses ordinary distributed
data parallelism, so each GPU holds a full FP32 model, gradients, and Adam
states; it has no activation-checkpointing or sharded-optimizer path. The 7B
configuration is therefore not shown to fit an 80GB H100, and the current
repository has no 7B capacity benchmark. First implement and test a memory
strategy (for example, sharded optimizer/model state plus activation
checkpointing), then run a short measured throughput/memory/restart benchmark
on an approved host. Only after that should a multi-week training reservation
be priced and authorized.

The local M3 Pro/PyTorch environment is not a substitute for that resource:
the installed PyTorch reports MPS unavailable and the code corpus/pretraining
budget is absent. A paid cloud account and a spending ceiling are also not
configured in this workspace.

## Acquisition gates

1. Owner/reviewer accepts or rejects each dataset candidate and records
   training, evaluation, and weight-distribution permissions separately.
2. Pin each accepted source revision; save the source archive, item snapshots,
   and exact license text, then generate hashes and task/source links.
3. Add the validation split contract and executable isolated task runner.
4. Finish a Guru 7B memory/throughput preflight before estimating a paid run.
5. Approve a provider, region, account, budget ceiling, retention and deletion
   policy before provisioning compute or transferring corpus data.
