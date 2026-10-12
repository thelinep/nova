"""Trust-boundary interfaces for external evaluator and rights registries.

No production implementation is included here. These abstract provider types
are privileged interfaces: only the application composition root may create
and inject implementations backed by separately controlled, reviewed records.
Never construct them from request data. Until that composition-root provider is
configured, both checks remain UNAVAILABLE.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Mapping

from guru.schemas.corpus_item import CorpusItem
from guru.schemas.evaluator_evidence import EvaluatorCaseSet, EvaluatorQualificationEvidence
from guru.schemas.rights_decision import RightsDecision
from guru.schemas.teacher_lineage import TeacherLineage


@dataclass(frozen=True)
class PinnedEvaluatorInputs:
    case_set: EvaluatorCaseSet
    qualification: EvaluatorQualificationEvidence
    qualification_digest: str
    trusted_qualification_digest: str
    test_suite_digest: str
    trusted_test_suite_digest: str
    expected_case_ids: tuple[str, ...]
    expected_case_test_digests: Mapping[str, str]
    task_digest: str


@dataclass(frozen=True)
class ApprovedRightsInputs:
    decision: RightsDecision
    approved_artifact_digest: str
    rights_manifest_digest: str
    trusted_rights_manifest_digest: str
    teachers: tuple[TeacherLineage, ...]
    teacher_registry_digest: str | None = None
    trusted_teacher_registry_digest: str | None = None


class EvaluatorEvidenceProvider(ABC):
    """Load measured evidence and pins from an independently controlled source."""

    @abstractmethod
    def load_for(self, item: CorpusItem) -> PinnedEvaluatorInputs | None:
        """Return evidence only after verifying the external qualification pin."""


class RightsEvidenceProvider(ABC):
    """Resolve source rights and approved teacher records by exact artifact/item."""

    @abstractmethod
    def load_for(self, item: CorpusItem) -> ApprovedRightsInputs | None:
        """Return rights only after approved-manifest and source linkage checks."""
