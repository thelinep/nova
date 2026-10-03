# Guru-Code (experimental foundation)

Guru-Code is an experimental task format and evaluation path, **not a claim that
any current Guru checkpoint can code reliably**. Existing training text is
primarily Sanskrit, Hindi and English prose and Panini material. Training on the
examples here is only a pipeline smoke check; it does not establish useful
coding capability. A dedicated, rights-reviewed code corpus, sufficient model
capacity/context, and broader held-out evaluations remain future work.

## Task data contract

`data/coding/tasks.jsonl` contains one JSON object per line using
`guru-code-task-v1`. Every task records an ID, split, language, natural-language
request, provenance, and a small rubric. Training tasks have a structured
`target`; held-out `eval` tasks must not include targets. Provenance is required
even for hand-authored synthetic tasks so the fixture origin is explicit.
`data/coding/model.json` records the current support status; it intentionally
reports no trained Guru-Code checkpoint and no established coding capability.

The target/proposal shape is:

```json
{
  "summary": "short explanation",
  "files": [{"path": "project-relative.py", "content": "complete file contents"}],
  "tests": ["test command or check description"]
}
```

This is a compact proposal contract, not a unified diff. Maataa remains
responsible for project access, path validation against an approved root,
review, approval, writes, test execution and Git delivery. Never use this
offline evaluator as an authorization or safety boundary.

## Validate and prepare the training split

From the `guru/` directory:

```sh
python -m guru code-data
python -m guru teach --size nano --pairs out/guru-code-sft.jsonl
```

`code-data` checks the task format and writes only the `train` rows in Guru's
existing `prompt`/`answer` SFT format. It does not download or add external data.
Use `--tasks FILE --sft-out FILE` to select another explicitly curated dataset.

## Evaluate held-out proposals

Provide JSONL predictions with one `id` and an `output` string containing the
model's raw JSON response:

```json
{"id":"eval-001","output":"{\"summary\":\"...\",\"files\":[...],\"tests\":[...]}"}
```

Then run:

```sh
python -m guru code-eval --predictions out/guru-code-predictions.jsonl
```

The report measures prediction coverage, strict JSON/plan adherence, basic
relative-path safety, Python syntax, and the fixture's expected paths/symbols/
test descriptions. It does not run generated code, inspect its runtime behavior,
verify tests, or establish security or production readiness. The synthetic
held-out set has only three small Python tasks; its rubric is deliberately
shallow and can be gamed. Do not tune on these eval prompts or targets, and
replace/expand them before making model-quality claims.

## Current limitations

- Only Python syntax is parsed. Other languages have no syntax checks here.
- Expected-symbol and test-description checks are lightweight rubric signals,
  not semantic correctness checks.
- Generated code is never executed.
- Task fixtures are original and hand-authored; they are not a representative
  benchmark and do not imply training data scale or rights clearance for future
  corpora.
- Model context, training scale, inference quality, tool integration, and Maataa
  coding qualification must be assessed separately on the exact exported model.
