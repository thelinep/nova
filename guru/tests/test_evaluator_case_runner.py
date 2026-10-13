"""Synthetic contract tests; no generated code is executed here."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from dataclasses import replace
import hashlib
import json
import os
import subprocess
import sys
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from guru.code_evaluator import EvaluationError, EvaluationPolicy
from guru.evaluator_case_runner import (
    DAEMON_LOGGING_POLICY,
    RUNNER_COMMAND,
    CaseRunnerAuthorizationError,
    LocalCaseRunnerAuthorizationProvider,
    PinnedLocalCaseRunnerInputs,
    _RUNNER,
    _local_docker_endpoint,
    _digest,
    evaluator_config_digest,
    run_python_case,
    run_python_case_set,
)
from guru.quality.providers import ApprovedRightsInputs, RightsEvidenceProvider
from guru.schemas.corpus_item import CorpusItem
from guru.schemas.evaluator_evidence import CaseStatus, EvaluatorCaseSet, EvaluatorQualificationEvidence
from guru.schemas.rights_decision import (
    RightsAuthorityBasis,
    RightsDecision,
    RightsEvidenceReference,
    SourceRights,
)


IMAGE = "python@sha256:" + "a" * 64
SOURCE = "c" * 64
MANIFEST = "d" * 64
ENDPOINT = "unix:///var/run/docker.sock"
NOW = datetime.now(timezone.utc)
TEST_SOURCE = '{"version":1,"cases":[{"function":"add","args":[1,2],"kwargs":{},"expected":3}]}'


class FakeEvaluator:
    def __init__(self, *, exit_code=0, stdout=b"case passed", stderr=b"",
                 output_limited=False, fail_cleanup=False):
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr
        self.output_limited = output_limited
        self.fail_cleanup = fail_cleanup
        self.calls = 0
        self.payload = None

    def __call__(self, payload, policy, *, local_endpoint=None):
        self.calls += 1
        self.payload = payload
        self.local_endpoint = local_endpoint
        if self.fail_cleanup:
            raise EvaluationError("synthetic cleanup failure")
        return SimpleNamespace(
            exit_code=self.exit_code, stdout=self.stdout, stderr=self.stderr,
            timed_out=False, output_limited=self.output_limited,
            stdout_truncated=self.output_limited,
            stderr_truncated=self.output_limited, container_removed=True,
        )


def item() -> CorpusItem:
    return CorpusItem(
        item_id="synthetic-item", task_id="task-001", prompt="Add two numbers",
        target="def add(a, b): return a + b", target_source="synthetic",
        source_digest=SOURCE, language="python",
    )


def rights(*, artifact_digest: str = SOURCE, allow_evaluation: bool = True) -> ApprovedRightsInputs:
    decision = RightsDecision(
        schema_version="guru-source-rights-v2",
        source_id="synthetic-source", uri="synthetic://source", revision="v1",
        artifact_sha256=artifact_digest,
        provenance_statement="synthetic fixture for evaluator contract tests",
        authority_basis=RightsAuthorityBasis.OWNER_ATTESTATION,
        authority_description="test-only synthetic permission",
        rights=SourceRights(
            allow_training=False, allow_evaluation=allow_evaluation,
            allow_ephemeral_transformation=False,
            allow_transformed_data_retention=False,
            allow_provider_transmission=False, allow_weight_distribution=False,
        ),
        reviewer="synthetic-test", decided_at=NOW,
        evidence_refs=[RightsEvidenceReference(
            evidence_id="synthetic-rights", uri="fixture", sha256=MANIFEST,
        )],
    )
    return ApprovedRightsInputs(
        decision=decision, approved_artifact_digest=artifact_digest,
        rights_manifest_digest=MANIFEST, trusted_rights_manifest_digest=MANIFEST,
        teachers=(),
    )


class FakeRightsProvider(RightsEvidenceProvider):
    def __init__(self, supplied=...):
        self.supplied = rights() if supplied is ... else supplied
        self.calls = 0

    def load_for(self, corpus_item):
        self.calls += 1
        return self.supplied


class FakeAuthorizationProvider(LocalCaseRunnerAuthorizationProvider):
    def __init__(self, *, qualification_age=timedelta(days=1),
                 bad_qualification_pin=False, bad_test_pin=False,
                 bad_endpoint_pin=False, bad_logging_pin=False, unavailable=False):
        self.qualification_age = qualification_age
        self.bad_qualification_pin = bad_qualification_pin
        self.bad_test_pin = bad_test_pin
        self.bad_endpoint_pin = bad_endpoint_pin
        self.bad_logging_pin = bad_logging_pin
        self.unavailable = unavailable
        self.calls = 0

    def load_for(self, corpus_item, *, config_digest, image_digest):
        self.calls += 1
        if self.unavailable:
            return None
        test_source = TEST_SOURCE
        test_digest = _digest(test_source.encode())
        qualified_at = NOW - self.qualification_age
        qualification = EvaluatorQualificationEvidence(
            schema_version="guru-evaluator-qualification-v1",
            qualification_id="synthetic-qualification", execution_scope="local",
            config_digest=config_digest, image_digest=image_digest,
            report_digest=MANIFEST, qualified_at=qualified_at,
        )
        qdigest = _digest(json.dumps(
            qualification.model_dump(mode="json"), ensure_ascii=False,
            sort_keys=True, separators=(",", ":"), allow_nan=False,
        ).encode())
        log_digest = _digest(DAEMON_LOGGING_POLICY.encode())
        endpoint_digest = _digest(ENDPOINT.encode())
        return PinnedLocalCaseRunnerInputs(
            qualification=qualification, qualification_digest=qdigest,
            trusted_qualification_digest=("0" * 64 if self.bad_qualification_pin else qdigest),
            test_digest=test_digest,
            trusted_test_digest=("0" * 64 if self.bad_test_pin else test_digest),
            test_suite_digest=MANIFEST, trusted_test_suite_digest=MANIFEST,
            docker_endpoint_digest=endpoint_digest,
            trusted_docker_endpoint_digest=("0" * 64 if self.bad_endpoint_pin else endpoint_digest),
            daemon_logging_policy_digest=log_digest,
            trusted_daemon_logging_policy_digest=("0" * 64 if self.bad_logging_pin else log_digest),
        )


class FakeCaseSetAuthorizationProvider(FakeAuthorizationProvider):
    def __init__(self, *, case_ids, test_sources, bad_case_manifest=False, bad_qualification_pin=False,
                 bad_endpoint_pin=False, bad_logging_pin=False, bad_suite_pin=False,
                 bad_config=False, bad_image=False, unavailable=False):
        super().__init__(bad_qualification_pin=bad_qualification_pin,
                         bad_endpoint_pin=bad_endpoint_pin,
                         bad_logging_pin=bad_logging_pin, unavailable=unavailable)
        self.case_ids = tuple(case_ids)
        self.case_digests = {case_id: _digest(test_sources[case_id].encode()) for case_id in case_ids}
        self.bad_case_manifest = bad_case_manifest
        self.bad_suite_pin = bad_suite_pin
        self.bad_config = bad_config
        self.bad_image = bad_image

    def load_for(self, corpus_item, *, config_digest, image_digest):
        self.calls += 1
        if self.unavailable:
            return None
        qualification = EvaluatorQualificationEvidence(
            schema_version="guru-evaluator-qualification-v1",
            qualification_id="synthetic-qualification", execution_scope="local",
            config_digest="0" * 64 if self.bad_config else config_digest,
            image_digest="0" * 64 if self.bad_image else image_digest,
            report_digest=MANIFEST, qualified_at=NOW - timedelta(days=1),
        )
        qdigest = _digest(json.dumps(
            qualification.model_dump(mode="json"), ensure_ascii=False,
            sort_keys=True, separators=(",", ":"), allow_nan=False,
        ).encode())
        endpoint_digest = _digest(ENDPOINT.encode())
        logging_digest = _digest(DAEMON_LOGGING_POLICY.encode())
        cases_payload = {
            "expected_case_ids": list(self.case_ids),
            "expected_case_test_digests": {key: self.case_digests[key] for key in self.case_ids},
        }
        cases_digest = _digest(json.dumps(
            cases_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False,
        ).encode())
        if self.bad_case_manifest:
            cases_digest = "0" * 64
        return PinnedLocalCaseRunnerInputs(
            qualification=qualification, qualification_digest=qdigest,
            trusted_qualification_digest="0" * 64 if self.bad_qualification_pin else qdigest,
            test_digest="0" * 64, trusted_test_digest="0" * 64,
            test_suite_digest=MANIFEST,
            trusted_test_suite_digest="0" * 64 if self.bad_suite_pin else MANIFEST,
            docker_endpoint_digest=endpoint_digest,
            trusted_docker_endpoint_digest="0" * 64 if self.bad_endpoint_pin else endpoint_digest,
            daemon_logging_policy_digest=logging_digest,
            trusted_daemon_logging_policy_digest="0" * 64 if self.bad_logging_pin else logging_digest,
            expected_case_ids=self.case_ids,
            expected_case_test_digests=self.case_digests,
            expected_cases_digest=cases_digest,
            trusted_expected_cases_digest=cases_digest,
        )


class FakeEvaluatorSequence:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def __call__(self, payload, policy, *, local_endpoint=None):
        self.calls.append((payload, local_endpoint))
        outcome = self.outcomes.pop(0) if self.outcomes else {}
        if isinstance(outcome, Exception):
            raise outcome
        return SimpleNamespace(
            exit_code=outcome.get("exit_code", 0), stdout=b"evidence", stderr=b"",
            timed_out=outcome.get("timed_out", False), output_limited=outcome.get("output_limited", False),
            stdout_truncated=outcome.get("output_limited", False), stderr_truncated=False,
            container_removed=outcome.get("container_removed", True),
        )


class EvaluatorCaseRunnerTests(unittest.TestCase):
    def setUp(self):
        self.policy = EvaluationPolicy(image=IMAGE, command=RUNNER_COMMAND)
        self.rights_provider = FakeRightsProvider()
        self.authorization_provider = FakeAuthorizationProvider()

    def run_case(self, evaluator=None, **overrides):
        fake = evaluator or FakeEvaluator()
        args = {
            "case_id": "case-synthetic-001", "item": item(),
            "candidate_source": "def add(a, b):\n    return a + b\n",
            "test_source": TEST_SOURCE,
            "rights_provider": self.rights_provider,
            "authorization_provider": self.authorization_provider,
            "policy": self.policy,
        }
        args.update(overrides)
        with patch("guru.evaluator_case_runner._local_docker_endpoint", return_value=ENDPOINT):
            with patch("guru.evaluator_case_runner.evaluate", side_effect=fake):
                result = run_python_case(**args)
        return result, fake

    def run_case_set(self, evaluator, *, case_ids=None, test_sources=None, authorization_provider=None,
                     starting_record_digest="0" * 64):
        test_sources = test_sources or {
            "case-b": '{"version":1,"cases":[{"function":"add","args":[1,2],"kwargs":{},"expected":3}]}',
            "case-a": '{"version":1,"cases":[{"function":"add","args":[2,2],"kwargs":{},"expected":4}]}',
        }
        case_ids = list(case_ids or test_sources.keys())
        auth = authorization_provider or FakeCaseSetAuthorizationProvider(
            case_ids=case_ids, test_sources=test_sources,
        )
        with patch("guru.evaluator_case_runner._local_docker_endpoint", return_value=ENDPOINT):
            with patch("guru.evaluator_case_runner.evaluate", side_effect=evaluator):
                result = run_python_case_set(
                    item=item(), candidate_source="def add(a, b): return a + b\n",
                    case_ids=case_ids, test_sources=test_sources,
                    rights_provider=self.rights_provider, authorization_provider=auth,
                    policy=self.policy, starting_record_digest=starting_record_digest,
                )
        return result, auth

    def test_pass_and_fail_emit_only_digest_bound_records(self):
        for kwargs, expected in (
            ({"stdout": b"candidate secret output"}, CaseStatus.PASS),
            ({"exit_code": 1, "stdout": b"failure detail", "stderr": b"trace secret"}, CaseStatus.FAIL),
        ):
            with self.subTest(expected=expected):
                evidence, fake = self.run_case(FakeEvaluator(**kwargs))
                self.assertIs(evidence.status, expected)
                self.assertTrue(evidence.cleanup_confirmed)
                self.assertEqual(fake.calls, 1)
                serialized = evidence.model_dump_json()
                for raw in (b"candidate secret output", b"failure detail", b"trace secret"):
                    self.assertNotIn(raw.decode(), serialized)
                self.assertEqual(evidence.item_digest, item().canonical_digest())
                self.assertEqual(evidence.task_digest, SOURCE)

    def test_source_rights_provider_must_pin_exact_source_artifact(self):
        self.rights_provider = FakeRightsProvider(rights(artifact_digest="e" * 64))
        with self.assertRaisesRegex(CaseRunnerAuthorizationError, "exact artifact"):
            self.run_case()
        self.rights_provider = FakeRightsProvider(replace(
            rights(), trusted_rights_manifest_digest="e" * 64,
        ))
        with self.assertRaisesRegex(CaseRunnerAuthorizationError, "manifest"):
            self.run_case()

    def test_missing_or_denied_source_rights_fails_before_execution(self):
        self.rights_provider = FakeRightsProvider(None)
        fake = FakeEvaluator()
        with self.assertRaisesRegex(CaseRunnerAuthorizationError, "rights record"):
            self.run_case(fake)
        self.assertEqual(fake.calls, 0)
        self.rights_provider = FakeRightsProvider(rights(allow_evaluation=False))
        with self.assertRaisesRegex(CaseRunnerAuthorizationError, "do not permit"):
            self.run_case(fake)
        self.assertEqual(fake.calls, 0)

    def test_missing_or_mismatched_qualification_pin_fails_before_execution(self):
        fake = FakeEvaluator()
        self.authorization_provider = FakeAuthorizationProvider(unavailable=True)
        with self.assertRaisesRegex(CaseRunnerAuthorizationError, "unavailable"):
            self.run_case(fake)
        self.authorization_provider = FakeAuthorizationProvider(bad_qualification_pin=True)
        with self.assertRaisesRegex(CaseRunnerAuthorizationError, "trusted provider pin"):
            self.run_case(fake)
        self.assertEqual(fake.calls, 0)

    def test_stale_qualification_fails_before_execution(self):
        self.authorization_provider = FakeAuthorizationProvider(qualification_age=timedelta(days=91))
        fake = FakeEvaluator()
        with self.assertRaisesRegex(CaseRunnerAuthorizationError, "stale"):
            self.run_case(fake)
        self.assertEqual(fake.calls, 0)

    def test_frozen_harness_digest_must_match_provider_pin(self):
        self.authorization_provider = FakeAuthorizationProvider(bad_test_pin=True)
        fake = FakeEvaluator()
        with self.assertRaisesRegex(CaseRunnerAuthorizationError, "harness or suite"):
            self.run_case(fake)
        self.assertEqual(fake.calls, 0)

    def test_harness_bytes_must_match_pinned_test_fixture(self):
        fake = FakeEvaluator()
        with self.assertRaisesRegex(CaseRunnerAuthorizationError, "frozen test digest"):
            self.run_case(fake, test_source='{"version":1,"cases":[{"function":"add","args":[2,2],"kwargs":{},"expected":4}]}')
        self.assertEqual(fake.calls, 0)

    def test_malformed_and_empty_suites_fail_before_evaluator(self):
        fake = FakeEvaluator()
        for source in (
            "assert add(1, 2) == 3\n",
            '{"version":1,"cases":[]}',
            '{"version":1,"cases":[{"function":"add","args":[1,2],"kwargs":{}}]}',
        ):
            with self.subTest(source=source):
                with self.assertRaises(CaseRunnerAuthorizationError):
                    self.run_case(fake, test_source=source)
        self.assertEqual(fake.calls, 0)

    def test_duplicate_json_keys_fail_before_rights_or_docker_lookup(self):
        fake = FakeEvaluator()
        for source in (
            '{"version":1,"version":1,"cases":[{"function":"add","args":[1,2],"kwargs":{},"expected":3}]}',
            '{"version":1,"cases":[{"function":"add","args":[1,2],"kwargs":{},"expected":3,"expected":4}]}',
        ):
            with self.subTest(source=source):
                with self.assertRaisesRegex(CaseRunnerAuthorizationError, "valid JSON"):
                    self.run_case(fake, test_source=source)
        self.assertEqual(self.rights_provider.calls, 0)
        self.assertEqual(self.authorization_provider.calls, 0)
        self.assertEqual(fake.calls, 0)

    def test_oversized_suite_is_rejected_before_rights_or_docker_lookup(self):
        fake = FakeEvaluator()
        oversized = '{"version":1,"cases":[]}' + (" " * self.policy.input_limit_bytes)
        with self.assertRaisesRegex(EvaluationError, "input exceeds policy limit"):
            self.run_case(fake, test_source=oversized)
        self.assertEqual(self.rights_provider.calls, 0)
        self.assertEqual(self.authorization_provider.calls, 0)
        self.assertEqual(fake.calls, 0)

    def test_candidate_zero_exit_without_a_result_cannot_pass_case(self):
        payload = json.dumps({
            "candidate_source": "import os\nos._exit(0)\n",
            "test_source": TEST_SOURCE,
        }).encode()
        proc = subprocess.run(
            [sys.executable, "-I", "-c", _RUNNER], input=payload,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False,
        )
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_candidate_crash_after_an_earlier_case_cannot_skip_remaining_cases(self):
        suite = json.dumps({"version": 1, "cases": [
            {"function": "value", "args": [1], "kwargs": {}, "expected": 1},
            {"function": "value", "args": [2], "kwargs": {}, "expected": 2},
        ]})
        payload = json.dumps({
            "candidate_source": (
                "import os\ndef value(number):\n"
                "    if number == 2: os._exit(0)\n"
                "    return number\n"
            ),
            "test_source": suite,
        }).encode()
        proc = subprocess.run(
            [sys.executable, "-I", "-c", _RUNNER], input=payload,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False,
        )
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_candidate_result_is_checked_by_outer_runner(self):
        payload = json.dumps({
            "candidate_source": "def add(a, b):\n    return a + b\n",
            "test_source": TEST_SOURCE,
        }).encode()
        proc = subprocess.run(
            [sys.executable, "-I", "-c", _RUNNER], input=payload,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode(errors="replace"))

    def test_candidate_descendant_cannot_hold_protocol_pipe_past_timeout(self):
        payload = json.dumps({
            "candidate_source": (
                "import subprocess, sys\n"
                "def add(a, b):\n"
                "    subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
                "    return a + b\n"
            ),
            "test_source": TEST_SOURCE,
        }).encode()
        started = time.monotonic()
        proc = subprocess.run(
            [sys.executable, "-I", "-c", _RUNNER], input=payload,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=9, check=False,
        )
        elapsed = time.monotonic() - started
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn(b"candidate process timed out", proc.stderr)
        self.assertNotIn(b"PermissionError", proc.stderr)
        self.assertLess(elapsed, 9)

    def test_detached_descendant_cannot_keep_case_runner_blocked(self):
        payload = json.dumps({
            "candidate_source": (
                "import subprocess, sys\n"
                "def add(a, b):\n"
                "    subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(6)'], "
                "start_new_session=True)\n"
                "    return a + b\n"
            ),
            "test_source": TEST_SOURCE,
        }).encode()
        started = time.monotonic()
        proc = subprocess.run(
            [sys.executable, "-I", "-c", _RUNNER], input=payload,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=9, check=False,
        )
        elapsed = time.monotonic() - started
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn(b"candidate process timed out", proc.stderr)
        self.assertNotIn(b"PermissionError", proc.stderr)
        self.assertLess(elapsed, 7)

    def test_protocol_requires_strict_version_and_json_typed_result_equality(self):
        bad_payloads = (
            {
                "candidate_source": "def answer():\n    return 1\n",
                "test_source": '{"version":true,"cases":[{"function":"answer","args":[],"kwargs":{},"expected":1}]}',
            },
            {
                "candidate_source": "def answer():\n    return True\n",
                "test_source": '{"version":1,"cases":[{"function":"answer","args":[],"kwargs":{},"expected":1}]}',
            },
        )
        for bad_payload in bad_payloads:
            with self.subTest(test_source=bad_payload["test_source"]):
                proc = subprocess.run(
                    [sys.executable, "-I", "-c", _RUNNER],
                    input=json.dumps(bad_payload).encode(),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False,
                )
                self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_local_endpoint_and_daemon_log_policy_must_be_pinned(self):
        fake = FakeEvaluator()
        self.authorization_provider = FakeAuthorizationProvider(bad_endpoint_pin=True)
        with self.assertRaisesRegex(CaseRunnerAuthorizationError, "endpoint"):
            self.run_case(fake)
        self.authorization_provider = FakeAuthorizationProvider(bad_logging_pin=True)
        with self.assertRaisesRegex(CaseRunnerAuthorizationError, "log-retention"):
            self.run_case(fake)
        self.assertEqual(fake.calls, 0)

    def test_docker_host_override_and_remote_context_are_rejected(self):
        with patch.dict(os.environ, {"DOCKER_HOST": "tcp://remote.example:2376"}):
            with self.assertRaisesRegex(CaseRunnerAuthorizationError, "override"):
                _local_docker_endpoint()
        with patch.dict(os.environ, {"DOCKER_CONTEXT": "remote-work"}):
            with self.assertRaisesRegex(CaseRunnerAuthorizationError, "override"):
                _local_docker_endpoint()
        with patch.dict(os.environ, {}, clear=True), patch(
            "guru.evaluator_case_runner.subprocess.run",
            side_effect=[SimpleNamespace(stdout="remote-work\n"),
                         SimpleNamespace(stdout="tcp://remote.example:2376\n")],
        ):
            with self.assertRaisesRegex(CaseRunnerAuthorizationError, "not a local"):
                _local_docker_endpoint()
        with patch.dict(os.environ, {}, clear=True), patch(
            "guru.evaluator_case_runner.subprocess.run",
            side_effect=[SimpleNamespace(stdout="default\n"),
                         SimpleNamespace(stdout=ENDPOINT + "\n")],
        ) as docker_run:
            self.assertEqual(_local_docker_endpoint(), ENDPOINT)
        self.assertEqual(len(docker_run.call_args_list), 2)
        self.assertEqual(docker_run.call_args_list[0].args[0], ["docker", "context", "show"])

    def test_truncated_output_is_not_a_completed_case(self):
        evidence, _ = self.run_case(FakeEvaluator(stdout=b"partial", output_limited=True))
        self.assertIs(evidence.status, CaseStatus.UNAVAILABLE)
        self.assertTrue(evidence.output_limited)
        self.assertTrue(evidence.stdout_truncated)
        self.assertTrue(evidence.cleanup_confirmed)

    def test_cleanup_failure_is_infrastructure_error_and_not_a_pass(self):
        evidence, fake = self.run_case(FakeEvaluator(fail_cleanup=True))
        self.assertIs(evidence.status, CaseStatus.INFRASTRUCTURE_ERROR)
        self.assertFalse(evidence.cleanup_confirmed)
        self.assertIsNone(evidence.exit_code)
        self.assertEqual(fake.calls, 1)

    def test_input_is_sent_ephemerally_and_evidence_can_be_chained(self):
        previous = "f" * 64
        evidence, fake = self.run_case(previous_record_digest=previous)
        decoded = json.loads(fake.payload)
        self.assertEqual(decoded["candidate_source"], "def add(a, b):\n    return a + b\n")
        self.assertEqual(decoded["test_source"], TEST_SOURCE)
        self.assertEqual(fake.local_endpoint, ENDPOINT)
        self.assertEqual(evidence.previous_record_digest, previous)

    def test_case_set_preserves_frozen_order_and_chains_record_digests(self):
        ids = ["case-b", "case-a"]
        sources = {
            "case-b": '{"version":1,"cases":[{"function":"add","args":[1,2],"kwargs":{},"expected":3}]}',
            "case-a": '{"version":1,"cases":[{"function":"add","args":[2,2],"kwargs":{},"expected":4}]}',
        }
        start = "f" * 64
        evaluator = FakeEvaluatorSequence([{}, {}])
        result, auth = self.run_case_set(evaluator, case_ids=ids, test_sources=sources,
                                         starting_record_digest=start)
        self.assertIsInstance(result, EvaluatorCaseSet)
        self.assertEqual(result.expected_case_ids, ids)
        self.assertEqual([case.case_id for case in result.cases], ids)
        self.assertEqual(result.starting_record_digest, start)
        self.assertEqual(result.cases[0].previous_record_digest, start)
        self.assertEqual(result.cases[1].previous_record_digest, result.cases[0].record_digest)
        self.assertEqual([case.status for case in result.cases], [CaseStatus.PASS, CaseStatus.PASS])
        self.assertEqual(len(evaluator.calls), 2)
        self.assertEqual(auth.calls, 1)
        self.assertEqual(self.rights_provider.calls, 1)

    def test_case_set_preflights_every_case_pin_before_evaluation(self):
        ids = ["case-b", "case-a"]
        sources = {
            "case-b": '{"version":1,"cases":[{"function":"add","args":[1,2],"kwargs":{},"expected":3}]}',
            "case-a": '{"version":1,"cases":[{"function":"add","args":[2,2],"kwargs":{},"expected":4}]}',
        }
        auth = FakeCaseSetAuthorizationProvider(case_ids=ids, test_sources=sources, bad_case_manifest=True)
        evaluator = FakeEvaluatorSequence([{}, {}])
        with self.assertRaisesRegex(CaseRunnerAuthorizationError, "case manifest"):
            self.run_case_set(evaluator, case_ids=ids, test_sources=sources, authorization_provider=auth)
        self.assertEqual(evaluator.calls, [])

    def test_case_set_rejects_id_and_test_digest_mismatch_before_evaluation(self):
        ids = ["case-b", "case-a"]
        sources = {
            "case-b": '{"version":1,"cases":[{"function":"add","args":[1,2],"kwargs":{},"expected":3}]}',
            "case-a": '{"version":1,"cases":[{"function":"add","args":[2,2],"kwargs":{},"expected":4}]}',
        }
        evaluator = FakeEvaluatorSequence([{}, {}])
        auth = FakeCaseSetAuthorizationProvider(case_ids=["case-a", "case-b"], test_sources=sources)
        with self.assertRaisesRegex(CaseRunnerAuthorizationError, "case IDs or test digests"):
            self.run_case_set(evaluator, case_ids=ids, test_sources=sources, authorization_provider=auth)
        self.assertEqual(evaluator.calls, [])

    def test_case_set_preflights_rights_qualification_runtime_and_limits(self):
        ids = ["case-b", "case-a"]
        sources = {
            "case-b": '{"version":1,"cases":[{"function":"add","args":[1,2],"kwargs":{},"expected":3}]}',
            "case-a": '{"version":1,"cases":[{"function":"add","args":[2,2],"kwargs":{},"expected":4}]}',
        }
        bad_providers = (
            FakeCaseSetAuthorizationProvider(case_ids=ids, test_sources=sources, bad_qualification_pin=True),
            FakeCaseSetAuthorizationProvider(case_ids=ids, test_sources=sources, bad_endpoint_pin=True),
            FakeCaseSetAuthorizationProvider(case_ids=ids, test_sources=sources, bad_logging_pin=True),
            FakeCaseSetAuthorizationProvider(case_ids=ids, test_sources=sources, bad_suite_pin=True),
            FakeCaseSetAuthorizationProvider(case_ids=ids, test_sources=sources, bad_config=True),
            FakeCaseSetAuthorizationProvider(case_ids=ids, test_sources=sources, bad_image=True),
        )
        for auth in bad_providers:
            with self.subTest(auth=auth):
                evaluator = FakeEvaluatorSequence([{}, {}])
                with self.assertRaises(CaseRunnerAuthorizationError):
                    self.run_case_set(evaluator, case_ids=ids, test_sources=sources, authorization_provider=auth)
                self.assertEqual(evaluator.calls, [])

        evaluator = FakeEvaluatorSequence([{}, {}])
        self.rights_provider = FakeRightsProvider(rights(allow_evaluation=False))
        with self.assertRaisesRegex(CaseRunnerAuthorizationError, "do not permit"):
            self.run_case_set(evaluator, case_ids=ids, test_sources=sources)
        self.assertEqual(evaluator.calls, [])

        self.rights_provider = FakeRightsProvider()
        evaluator = FakeEvaluatorSequence([{}, {}])
        tiny_policy = EvaluationPolicy(image=IMAGE, command=RUNNER_COMMAND, input_limit_bytes=1)
        with patch("guru.evaluator_case_runner._local_docker_endpoint", return_value=ENDPOINT):
            with patch("guru.evaluator_case_runner.evaluate", side_effect=evaluator):
                with self.assertRaisesRegex(EvaluationError, "input exceeds"):
                    run_python_case_set(
                        item=item(), candidate_source="def add(a,b): return a+b",
                        case_ids=ids, test_sources=sources, rights_provider=self.rights_provider,
                        authorization_provider=FakeCaseSetAuthorizationProvider(case_ids=ids, test_sources=sources),
                        policy=tiny_policy,
                    )
        self.assertEqual(evaluator.calls, [])

    def test_case_set_continues_after_ordinary_failure(self):
        evaluator = FakeEvaluatorSequence([{"exit_code": 1}, {}])
        result, _ = self.run_case_set(evaluator)
        self.assertEqual([case.status for case in result.cases], [CaseStatus.FAIL, CaseStatus.PASS])
        self.assertEqual(len(evaluator.calls), 2)

    def test_case_set_retains_incomplete_outcomes_but_never_reports_them_as_pass(self):
        for first_outcome, expected in (
            ({"timed_out": True}, CaseStatus.TIMEOUT),
            ({"container_removed": False}, CaseStatus.INFRASTRUCTURE_ERROR),
            ({"output_limited": True}, CaseStatus.UNAVAILABLE),
        ):
            with self.subTest(expected=expected):
                evaluator = FakeEvaluatorSequence([first_outcome, {}])
                result, _ = self.run_case_set(evaluator)
                self.assertEqual([case.status for case in result.cases], [expected, CaseStatus.PASS])
                self.assertEqual(len(evaluator.calls), 2)
                self.assertFalse(result.cases[0].status is CaseStatus.PASS)
                self.assertFalse(result.cases[0].cleanup_confirmed if expected is CaseStatus.INFRASTRUCTURE_ERROR else False)


if __name__ == "__main__":
    unittest.main()
