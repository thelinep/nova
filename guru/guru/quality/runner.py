"""Fail-closed orchestration from typed check evidence to an admission audit."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from guru.quality.checks import CheckRunReport, run_deterministic_checks
from guru.quality.gate import item_decision
from guru.schemas.corpus_item import CorpusItem
from guru.schemas.quality import HumanReviewRecord, ItemAdmission, QualityTier
from guru.quality.providers import EvaluatorEvidenceProvider, RightsEvidenceProvider


def run_item_quality(
    raw_item: CorpusItem | Mapping[str, Any], *, tier: QualityTier,
    source_manifest_path: str | Path | None = None,
    source_manifest_digest: str | None = None,
    corpus_items: Sequence[CorpusItem | Mapping[str, Any]] | None = None,
    group_assignments: Mapping[str, str | Sequence[str]] | None = None,
    evaluator_provider: EvaluatorEvidenceProvider | None = None,
    rights_provider: RightsEvidenceProvider | None = None,
    human_review: HumanReviewRecord | None = None,
) -> tuple[CheckRunReport, ItemAdmission]:
    """Run providers and emit a decision only for a complete measured check set.

    Missing/unavailable evaluator or rights evidence raises before ``item_decision``
    and therefore before any admission audit is written.
    """
    report = run_deterministic_checks(
        raw_item, source_manifest_path=source_manifest_path,
        source_manifest_digest=source_manifest_digest,
        corpus_items=corpus_items, group_assignments=group_assignments,
        evaluator_provider=evaluator_provider,
        rights_provider=rights_provider,
    )
    if any(record.status.value == "UNAVAILABLE" for record in report.records):
        from guru.quality.checks import IncompleteCheckRunError
        raise IncompleteCheckRunError("unavailable check prevents decision and audit")
    checks = report.as_auto_checks()
    parsed = raw_item if isinstance(raw_item, CorpusItem) else CorpusItem.model_validate(dict(raw_item))
    return report, item_decision(item_id=parsed.item_id,
                                 item_digest=parsed.canonical_digest(), tier=tier,
                                 auto_checks=checks, human_review=human_review)
