"""Structural validator for Guru model intake records.

References are shape-checked only. This module does not resolve documents,
establish rights, contact providers, or make an admission decision itself.
"""
from __future__ import annotations

import re
from datetime import datetime

SCHEMA_VERSION = "guru-code-model-intake-v1"
PERMISSION_FIELDS = (
    "weights_use",
    "weights_modification",
    "weights_distribution",
    "teacher_output_training",
    "input_transmission",
    "input_retention",
    "provider_training_on_inputs",
)
PERMISSION_STATES = {"approved", "denied", "not_applicable", "pending_review"}
REVIEW_STATES = {"pending_review", "approved", "rejected"}
ROLES = ("student_base", "teacher", "runtime_only")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ModelIntakeError(ValueError):
    """A model intake record is incomplete or internally inconsistent."""


def _text(value: object, label: str, *, limit: int = 512) -> None:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ModelIntakeError(f"{label} must be a non-empty string of at most {limit} characters")


def _digest(value: object, label: str, *, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, str) or not _SHA256.fullmatch(value):
        suffix = " or null" if nullable else ""
        raise ModelIntakeError(f"{label} must be a lowercase SHA-256 digest{suffix}")


def _evidence_ref(ref: object, label: str) -> None:
    if not isinstance(ref, dict):
        raise ModelIntakeError(f"{label} must be an evidence-reference object")
    _text(ref.get("ref_id"), f"{label}.ref_id")
    _text(ref.get("kind"), f"{label}.kind")
    _digest(ref.get("sha256"), f"{label}.sha256")
    covers = ref.get("covers")
    if not isinstance(covers, list) or not covers or not all(isinstance(x, str) and x in PERMISSION_FIELDS for x in covers):
        raise ModelIntakeError(f"{label}.covers must list permission field names")
    # A URI may be retained as a locator, but is never dereferenced or treated
    # as evidence by this structural validator.
    if "uri" in ref and (not isinstance(ref["uri"], str) or len(ref["uri"]) > 2048):
        raise ModelIntakeError(f"{label}.uri must be a string no longer than 2048 characters")


def validate_model_intake(record: object) -> None:
    """Validate a complete intake record and approved-review consistency.

    A structurally valid record is not a finding that its permissions or
    referenced evidence are valid; that requires independent human review.
    """
    if not isinstance(record, dict):
        raise ModelIntakeError("model intake must be a JSON object")
    if record.get("schema_version") != SCHEMA_VERSION:
        raise ModelIntakeError(f"schema_version must be {SCHEMA_VERSION!r}")
    for field in ("intake_id", "model_id", "intended_use"):
        _text(record.get(field), field)
    _digest(record.get("model_sha256"), "model_sha256")
    _digest(record.get("adapter_sha256"), "adapter_sha256", nullable=True)
    roles = [role for role in ROLES if type(record.get(role)) is bool and record[role]]
    if len(roles) != 1 or any(type(record.get(role)) is not bool for role in ROLES):
        raise ModelIntakeError("exactly one of student_base, teacher, and runtime_only must be true booleans")
    role = roles[0]

    tokenizer = record.get("tokenizer")
    if not isinstance(tokenizer, dict):
        raise ModelIntakeError("tokenizer must be an object")
    for field in ("id", "revision"):
        _text(tokenizer.get(field), f"tokenizer.{field}")
    _digest(tokenizer.get("sha256"), "tokenizer.sha256")
    context = record.get("context_tokens")
    if type(context) is not int or context < 1:
        raise ModelIntakeError("context_tokens must be a positive integer")
    runtime = record.get("runtime")
    if not isinstance(runtime, dict):
        raise ModelIntakeError("runtime must be an object")
    for field in ("name", "version"):
        _text(runtime.get(field), f"runtime.{field}")
    _digest(runtime.get("artifact_sha256"), "runtime.artifact_sha256")

    permissions = record.get("permissions")
    if not isinstance(permissions, dict):
        raise ModelIntakeError("permissions must be an object")
    for field in PERMISSION_FIELDS:
        if permissions.get(field) not in PERMISSION_STATES:
            raise ModelIntakeError(f"permissions.{field} must be one of {', '.join(sorted(PERMISSION_STATES))}")
    scopes = permissions.get("permitted_scopes")
    if not isinstance(scopes, list) or not all(isinstance(x, str) and x.strip() for x in scopes):
        raise ModelIntakeError("permissions.permitted_scopes must be a list of non-empty strings")
    evidence_refs = permissions.get("evidence_refs")
    if not isinstance(evidence_refs, list):
        raise ModelIntakeError("permissions.evidence_refs must be a list")
    covered = set()
    for index, ref in enumerate(evidence_refs):
        _evidence_ref(ref, f"permissions.evidence_refs[{index}]")
        covered.update(ref["covers"])

    review = record.get("review")
    if not isinstance(review, dict) or review.get("status") not in REVIEW_STATES:
        raise ModelIntakeError("review.status must be pending_review, approved, or rejected")
    if review["status"] == "approved":
        _text(review.get("reviewer"), "review.reviewer")
        reviewed_at = review.get("reviewed_at")
        if not isinstance(reviewed_at, str):
            raise ModelIntakeError("approved review requires review.reviewed_at")
        try:
            datetime.fromisoformat(reviewed_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ModelIntakeError("review.reviewed_at must be an ISO-8601 timestamp") from exc
        notes_ref = review.get("notes_ref")
        _evidence_ref(notes_ref, "review.notes_ref")
        if not evidence_refs:
            raise ModelIntakeError("approved review requires permission evidence references")
        if set(PERMISSION_FIELDS) - covered:
            raise ModelIntakeError("approved review requires evidence references covering every permission field")
        pending = [key for key in PERMISSION_FIELDS if permissions[key] == "pending_review"]
        if pending:
            raise ModelIntakeError(f"cannot approve intake while permissions remain pending: {', '.join(pending)}")
        required_approved = {
            "student_base": {"weights_use", "weights_modification"},
            "teacher": {"weights_use", "teacher_output_training"},
            "runtime_only": {"weights_use"},
        }[role]
        denied = sorted(key for key in required_approved if permissions[key] != "approved")
        if denied:
            raise ModelIntakeError(f"approved review conflicts with required permissions: {', '.join(denied)}")
    elif review.get("status") == "pending_review":
        if review.get("reviewed_at") is not None:
            raise ModelIntakeError("pending review must not have review.reviewed_at")

    lineage = record.get("lineage")
    if not isinstance(lineage, dict):
        raise ModelIntakeError("lineage must be an object")
    for field in ("parent_model_intake_ids", "source_manifest_refs", "task_refs",
                  "trajectory_refs", "teacher_output_refs", "derived_artifact_refs"):
        value = lineage.get(field)
        if not isinstance(value, list):
            raise ModelIntakeError(f"lineage.{field} must be a list")
        if any(not isinstance(item, str) or not item.strip() for item in value):
            raise ModelIntakeError(f"lineage.{field} entries must be non-empty strings")
    if lineage.get("base_model_intake_id") is not None:
        _text(lineage["base_model_intake_id"], "lineage.base_model_intake_id")
    if not lineage["source_manifest_refs"] and not lineage["derived_artifact_refs"]:
        raise ModelIntakeError("lineage requires a source_manifest_refs or derived_artifact_refs entry")


def has_approved_review_record(record: object) -> bool:
    """Report the recorded review status only; this does not establish admission."""
    validate_model_intake(record)
    return record["review"]["status"] == "approved"
