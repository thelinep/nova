"""An admitted training/evaluation item with explicit provenance."""
from __future__ import annotations

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
