# Response distillation vs. SFT-only baseline

**Experiment:** `exp-rd-vs-sft-001`
**State:** blocked draft; not pre-registered, not started
**Scope:** one teacher, one student base, one Python task family, two arms, one frozen executable evaluation set

This plan compares reviewed teacher-response targets against ordinary SFT on
the same tasks. It does not test logits/hidden states, on-policy distillation,
multi-agent trajectory distillation, continued pretraining, weight merging,
multiple teachers, or multiple student bases. A result only describes this
specific method and frozen evaluation set.

## Hypothesis

Reviewed response distillation from an admitted teacher improves executable
correctness on Guru-Code tasks by at least **+0.02 absolute** over SFT-only, at
no more than **3× total cost**, with no security regression. The cost ceiling
may rise to **5× only if executable correctness improves by at least +0.05**.
These thresholds are draft decision rules and require owner ratification before
pre-registration.

## Arms

| Arm | Training targets | Purpose |
| --- | --- | --- |
| `sft_only` | Existing admitted human-written task/target pairs | Baseline |
| `response_distill` | Teacher responses for the same tasks, admitted through rights, disclosure, quality, evaluator and human-review gates | Treatment |

Both arms must use the same student checkpoint and tokenizer digests, task
IDs, prompt template, split, sequence-length policy, optimizer, learning-rate
schedule, batch policy, epochs, checkpoint selection rule, hardware class and
two seed IDs. Training-item count must match. Record target-token counts and
all differences in actual cost. The target text source is the intended
intervention; do not silently change other training settings by arm.

## Hard prerequisites

Do not pre-register, generate teacher outputs, train, or evaluate until every
blocking item is closed and linked to evidence:

1. An owner-approved teacher intake record with exact model and adapter
   digests, access mode, terms and output-training permission.
2. Per-task input disclosure approval, including allowed fields, provider
   input retention/training, region, confidentiality, and the named
   transmission approver. Block private, secret, personal, unreleased, or
   rights-unclear inputs by default.
3. An owner-approved student-base checkpoint and tokenizer with immutable
   digests and at least 4096-token context.
4. At least 500 validator-clean, small executable Python tasks in the complete
   pool. Sort by SHA-256 of UTF-8 `task_id` bytes (task ID breaks any hash
   tie), assign `floor(0.8N)` rows to train, the next `floor(0.1N)` to
   validation, and the remainder to hidden test. Freeze all task-ID lists and
   the held-out set before teacher generation.
5. A separate `guru-eval-v1` executable held-out suite with a committed digest,
   deterministic acceptance checks, and security tasks covering auth, secrets,
   sandboxing and evaluator behavior. It must not be exposed to the teacher,
   training, prompt tuning, or checkpoint selection.
6. A reviewed, digest-pinned isolated evaluator with machine-readable evidence,
   no host/project/credential mounts or network egress, bounded resources,
   cancellation and verified cleanup. Freeze the exact evaluator image,
   invocation contract and evidence schema in the pre-registration. Mock tests
   are insufficient.
7. Implemented and tested versions of the quality-admission and
   input-disclosure policies. `quality-v0.1` and `disclosure-v0.1` in the
   template are proposed identifiers, not existing approvals.
8. A named two-reviewer Tier A process, disagreement escalation, and a
   predeclared review sampling plan.
9. A suitable training host, reproducible environment, checkpoint/restart
   test, wall-clock limits, owner-approved total budget ceiling, and cost
   instrumentation. The currently observed Mac is not a training resource;
   no GPU spending is authorized by this plan.
10. An immutable signed-by-owner pre-registration record and its SHA-256
    digest. The result checker binds that digest to the exact canonical JSON
    record and checks that experiment identity, hypothesis, thresholds,
    approvals, budget, model lineage, evaluation set, split and policy versions
    match the reported run. It cannot authenticate signatures, approval
    references, or the truth of rights and evidence claims.

If any prerequisite is missing, this remains a draft. No teacher request or
training job may be started.

## Data protocol

1. Freeze the task list, source provenance, train/validation/test split, and
   separate held-out evaluation digest. Group by repository, source, family
   and duplicates before splitting.
2. Apply the disclosure gate to every proposed teacher input. Store the
   request, allowed fields, decision, approver and provider-retention settings.
3. Save each raw teacher response immutably with the exact teacher digest,
   prompt digest, decoding settings, timestamp and task lineage.
4. Run duplicate/leakage checks, parser/compiler and deterministic task tests,
   dependency/secret/path/security checks, and the qualified isolated
   evaluator. Preserve failures as rejected process evidence, never positive
   targets by default.
5. Review all Tier A examples with two independent reviewers. Review Tier B at
   10% (minimum 5) and Tier C at 1% (minimum 1); classify tiers before review.
   Escalate disagreement. These sampling rates are proposed and must be
   ratified by the owner before the experiment starts.
6. Admit only responses with complete rights and teacher lineage, successful
   executable/security checks, and an explicit human disposition. Apply the
   versioned batch rejection rule; do not average conflicting answers.
7. Build the baseline from the same task IDs using existing human-written
   targets. Apply the same quality checks to that data. If treatment examples
   are rejected, either regenerate under a separately recorded setting or
   remove the matching task from both arms before freezing the training list.
8. Hash the final item lists and assert task-ID and item-count parity before
   training.

## Training and evaluation

- Run two matched seed IDs per arm; keep training settings identical.
- No arm-specific hyperparameter tuning. Tuning is a separately preregistered
  experiment.
- Choose checkpoints by one frozen rule applied to both arms. Do not use the
  hidden test set for model selection.
- Execute every frozen evaluation case in the qualified evaluator and retain
  raw per-case evidence bound to exact model/tokenizer, prompt, runner-image
  and command digests.
- Report executable correctness, security pass rate, lint-clean rate,
  regression rate, and conversation quality. Conversation quality alone
  cannot establish a win.
- Two independent reviewers adjudicate the same blinded Tier A sample for
  both arms; disagreement escalates to the owner/delegate.

## Full-cost accounting

Record actual USD costs for both arms in all categories:

1. Teacher inference.
2. Data-generation overhead.
3. Input-disclosure review.
4. Data review (item and batch).
5. Quality-gate runs.
6. Student training.
7. Evaluation.
8. Inference at deployment.
9. Engineering attributable to the arm.
10. Storage and transfer.

Every category must be an actual measured amount or carry an explicit
not-applicable reason. Baseline teacher inference is not applicable because no
teacher calls are made; it is not silently treated as zero. The decision tool
uses actual amounts and ignores preregistered estimates. Report GPU-hours,
teacher tokens/calls, reviewer-hours, training tokens, evaluation compute,
inference latency/memory and storage alongside USD.

## Decision rule

`guru.experiments.decision` validates that both arms are present, share the
frozen training-task digest and evaluation digest, use the same two seeds,
have complete actual-cost ledgers and human-review records, and stay within the
pre-registered total budget. It then applies these rules:

- **Admit:** treatment improves executable correctness by at least +0.02;
  both matched seeds independently improve by at least +0.02 and each lies
  within ±0.01 of the mean delta; no seed has a security regression; both
  blinded human reviews pass; and treatment/baseline actual total cost is at
  most 3× (at most 5× only when the correctness gain is at least +0.05).
- **Reject:** actual combined cost exceeds the approved ceiling; human review
  fails; any matched seed regresses on security; correctness does not improve
  while treatment costs more; the mean win disappears on a seed; conversation
  quality is the only improvement; or the relevant maximum cost ratio is
  exceeded without reaching its corresponding correctness threshold.
- **Inconclusive:** all other outcomes, including seed disagreement greater
  than 0.02. Preserve this result; do not silently retry or change thresholds.

The code emits calculations and reasons, not an authorization to release a
model. These thresholds are drafts pending owner ratification and should be
changed only in a new pre-registration revision before any outputs are seen.

## Required final report

Report in this order: frozen hypothesis; evaluation ID and digest; policy
versions; cost/quality arm table; baseline comparisons and matched-seed
results; human adjudication; exclusions and unmeasured items; rejected or
inconclusive outcomes and reasons; cost actuals; limitations; owner sign-off.
The checked-in `report.md` is an unfilled template. `guru.experiments.report`
can render a report from completed result and decision JSON.

## Completion criteria

The experiment is complete only when the preregistration digest matches the
executed record, both arms and seeds have reproducible artifacts, all actual
costs and exclusions are reported, the frozen evaluation is unchanged, human
adjudication is complete, the decision rule runs successfully, and an owner
signs the report. A positive result is not Maataa model qualification; that
still requires the separate exact-artifact qualification gate.
