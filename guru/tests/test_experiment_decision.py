"""Deterministic tests for the draft response-distillation decision rules."""
import hashlib
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from guru.experiments.decision import (COST_CATEGORIES, ExperimentInputError,
                                       evaluate_results)
from guru.experiments.report import render_report


def sha(char):
    return char * 64


def model_lineage():
    return {
        "teacher_intake_sha256": sha("a"),
        "teacher_model_sha256": sha("b"),
        "teacher_adapter_sha256": None,
        "student_base_intake_sha256": sha("c"),
        "student_base_sha256": sha("d"),
        "tokenizer_sha256": sha("e"),
        "context_tokens": 4096,
        "training_recipe_sha256": sha("f"),
        "evaluator_image_sha256": sha("0"),
    }


def seed_result(seed, executable=30, security=10, conversation=0.6):
    return {
        "seed": seed,
        "student_checkpoint_sha256": sha("1" if seed == 11 else "2"),
        "evaluation_evidence_sha256": sha("3" if seed == 11 else "4"),
        "metrics": {
            "evaluation_cases": 50,
            "executable_correct": executable,
            "security_cases": 10,
            "security_pass": security,
            "lint_cases": 50,
            "lint_clean": 48,
            "regression_cases": 50,
            "regressions": 0,
            "conversation_quality": conversation,
        },
    }


def cost_lines(teacher_cost=None, estimate=9999):
    lines = {}
    for category in COST_CATEGORIES:
        if category == "teacher_inference" and teacher_cost is None:
            lines[category] = {
                "measured": True,
                "actual_usd": None,
                "not_applicable_reason": "The baseline makes no teacher calls.",
                "pre_registered_estimate_usd": None,
            }
        else:
            actual = teacher_cost if category == "teacher_inference" else 10
            lines[category] = {
                "measured": True,
                "actual_usd": actual,
                "evidence_sha256": sha("f"),
                "pre_registered_estimate_usd": estimate,
            }
    return lines


def arm(*, treatment=False, deltas=(3, 3), security=(10, 10),
        conversation=(0.6, 0.6), teacher_cost=None):
    start = 30
    seed_ids = (11, 22)
    return {
        "training_task_ids_sha256": sha("a"),
        "training_item_count": 400,
        "training_token_count": 50_000 if not treatment else 55_000,
        "student_base_sha256": model_lineage()["student_base_sha256"],
        "tokenizer_sha256": model_lineage()["tokenizer_sha256"],
        "training_recipe_sha256": model_lineage()["training_recipe_sha256"],
        "eval_set_sha256": sha("b"),
        "eval_set_size": 50,
        "seed_results": [
            seed_result(seed_ids[0], start + (deltas[0] if treatment else 0), security[0], conversation[0]),
            seed_result(seed_ids[1], start + (deltas[1] if treatment else 0), security[1], conversation[1]),
        ],
        "human_adjudication": {
            "sample_size": 30,
            "reviewer_count": 2,
            "blind_to_arm": True,
            "passed": True,
        },
        "costs": cost_lines(teacher_cost=teacher_cost),
    }


def result_document(**overrides):
    document = {
        "schema_version": "guru-code-experiment-results-v1",
        "experiment_id": "exp-rd-vs-sft-001",
        "status": "completed",
        "hypothesis": "A test hypothesis.",
        "pre_registration": {},
        "model_lineage": model_lineage(),
        "frozen_eval_set": {"id": "guru-eval-v1", "sha256": sha("b"), "size": 50,
                            "evaluator_image_sha256": model_lineage()["evaluator_image_sha256"]},
        "task_split": {
            "total_count": 500, "train_count": 400, "validation_count": 50, "test_count": 50,
            "train_task_ids_sha256": sha("a"),
            "validation_task_ids_sha256": sha("d"),
            "test_task_ids_sha256": sha("e"),
        },
        "policy_versions": {"quality": "quality-v0.1", "disclosure": "disclosure-v0.1"},
        "exclusions": [],
        "arms": {
        "sft_only": arm(deltas=(3, 3)),
            "response_distill": arm(treatment=True, deltas=(3, 3), teacher_cost=20),
        },
    }
    rule = {
                "correctness_gain_minimum": 0.02,
                "correctness_gain_for_5x_cost": 0.05,
                "cost_ratio_maximum": 3.0,
                "cost_ratio_maximum_for_5x": 5.0,
                "security_regression_allowed": 0.0,
                "matched_seed_tolerance": 0.01,
                "seed_disagreement_inconclusive_above": 0.02,
                "seed_count_per_arm": 2,
    }
    record = {
        "status": "pre_registered",
        "experiment_id": "exp-rd-vs-sft-001",
        "hypothesis": document["hypothesis"],
        "decision_rule_version": "rd-sft-v0.1-proposed",
        "decision_rule_owner_ratification_ref": "decision-rule-approval-1",
        "decision_rule": rule,
        "owner_signoff": {"owner": "owner", "approval_ref": "approval-1", "approved_at": "2026-10-04"},
        "budget_ceiling_usd": 500,
        "model_lineage": model_lineage(),
        "frozen_eval_set": document["frozen_eval_set"],
        "task_split": document["task_split"],
        "policy_versions": document["policy_versions"],
    }
    document["pre_registration"] = {
        **record,
        "sha256": hashlib.sha256(json.dumps(record, sort_keys=True, separators=(",", ":"),
                                  ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest(),
        "record": record,
    }
    for key, value in overrides.items():
        document[key] = value
    return document


class ExperimentDecisionTests(unittest.TestCase):
    def test_missing_cost_category_fails_validation(self):
        row = result_document()
        del row["arms"]["sft_only"]["costs"]["evaluation"]
        with self.assertRaisesRegex(ExperimentInputError, "evaluation"):
            evaluate_results(row)

    def test_empty_cost_requires_explicit_reason(self):
        row = result_document()
        row["arms"]["sft_only"]["costs"]["student_training"]["actual_usd"] = None
        row["arms"]["sft_only"]["costs"]["student_training"].pop("not_applicable_reason", None)
        with self.assertRaisesRegex(ExperimentInputError, "not_applicable_reason"):
            evaluate_results(row)

    def test_baseline_arm_is_required(self):
        row = result_document()
        del row["arms"]["sft_only"]
        with self.assertRaisesRegex(ExperimentInputError, "both sft_only"):
            evaluate_results(row)

    def test_frozen_eval_set_must_match_for_both_arms(self):
        row = result_document()
        row["arms"]["response_distill"]["eval_set_sha256"] = sha("d")
        with self.assertRaisesRegex(ExperimentInputError, "exact frozen evaluation"):
            evaluate_results(row)

    def test_model_artifacts_must_match_preregistered_lineage(self):
        row = result_document()
        row["arms"]["response_distill"]["training_recipe_sha256"] = sha("z")
        with self.assertRaisesRegex(ExperimentInputError, "pre-registered model lineage"):
            evaluate_results(row)

    def test_decision_admits_when_all_criteria_are_met(self):
        result = evaluate_results(result_document())
        self.assertEqual(result["decision"], "admit")
        self.assertAlmostEqual(result["metrics"]["executable_correctness_delta"], 0.06)
        self.assertEqual(result["metrics"]["cost_ratio"], 110 / 90)

    def test_decision_rejects_when_correctness_does_not_improve_and_cost_rises(self):
        row = result_document()
        row["arms"]["response_distill"] = arm(treatment=True, deltas=(0, 0), teacher_cost=200)
        self.assertEqual(evaluate_results(row)["decision"], "reject")

    def test_decision_rejects_on_security_regression(self):
        row = result_document()
        row["arms"]["response_distill"] = arm(treatment=True, deltas=(3, 3), security=(10, 9), teacher_cost=20)
        self.assertEqual(evaluate_results(row)["decision"], "reject")

    def test_decision_rejects_when_gain_only_appears_in_conversation_quality(self):
        row = result_document()
        row["arms"]["response_distill"] = arm(treatment=True, deltas=(0, 0), conversation=(0.9, 0.9), teacher_cost=0)
        self.assertEqual(evaluate_results(row)["decision"], "reject")

    def test_decision_rejects_when_seed_resampling_removes_a_mean_win(self):
        row = result_document()
        row["arms"]["response_distill"] = arm(treatment=True, deltas=(4, 0), teacher_cost=20)
        self.assertEqual(evaluate_results(row)["decision"], "reject")

    def test_marginal_cost_per_absolute_correctness_point(self):
        row = result_document()
        row["arms"]["response_distill"] = arm(treatment=True, deltas=(3, 3), teacher_cost=30)
        result = evaluate_results(row)
        self.assertAlmostEqual(result["metrics"]["cost_per_absolute_correctness_point_usd"], 500)

    def test_actual_cost_replaces_preregistered_estimate(self):
        row = result_document()
        row["arms"]["response_distill"]["costs"]["student_training"]["pre_registered_estimate_usd"] = 1_000_000
        result = evaluate_results(row)
        self.assertEqual(result["arms"]["response_distill"]["actual_cost_usd"], 110)

    def test_unratified_preregistration_cannot_produce_decision(self):
        row = result_document()
        row["pre_registration"]["status"] = "blocked_draft"
        row["pre_registration"]["record"]["status"] = "blocked_draft"
        row["pre_registration"]["sha256"] = hashlib.sha256(
            json.dumps(row["pre_registration"]["record"], sort_keys=True, separators=(",", ":"),
                       ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()
        with self.assertRaisesRegex(ExperimentInputError, "pre_registered"):
            evaluate_results(row)

    def test_pre_registration_digest_binds_exact_record(self):
        row = result_document()
        row["pre_registration"]["record"]["hypothesis"] = "silently altered"
        with self.assertRaisesRegex(ExperimentInputError, "does not match"):
            evaluate_results(row)

    def test_report_shows_decision_actuals_and_not_applicable_reason(self):
        row = result_document()
        rendered = render_report(row)
        self.assertIn("**Decision:** **ADMIT**", rendered)
        self.assertIn("preregistered estimates are retained only as planning records", rendered)
        self.assertIn("The baseline makes no teacher calls.", rendered)
        self.assertIn("Matched-seed results", rendered)


if __name__ == "__main__":
    unittest.main()
