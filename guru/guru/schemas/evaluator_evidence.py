"""Versioned, raw-output-free evidence for one evaluator case."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import Field, field_validator, model_validator

from .teacher_lineage import StrictModel


class CaseStatus(str, Enum):
    UNAVAILABLE = "unavailable"
    INFRASTRUCTURE_ERROR = "infrastructure_error"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"
    PASS = "pass"
    FAIL = "fail"


class ResourceLimits(StrictModel):
    timeout_ms: int = Field(gt=0, le=300_000)
    memory_bytes: int = Field(gt=0, le=8 * 1024**3)
    cpu_millis: int = Field(gt=0, le=8_000)
    pids: int = Field(gt=0, le=4_096)
    output_bytes: int = Field(gt=0, le=1024**2)
    input_bytes: int = Field(gt=0, le=16 * 1024**2)


class EvaluationCaseEvidence(StrictModel):
    """One immutable test-case outcome; stdout/stderr content is never stored."""

    schema_version: Literal["guru-evaluator-case-v2"] = "guru-evaluator-case-v2"
    case_id: str = Field(min_length=1, max_length=256)
    item_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    task_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    candidate_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    test_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    image_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    config_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    command: tuple[str, ...] = Field(min_length=1, max_length=64)
    limits: ResourceLimits
    started_at: datetime
    finished_at: datetime
    status: CaseStatus
    exit_code: int | None = Field(default=None, ge=-255, le=255)
    cleanup_confirmed: bool
    output_limited: bool = False
    stdout_truncated: bool = False
    stderr_truncated: bool = False
    stdout_bytes: int = Field(ge=0, le=1024**2)
    stderr_bytes: int = Field(ge=0, le=1024**2)
    stdout_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    stderr_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    previous_record_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    record_digest: str = Field(pattern=r"^[0-9a-f]{64}$")

    @field_validator("command")
    @classmethod
    def command_is_fixed_argv(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if any(not part or "\x00" in part for part in value):
            raise ValueError("command must contain non-empty argv strings without NUL")
        return value

    @model_validator(mode="after")
    def coherent_outcome(self) -> EvaluationCaseEvidence:
        if self.started_at.tzinfo is None or self.finished_at.tzinfo is None:
            raise ValueError("timestamps must be timezone-aware")
        if self.finished_at < self.started_at:
            raise ValueError("finished_at cannot precede started_at")
        if self.stdout_bytes + self.stderr_bytes > self.limits.output_bytes:
            raise ValueError("captured output byte counts exceed the combined output limit")
        if self.status is CaseStatus.PASS:
            if self.exit_code != 0 or not self.cleanup_confirmed:
                raise ValueError("pass requires exit_code 0 and confirmed cleanup")
        elif self.status is CaseStatus.FAIL:
            if self.exit_code in (None, 0) or not self.cleanup_confirmed:
                raise ValueError("fail requires a non-zero exit_code and confirmed cleanup")
        elif self.exit_code is not None:
            raise ValueError("non-completed status cannot carry an exit_code")
        return self
