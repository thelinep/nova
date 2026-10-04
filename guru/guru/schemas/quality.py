"""Automated and human corpus quality admission records."""
from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import Field, field_validator, model_validator

from .teacher_lineage import StrictModel


class QualityTier(str, Enum):
    A = "A"
    B = "B"
    C = "C"


class AutoCheckName(str, Enum):
    SCHEMA = "schema"
    SYNTAX = "syntax"
    TESTS = "tests"
    SECURITY = "security"
    LICENSE = "license"
    PROVENANCE = "provenance"
    DUPLICATE = "duplicate"
    LEAKAGE = "leakage"


REQUIRED_AUTO_CHECKS: frozenset[AutoCheckName] = frozenset(AutoCheckName)


class AdmissionDecision(str, Enum):
    ADMIT = "admit"
    ADMIT_WITH_FOLLOWUP = "admit_with_followup"
    REJECT = "reject"
    QUARANTINE = "quarantine"
    CONTINUE = "continue"


class AutoCheckResult(StrictModel):
    name: AutoCheckName
    passed: bool
    evidence_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    detail_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class HumanReviewRecord(StrictModel):
    reviewer_id: str = Field(min_length=1)
    tier: QualityTier = QualityTier.A
    accepted: bool
    reviewed_at: datetime
    notes_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class ItemAdmission(StrictModel):
    item_id: str = Field(min_length=1)
    tier: QualityTier
    auto_checks: list[AutoCheckResult]
    human_review: HumanReviewRecord | None = None
    decision: AdmissionDecision
    reason_codes: list[str] = Field(default_factory=list)
    policy_version: str = "quality-v1"
    item_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    decided_at: datetime | None = None

    @field_validator("auto_checks")
    @classmethod
    def all_required_checks_present(cls, checks: list[AutoCheckResult]) -> list[AutoCheckResult]:
        names = [check.name for check in checks]
        if len(names) != len(set(names)) or set(names) != REQUIRED_AUTO_CHECKS:
            raise ValueError("auto_checks must contain each of the 8 required names exactly once")
        return checks


class BatchAdmission(StrictModel):
    batch_id: str = Field(min_length=1)
    teacher_ids: list[str] = Field(default_factory=list)
    item_count: int = Field(ge=0)
    tier_mix: dict[QualityTier, int] = Field(default_factory=dict)
    sample_count: int = Field(ge=0)
    failure_count: int = Field(ge=0)
    observed_failure_rate: float = Field(ge=0, le=1)
    upper_confidence_bound: float = Field(ge=0, le=1)
    decision: AdmissionDecision
    reason_codes: list[str] = Field(default_factory=list)
    policy: dict[str, float | int] = Field(default_factory=dict)
    decided_at: datetime | None = None

    @model_validator(mode="after")
    def coherent_counts(self) -> BatchAdmission:
        if self.failure_count > self.sample_count:
            raise ValueError("failure_count cannot exceed sample_count")
        return self
