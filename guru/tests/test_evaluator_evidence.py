"""Synthetic contract tests; these do not execute generated candidate code."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from guru.evaluator_evidence import (
    EvidenceLogError,
    _ZERO_DIGEST,
    _canonical_bytes,
    append_case_atomic,
    replay_cases,
    seal_case,
    map_evidence_to_tests_check,
)
from guru.schemas.evaluator_evidence import CaseStatus, EvaluationCaseEvidence


HEX_A = "a" * 64
HEX_B = "b" * 64
HEX_C = "c" * 64
HEX_D = "d" * 64
HEX_E = "e" * 64
HEX_F = "f" * 64


def case_record(**overrides) -> dict:
    now = datetime.now(timezone.utc)
    record = {
        "schema_version": "guru-evaluator-case-v2",
        "case_id": "case-001",
        "item_digest": HEX_F,
        "task_digest": HEX_A,
        "candidate_digest": HEX_B,
        "test_digest": HEX_C,
        "image_digest": HEX_D,
        "config_digest": HEX_E,
        "command": ["/opt/runner", "--fixed-json-stdin"],
        "limits": {
            "timeout_ms": 10_000,
            "memory_bytes": 512 * 1024 * 1024,
            "cpu_millis": 1000,
            "pids": 128,
            "output_bytes": 4096,
            "input_bytes": 65_536,
        },
        "started_at": now.isoformat(),
        "finished_at": (now + timedelta(milliseconds=10)).isoformat(),
        "status": "pass",
        "exit_code": 0,
        "cleanup_confirmed": True,
        "output_limited": False,
        "stdout_truncated": False,
        "stderr_truncated": False,
        "stdout_bytes": 3,
        "stderr_bytes": 0,
        "stdout_digest": HEX_A,
        "stderr_digest": HEX_B,
        "previous_record_digest": _ZERO_DIGEST,
        "record_digest": "0" * 64,
    }
    record.update(overrides)
    return record


def sealed(**overrides) -> EvaluationCaseEvidence:
    return seal_case(case_record(**overrides))


class EvaluatorEvidenceSchemaTests(unittest.TestCase):
    def test_malformed_sha256_fields_are_rejected(self):
        for field, value in (("item_digest", "not-a-digest"), ("task_digest", "not-a-digest"),
                             ("stdout_digest", "A" * 64),
                             ("candidate_digest", "f" * 63)):
            with self.subTest(field=field), self.assertRaises(ValueError):
                seal_case(case_record(**{field: value}))

    def test_contradictory_status_and_exit_code_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "pass requires"):
            seal_case(case_record(exit_code=9))
        with self.assertRaisesRegex(ValueError, "fail requires"):
            seal_case(case_record(status="fail", exit_code=0))
        with self.assertRaisesRegex(ValueError, "non-completed status"):
            seal_case(case_record(status="timeout", exit_code=124))

    def test_completed_pass_and_fail_are_distinct(self):
        passed = sealed()
        failed = seal_case(case_record(status="fail", exit_code=1))
        passed_check = map_evidence_to_tests_check(passed, expected_item_digest=HEX_F)
        failed_check = map_evidence_to_tests_check(failed, expected_item_digest=HEX_F)
        self.assertTrue(passed_check.passed)
        self.assertFalse(failed_check.passed)
        self.assertEqual(passed_check.item_digest, HEX_F)
        self.assertEqual(failed_check.item_digest, HEX_F)
        self.assertFalse(map_evidence_to_tests_check(passed, expected_item_digest=HEX_A).passed)

    def test_statuses_distinguish_unavailable_infrastructure_timeout_cancel_and_completion(self):
        for status in ("unavailable", "infrastructure_error", "timeout", "cancelled"):
            item = seal_case(case_record(status=status, exit_code=None))
            self.assertIs(item.status, CaseStatus(status))
            self.assertFalse(map_evidence_to_tests_check(item, expected_item_digest=HEX_F).passed)

    def test_incomplete_or_truncated_pass_never_yields_tests_pass(self):
        self.assertFalse(map_evidence_to_tests_check(sealed(output_limited=True), expected_item_digest=HEX_F).passed)
        self.assertFalse(map_evidence_to_tests_check(sealed(stdout_truncated=True), expected_item_digest=HEX_F).passed)
        self.assertFalse(map_evidence_to_tests_check(sealed(stderr_truncated=True), expected_item_digest=HEX_F).passed)
        self.assertFalse(map_evidence_to_tests_check(sealed(status="infrastructure_error", exit_code=None),
                                                    expected_item_digest=HEX_F).passed)

    def test_malformed_or_tampered_record_never_yields_tests_pass(self):
        malformed = case_record(task_digest="invalid")
        self.assertFalse(map_evidence_to_tests_check(malformed, expected_item_digest=HEX_F).passed)
        item = sealed()
        self.assertTrue(map_evidence_to_tests_check(item, expected_item_digest=HEX_F).passed)
        tampered = item.model_dump(mode="json")
        tampered["candidate_digest"] = HEX_C
        self.assertFalse(map_evidence_to_tests_check(tampered, expected_item_digest=HEX_F).passed)
        wrong_parent = seal_case(case_record(), previous_record_digest=HEX_E)
        self.assertFalse(map_evidence_to_tests_check(wrong_parent, expected_item_digest=HEX_F).passed)

    def test_schema_rejects_arbitrary_raw_output_fields(self):
        with self.assertRaises(ValueError):
            seal_case(case_record(stdout="raw secret output"))


class EvaluatorEvidencePersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "cases.jsonl"

    def test_persists_and_replays_canonical_digest_chain_without_raw_output(self):
        item = append_case_atomic(self.path, case_record())
        second = case_record(case_id="case-002")
        append_case_atomic(self.path, second)
        replay = replay_cases(self.path)
        self.assertEqual([r.case_id for r in replay], ["case-001", "case-002"])
        self.assertEqual(replay[0].item_digest, HEX_F)
        self.assertEqual(replay[1].item_digest, HEX_F)
        self.assertEqual(replay[1].previous_record_digest, item.record_digest)
        self.assertTrue(map_evidence_to_tests_check(
            replay[1], expected_item_digest=HEX_F,
            expected_previous_record_digest=item.record_digest,
        ).passed)
        self.assertFalse(map_evidence_to_tests_check(
            replay[1], expected_item_digest=HEX_E,
            expected_previous_record_digest=item.record_digest,
        ).passed)
        persisted = self.path.read_bytes()
        self.assertNotIn(b"raw stdout", persisted)
        self.assertNotIn(b"raw stderr", persisted)
        self.assertIn(b"stdout_digest", persisted)
        self.assertIn(b"stderr_digest", persisted)

    def test_duplicate_case_ids_rejected_on_append_and_replay(self):
        first = append_case_atomic(self.path, case_record())
        with self.assertRaisesRegex(EvidenceLogError, "duplicate"):
            append_case_atomic(self.path, case_record())
        duplicate = seal_case(case_record(), previous_record_digest=first.record_digest)
        with self.path.open("ab") as stream:
            stream.write(_canonical_bytes(duplicate.model_dump(mode="json")) + b"\n")
        with self.assertRaisesRegex(EvidenceLogError, "duplicate"):
            replay_cases(self.path)

    def test_tampering_and_middle_record_removal_break_integrity_chain(self):
        first = append_case_atomic(self.path, case_record())
        append_case_atomic(self.path, case_record(case_id="case-002"))
        lines = self.path.read_text().splitlines()
        changed = json.loads(lines[0])
        changed["candidate_digest"] = HEX_C
        lines[0] = json.dumps(changed, sort_keys=True, separators=(",", ":"))
        self.path.write_text("\n".join(lines) + "\n")
        with self.assertRaisesRegex(EvidenceLogError, "integrity digest mismatch"):
            replay_cases(self.path)
        # Restore a valid chain, then drop its predecessor. The next line cannot
        # be replayed because its predecessor digest no longer matches genesis.
        one = seal_case(case_record())
        two = seal_case(case_record(case_id="case-002"), previous_record_digest=one.record_digest)
        self.path.write_bytes(_canonical_bytes(two.model_dump(mode="json")) + b"\n")
        with self.assertRaisesRegex(EvidenceLogError, "chain link mismatch"):
            replay_cases(self.path)

    def test_truncated_final_line_is_rejected(self):
        append_case_atomic(self.path, case_record())
        self.path.write_bytes(self.path.read_bytes()[:-1])
        with self.assertRaisesRegex(EvidenceLogError, "truncated final line"):
            replay_cases(self.path)

    def test_failed_atomic_replace_preserves_previous_file(self):
        append_case_atomic(self.path, case_record())
        before = self.path.read_bytes()
        with patch("guru.evaluator_evidence.os.replace", side_effect=OSError("injected replace failure")):
            with self.assertRaisesRegex(OSError, "injected replace failure"):
                append_case_atomic(self.path, case_record(case_id="case-002"))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual([r.case_id for r in replay_cases(self.path)], ["case-001"])

    def test_rejects_missing_parent_directory(self):
        with self.assertRaises(FileNotFoundError):
            append_case_atomic(self.path.parent / "missing" / "cases.jsonl", case_record())


if __name__ == "__main__":
    unittest.main()
