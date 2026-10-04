from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
import unittest
from unittest.mock import patch

from guru.disclosure.call import PayloadDigestMismatch, RedactionRequired, call_remote_teacher
from guru.disclosure.gate import DisclosureDenied, evaluate_disclosure
from guru.disclosure.redact import sanitize
from guru.audit_log import digest_json
from guru.schemas.disclosure import Classification, Decision, DisclosureRequest, Reason
from guru.schemas.teacher_lineage import (
    AccessMethod, InputDisclosure, InputType, OutputRights, ReviewStatus, TeacherLineage,
)


def teacher(**overrides: Any) -> TeacherLineage:
    values = {
        "teacher_id": "teacher-1", "model_name": "reviewed-model", "license": "Apache-2.0",
        "access_method": AccessMethod.API, "output_rights": OutputRights.MAY_TRAIN,
        "review_status": ReviewStatus.APPROVED, "reviewed_by": "reviewer-1",
        "reviewed_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "input_disclosure": InputDisclosure(
            allowed_input_types=[InputType.SOURCE_CODE], retention_bounded=True, logging_allowed=True,
        ),
    }
    values.update(overrides)
    return TeacherLineage(**values)


def request(**overrides: Any) -> DisclosureRequest:
    values = {"request_id": "req-1", "input_type": InputType.SOURCE_CODE,
              "classification": Classification.PUBLIC, "payload_digest": "a" * 64}
    values.update(overrides)
    return DisclosureRequest(**values)


class DisclosureGateTests(unittest.TestCase):
    def test_each_deny_reason(self) -> None:
        cases = [
            (teacher(review_status=ReviewStatus.PENDING, reviewed_by=None, reviewed_at=None), request(), Reason.TEACHER_NOT_APPROVED),
            (teacher(), request(input_type=InputType.LOGS), Reason.INPUT_TYPE_NOT_ALLOWED),
            (teacher(), request(confidentiality_required=True), Reason.CONFIDENTIALITY_NO_APPROVER),
            (teacher(input_disclosure=InputDisclosure(
                allowed_input_types=[InputType.SOURCE_CODE], provider_trains_on_inputs=True,
                retention_bounded=True)), request(), Reason.PROVIDER_TRAINS_ON_INPUTS),
            (teacher(input_disclosure=InputDisclosure(
                allowed_input_types=[InputType.SOURCE_CODE], retention_bounded=False)), request(), Reason.RETENTION_UNBOUNDED),
            (teacher(input_disclosure=InputDisclosure(
                allowed_input_types=[InputType.SOURCE_CODE], retention_bounded=True, logging_allowed=False)),
             request(), Reason.LOGGING_NOT_ALLOWED),
        ]
        with TemporaryDirectory() as directory, patch("guru.disclosure.gate.AUDIT_PATH", Path(directory) / "disclosure.jsonl"):
            for reviewed_teacher, disclosure_request, expected in cases:
                with self.subTest(reason=expected):
                    result = evaluate_disclosure(disclosure_request, reviewed_teacher)
                    self.assertIs(result.decision, Decision.DENY)
                    self.assertIn(expected, result.reasons)

    def test_deny_takes_priority_over_redaction(self) -> None:
        with TemporaryDirectory() as directory, patch("guru.disclosure.gate.AUDIT_PATH", Path(directory) / "gate.jsonl"):
            result = evaluate_disclosure(request(
                input_type=InputType.LOGS, classification=Classification.PII), teacher())
            self.assertIs(result.decision, Decision.DENY)
            self.assertIn(Reason.INPUT_TYPE_NOT_ALLOWED, result.reasons)
            self.assertEqual(result.redactions, [])

    def test_non_api_teacher_cannot_be_transmitted_to_remote_teacher(self) -> None:
        with TemporaryDirectory() as directory, patch("guru.disclosure.gate.AUDIT_PATH", Path(directory) / "gate.jsonl"):
            result = evaluate_disclosure(request(), teacher(access_method=AccessMethod.WEIGHTS))
            self.assertIs(result.decision, Decision.DENY)
            self.assertIn(Reason.TEACHER_NOT_APPROVED, result.reasons)

    def test_allow_and_deny_write_digest_only_audit_lines(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "disclosure.jsonl"
            with patch("guru.disclosure.gate.AUDIT_PATH", path):
                evaluate_disclosure(request(), teacher())
                evaluate_disclosure(request(input_type=InputType.LOGS), teacher())
            records = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual(len(records), 2)
            self.assertEqual([row["decision"] for row in records], ["allow", "deny"])
            self.assertTrue(all(row["payload_digest"] == "a" * 64 for row in records))
            self.assertNotIn("raw_payload", path.read_text())

    def test_sanitizer_strips_openai_key_and_email(self) -> None:
        result = sanitize("contact person@example.org; key sk-1234567890abcdef1234567890", redact_pii=True)
        self.assertNotIn("sk-1234567890abcdef1234567890", result.payload)
        self.assertNotIn("person@example.org", result.payload)
        self.assertEqual({action.kind for action in result.redactions}, {"openai_api_key", "email"})

    def test_sanitizer_strips_aws_bearer_and_pem_secrets(self) -> None:
        pem = "-----BEGIN PRIVATE KEY-----\nprivate bytes\n-----END PRIVATE KEY-----"
        result = sanitize(
            f"AKIAABCDEFGHIJKLMNOP Bearer eyJhbGciOiJub25lIn0.signature.token {pem}",
            redact_pii=False,
        )
        self.assertEqual({action.kind for action in result.redactions},
                         {"aws_access_key", "bearer_token", "pem_private_key"})
        self.assertNotIn("AKIAABCDEFGHIJKLMNOP", result.payload)
        self.assertNotIn("eyJhbGciOiJub25lIn0.signature.token", result.payload)
        self.assertNotIn("private bytes", result.payload)

    def test_call_never_sends_after_deny_and_logs_redaction_before_send(self) -> None:
        with TemporaryDirectory() as directory:
            audit = Path(directory) / "disclosure.jsonl"
            send_calls: list[object] = []
            with patch("guru.disclosure.gate.AUDIT_PATH", audit), patch("guru.disclosure.call.AUDIT_PATH", audit):
                with self.assertRaises(DisclosureDenied):
                    call_remote_teacher(
                        teacher=teacher(), request=request(input_type=InputType.LOGS),
                        raw_payload="secret raw", send_fn=lambda payload: send_calls.append(payload) or "ok",
                    )
                self.assertEqual(send_calls, [])
                response = call_remote_teacher(
                    teacher=teacher(), request=request(classification=Classification.PII,
                                                       payload_digest=digest_json("email person@example.org")),
                    raw_payload="email person@example.org",
                    send_fn=lambda payload: send_calls.append(payload) or "ok",
                )
            self.assertEqual(response, "ok")
            self.assertNotIn("person@example.org", str(send_calls[-1]))
            rows = [json.loads(line) for line in audit.read_text().splitlines()]
            self.assertEqual([row["event"] for row in rows], [
                "disclosure_decision", "disclosure_decision", "disclosure_redactions",
            ])

    def test_payload_digest_mismatch_stops_before_send(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "disclosure.jsonl"
            sent: list[object] = []
            with patch("guru.disclosure.gate.AUDIT_PATH", path), patch("guru.disclosure.call.AUDIT_PATH", path):
                with self.assertRaises(PayloadDigestMismatch):
                    call_remote_teacher(teacher=teacher(), request=request(), raw_payload="different bytes",
                                        send_fn=lambda payload: sent.append(payload) or "ok")
            self.assertEqual(sent, [])
            records = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual(records[-1]["event"], "disclosure_payload_digest_mismatch")

    def test_policy_redaction_without_a_match_fails_closed(self) -> None:
        with TemporaryDirectory() as directory:
            audit = Path(directory) / "gate.jsonl"
            with patch("guru.disclosure.gate.AUDIT_PATH", audit), patch("guru.disclosure.call.AUDIT_PATH", audit):
                with self.assertRaises(RedactionRequired):
                    call_remote_teacher(teacher=teacher(), request=request(
                        classification=Classification.PII, payload_digest=digest_json("ordinary code")),
                                        raw_payload="ordinary code", send_fn=lambda payload: "not sent")


if __name__ == "__main__":
    unittest.main()
