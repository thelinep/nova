"""Fail-closed decision rules for exp-rd-vs-sft-001 result records.

This module consumes completed experiment evidence. It does not call teachers,
train models, run evaluators, authorize spending, or verify the truth of
human-entered approvals and evidence references.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

SCHEMA_VERSION = "guru-code-experiment-results-v1"
EXPERIMENT_ID = "exp-rd-vs-sft-001"
DECISION_RULE_VERSION = "rd-sft-v0.1-proposed"
DECISION_RULE = {
    "correctness_gain_minimum": 0.02,
    "correctness_gain_for_5x_cost": 0.05,
    "cost_ratio_maximum": 3.0,
    "cost_ratio_maximum_for_5x": 5.0,
    "security_regression_allowed": 0.0,
    "matched_seed_tolerance": 0.01,
    "seed_disagreement_inconclusive_above": 0.02,
    "seed_count_per_arm": 2,
}
EXPECTED_ARMS = ("sft_only", "response_distill")
COST_CATEGORIES = (
    "teacher_inference",
    "data_generation_overhead",
    "input_disclosure_review",
    "data_review",
    "quality_gate_runs",
    "student_training",
    "evaluation",
    "inference_at_deployment",
    "engineering",
    "storage_and_transfer",
)
_SHA256 = set("0123456789abcdef")


class ExperimentInputError(ValueError):
    """A result record is incomplete or not comparable."""


def _is_sha256(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and set(value) <= _SHA256


def _canonical_sha256(value: object) -> str:
    """Hash a JSON value with a stable canonical encoding."""
    try:
        payload = json.dumps(value, sort_keys=True, separators=(",", ":"),
                             ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ExperimentInputError("pre_registration.record must be canonical JSON data") from exc
    return hashlib.sha256(payload).hexdigest()


def _finite_number(value: object, label: str, *, minimum: float | None = None,
                   maximum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ExperimentInputError(f"{label} must be a finite number")
    number = float(value)
    if minimum is not None and number < minimum:
        raise ExperimentInputError(f"{label} must be at least {minimum}")
    if maximum is not None and number > maximum:
        raise ExperimentInputError(f"{label} must be at most {maximum}")
    return number


def _count(value: object, label: str, *, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ExperimentInputError(f"{label} must be an integer >= {minimum}")
    return value


def _rate(numerator: object, denominator: object, label: str) -> float:
    n = _count(numerator, f"{label}.passed")
    d = _count(denominator, f"{label}.total", minimum=1)
    if n > d:
        raise ExperimentInputError(f"{label}.passed cannot exceed total")
    return n / d


def _read_costs(arm: dict, label: str) -> tuple[float, dict[str, dict]]:
    costs = arm.get("costs")
    if not isinstance(costs, dict):
        raise ExperimentInputError(f"{label}.costs must be an object")
    missing = sorted(set(COST_CATEGORIES) - costs.keys())
    extra = sorted(costs.keys() - set(COST_CATEGORIES))
    if missing:
        raise ExperimentInputError(f"{label} is missing cost categories: {', '.join(missing)}")
    if extra:
        raise ExperimentInputError(f"{label} has unknown cost categories: {', '.join(extra)}")

    total = 0.0
    normalized: dict[str, dict] = {}
    for category in COST_CATEGORIES:
        line = costs[category]
        key = f"{label}.costs.{category}"
        if not isinstance(line, dict) or line.get("measured") is not True:
            raise ExperimentInputError(f"{key} must contain measured actual cost evidence")
        actual = line.get("actual_usd")
        if actual is None:
            reason = line.get("not_applicable_reason")
            if not isinstance(reason, str) or not reason.strip():
                raise ExperimentInputError(f"{key} with no actual requires not_applicable_reason")
            normalized[category] = {"actual_usd": None, "not_applicable_reason": reason.strip()}
            continue
        amount = _finite_number(actual, f"{key}.actual_usd", minimum=0)
        if not _is_sha256(line.get("evidence_sha256")):
            raise ExperimentInputError(f"{key}.evidence_sha256 must bind the measured actual cost evidence")
        if line.get("not_applicable_reason") not in (None, ""):
            raise ExperimentInputError(f"{key} cannot be both measured and not applicable")
        # Deliberately ignore pre_registered_estimate_usd. Decisions use actuals.
        normalized[category] = {
            "actual_usd": amount,
            "evidence_sha256": line["evidence_sha256"],
            "not_applicable_reason": None,
        }
        total += amount
    return total, normalized


def _read_seed_result(row: object, label: str, eval_size: int) -> dict:
    if not isinstance(row, dict):
        raise ExperimentInputError(f"{label} must be an object")
    seed = row.get("seed")
    if type(seed) not in (int, str) or (isinstance(seed, str) and not seed.strip()):
        raise ExperimentInputError(f"{label}.seed must be a non-empty string or integer")
    metrics = row.get("metrics")
    if not isinstance(metrics, dict):
        raise ExperimentInputError(f"{label}.metrics must be an object")
    if metrics.get("evaluation_cases") != eval_size:
        raise ExperimentInputError(f"{label}.metrics.evaluation_cases must match the frozen evaluation size")
    exec_rate = _rate(metrics.get("executable_correct"), metrics.get("evaluation_cases"), f"{label}.executable")
    security_rate = _rate(metrics.get("security_pass"), metrics.get("security_cases"), f"{label}.security")
    lint_rate = _rate(metrics.get("lint_clean"), metrics.get("lint_cases"), f"{label}.lint")
    regression_count = _count(metrics.get("regressions"), f"{label}.regressions")
    regression_cases = _count(metrics.get("regression_cases"), f"{label}.regression_cases", minimum=1)
    if regression_count > regression_cases:
        raise ExperimentInputError(f"{label}.regressions cannot exceed regression_cases")
    conversation = _finite_number(metrics.get("conversation_quality"), f"{label}.conversation_quality", minimum=0, maximum=1)
    return {
        "seed": seed,
        "student_checkpoint_sha256": row.get("student_checkpoint_sha256"),
        "evaluation_evidence_sha256": row.get("evaluation_evidence_sha256"),
        "executable_correctness": exec_rate,
        "security_pass_rate": security_rate,
        "lint_clean_rate": lint_rate,
        "regression_rate": regression_count / regression_cases,
        "conversation_quality": conversation,
    }


def _mean(rows: list[dict], field: str) -> float:
    return sum(row[field] for row in rows) / len(rows)


def evaluate_results(document: object) -> dict:
    """Validate comparability, compute actual costs, and apply the draft rule."""
    if not isinstance(document, dict) or document.get("schema_version") != SCHEMA_VERSION:
        raise ExperimentInputError(f"schema_version must be {SCHEMA_VERSION!r}")
    if document.get("experiment_id") != EXPERIMENT_ID:
        raise ExperimentInputError(f"experiment_id must be {EXPERIMENT_ID!r}")
    if document.get("status") != "completed":
        raise ExperimentInputError("only completed experiment results can be decided")
    if not isinstance(document.get("hypothesis"), str) or not document["hypothesis"].strip():
        raise ExperimentInputError("the pre-registered hypothesis text is required")

    prereg = document.get("pre_registration")
    if not isinstance(prereg, dict):
        raise ExperimentInputError("a frozen, pre_registered record is required before results can be decided")
    record = prereg.get("record")
    if not isinstance(record, dict):
        raise ExperimentInputError("pre_registration.record must contain the exact frozen pre-registration object")
    if not _is_sha256(prereg.get("sha256")):
        raise ExperimentInputError("pre_registration.sha256 must be a lowercase SHA-256 digest")
    if prereg["sha256"] != _canonical_sha256(record):
        raise ExperimentInputError("pre_registration.sha256 does not match the canonical pre_registration.record")
    if record.get("status") != "pre_registered" or prereg.get("status") != record.get("status"):
        raise ExperimentInputError("a frozen, pre_registered record is required before results can be decided")
    if record.get("experiment_id") != EXPERIMENT_ID or prereg.get("experiment_id") != record.get("experiment_id"):
        raise ExperimentInputError("pre_registration.record must bind this exact experiment_id")
    if record.get("hypothesis") != document["hypothesis"]:
        raise ExperimentInputError("result hypothesis must exactly match the frozen pre-registration record")
    if record.get("decision_rule_version") != DECISION_RULE_VERSION or record.get("decision_rule") != DECISION_RULE:
        raise ExperimentInputError("pre_registration must bind the exact supported decision-rule version and thresholds")
    if prereg.get("decision_rule_version") != record.get("decision_rule_version") or prereg.get("decision_rule") != record.get("decision_rule"):
        raise ExperimentInputError("pre_registration wrapper must match the frozen decision rule")
    rule_approval = record.get("decision_rule_owner_ratification_ref")
    if not isinstance(rule_approval, str) or not rule_approval.strip():
        raise ExperimentInputError("the decision-rule thresholds require an owner ratification reference")
    if prereg.get("decision_rule_owner_ratification_ref") != rule_approval:
        raise ExperimentInputError("pre_registration wrapper must match the frozen decision-rule ratification reference")
    signoff = record.get("owner_signoff")
    if not isinstance(signoff, dict) or any(not isinstance(signoff.get(key), str) or not signoff[key].strip()
                                            for key in ("owner", "approval_ref", "approved_at")):
        raise ExperimentInputError("pre_registration requires owner, approval_ref, and approved_at")
    if prereg.get("owner_signoff") != signoff:
        raise ExperimentInputError("pre_registration wrapper must match the frozen owner signoff")
    budget = _finite_number(record.get("budget_ceiling_usd"), "pre_registration.budget_ceiling_usd", minimum=0.01)
    if prereg.get("budget_ceiling_usd") != budget:
        raise ExperimentInputError("pre_registration wrapper must match the frozen budget ceiling")
    model_lineage = document.get("model_lineage")
    prereg_lineage = record.get("model_lineage")
    if not isinstance(model_lineage, dict) or model_lineage != prereg_lineage:
        raise ExperimentInputError("result model lineage must match the pre-registered exact model and evaluator digests")
    if prereg.get("model_lineage") != prereg_lineage:
        raise ExperimentInputError("pre_registration wrapper must match the frozen model lineage")
    for field in ("teacher_intake_sha256", "teacher_model_sha256", "student_base_intake_sha256",
                  "student_base_sha256", "tokenizer_sha256", "training_recipe_sha256", "evaluator_image_sha256"):
        if not _is_sha256(model_lineage.get(field)):
            raise ExperimentInputError(f"model_lineage.{field} must be a lowercase SHA-256 digest")
    if model_lineage.get("teacher_adapter_sha256") is not None and not _is_sha256(model_lineage["teacher_adapter_sha256"]):
        raise ExperimentInputError("model_lineage.teacher_adapter_sha256 must be a lowercase SHA-256 digest or null")
    if type(model_lineage.get("context_tokens")) is not int or model_lineage["context_tokens"] < 4096:
        raise ExperimentInputError("model_lineage.context_tokens must be at least 4096")

    frozen_eval = document.get("frozen_eval_set")
    if not isinstance(frozen_eval, dict) or not isinstance(frozen_eval.get("id"), str) or not frozen_eval["id"].strip():
        raise ExperimentInputError("frozen_eval_set.id is required")
    if frozen_eval["id"] != "guru-eval-v1":
        raise ExperimentInputError("frozen_eval_set.id must be guru-eval-v1 for this experiment")
    if not _is_sha256(frozen_eval.get("sha256")):
        raise ExperimentInputError("frozen_eval_set.sha256 must be a lowercase SHA-256 digest")
    if frozen_eval.get("evaluator_image_sha256") != model_lineage["evaluator_image_sha256"]:
        raise ExperimentInputError("frozen evaluation runner image must match pre-registered evaluator digest")
    eval_size = _count(frozen_eval.get("size"), "frozen_eval_set.size", minimum=1)
    if record.get("frozen_eval_set") != frozen_eval:
        raise ExperimentInputError("frozen_eval_set must exactly match the pre-registration record")

    task_split = document.get("task_split")
    if not isinstance(task_split, dict):
        raise ExperimentInputError("task_split is required")
    pool_size = _count(task_split.get("total_count"), "task_split.total_count", minimum=500)
    split_counts = {
        "train": _count(task_split.get("train_count"), "task_split.train_count", minimum=1),
        "validation": _count(task_split.get("validation_count"), "task_split.validation_count", minimum=1),
        "test": _count(task_split.get("test_count"), "task_split.test_count", minimum=1),
    }
    if sum(split_counts.values()) != pool_size:
        raise ExperimentInputError("task split counts must sum to total_count")
    expected_counts = {
        "train": math.floor(pool_size * 0.8),
        "validation": math.floor(pool_size * 0.1),
        "test": pool_size - math.floor(pool_size * 0.8) - math.floor(pool_size * 0.1),
    }
    if split_counts != expected_counts:
        raise ExperimentInputError("task split counts must follow the frozen 80/10/10 allocation rule")
    split_digests = {}
    for name in ("train", "validation", "test"):
        digest = task_split.get(f"{name}_task_ids_sha256")
        if not _is_sha256(digest):
            raise ExperimentInputError(f"task_split.{name}_task_ids_sha256 must be a SHA-256 digest")
        split_digests[name] = digest
    if eval_size != split_counts["test"]:
        raise ExperimentInputError("frozen evaluation size must match the frozen test split size")
    if record.get("task_split") != task_split:
        raise ExperimentInputError("task_split must exactly match the pre-registration record")

    policies = document.get("policy_versions")
    if not isinstance(policies, dict):
        raise ExperimentInputError("policy_versions must be an object")
    for field in ("quality", "disclosure"):
        if not isinstance(policies.get(field), str) or not policies[field].strip():
            raise ExperimentInputError(f"policy_versions.{field} is required")
    if record.get("policy_versions") != policies:
        raise ExperimentInputError("policy_versions must exactly match the pre-registration record")

    exclusions = document.get("exclusions")
    if not isinstance(exclusions, list):
        raise ExperimentInputError("exclusions must be a list; use an empty list only after confirming none")
    for index, exclusion in enumerate(exclusions):
        if not isinstance(exclusion, dict):
            raise ExperimentInputError(f"exclusions[{index}] must be an object")
        for field in ("item", "reason"):
            if not isinstance(exclusion.get(field), str) or not exclusion[field].strip():
                raise ExperimentInputError(f"exclusions[{index}].{field} is required")

    arms = document.get("arms")
    if not isinstance(arms, dict) or set(arms) != set(EXPECTED_ARMS):
        raise ExperimentInputError("both sft_only and response_distill arms are required; no additional arms are allowed")
    normalized_arms = {}
    all_task_digests = set()
    for arm_id in EXPECTED_ARMS:
        arm = arms[arm_id]
        label = f"arms.{arm_id}"
        if not isinstance(arm, dict):
            raise ExperimentInputError(f"{label} must be an object")
        for field in ("student_base_sha256", "tokenizer_sha256", "training_recipe_sha256"):
            if arm.get(field) != model_lineage[field]:
                raise ExperimentInputError(f"{label}.{field} must match the pre-registered model lineage")
        if arm.get("eval_set_sha256") != frozen_eval["sha256"] or arm.get("eval_set_size") != eval_size:
            raise ExperimentInputError(f"{label} must use the exact frozen evaluation digest and size")
        task_digest = arm.get("training_task_ids_sha256")
        if not _is_sha256(task_digest):
            raise ExperimentInputError(f"{label}.training_task_ids_sha256 must be a SHA-256 digest")
        all_task_digests.add(task_digest)
        training_count = _count(arm.get("training_item_count"), f"{label}.training_item_count", minimum=1)
        if training_count != split_counts["train"]:
            raise ExperimentInputError(f"{label}.training_item_count must match task_split.train_count")
        if task_digest != split_digests["train"]:
            raise ExperimentInputError(f"{label}.training_task_ids_sha256 must match the frozen train split")
        _count(arm.get("training_token_count"), f"{label}.training_token_count", minimum=1)
        seed_rows = arm.get("seed_results")
        if not isinstance(seed_rows, list) or len(seed_rows) != 2:
            raise ExperimentInputError(f"{label}.seed_results must contain exactly two pre-registered seeds")
        seeds = [_read_seed_result(row, f"{label}.seed_results[{index}]", eval_size)
                 for index, row in enumerate(seed_rows)]
        if len({str(row["seed"]) for row in seeds}) != 2:
            raise ExperimentInputError(f"{label} must use two distinct seeds")
        for index, row in enumerate(seeds):
            if not _is_sha256(row["student_checkpoint_sha256"]):
                raise ExperimentInputError(f"{label}.seed_results[{index}].student_checkpoint_sha256 is required")
            if not _is_sha256(row["evaluation_evidence_sha256"]):
                raise ExperimentInputError(f"{label}.seed_results[{index}].evaluation_evidence_sha256 is required")
        adjudication = arm.get("human_adjudication")
        if not isinstance(adjudication, dict):
            raise ExperimentInputError(f"{label}.human_adjudication is required")
        _count(adjudication.get("sample_size"), f"{label}.human_adjudication.sample_size", minimum=30)
        if adjudication.get("reviewer_count") != 2 or adjudication.get("blind_to_arm") is not True:
            raise ExperimentInputError(f"{label} requires two reviewers and blind-to-arm adjudication")
        passed = adjudication.get("passed")
        if type(passed) is not bool:
            raise ExperimentInputError(f"{label}.human_adjudication.passed must be a boolean")
        actual_total, costs = _read_costs(arm, label)
        normalized_arms[arm_id] = {
            "training_item_count": training_count,
            "training_token_count": arm["training_token_count"],
            "training_task_ids_sha256": task_digest,
            "seeds": seeds,
            "human_adjudication": {
                "sample_size": adjudication["sample_size"],
                "reviewer_count": 2,
                "blind_to_arm": True,
                "passed": passed,
            },
            "actual_cost_usd": actual_total,
            "cost_categories_usd": costs,
        }
    if len(all_task_digests) != 1:
        raise ExperimentInputError("the arms must use the same frozen training task IDs")
    if normalized_arms["sft_only"]["training_item_count"] != normalized_arms["response_distill"]["training_item_count"]:
        raise ExperimentInputError("the arms must contain the same number of training items")
    if {str(seed["seed"]) for seed in normalized_arms["sft_only"]["seeds"]} != {str(seed["seed"]) for seed in normalized_arms["response_distill"]["seeds"]}:
        raise ExperimentInputError("the arms must use the same two seed identifiers")

    baseline = normalized_arms["sft_only"]
    treatment = normalized_arms["response_distill"]
    baseline_total = baseline["actual_cost_usd"]
    treatment_total = treatment["actual_cost_usd"]
    combined_total = baseline_total + treatment_total
    if baseline_total <= 0:
        raise ExperimentInputError("baseline actual cost must be positive to calculate cost ratio")
    if combined_total <= 0:
        raise ExperimentInputError("combined actual cost must be positive")

    baseline_by_seed = {str(row["seed"]): row for row in baseline["seeds"]}
    treatment_by_seed = {str(row["seed"]): row for row in treatment["seeds"]}
    seed_deltas = []
    for seed in sorted(baseline_by_seed):
        base, trained = baseline_by_seed[seed], treatment_by_seed[seed]
        seed_deltas.append({
            "seed": base["seed"],
            "executable_correctness_delta": trained["executable_correctness"] - base["executable_correctness"],
            "security_pass_rate_delta": trained["security_pass_rate"] - base["security_pass_rate"],
            "conversation_quality_delta": trained["conversation_quality"] - base["conversation_quality"],
        })
    mean_exec_delta = sum(row["executable_correctness_delta"] for row in seed_deltas) / len(seed_deltas)
    mean_security_delta = sum(row["security_pass_rate_delta"] for row in seed_deltas) / len(seed_deltas)
    mean_conversation_delta = sum(row["conversation_quality_delta"] for row in seed_deltas) / len(seed_deltas)
    seed_exec_deltas = [row["executable_correctness_delta"] for row in seed_deltas]
    seed_spread = max(seed_exec_deltas) - min(seed_exec_deltas)
    cost_ratio = treatment_total / baseline_total
    allowed_cost_ratio = 5.0 if mean_exec_delta >= 0.05 else 3.0

    reasons: list[str] = []
    decision = "inconclusive"
    if combined_total > budget:
        decision = "reject"
        reasons.append("combined actual cost exceeded the pre-registered ceiling")
    elif not baseline["human_adjudication"]["passed"] or not treatment["human_adjudication"]["passed"]:
        decision = "reject"
        reasons.append("blind human adjudication failed in at least one arm")
    elif any(row["security_pass_rate_delta"] < 0 for row in seed_deltas):
        decision = "reject"
        reasons.append("security pass rate regressed on at least one matched seed")
    elif mean_exec_delta <= 0 and cost_ratio > 1.0:
        decision = "reject"
        reasons.append("executable correctness did not improve and response distillation cost more")
    elif mean_exec_delta >= 0.02 and any(delta <= 0 for delta in seed_exec_deltas):
        decision = "reject"
        reasons.append("the executable-correctness win disappeared on seed resampling")
    elif mean_exec_delta < 0.02 and mean_conversation_delta > 0:
        decision = "reject"
        reasons.append("the measured gain was limited to conversation quality, below the executable-correctness threshold")
    elif seed_spread > 0.02:
        reasons.append("matched-seed executable-correctness deltas disagree by more than 0.02")
    elif mean_exec_delta < 0.02 and cost_ratio > 3.0:
        decision = "reject"
        reasons.append("response distillation did not meet the correctness threshold and exceeded 3x cost")
    elif mean_exec_delta >= 0.05 and cost_ratio > 5.0:
        decision = "reject"
        reasons.append("the cost ratio exceeded 5x despite the higher correctness gain")
    elif mean_exec_delta >= 0.02 and mean_security_delta >= 0 and all(
        abs(delta - mean_exec_delta) <= 0.01 and delta >= 0.02 for delta in seed_exec_deltas
    ) and cost_ratio <= allowed_cost_ratio:
        decision = "admit"
        reasons.append("both matched seeds meet the correctness, reproducibility, security, cost, and adjudication gates")
    else:
        reasons.append("one or more admission thresholds were not met; record as inconclusive unless a rejection rule above applies")

    return {
        "schema_version": "guru-code-experiment-decision-v1",
        "experiment_id": EXPERIMENT_ID,
        "decision_rule_version": DECISION_RULE_VERSION,
        "pre_registration_sha256": prereg["sha256"],
        "model_lineage": model_lineage,
        "frozen_eval_set": {"id": frozen_eval["id"], "sha256": frozen_eval["sha256"], "size": eval_size},
        "task_split": {"total_count": pool_size, **split_counts, **{f"{name}_task_ids_sha256": digest for name, digest in split_digests.items()}},
        "decision": decision,
        "metrics": {
            "executable_correctness_delta": mean_exec_delta,
            "security_pass_rate_delta": mean_security_delta,
            "conversation_quality_delta": mean_conversation_delta,
            "matched_seed_deltas": seed_deltas,
            "seed_executable_delta_spread": seed_spread,
            "baseline_actual_cost_usd": baseline_total,
            "response_distill_actual_cost_usd": treatment_total,
            "combined_actual_cost_usd": combined_total,
            "cost_ratio": cost_ratio,
            "allowed_cost_ratio": allowed_cost_ratio,
            "budget_ceiling_usd": budget,
            "cost_per_absolute_correctness_point_usd": (
                (treatment_total - baseline_total) / mean_exec_delta if mean_exec_delta > 0 else None
            ),
        },
        "arms": normalized_arms,
        "reasons": reasons,
        "limitations": [
            "This decision applies only to the exact preregistration, student, policies, and frozen evaluation digest in the input.",
            "Owner signatures and evidence references are recorded assertions; this utility does not authenticate or resolve them.",
            "The decision does not qualify a Guru-Code checkpoint for Maataa or authorize deployment or spending.",
        ],
    }


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ExperimentInputError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate completed response-distillation experiment evidence")
    parser.add_argument("results", type=Path, help="completed guru-code-experiment-results-v1 JSON")
    parser.add_argument("--output", type=Path, help="write decision JSON to this path; default is stdout")
    args = parser.parse_args(argv)
    try:
        raw = args.results.read_bytes()
        if len(raw) > 10 * 1024 * 1024:
            raise ExperimentInputError("result file exceeds 10 MiB")
        document = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                              parse_constant=lambda value: (_ for _ in ()).throw(ExperimentInputError(f"invalid JSON number {value}")))
        decision = evaluate_results(document)
        output = json.dumps(decision, indent=2, sort_keys=True, allow_nan=False) + "\n"
        if args.output:
            if args.output.exists():
                raise ExperimentInputError(f"refusing to overwrite existing decision file: {args.output}")
            args.output.parent.mkdir(parents=True, exist_ok=True)
            temporary = args.output.with_name(args.output.name + ".tmp")
            if temporary.exists():
                raise ExperimentInputError(f"refusing to overwrite existing temporary file: {temporary}")
            temporary.write_text(output, encoding="utf-8")
            temporary.replace(args.output)
        else:
            sys.stdout.write(output)
        return 0
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ExperimentInputError) as exc:
        sys.stderr.write(f"experiment decision refused: {exc}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
