"""An admitted training/evaluation item with explicit provenance."""
from __future__ import annotations

import hashlib
import json

from pydantic import Field, model_validator

from .teacher_lineage import StrictModel


class CorpusItem(StrictModel):
    item_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    prompt: str = Field(min_length=1)
    target: str = Field(min_length=1)
    target_source: str = Field(min_length=1)
    teacher_lineage_id: str | None = None
    trajectory_id: str | None = None
    source_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    language: str = "python"
    metadata: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def source_reference_required(self) -> CorpusItem:
        if self.target_source == "teacher" and not self.teacher_lineage_id:
            raise ValueError("target_source == 'teacher' requires teacher_lineage_id")
        if self.target_source == "trajectory" and not self.trajectory_id:
            raise ValueError("target_source == 'trajectory' requires trajectory_id")
        return self

    def canonical_digest(self) -> str:
        """SHA-256 over every normalized field used to admit or train this item."""
        raw = json.dumps(
            self.model_dump(mode="json"), ensure_ascii=False, sort_keys=True,
            separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")
        return hashlib.sha256(raw).hexdigest()
