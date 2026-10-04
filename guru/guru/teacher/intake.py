"""Offline teacher intake and rights validation."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from guru.schemas.teacher_lineage import AccessMethod, OutputRights, ReviewStatus, TeacherLineage


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def validate_teacher(teacher: TeacherLineage) -> dict[str, Any]:
    blockers: list[str] = []
    warnings: list[str] = []
    if teacher.review_status is not ReviewStatus.APPROVED:
        blockers.append("review_status is not APPROVED")
    if teacher.review_status is ReviewStatus.APPROVED and (not teacher.reviewed_by or teacher.reviewed_at is None):
        blockers.append("approved teacher is missing reviewed_by or reviewed_at")
    license_name = teacher.license.lower()
    research_only_mismatch = (
        teacher.output_rights is OutputRights.RESEARCH_ONLY
        and license_name.startswith(("apache-", "mit", "bsd-"))
    )
    training_rights = {OutputRights.MAY_TRAIN, OutputRights.MAY_REDISTRIBUTE}
    if teacher.output_rights not in training_rights:
        blockers.append("output_rights does not permit training")
    prohibited_training_terms = ("non-production", "nonproduction", "research only", "research-only", "mnpl")
    if (teacher.output_rights in training_rights
            and any(term in license_name for term in prohibited_training_terms)):
        blockers.append("license does not grant training rights")
    if research_only_mismatch:
        warnings.append("license is more permissive than output_rights; review")
    disclosure = teacher.input_disclosure
    if (teacher.access_method is AccessMethod.API and disclosure.confidentiality_required
            and not disclosure.transmission_approved_by):
        blockers.append("confidentiality is required but no transmission approver is recorded")
    if teacher.access_method is AccessMethod.WEIGHTS and not teacher.model_digest:
        blockers.append("weights access has no model_digest")
    return {"admissible": not blockers, "blockers": blockers, "warnings": warnings}


def load_registry(path: str | Path) -> list[TeacherLineage]:
    teachers: list[TeacherLineage] = []
    with Path(path).open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line, object_pairs_hook=_unique_object)
                teachers.append(TeacherLineage.model_validate(record))
            except (json.JSONDecodeError, ValidationError, ValueError) as exc:
                raise ValueError(f"{path}:{line_number}: invalid teacher registry record") from exc
    return teachers
