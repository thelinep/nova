from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import AbstractSet, Any
import unittest
from unittest.mock import patch

from guru.quality.gate import batch_decision, classify_tier, item_decision, promote_if_sensitive
from guru.schemas.quality import AdmissionDecision, AutoCheckName, ItemAdmission, QualityTier
from guru.schemas.experiment import Arm, ArmResult, CostLine, EvalMetrics, Experiment, REQUIRED_COST_CATEGORIES
from guru.quality.calibration import track_reviewer_agreement
from pydantic import ValidationError


def checks(*, failed: AbstractSet[AutoCheckName] = frozenset()) -> list[dict[str, Any]]:
    return [{"name": name, "passed": name not in failed, "item_digest": "b" * 64,
             "evidence_digest": "c" * 64}
            for name in AutoCheckName]


def review(accepted: bool = True, tier: QualityTier = QualityTier.A) -> dict[str, Any]:
    return {"reviewer_id": "reviewer-1", "tier": tier, "accepted": accepted,
            "reviewed_at": datetime(2026, 1, 1, tzinfo=timezone.utc)}


class QualityGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = TemporaryDirectory()
        self.audit_path = Path(self.temp.name) / "quality.jsonl"
        self.audit = patch("guru.quality.gate.AUDIT_PATH", self.audit_path)
        self.audit.start()
        self.addCleanup(self.audit.stop)
        self.addCleanup(self.temp.cleanup)

    def test_tier_a_requires_accepted_review(self) -> None:
        self.assertEqual(item_decision(item_id="a", item_digest="b" * 64, tier=QualityTier.A, auto_checks=checks(),
                                       human_review=None).decision, AdmissionDecision.REJECT)
        self.assertEqual(item_decision(item_id="b", item_digest="b" * 64, tier=QualityTier.A, auto_checks=checks(),
                                       human_review=review(True)).decision, AdmissionDecision.ADMIT)

    def test_tier_b_followup_and_rejected_review_paths(self) -> None:
        pending = item_decision(item_id="b1", item_digest="b" * 64, tier=QualityTier.B, auto_checks=checks(), human_review=None)
        rejected = item_decision(item_id="b2", item_digest="b" * 64, tier=QualityTier.B, auto_checks=checks(),
                                  human_review=review(False, QualityTier.B))
        self.assertEqual(pending.decision, AdmissionDecision.ADMIT_WITH_FOLLOWUP)
        self.assertEqual(rejected.decision, AdmissionDecision.REJECT)

    def test_tier_c_auto_admits(self) -> None:
        result = item_decision(item_id="c", item_digest="b" * 64, tier=QualityTier.C, auto_checks=checks(), human_review=None)
        self.assertEqual(result.decision, AdmissionDecision.ADMIT)

    def test_failed_auto_check_rejects_a_b_and_quarantines_c(self) -> None:
        failed = {AutoCheckName.SECURITY}
        self.assertEqual(item_decision(item_id="a", item_digest="b" * 64, tier=QualityTier.A,
                                       auto_checks=checks(failed=failed), human_review=review()).decision,
                         AdmissionDecision.REJECT)
        self.assertEqual(item_decision(item_id="b", item_digest="b" * 64, tier=QualityTier.B,
                                       auto_checks=checks(failed=failed), human_review=None).decision,
                         AdmissionDecision.REJECT)
        self.assertEqual(item_decision(item_id="c", item_digest="b" * 64, tier=QualityTier.C,
                                       auto_checks=checks(failed=failed), human_review=None).decision,
                         AdmissionDecision.QUARANTINE)

    def test_sensitive_keyword_promotes_to_tier_a(self) -> None:
        self.assertIs(promote_if_sensitive(QualityTier.C, "review the sandbox token"), QualityTier.A)
        self.assertIs(classify_tier(executable=True, security_relevant=False, license_ambiguous=False), QualityTier.B)

    def test_batch_rejects_when_window_failure_rate_exceeds_ceiling(self) -> None:
        outcomes = [AdmissionDecision.REJECT, AdmissionDecision.REJECT] + [AdmissionDecision.ADMIT] * 23
        result = batch_decision(batch_id="window", teacher_ids=["t1"], item_count=25,
                                tier_mix={QualityTier.B: 25}, outcomes=outcomes)
        self.assertEqual(result.decision, AdmissionDecision.REJECT)

    def test_batch_accepts_when_upper_bound_is_below_ceiling(self) -> None:
        result = batch_decision(batch_id="accept", teacher_ids=["t1"], item_count=60,
                                tier_mix={QualityTier.C: 60}, outcomes=[AdmissionDecision.ADMIT] * 60)
        self.assertEqual(result.decision, AdmissionDecision.ADMIT)
        self.assertLessEqual(result.upper_confidence_bound, 0.05)

    def test_batch_continues_when_sample_is_inconclusive(self) -> None:
        outcomes = [AdmissionDecision.REJECT] + [AdmissionDecision.ADMIT] * 49
        result = batch_decision(batch_id="continue", teacher_ids=["t1"], item_count=50,
                                tier_mix={QualityTier.B: 50}, outcomes=outcomes)
        self.assertEqual(result.decision, AdmissionDecision.CONTINUE)

    def test_all_decisions_are_logged_without_item_content(self) -> None:
        path = Path(self.temp.name) / "quality.jsonl"
        decision = item_decision(item_id="item-7", item_digest="b" * 64, tier=QualityTier.C,
                                 auto_checks=checks(), human_review=None)
        records = [json.loads(line) for line in path.read_text().splitlines()]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["event"], "item_admission")
        self.assertRegex(records[0]["payload_digest"], r"^[0-9a-f]{64}$")
        self.assertEqual(records[0]["item_digest"], decision.item_digest)
        self.assertNotIn("prompt", path.read_text())

    def test_item_decision_requires_lowercase_sha256_content_digest(self) -> None:
        with self.assertRaisesRegex(ValueError, "item_digest"):
            item_decision(item_id="item", item_digest="not-a-digest", tier=QualityTier.C,
                          auto_checks=checks(), human_review=None)

    def test_item_decision_rejects_checks_bound_to_another_item(self) -> None:
        mismatched = checks()
        mismatched[0]["item_digest"] = "d" * 64
        with self.assertRaisesRegex(ValueError, "bind to the decision item_digest"):
            item_decision(item_id="item", item_digest="b" * 64, tier=QualityTier.C,
                          auto_checks=mismatched, human_review=None)
        self.assertFalse(self.audit_path.exists())

    def test_auto_check_schema_requires_an_item_binding(self) -> None:
        unbound = checks()
        for check in unbound:
            check.pop("item_digest")
        with self.assertRaises(ValidationError):
            item_decision(item_id="item", item_digest="b" * 64, tier=QualityTier.C,
                          auto_checks=unbound, human_review=None)

    def test_item_admission_schema_rejects_mismatched_check_bindings(self) -> None:
        with self.assertRaises(ValidationError):
            ItemAdmission(
                item_id="item", tier=QualityTier.C, auto_checks=checks(),
                decision=AdmissionDecision.ADMIT, item_digest="d" * 64,
            )

    def test_experiment_requires_every_cost_and_baseline_arm(self) -> None:
        costs = {name: CostLine(amount=None, not_applicable_reason="not incurred")
                 for name in REQUIRED_COST_CATEGORIES}
        result = ArmResult(arm=Arm.BASELINE, costs=costs,
                           metrics=EvalMetrics(case_count=0, passed=0, failed=0))
        with self.assertRaises(ValidationError):
            ArmResult(arm=Arm.BASELINE, costs={"evaluation": costs["evaluation"]},
                      metrics=EvalMetrics(case_count=0, passed=0, failed=0))
        with self.assertRaises(ValidationError):
            Experiment(experiment_id="exp", arms={"treatment": result},
                       preregistration_digest="a" * 64, evaluation_digest="b" * 64,
                       policy_version="quality-v1")

    def test_calibration_flags_tier_b_acceptance_divergence_at_fifty_reviews(self) -> None:
        accepted = [{"reviewer_id": "accept-all", "tier": "B", "accepted": True,
                     "reviewed_at": "2026-01-01T00:00:00Z"} for _ in range(50)]
        rejected = [{"reviewer_id": "reject-all", "tier": "B", "accepted": False,
                     "reviewed_at": "2026-01-01T00:00:00Z"} for _ in range(50)]
        summary = track_reviewer_agreement(accepted + rejected)
        self.assertTrue(summary["accept-all"]["flagged"])
        self.assertTrue(summary["reject-all"]["flagged"])


if __name__ == "__main__":
    unittest.main()
