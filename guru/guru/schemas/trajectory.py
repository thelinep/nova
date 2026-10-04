"""Auditable multi-agent coding trajectory schemas."""
from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import Field, field_validator, model_validator

from .teacher_lineage import StrictModel


class Role(str, Enum):
    PLANNER = "planner"
    CODER = "coder"
    TESTER = "tester"
    REVIEWER = "reviewer"
    SUPERVISOR = "supervisor"
    HUMAN = "human"


class ActionType(str, Enum):
    MESSAGE = "message"
    TOOL_CALL = "tool_call"
    PATCH = "patch"
    EVIDENCE = "evidence"
    DECISION = "decision"


class FinalOutcome(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    QUARANTINED = "quarantined"


class ProjectSnapshot(StrictModel):
    repository_id: str = Field(min_length=1)
    revision: str = Field(min_length=1)
    snapshot_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    file_digests: dict[str, str] = Field(default_factory=dict)


class AcceptanceCheck(StrictModel):
    check_id: str = Field(min_length=1)
    description: str = Field(min_length=1)
    required: bool = True
    evidence_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class ToolCall(StrictModel):
    tool_name: str = Field(min_length=1)
    input_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    output_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    exit_code: int | None = None


class Evidence(StrictModel):
    evidence_type: str = Field(min_length=1)
    digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    artifact_ref: str | None = None


class Turn(StrictModel):
    turn_index: int = Field(ge=0)
    role: Role
    action_type: ActionType
    content: str = ""
    model_id: str | None = None
    model_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    prompt_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    tool_call: ToolCall | None = None
    patch_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    evidence: list[Evidence] = Field(default_factory=list)

    @field_validator("content")
    @classmethod
    def reject_private_reasoning(cls, value: str) -> str:
        lowered = value.casefold()
        for phrase in ("<thinking>", "chain of thought:", "internal reasoning:"):
            if phrase in lowered:
                raise ValueError("turn content must not include private chain-of-thought text")
        return value


class HumanAdjudication(StrictModel):
    required: bool = True
    decision: FinalOutcome | None = None
    reviewer_id: str | None = None
    decided_at: datetime | None = None
    notes_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def decision_has_reviewer(self) -> HumanAdjudication:
        if self.decision not in (None, FinalOutcome.PENDING) and (not self.reviewer_id or self.decided_at is None):
            raise ValueError("a decided HumanAdjudication requires reviewer_id and decided_at")
        return self


class TrainingEligibility(StrictModel):
    eligible: bool = False
    reason_codes: list[str] = Field(default_factory=list)
    policy_version: str = ""


class Trajectory(StrictModel):
    trajectory_id: str = Field(min_length=1)
    project_snapshot: ProjectSnapshot
    acceptance_checks: list[AcceptanceCheck] = Field(default_factory=list)
    turns: list[Turn] = Field(min_length=1)
    human_adjudication: HumanAdjudication = Field(default_factory=HumanAdjudication)
    final_outcome: FinalOutcome = FinalOutcome.PENDING
    training_eligibility: TrainingEligibility = Field(default_factory=TrainingEligibility)
    leakage_group: str | None = None
    created_at: datetime | None = None

    @model_validator(mode="after")
    def validate_order_and_approval(self) -> Trajectory:
        indices = [turn.turn_index for turn in self.turns]
        if len(indices) != len(set(indices)) or indices != sorted(indices):
            raise ValueError("turn_index values must be unique and monotonically increasing")
        if (self.final_outcome is FinalOutcome.APPROVED and self.human_adjudication.required
                and self.human_adjudication.decision is not FinalOutcome.APPROVED):
            raise ValueError("APPROVED final_outcome requires an approved HumanAdjudication")
        return self
