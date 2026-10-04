"""Audited quality admission and sequential batch sampling."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from typing import Sequence

from scipy.stats import beta

from guru.audit_log import append_audit_line
from guru.schemas.quality import (
    AdmissionDecision, AutoCheckName, AutoCheckResult, BatchAdmission,
    HumanReviewRecord, ItemAdmission, QualityTier, REQUIRED_AUTO_CHECKS,
)

AUDIT_PATH = Path(__file__).resolve().parents[2] / "audit" / "quality.jsonl"
POLICY: dict[str, float | int] = {
    "target_failure": 0.02,
    "hard_ceiling": 0.05,
    "window": 25,
    "min_sample": 50,
    "max_sample": 200,
    "confidence_level": 0.95,
}
SENSITIVE_KEYWORDS = frozenset({
    "auth", "secret", "token", "sandbox", "eval", "license", "password", "crypto", "permission",
})


class QualityInputError(ValueError):
    """An admission input cannot be evaluated safely."""


def _payload_digest(value: object) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _audit(event: str, *, payload_digest: str, fields: dict) -> None:
    append_audit_line(AUDIT_PATH, event=event, payload_digest=payload_digest, fields=fields)


def classify_tier(*, executable: bool, security_relevant: bool, license_ambiguous: bool) -> QualityTier:
    if any(type(value) is not bool for value in (executable, security_relevant, license_ambiguous)):
        raise QualityInputError("tier classification inputs must be booleans")
    if security_relevant or license_ambiguous:
        return QualityTier.A
    if executable:
        return QualityTier.B
    return QualityTier.C


def promote_if_sensitive(tier: QualityTier, text: str) -> QualityTier:
    try:
        tier = QualityTier(tier)
    except ValueError as exc:
        raise QualityInputError("tier must be A, B, or C") from exc
    if not isinstance(text, str):
        raise QualityInputError("sensitivity text must be a string")
    words = {word.casefold() for word in re.findall(r"[A-Za-z]+", text)}
    return QualityTier.A if words & SENSITIVE_KEYWORDS else tier


def item_decision(*, item_id: str, tier: QualityTier, auto_checks: Sequence[AutoCheckResult | dict],
                  human_review: HumanReviewRecord | dict | None) -> ItemAdmission:
    if not isinstance(item_id, str) or not item_id.strip():
        raise QualityInputError("item_id must be non-empty")
    try:
        tier = QualityTier(tier)
    except ValueError as exc:
        raise QualityInputError("tier must be A, B, or C") from exc
    checks = [check if isinstance(check, AutoCheckResult) else AutoCheckResult.model_validate(check)
              for check in auto_checks]
    if {check.name for check in checks} != REQUIRED_AUTO_CHECKS or len(checks) != len(REQUIRED_AUTO_CHECKS):
        raise QualityInputError("all eight unique automatic checks are required")
    review = (human_review if isinstance(human_review, HumanReviewRecord)
              else HumanReviewRecord.model_validate(human_review) if human_review is not None else None)
    if review is not None and review.tier is not tier:
        raise QualityInputError("human review tier must match the item tier")
    failed_checks = [check.name.value for check in checks if not check.passed]
    if failed_checks:
        decision = AdmissionDecision.QUARANTINE if tier is QualityTier.C else AdmissionDecision.REJECT
        reasons = [f"failed_auto_check:{name}" for name in failed_checks]
    elif tier is QualityTier.A:
        if review is None or not review.accepted:
            decision, reasons = AdmissionDecision.REJECT, ["tier_a_requires_accepted_human_review"]
        else:
            decision, reasons = AdmissionDecision.ADMIT, ["tier_a_review_accepted"]
    elif tier is QualityTier.B:
        if review is None:
            decision, reasons = AdmissionDecision.ADMIT_WITH_FOLLOWUP, ["tier_b_followup_required"]
        elif not review.accepted:
            decision, reasons = AdmissionDecision.REJECT, ["tier_b_review_rejected"]
        else:
            decision, reasons = AdmissionDecision.ADMIT, ["tier_b_review_accepted"]
    elif review is not None and not review.accepted:
        decision, reasons = AdmissionDecision.REJECT, ["tier_c_review_rejected"]
    else:
        decision, reasons = AdmissionDecision.ADMIT, ["tier_c_auto_admit"]
    decision_record = {
        "item_id": item_id, "tier": tier.value, "decision": decision.value,
        "failed_checks": failed_checks,
        "check_digests": sorted(check.evidence_digest for check in checks if check.evidence_digest),
        "reviewer_id": review.reviewer_id if review else None,
        "review_accepted": review.accepted if review else None,
    }
    digest = _payload_digest(decision_record)
    result = ItemAdmission(
        item_id=item_id, tier=tier, auto_checks=checks, human_review=review,
        decision=decision, reason_codes=reasons,
        decided_at=datetime.now(timezone.utc),
    )
    _audit("item_admission", payload_digest=digest, fields={
        "item_id": item_id, "tier": tier.value, "decision": decision.value,
        "reason_codes": reasons, "failed_check_count": len(failed_checks),
    })
    return result


def _upper_confidence_bound(failures: int, sample_count: int, confidence_level: float) -> float:
    if sample_count == 0:
        return 1.0
    if failures == sample_count:
        return 1.0
    return float(beta.ppf(confidence_level, failures + 1, sample_count - failures))


def batch_decision(*, batch_id: str, teacher_ids: Sequence[str], item_count: int,
                   tier_mix: dict[QualityTier | str, int],
                   outcomes: Sequence[ItemAdmission | AdmissionDecision | str]) -> BatchAdmission:
    if not isinstance(batch_id, str) or not batch_id.strip() or type(item_count) is not int or item_count < 0:
        raise QualityInputError("batch_id must be non-empty and item_count non-negative")
    normalized: list[AdmissionDecision] = []
    for outcome in outcomes:
        try:
            decision = outcome.decision if isinstance(outcome, ItemAdmission) else AdmissionDecision(outcome)
        except (ValueError, TypeError) as exc:
            raise QualityInputError("outcomes contain an unknown admission decision") from exc
        if decision is AdmissionDecision.CONTINUE:
            raise QualityInputError("batch outcomes must be item-level decisions, not CONTINUE")
        normalized.append(decision)
    sample = normalized[:min(len(normalized), item_count, int(POLICY["max_sample"]))]
    failed = sum(decision in {AdmissionDecision.REJECT, AdmissionDecision.QUARANTINE} for decision in sample)
    n = len(sample)
    rate = failed / n if n else 0.0
    ucb = _upper_confidence_bound(failed, n, float(POLICY["confidence_level"]))
    hard = float(POLICY["hard_ceiling"])
    window = int(POLICY["window"])
    window_exceeded = any(
        sum(decision in {AdmissionDecision.REJECT, AdmissionDecision.QUARANTINE}
            for decision in sample[start:start + window]) / window > hard
        for start in range(0, n - window + 1)
    )
    if window_exceeded or (n > 0 and rate >= hard):
        decision, reasons = AdmissionDecision.REJECT, ["observed_failure_rate_at_or_above_hard_ceiling"]
    elif n >= int(POLICY["min_sample"]) and ucb <= hard:
        decision, reasons = AdmissionDecision.ADMIT, ["upper_confidence_bound_within_hard_ceiling"]
    elif n >= int(POLICY["max_sample"]) and ucb > hard:
        decision, reasons = AdmissionDecision.REJECT, ["upper_confidence_bound_above_hard_ceiling_at_max_sample"]
    else:
        decision, reasons = AdmissionDecision.CONTINUE, ["sequential_sample_is_inconclusive"]
    if not isinstance(tier_mix, dict):
        raise QualityInputError("tier_mix must map A, B, or C to counts")
    try:
        normalized_tier_mix = {QualityTier(key): int(value) for key, value in tier_mix.items()}
    except (TypeError, ValueError) as exc:
        raise QualityInputError("tier_mix must map A, B, or C to counts") from exc
    if any(type(value) is not int or value < 0 for value in tier_mix.values()):
        raise QualityInputError("tier_mix counts must be non-negative integers")
    if sum(tier_mix.values()) != item_count:
        raise QualityInputError("tier_mix counts must sum to item_count")
    if any(not isinstance(teacher_id, str) or not teacher_id.strip() for teacher_id in teacher_ids):
        raise QualityInputError("teacher_ids must contain non-empty strings")
    record = {
        "batch_id": batch_id, "teacher_ids": list(teacher_ids), "item_count": item_count,
        "tier_mix": {tier.value: count for tier, count in normalized_tier_mix.items()},
        "sample_count": n, "failure_count": failed, "decision": decision.value,
    }
    digest = _payload_digest(record)
    result = BatchAdmission(
        **record, observed_failure_rate=rate, upper_confidence_bound=ucb,
        reason_codes=reasons, policy=dict(POLICY), decided_at=datetime.now(timezone.utc),
    )
    _audit("batch_admission", payload_digest=digest, fields={
        "batch_id": batch_id, "decision": decision.value, "sample_count": n,
        "failure_count": failed, "observed_failure_rate": rate,
        "upper_confidence_bound": ucb, "reason_codes": reasons,
    })
    return result
