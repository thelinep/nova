"""Mock-only tests for evaluator policy and lifecycle (not isolation tests)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from guru.code_evaluator import (
    DockerCliEngine, EngineResult, EvaluationError, EvaluationPolicy,
    evaluate, _docker_options,
)


IMAGE = "registry.example.invalid/guru-runner@sha256:" + "a" * 64
CONTAINER_ID = "b" * 64


class FakeEngine:
    def __init__(self, result=None, fail_start=False, fail_remove=False):
        self.result = result or EngineResult(0, b"ok", b"")
        self.fail_start = fail_start
        self.fail_remove = fail_remove
        self.created = []
        self.started = []
        self.removed = []

    def create(self, policy, name):
        self.created.append((policy, name))
        return CONTAINER_ID

    def start(self, container_id, payload, policy):
        self.started.append((container_id, payload))
        if self.fail_start:
            raise RuntimeError("mock start failure")
        return self.result

    def remove(self, container_id, policy):
        self.removed.append(container_id)
        if self.fail_remove:
            raise RuntimeError("mock cleanup failure")


def policy(**overrides):
    values = {"image": IMAGE, "command": ("/opt/runner", "--stdin-json")}
    values.update(overrides)
    return EvaluationPolicy(**values)


class EvaluationPolicyTests(unittest.TestCase):
    def test_requires_digest_pinned_image(self):
        for image in ("latest", "repo/image:tag", "repo/image@sha256:short"):
            with self.subTest(image=image), self.assertRaises(ValueError):
                policy(image=image)

    def test_rejects_unsafe_or_unbounded_policy_values(self):
        for kwargs in ({"timeout_seconds": 301}, {"memory_bytes": 10},
                       {"cpu_count": 0}, {"pids_limit": 0},
                       {"input_limit_bytes": 17 * 1024**2}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                policy(**kwargs)

    def test_constructed_container_has_no_network_mounts_or_credentials(self):
        args = _docker_options(policy(), "guru-eval-" + "c" * 32)
        self.assertIn("none", args)
        self.assertIn("--read-only", args)
        self.assertIn("--cap-drop", args)
        self.assertIn("ALL", args)
        self.assertIn("no-new-privileges", args)
        self.assertIn("--memory-swap", args)
        self.assertIn("--pids-limit", args)
        self.assertIn("--tmpfs", args)
        self.assertFalse(any(x in {"--mount", "-v", "--volume", "--env", "-e", "--env-file", "--privileged", "--device"} for x in args))
        self.assertFalse(any("secret" in x.lower() or "token" in x.lower() for x in args))

    def test_rejects_invalid_generated_name_before_docker_call(self):
        with self.assertRaises(ValueError):
            _docker_options(policy(), "host-path")


class EvaluationLifecycleTests(unittest.TestCase):
    def test_happy_path_records_hash_and_cleanup(self):
        fake = FakeEngine(EngineResult(7, b"bounded stdout", b"diagnostic"))
        evidence = evaluate(b"opaque request", policy(), fake)
        self.assertEqual(evidence.exit_code, 7)
        self.assertEqual(len(evidence.input_sha256), 64)
        self.assertTrue(evidence.container_removed)
        self.assertEqual(fake.removed, [CONTAINER_ID])
        self.assertEqual(fake.started[0][1], b"opaque request")

    def test_removes_container_after_start_failure(self):
        fake = FakeEngine(fail_start=True)
        with self.assertRaisesRegex(RuntimeError, "mock start failure"):
            evaluate(b"payload", policy(), fake)
        self.assertEqual(fake.removed, [CONTAINER_ID])

    def test_cleanup_failure_fails_closed(self):
        fake = FakeEngine(fail_remove=True)
        with self.assertRaisesRegex(RuntimeError, "mock cleanup failure"):
            evaluate(b"payload", policy(), fake)

    def test_rejects_oversized_input_before_creating_container(self):
        fake = FakeEngine()
        with self.assertRaisesRegex(EvaluationError, "input exceeds"):
            evaluate(b"12345", policy(input_limit_bytes=4), fake)
        self.assertEqual(fake.created, [])

    def test_bounds_combined_evidence_output(self):
        fake = FakeEngine(EngineResult(0, b"a" * 1200, b"b" * 100, output_limited=True))
        evidence = evaluate(b"x", policy(output_limit_bytes=1024), fake)
        self.assertLessEqual(len(evidence.stdout) + len(evidence.stderr), 1024)
        self.assertTrue(evidence.output_limited)
        self.assertTrue(evidence.stdout_truncated)


if __name__ == "__main__":
    unittest.main()
