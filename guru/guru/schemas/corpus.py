"""Corpus manifests and freeze-time invariants."""
from __future__ import annotations

from enum import Enum

from pydantic import Field, model_validator

from .teacher_lineage import StrictModel


class CorpusKind(str, Enum):
    C_SFT = "c_sft"
    C_RD = "c_rd"
    C_TRACE = "c_trace"


class CorpusStatus(str, Enum):
    DRAFT = "draft"
    FROZEN = "frozen"


class CorpusManifest(StrictModel):
    schema_version: str = "guru-code-corpus-v1"
    corpus_id: str = Field(min_length=1)
    version: str = Field(min_length=1)
    kind: CorpusKind
    status: CorpusStatus = CorpusStatus.DRAFT
    owner_approval: dict[str, str] | None = None
    split_seed: str = Field(min_length=1)
    split_rule: str
    item_count: int = Field(ge=0)
    split_counts: dict[str, int]
    teacher_ids: list[str] = Field(default_factory=list)
    excluded_task_ids: list[str] = Field(default_factory=list)
    exclusion_reasons: dict[str, str] = Field(default_factory=dict)
    item_file_digests: dict[str, str]
    items_digest: str = Field(pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def validate_freeze_and_exclusions(self) -> CorpusManifest:
        if self.status is CorpusStatus.FROZEN and not self.owner_approval:
            raise ValueError("FROZEN requires owner_approval")
        missing = [task_id for task_id in self.excluded_task_ids
                   if task_id not in self.exclusion_reasons or not self.exclusion_reasons[task_id].strip()]
        if missing:
            raise ValueError("every excluded_task_id must have an exclusion_reasons entry")
        return self
