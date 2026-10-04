"""Injection-only remote teacher call boundary; contains no provider SDK."""
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from guru.audit_log import append_audit_line
from guru.schemas.disclosure import Classification, Decision, DisclosureRequest
from guru.schemas.teacher_lineage import TeacherLineage

from .gate import assert_transmittable
from .redact import sanitize

AUDIT_PATH = Path(__file__).resolve().parents[2] / "audit" / "disclosure.jsonl"


class RedactionRequired(RuntimeError):
    """Raised when policy requires redaction but the payload had no redactions."""


class PayloadDigestMismatch(RuntimeError):
    """Raised when the actual payload differs from the digest reviewed by policy."""


def call_remote_teacher(*, teacher: TeacherLineage, request: DisclosureRequest,
                        raw_payload: Any, send_fn: Callable[[Any], str]) -> str:
    decision = assert_transmittable(request, teacher)
    sanitized = sanitize(raw_payload, redact_pii=request.classification is Classification.PII)
    if sanitized.payload_digest != request.payload_digest:
        append_audit_line(
            AUDIT_PATH,
            event="disclosure_payload_digest_mismatch",
            payload_digest=sanitized.payload_digest,
            fields={"request_id": request.request_id, "teacher_id": teacher.teacher_id,
                    "reviewed_payload_digest": request.payload_digest},
        )
        raise PayloadDigestMismatch("payload digest differs from the disclosure request")
    if decision.decision is Decision.ALLOW_WITH_REDACTION and not sanitized.redactions:
        append_audit_line(
            AUDIT_PATH,
            event="disclosure_redaction_required_but_not_found",
            payload_digest=sanitized.payload_digest,
            fields={"request_id": request.request_id, "teacher_id": teacher.teacher_id},
        )
        raise RedactionRequired("policy demanded redaction but no matching sensitive data was found")
    if sanitized.redactions:
        append_audit_line(
            AUDIT_PATH,
            event="disclosure_redactions",
            payload_digest=sanitized.payload_digest,
            fields={
                "request_id": request.request_id,
                "teacher_id": teacher.teacher_id,
                "sanitized_digest": sanitized.sanitized_digest,
                "redaction_count": len(sanitized.redactions),
                "redaction_kinds": sorted({action.kind for action in sanitized.redactions}),
            },
        )
    response = send_fn(sanitized.payload)
    if not isinstance(response, str):
        raise TypeError("send_fn must return str")
    return response
