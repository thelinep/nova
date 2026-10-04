"""Fail-closed disclosure gate for injected remote-teacher call functions."""
from __future__ import annotations

from pathlib import Path

from guru.audit_log import append_audit_line
from guru.schemas.disclosure import Classification, Decision, DisclosureDecision, DisclosureRequest, Reason
from guru.schemas.teacher_lineage import AccessMethod, ReviewStatus, TeacherLineage

AUDIT_PATH = Path(__file__).resolve().parents[2] / "audit" / "disclosure.jsonl"
REASON_PRIORITY = (
    Reason.TEACHER_NOT_APPROVED,
    Reason.INPUT_TYPE_NOT_ALLOWED,
    Reason.CONFIDENTIALITY_NO_APPROVER,
    Reason.PROVIDER_TRAINS_ON_INPUTS,
    Reason.RETENTION_UNBOUNDED,
    Reason.LOGGING_NOT_ALLOWED,
)


class DisclosureDenied(PermissionError):
    def __init__(self, decision: DisclosureDecision) -> None:
        self.decision = decision
        super().__init__(", ".join(reason.value for reason in decision.reasons))


def _audit(decision: DisclosureDecision) -> None:
    append_audit_line(
        AUDIT_PATH,
        event="disclosure_decision",
        payload_digest=decision.payload_digest,
        fields={
            "request_id": decision.request_id,
            "teacher_id": decision.teacher_id,
            "decision": decision.decision.value,
            "reasons": [reason.value for reason in decision.reasons],
            "policy_version": decision.policy_version,
            "redaction_count": len(decision.redactions),
        },
    )


def evaluate_disclosure(request: DisclosureRequest, teacher: TeacherLineage) -> DisclosureDecision:
    """Evaluate the policy without sending data; persist its digest-only decision."""
    disclosure = teacher.input_disclosure
    failed: set[Reason] = set()
    if (teacher.access_method is not AccessMethod.API or teacher.review_status is not ReviewStatus.APPROVED
            or not teacher.reviewed_by or teacher.reviewed_at is None):
        failed.add(Reason.TEACHER_NOT_APPROVED)
    if request.input_type not in disclosure.allowed_input_types:
        failed.add(Reason.INPUT_TYPE_NOT_ALLOWED)
    if ((request.confidentiality_required or disclosure.confidentiality_required)
            and not disclosure.transmission_approved_by):
        failed.add(Reason.CONFIDENTIALITY_NO_APPROVER)
    provider_trains = disclosure.provider_trains_on_inputs or request.provider_trains_on_inputs is True
    retention_bounded = disclosure.retention_bounded and request.retention_bounded is not False
    logging_allowed = disclosure.logging_allowed and request.logging_allowed is not False
    if provider_trains:
        failed.add(Reason.PROVIDER_TRAINS_ON_INPUTS)
    if not retention_bounded:
        failed.add(Reason.RETENTION_UNBOUNDED)
    if not logging_allowed:
        failed.add(Reason.LOGGING_NOT_ALLOWED)
    reasons = [reason for reason in REASON_PRIORITY if reason in failed]
    if reasons:
        result = DisclosureDecision(
            request_id=request.request_id, teacher_id=teacher.teacher_id,
            decision=Decision.DENY, reasons=reasons, payload_digest=request.payload_digest,
        )
    elif request.classification in {Classification.SECRETS, Classification.PII}:
        result = DisclosureDecision(
            request_id=request.request_id, teacher_id=teacher.teacher_id,
            decision=Decision.ALLOW_WITH_REDACTION, payload_digest=request.payload_digest,
        )
    else:
        result = DisclosureDecision(
            request_id=request.request_id, teacher_id=teacher.teacher_id,
            decision=Decision.ALLOW, payload_digest=request.payload_digest,
        )
    _audit(result)
    return result


def assert_transmittable(request: DisclosureRequest, teacher: TeacherLineage) -> DisclosureDecision:
    """Return the audited decision or raise a typed denial."""
    decision = evaluate_disclosure(request, teacher)
    if decision.decision is Decision.DENY:
        raise DisclosureDenied(decision)
    return decision
