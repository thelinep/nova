"""Input disclosure decisions for remote teacher calls."""
from __future__ import annotations

from enum import Enum

from pydantic import Field, model_validator

from .teacher_lineage import InputType, StrictModel


class Decision(str, Enum):
    ALLOW = "allow"
    ALLOW_WITH_REDACTION = "allow_with_redaction"
    DENY = "deny"


class Reason(str, Enum):
    TEACHER_NOT_APPROVED = "teacher_not_approved"
    INPUT_TYPE_NOT_ALLOWED = "input_type_not_allowed"
    CONFIDENTIALITY_NO_APPROVER = "confidentiality_no_approver"
    PROVIDER_TRAINS_ON_INPUTS = "provider_trains_on_inputs"
    RETENTION_UNBOUNDED = "retention_unbounded"
    LOGGING_NOT_ALLOWED = "logging_not_allowed"


class Classification(str, Enum):
    PUBLIC = "public"
    INTERNAL = "internal"
    CONFIDENTIAL = "confidential"
    PII = "pii"
    SECRETS = "secrets"


class DisclosureRequest(StrictModel):
    request_id: str = Field(min_length=1)
    input_type: InputType
    classification: Classification = Classification.PUBLIC
    payload_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    confidentiality_required: bool = False
    provider_trains_on_inputs: bool | None = None
    retention_bounded: bool | None = None
    logging_allowed: bool | None = None


class RedactionAction(StrictModel):
    kind: str = Field(min_length=1)
    location: str = Field(min_length=1)
    replacement: str = Field(min_length=1)


class DisclosureDecision(StrictModel):
    request_id: str
    teacher_id: str
    decision: Decision
    reasons: list[Reason] = Field(default_factory=list)
    redactions: list[RedactionAction] = Field(default_factory=list)
    policy_version: str = "disclosure-v1"
    payload_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def denied_needs_reason(self) -> DisclosureDecision:
        if self.decision is Decision.DENY and not self.reasons:
            raise ValueError("DENY must include at least one Reason")
        return self
