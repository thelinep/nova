# Response-distillation vs. SFT-only report

**Experiment ID:** `exp-rd-vs-sft-001`
**Report status:** template — no experiment has run
**Decision:** not evaluated

> This template is not evidence of a run, model capability, rights approval,
> or Maataa qualification. Fill it only from the completed preregistration,
> immutable run artifacts, measured costs, and `decision.json`.

## 1. Pre-registered hypothesis

> Reviewed response distillation from an admitted teacher improves executable
> correctness on Guru-Code tasks by at least +0.02 absolute over SFT-only, at
> no more than 3× total cost, with no security regression. The cost ceiling may
> rise to 5× only if executable correctness improves by at least +0.05.

Pre-registration SHA-256: **pending**
Owner and approval reference: **pending**

## 2. Frozen evaluation and policies

| Field | Recorded value |
| --- | --- |
| Evaluation set ID | pending |
| Evaluation set SHA-256 | pending |
| Evaluation case count | pending |
| Quality policy version | pending |
| Disclosure policy version | pending |
| Decision rule version | pending owner ratification |
| Evaluator image SHA-256 | pending |

## 3. Arm comparison

| Arm | Actual total USD | Executable correctness | Security pass rate | Lint-clean rate | Regression rate | Conversation quality | Human review |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| SFT-only | pending | pending | pending | pending | pending | pending | pending |
| Response-distill | pending | pending | pending | pending | pending | pending | pending |
| Delta / ratio | pending | pending | pending | pending | pending | pending | pending |

## 4. Matched-seed results

| Seed | Baseline executable correctness | Treatment executable correctness | Delta | Baseline security | Treatment security | Delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Seed 1 | pending | pending | pending | pending | pending | pending |
| Seed 2 | pending | pending | pending | pending | pending | pending |

## 5. Actual cost accounting

Record measured USD for each category and each arm. Use an explicit reason for
every not-applicable item. Estimated values from the preregistration are not
actual cost and are not used in the decision.

| Category | SFT-only actual USD / reason | Response-distill actual USD / reason |
| --- | --- | --- |
| Teacher inference | pending | pending |
| Data-generation overhead | pending | pending |
| Input-disclosure review | pending | pending |
| Data review | pending | pending |
| Quality-gate runs | pending | pending |
| Student training | pending | pending |
| Evaluation | pending | pending |
| Inference at deployment | pending | pending |
| Engineering | pending | pending |
| Storage and transfer | pending | pending |
| Combined total / cost ratio | pending | pending |

Also report GPU-hours, teacher tokens/calls, reviewer-hours, training tokens,
evaluation compute, inference latency/memory and storage.

## 6. Human adjudication

- Tier A sample and two independent reviewers: pending
- Blinded-to-arm: pending
- Agreement/disagreement and escalation: pending
- Pass/fail with evidence reference: pending

## 7. Exclusions and unmeasured items

| Item | Why excluded or not measured | Owner disposition |
| --- | --- | --- |
| pending | pending | pending |

## 8. Decision and reasons

- Decision from `decision.json`: **not evaluated**
- Computed correctness delta: pending
- Computed security delta: pending
- Computed treatment/baseline cost ratio: pending
- Threshold set used: pending
- Decision reasons: pending

## 9. Negative, rejected and inconclusive outcomes

Record every rejected item/arm, inconclusive result, failed seed, policy
deviation and reason. Do not silently retry or omit a negative result.

Pending; no run exists.

## 10. Artifacts, limitations and sign-off

- Training-task list and digest: pending
- Student, tokenizer and teacher digests: pending
- Runner image and per-case evidence: pending
- Run recipes, logs and checkpoints: pending
- Deviations from preregistration: pending
- Limitations: current template and decision code do not authenticate evidence,
  approvals or signatures; the isolated evaluator, corpus and checkpoint are
  not yet qualified.
- Owner sign-off: pending
