"""Rights and provenance records for teacher models."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class AccessMethod(str, Enum):
    API = "api"
    WEIGHTS = "weights"
    LOCAL = "local"


class OutputRights(str, Enum):
    RESEARCH_ONLY = "research_only"
    MAY_TRAIN = "may_train"
    MAY_REDISTRIBUTE = "may_redistribute"


class ReviewStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class InputType(str, Enum):
    SOURCE_CODE = "source_code"
    LOGS = "logs"
    PATCHES = "patches"
    PROMPTS = "prompts"
    TRACES = "traces"
    METADATA = "metadata"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class InputDisclosure(StrictModel):
    allowed_input_types: list[InputType] = Field(default_factory=list)
    confidentiality_required: bool = False
    transmission_approved_by: str | None = None
    provider_trains_on_inputs: bool = False
    retention_bounded: bool = False
    retention_days: int | None = Field(default=None, ge=0)
    logging_allowed: bool = True

    @model_validator(mode="after")
    def require_transmission_approver(self) -> InputDisclosure:
        if self.confidentiality_required and not self.transmission_approved_by:
            raise ValueError("confidentiality_required needs transmission_approved_by")
        return self


def _normalize_digests(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return [item for item in value if item]
    raise ValueError("digest fields must be a string, a list of strings, or null")


class TeacherLineage(StrictModel):
    teacher_id: str = Field(min_length=1)
    model_name: str = Field(min_length=1)
    access_method: AccessMethod
    output_rights: OutputRights
    review_status: ReviewStatus
    reviewed_by: str | None = None
    reviewed_at: datetime | None = None
    adapter_digests: list[str] = Field(default_factory=list)
    model_digest: list[str] = Field(default_factory=list)
    input_disclosure: InputDisclosure = Field(default_factory=InputDisclosure)

    @field_validator("adapter_digests", "model_digest", mode="before")
    @classmethod
    def normalize_digest_shapes(cls, value: Any) -> list[str]:
        return _normalize_digests(value)

    @model_validator(mode="after")
    def require_approval_evidence(self) -> TeacherLineage:
        if self.review_status is ReviewStatus.APPROVED and (not self.reviewed_by or self.reviewed_at is None):
            raise ValueError("APPROVED requires reviewed_by and reviewed_at")
        return self
