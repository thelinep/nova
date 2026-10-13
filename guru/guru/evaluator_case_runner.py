"""Rights- and qualification-bound execution of one frozen Python test case.

This is a case-runner scaffold over the Docker evaluator primitive. It does
not qualify a Docker host, image, runner, or isolation boundary. Rights,
qualification, test-suite, endpoint, and container logging pins must come from
trusted composition-root providers; no production provider composition is
configured. Proposal and harness bytes are sent only to a verified local
Docker endpoint whose container log configuration is inspected by full ID
before start, and are never written by this module. A daemon-wide default does
not prove this container's policy.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import subprocess
from types import MappingProxyType
from typing import Any, Mapping, Sequence

from guru.code_evaluator import (
    DOCKER_ENGINE_RECOVERY_VERSION,
    EvaluationError,
    EvaluationPolicy,
    evaluate,
)
from guru.evaluator_evidence import _ZERO_DIGEST, seal_case
from guru.quality.providers import ApprovedRightsInputs, RightsEvidenceProvider
from guru.quality.use_scope import GURU_USE_SCOPE_POLICY
from guru.schemas.corpus_item import CorpusItem
from guru.schemas.evaluator_evidence import (
    CaseStatus,
    EvaluationCaseEvidence,
    EvaluatorCaseSet,
    EvaluatorQualificationEvidence,
    ResourceLimits,
)
from guru.schemas.rights_decision import RightsDecision
from guru.schemas.teacher_lineage import TeacherLineage
from guru.teacher.intake import validate_teacher


class CaseRunnerAuthorizationError(ValueError):
    """The source or local evaluator is not authorized for this case."""


@dataclass(frozen=True)
class PinnedLocalCaseRunnerInputs:
    """Qualification and frozen-test pins from a trusted composition root."""

    qualification: EvaluatorQualificationEvidence
    qualification_digest: str
    trusted_qualification_digest: str
    test_digest: str
    trusted_test_digest: str
    test_suite_digest: str
    trusted_test_suite_digest: str
    docker_endpoint_digest: str
    trusted_docker_endpoint_digest: str
    daemon_logging_policy_digest: str
    trusted_daemon_logging_policy_digest: str
    expected_case_ids: tuple[str, ...] | None = None
    expected_case_test_digests: Mapping[str, str] | None = None
    expected_cases_digest: str | None = None
    trusted_expected_cases_digest: str | None = None


class LocalCaseRunnerAuthorizationProvider(ABC):
    """Privileged source for qualification and frozen-harness pins.

    Guru currently has no production composition-root implementation.
    Implementations must be constructed by the application composition root,
    never from request data or caller-provided values.
    """

    @abstractmethod
    def load_for(
        self, item: CorpusItem, *, config_digest: str, image_digest: str,
    ) -> PinnedLocalCaseRunnerInputs | None:
        """Return externally pinned qualification and test-suite digests."""


# Candidate code and frozen cases use separate processes. The outer runner
# owns all assertions and receives only JSON values from one short-lived
# candidate process per case. In particular, candidate os._exit(0) cannot
# skip the outer runner's remaining cases or assertion checks.
_CANDIDATE_RUNNER = r'''import contextlib, io, json, sys, traceback
protocol_stdout = sys.stdout
try:
    request = json.load(sys.stdin)
    namespace = {"__name__": "__main__", "__file__": "<guru-candidate>"}
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        exec(compile(request["candidate_source"], "<guru-candidate>", "exec"), namespace, namespace)
        function = namespace[request["function"]]
        result = function(*request["args"], **request["kwargs"])
    encoded = json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    protocol_stdout.write(encoded + "\n")
    protocol_stdout.flush()
except BaseException:
    traceback.print_exc(file=sys.stderr)
    raise SystemExit(1)
'''

# Fixed, standard-library-only entry point. `test_source` is a data-only JSON
# suite; it is never compiled or executed as Python. Expected values stay in
# this parent process and are not included in candidate requests.
_RUNNER = r'''import json, os, signal, subprocess, sys, traceback
_CASE_RUNNER = ''' + repr(_CANDIDATE_RUNNER) + r'''
def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result
def parse_suite(source):
    try:
        suite = json.loads(source, object_pairs_hook=reject_duplicate_keys,
                           parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (TypeError, ValueError, json.JSONDecodeError):
        raise ValueError("test suite must be valid JSON")
    if (not isinstance(suite, dict) or set(suite) != {"version", "cases"} or
            type(suite["version"]) is not int or suite["version"] != 1):
        raise ValueError("test suite must use version 1 schema")
    cases = suite["cases"]
    if not isinstance(cases, list) or not cases:
        raise ValueError("test suite must contain at least one case")
    for case in cases:
        if not isinstance(case, dict) or set(case) != {"function", "args", "kwargs", "expected"}:
            raise ValueError("test case has invalid fields")
        if (not isinstance(case["function"], str) or not case["function"].isidentifier() or
                not isinstance(case["args"], list) or not isinstance(case["kwargs"], dict)):
            raise ValueError("test case has invalid call shape")
    return cases
try:
    payload = json.load(sys.stdin)
    candidate = payload["candidate_source"]
    cases = parse_suite(payload["test_source"])
    for case in cases:
        request = {"candidate_source": candidate, "function": case["function"],
                   "args": case["args"], "kwargs": case["kwargs"]}
        child = subprocess.Popen(
            [sys.executable, "-I", "-c", _CASE_RUNNER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        )
        request_bytes = json.dumps(
            request, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")
        try:
            stdout, stderr = child.communicate(input=request_bytes, timeout=5)
        except subprocess.TimeoutExpired:
            # Candidate descendants inherit the protocol pipes. Kill the whole
            # process group before reaping the direct child. Detached
            # descendants can escape that group, so pipe closure and bounded
            # direct-child reaping are also required; Docker container removal
            # remains the final descendant cleanup boundary.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except OSError:
                try:
                    child.kill()
                except OSError:
                    pass
            for stream in (child.stdout, child.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                try:
                    child.kill()
                except OSError:
                    pass
                try:
                    child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    pass
            raise RuntimeError("candidate process timed out")
        if child.returncode != 0:
            raise RuntimeError("candidate process failed")
        if len(stdout) > 65536 or len(stderr) > 65536:
            raise RuntimeError("candidate process output exceeded limit")
        lines = stdout.splitlines()
        if len(lines) != 1:
            raise RuntimeError("candidate process did not return exactly one result")
        response = json.loads(lines[0], object_pairs_hook=reject_duplicate_keys,
                              parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        if not isinstance(response, dict) or set(response) != {"ok", "result"} or response["ok"] is not True:
            raise RuntimeError("candidate process returned an invalid result")
        expected_json = json.dumps(case["expected"], sort_keys=True, ensure_ascii=False,
                                   allow_nan=False, separators=(",", ":"))
        result_json = json.dumps(response["result"], sort_keys=True, ensure_ascii=False,
                                 allow_nan=False, separators=(",", ":"))
        if result_json != expected_json:
            raise AssertionError("candidate result did not match expected value")
except BaseException:
    traceback.print_exc(file=sys.stderr)
    raise SystemExit(1)
'''
RUNNER_COMMAND = ("python", "-I", "-c", _RUNNER)
RUNNER_VERSION = "guru-python-case-runner-v3"
# Historical authorization-record field names remain stable. This versioned
# policy is enforced against each exact container before it is started.
DAEMON_LOGGING_POLICY = "per-container-log-driver-none-inspected-before-start-v1"
MAX_QUALIFICATION_AGE = timedelta(days=90)


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical_digest(value: Any) -> str:
    return _digest(json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8"))


def evaluator_config_digest(policy: EvaluationPolicy, *, docker_endpoint: str = "") -> str:
    """Digest every evaluator setting and the fixed runner implementation."""
    return _canonical_digest({
        "runner_version": RUNNER_VERSION,
        "engine_recovery_version": DOCKER_ENGINE_RECOVERY_VERSION,
        "docker_endpoint": docker_endpoint,
        "daemon_logging_policy": DAEMON_LOGGING_POLICY,
        "command": list(policy.command),
        "image": policy.image,
        "timeout_seconds": policy.timeout_seconds,
        "memory_bytes": policy.memory_bytes,
        "cpu_count": policy.cpu_count,
        "pids_limit": policy.pids_limit,
        "tmpfs_bytes": policy.tmpfs_bytes,
        "input_limit_bytes": policy.input_limit_bytes,
        "output_limit_bytes": policy.output_limit_bytes,
        "control_timeout_seconds": policy.control_timeout_seconds,
    })


def _image_digest(image: str) -> str:
    return image.rsplit("@sha256:", 1)[1]


def _local_docker_endpoint() -> str:
    """Resolve the active Docker context and reject non-local endpoints."""
    # Explicit daemon/context overrides complicate proving which endpoint the
    # Docker CLI primitive will use. Require the ordinary active context.
    if os.environ.get("DOCKER_HOST") or os.environ.get("DOCKER_CONTEXT"):
        raise CaseRunnerAuthorizationError("Docker endpoint override prevents local-only evaluation")
    try:
        context = subprocess.run(
            ["docker", "context", "show"], check=True, capture_output=True,
            text=True, timeout=5, shell=False,
        ).stdout.strip()
        if not context or any(char.isspace() for char in context):
            raise ValueError("invalid active context")
        endpoint = subprocess.run(
            ["docker", "context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"],
            check=True, capture_output=True, text=True, timeout=5, shell=False,
        ).stdout.strip()
        if not endpoint.startswith("unix://"):
            raise CaseRunnerAuthorizationError("Docker endpoint is not a local Unix socket")
    except CaseRunnerAuthorizationError:
        raise
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise CaseRunnerAuthorizationError("cannot verify active Docker endpoint is local") from exc
    return endpoint


def run_python_case(
    *,
    case_id: str,
    item: CorpusItem,
    candidate_source: str,
    test_source: str,
    rights_provider: RightsEvidenceProvider,
    authorization_provider: LocalCaseRunnerAuthorizationProvider,
    policy: EvaluationPolicy,
    previous_record_digest: str = _ZERO_DIGEST,
) -> EvaluationCaseEvidence:
    """Run candidate source with one frozen harness and return sealed evidence.

    Source rights are loaded from a composition-root provider and must bind the
    exact ``item.source_digest``. A separate trusted provider must pin the local
    qualification, image, configuration, test harness, and per-container log policy.
    No production provider composition is currently configured in Guru.
    """
    if not isinstance(item, CorpusItem):
        raise CaseRunnerAuthorizationError("typed corpus item is required")
    if not isinstance(candidate_source, str) or not isinstance(test_source, str):
        raise TypeError("candidate_source and test_source must be strings")
    try:
        candidate_bytes = candidate_source.encode("utf-8")
        test_bytes = test_source.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError("candidate and test suite must contain valid UTF-8 text") from exc
    if len(candidate_bytes) + len(test_bytes) > policy.input_limit_bytes:
        raise EvaluationError("evaluation input exceeds policy limit")
    _validate_test_suite(test_source)
    if not isinstance(rights_provider, RightsEvidenceProvider):
        raise CaseRunnerAuthorizationError("trusted source-rights provider is required")
    approved = rights_provider.load_for(item)
    if not isinstance(approved, ApprovedRightsInputs):
        raise CaseRunnerAuthorizationError("pinned approved source-rights record is unavailable")
    rights_decision = approved.decision
    if not isinstance(rights_decision, RightsDecision):
        raise CaseRunnerAuthorizationError("typed source-rights decision is required")
    if (approved.approved_artifact_digest != item.source_digest or
            rights_decision.artifact_sha256 != item.source_digest):
        raise CaseRunnerAuthorizationError("source rights are not pinned to this exact artifact")
    if (approved.rights_manifest_digest != approved.trusted_rights_manifest_digest or
            not _is_digest(approved.rights_manifest_digest)):
        raise CaseRunnerAuthorizationError("source-rights manifest is not trusted-pinned")
    if item.teacher_lineage_id is not None:
        teachers = approved.teachers
        matches = [teacher for teacher in teachers
                   if isinstance(teacher, TeacherLineage) and
                   teacher.teacher_id == item.teacher_lineage_id]
        if (approved.teacher_registry_digest is None or
                approved.teacher_registry_digest != approved.trusted_teacher_registry_digest or
                not _is_digest(approved.teacher_registry_digest) or
                len(matches) != 1 or not validate_teacher(matches[0])["admissible"]):
            raise CaseRunnerAuthorizationError("teacher lineage or registry pin is unavailable")
    if not GURU_USE_SCOPE_POLICY.permits_evaluation(rights_decision.rights, "local"):
        raise CaseRunnerAuthorizationError("source rights do not permit local evaluation")
    if not isinstance(authorization_provider, LocalCaseRunnerAuthorizationProvider):
        raise CaseRunnerAuthorizationError("trusted local qualification provider is required")
    docker_endpoint = _local_docker_endpoint()
    config_digest = evaluator_config_digest(policy, docker_endpoint=docker_endpoint)
    image_digest = _image_digest(policy.image)
    pinned = authorization_provider.load_for(
        item, config_digest=config_digest, image_digest=image_digest,
    )
    if not isinstance(pinned, PinnedLocalCaseRunnerInputs):
        raise CaseRunnerAuthorizationError("pinned local qualification and test suite are unavailable")
    qualification = pinned.qualification
    if not isinstance(qualification, EvaluatorQualificationEvidence):
        raise CaseRunnerAuthorizationError("typed local evaluator qualification is required")
    qdigest = _canonical_digest(qualification.model_dump(mode="json"))
    if (pinned.qualification_digest != qdigest or
            pinned.trusted_qualification_digest != qdigest or
            not _is_digest(pinned.trusted_qualification_digest)):
        raise CaseRunnerAuthorizationError("qualification evidence does not match trusted provider pin")
    if pinned.expected_case_test_digests is not None:
        if (pinned.expected_case_ids is None or case_id not in pinned.expected_case_ids or
                set(pinned.expected_case_test_digests) != set(pinned.expected_case_ids) or
                any(not _is_digest(value) for value in pinned.expected_case_test_digests.values())):
            raise CaseRunnerAuthorizationError("case IDs or test digests differ from the frozen provider pins")
        case_manifest = _canonical_digest({
            "expected_case_ids": list(pinned.expected_case_ids),
            "expected_case_test_digests": {
                key: pinned.expected_case_test_digests[key] for key in pinned.expected_case_ids
            },
        })
        if (pinned.expected_cases_digest != case_manifest or
                pinned.trusted_expected_cases_digest != case_manifest):
            raise CaseRunnerAuthorizationError("frozen case manifest does not match trusted provider pin")
    if ((pinned.expected_case_test_digests is None and
         (not _is_digest(pinned.test_digest) or pinned.test_digest != pinned.trusted_test_digest or
          not _is_digest(pinned.trusted_test_digest))) or
            not _is_digest(pinned.test_suite_digest) or
            pinned.test_suite_digest != pinned.trusted_test_suite_digest or
            not _is_digest(pinned.trusted_test_suite_digest)):
        raise CaseRunnerAuthorizationError("test harness or suite does not match trusted provider pin")
    endpoint_digest = _digest(docker_endpoint.encode("utf-8"))
    if (pinned.docker_endpoint_digest != endpoint_digest or
            pinned.trusted_docker_endpoint_digest != endpoint_digest or
            not _is_digest(pinned.trusted_docker_endpoint_digest)):
        raise CaseRunnerAuthorizationError("local Docker endpoint does not match trusted qualification pin")
    log_policy_digest = _digest(DAEMON_LOGGING_POLICY.encode("utf-8"))
    if (pinned.daemon_logging_policy_digest != log_policy_digest or
            pinned.trusted_daemon_logging_policy_digest != log_policy_digest):
        raise CaseRunnerAuthorizationError("per-container log-retention policy is not pinned")
    if qualification.execution_scope != "local":
        raise CaseRunnerAuthorizationError("qualification scope is not local")
    if qualification.config_digest != config_digest or qualification.image_digest != image_digest:
        raise CaseRunnerAuthorizationError("qualification does not bind this image and evaluator config")
    if tuple(policy.command) != RUNNER_COMMAND:
        raise CaseRunnerAuthorizationError("policy command differs from the fixed Python case runner")
    started = datetime.now(timezone.utc)
    qualified_at = qualification.qualified_at.astimezone(timezone.utc)
    started_utc = started.astimezone(timezone.utc)
    if qualified_at > started_utc or started_utc - qualified_at > MAX_QUALIFICATION_AGE:
        raise CaseRunnerAuthorizationError("evaluator qualification is stale or future-dated")
    if (not isinstance(previous_record_digest, str) or len(previous_record_digest) != 64 or
            any(character not in "0123456789abcdef" for character in previous_record_digest)):
        raise ValueError("previous_record_digest must be a lowercase SHA-256 digest")

    test_digest = _digest(test_bytes)
    expected_test_digest = pinned.test_digest
    if pinned.expected_case_test_digests is not None:
        expected_test_digest = pinned.expected_case_test_digests.get(case_id, "")
    if test_digest != expected_test_digest:
        raise CaseRunnerAuthorizationError("test harness differs from trusted frozen test digest")
    payload = json.dumps({
        "candidate_source": candidate_source,
        "test_source": test_source,
    }, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(payload) > policy.input_limit_bytes:
        raise EvaluationError("evaluation input exceeds policy limit")

    finished = started_utc
    result = None
    cleanup_confirmed = False
    infrastructure_error = False
    try:
        # Keep the public path pinned to the local Docker CLI primitive. Do not
        # accept an injected engine here: an arbitrary engine could transmit
        # candidate or harness bytes outside the owner-selected local scope.
        result = evaluate(payload, policy, local_endpoint=docker_endpoint)
        cleanup_confirmed = result.container_removed
        finished = max(datetime.now(timezone.utc), started_utc)
    except EvaluationError:
        # The primitive intentionally does not expose partial output when
        # startup/cleanup fails. Record only a digest-only infrastructure
        # outcome; cleanup remains explicitly unconfirmed.
        infrastructure_error = True
        finished = max(datetime.now(timezone.utc), started_utc)

    stdout = result.stdout if result is not None else b""
    stderr = result.stderr if result is not None else b""
    out_limited = bool(result and result.output_limited)
    stdout_truncated = bool(result and result.stdout_truncated)
    stderr_truncated = bool(result and result.stderr_truncated)
    if infrastructure_error or not cleanup_confirmed:
        status = CaseStatus.INFRASTRUCTURE_ERROR
        exit_code = None
    elif result.timed_out:
        status = CaseStatus.TIMEOUT
        exit_code = None
    elif out_limited or stdout_truncated or stderr_truncated:
        # Truncated output cannot be treated as a complete pass/fail result.
        status = CaseStatus.UNAVAILABLE
        exit_code = None
    elif result.exit_code == 0:
        status = CaseStatus.PASS
        exit_code = 0
    else:
        status = CaseStatus.FAIL
        exit_code = result.exit_code

    limits = ResourceLimits(
        timeout_ms=int(policy.timeout_seconds * 1000),
        memory_bytes=policy.memory_bytes,
        cpu_millis=int(policy.cpu_count * 1000),
        pids=policy.pids_limit,
        output_bytes=policy.output_limit_bytes,
        input_bytes=policy.input_limit_bytes,
    )
    record = {
        "schema_version": "guru-evaluator-case-v3",
        "case_id": case_id,
        "item_digest": item.canonical_digest(),
        "task_digest": item.source_digest,
        "candidate_digest": _digest(candidate_bytes),
        "test_digest": test_digest,
        "test_suite_digest": pinned.test_suite_digest,
        "image_digest": image_digest,
        "config_digest": config_digest,
        "command": list(policy.command),
        "limits": limits.model_dump(mode="json"),
        "started_at": started_utc.isoformat(),
        "finished_at": finished.isoformat(),
        "status": status.value,
        "exit_code": exit_code,
        "cleanup_confirmed": cleanup_confirmed,
        "output_limited": out_limited,
        "stdout_truncated": stdout_truncated,
        "stderr_truncated": stderr_truncated,
        "stdout_bytes": len(stdout),
        "stderr_bytes": len(stderr),
        "stdout_digest": _digest(stdout),
        "stderr_digest": _digest(stderr),
        "previous_record_digest": _ZERO_DIGEST,
        "record_digest": _ZERO_DIGEST,
    }
    return seal_case(record, previous_record_digest=previous_record_digest)


def run_python_case_set(
    *,
    item: CorpusItem,
    candidate_source: str,
    case_ids: Sequence[str],
    test_sources: Mapping[str, str],
    rights_provider: RightsEvidenceProvider,
    authorization_provider: LocalCaseRunnerAuthorizationProvider,
    policy: EvaluationPolicy,
    starting_record_digest: str = _ZERO_DIGEST,
) -> EvaluatorCaseSet:
    """Run a frozen ordered suite after preflighting all case and runtime pins.

    Cases execute sequentially through :func:`run_python_case`. Ordinary
    failures do not stop the suite. Incomplete or infrastructure outcomes are
    retained for diagnosis, but the quality ``TESTS`` mapper rejects them and
    therefore cannot treat such a set as passing.
    """
    if not isinstance(item, CorpusItem):
        raise CaseRunnerAuthorizationError("typed corpus item is required")
    if not isinstance(candidate_source, str):
        raise TypeError("candidate_source must be a string")
    if not isinstance(case_ids, Sequence) or isinstance(case_ids, (str, bytes)):
        raise CaseRunnerAuthorizationError("ordered frozen case IDs are required")
    ids = list(case_ids)
    if (not ids or any(not isinstance(case_id, str) or not case_id or len(case_id) > 256 for case_id in ids)
            or len(ids) != len(set(ids))):
        raise CaseRunnerAuthorizationError("frozen case IDs must be non-empty, unique strings")
    if not isinstance(test_sources, Mapping) or set(test_sources) != set(ids):
        raise CaseRunnerAuthorizationError("test sources must exactly match frozen case IDs")
    if not _is_digest(starting_record_digest):
        raise ValueError("starting_record_digest must be a lowercase SHA-256 digest")
    if not isinstance(policy, EvaluationPolicy):
        raise TypeError("policy must be an EvaluationPolicy")

    try:
        candidate_bytes = candidate_source.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError("candidate must contain valid UTF-8 text") from exc
    checked_sources: dict[str, str] = {}
    test_digests: dict[str, str] = {}
    for case_id in ids:
        source = test_sources[case_id]
        if not isinstance(source, str):
            raise TypeError("test_sources values must be strings")
        try:
            source_bytes = source.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise ValueError("test suite must contain valid UTF-8 text") from exc
        if len(_validate_test_suite(source)) != 1:
            raise CaseRunnerAuthorizationError("each case source must contain exactly one test case")
        payload = json.dumps(
            {"candidate_source": candidate_source, "test_source": source},
            ensure_ascii=False, separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")
        if (len(candidate_bytes) + len(source_bytes) > policy.input_limit_bytes or
                len(payload) > policy.input_limit_bytes):
            raise EvaluationError("evaluation input exceeds policy limit")
        checked_sources[case_id] = source
        test_digests[case_id] = _digest(source_bytes)

    # Validate all shared rights and runtime pins before the first backend call.
    if not isinstance(rights_provider, RightsEvidenceProvider):
        raise CaseRunnerAuthorizationError("trusted source-rights provider is required")
    approved = rights_provider.load_for(item)
    if not isinstance(approved, ApprovedRightsInputs):
        raise CaseRunnerAuthorizationError("pinned approved source-rights record is unavailable")
    rights_decision = approved.decision
    if not isinstance(rights_decision, RightsDecision):
        raise CaseRunnerAuthorizationError("typed source-rights decision is required")
    if (approved.approved_artifact_digest != item.source_digest or
            rights_decision.artifact_sha256 != item.source_digest):
        raise CaseRunnerAuthorizationError("source rights are not pinned to this exact artifact")
    if (approved.rights_manifest_digest != approved.trusted_rights_manifest_digest or
            not _is_digest(approved.rights_manifest_digest)):
        raise CaseRunnerAuthorizationError("source-rights manifest is not trusted-pinned")
    if item.teacher_lineage_id is not None:
        matches = [teacher for teacher in approved.teachers
                   if isinstance(teacher, TeacherLineage) and teacher.teacher_id == item.teacher_lineage_id]
        if (approved.teacher_registry_digest is None or
                approved.teacher_registry_digest != approved.trusted_teacher_registry_digest or
                not _is_digest(approved.teacher_registry_digest) or len(matches) != 1 or
                not validate_teacher(matches[0])["admissible"]):
            raise CaseRunnerAuthorizationError("teacher lineage or registry pin is unavailable")
    if not GURU_USE_SCOPE_POLICY.permits_evaluation(rights_decision.rights, "local"):
        raise CaseRunnerAuthorizationError("source rights do not permit local evaluation")
    if not isinstance(authorization_provider, LocalCaseRunnerAuthorizationProvider):
        raise CaseRunnerAuthorizationError("trusted local qualification provider is required")

    endpoint = _local_docker_endpoint()
    config_digest = evaluator_config_digest(policy, docker_endpoint=endpoint)
    image_digest = _image_digest(policy.image)
    pinned = authorization_provider.load_for(item, config_digest=config_digest, image_digest=image_digest)
    if not isinstance(pinned, PinnedLocalCaseRunnerInputs):
        raise CaseRunnerAuthorizationError("pinned local qualification and test suite are unavailable")
    qualification = pinned.qualification
    if not isinstance(qualification, EvaluatorQualificationEvidence):
        raise CaseRunnerAuthorizationError("typed local evaluator qualification is required")
    qdigest = _canonical_digest(qualification.model_dump(mode="json"))
    if (pinned.qualification_digest != qdigest or pinned.trusted_qualification_digest != qdigest or
            not _is_digest(qdigest)):
        raise CaseRunnerAuthorizationError("qualification evidence does not match trusted provider pin")

    if (pinned.expected_case_ids is None or pinned.expected_case_test_digests is None or
            list(pinned.expected_case_ids) != ids or
            set(pinned.expected_case_test_digests) != set(ids) or
            any(pinned.expected_case_test_digests.get(case_id) != test_digests[case_id] for case_id in ids)):
        raise CaseRunnerAuthorizationError("case IDs or test digests differ from the frozen provider pins")
    case_manifest = _canonical_digest({
        "expected_case_ids": ids,
        "expected_case_test_digests": {case_id: test_digests[case_id] for case_id in ids},
    })
    if (pinned.expected_cases_digest != case_manifest or
            pinned.trusted_expected_cases_digest != case_manifest):
        raise CaseRunnerAuthorizationError("frozen case manifest does not match trusted provider pin")

    endpoint_digest = _digest(endpoint.encode("utf-8"))
    if (pinned.docker_endpoint_digest != endpoint_digest or
            pinned.trusted_docker_endpoint_digest != endpoint_digest):
        raise CaseRunnerAuthorizationError("local Docker endpoint does not match trusted qualification pin")
    logging_digest = _digest(DAEMON_LOGGING_POLICY.encode("utf-8"))
    if (pinned.daemon_logging_policy_digest != logging_digest or
            pinned.trusted_daemon_logging_policy_digest != logging_digest):
        raise CaseRunnerAuthorizationError("per-container log-retention policy is not pinned")
    if (not _is_digest(pinned.test_suite_digest) or
            pinned.test_suite_digest != pinned.trusted_test_suite_digest):
        raise CaseRunnerAuthorizationError("test suite does not match trusted provider pin")
    if (qualification.execution_scope != "local" or qualification.config_digest != config_digest or
            qualification.image_digest != image_digest):
        raise CaseRunnerAuthorizationError("qualification does not bind this local image and config")
    if tuple(policy.command) != RUNNER_COMMAND:
        raise CaseRunnerAuthorizationError("policy command differs from the fixed Python case runner")
    now = datetime.now(timezone.utc)
    qualified_at = qualification.qualified_at.astimezone(timezone.utc)
    if qualified_at > now or now - qualified_at > MAX_QUALIFICATION_AGE:
        raise CaseRunnerAuthorizationError("evaluator qualification is stale or future-dated")
    if (policy.timeout_seconds <= 0 or policy.memory_bytes <= 0 or policy.cpu_count <= 0 or
            policy.pids_limit <= 0 or policy.output_limit_bytes <= 0 or policy.input_limit_bytes <= 0):
        raise CaseRunnerAuthorizationError("evaluator resource limits must be positive")
    frozen_pinned = replace(
        pinned,
        expected_case_ids=tuple(ids),
        expected_case_test_digests=MappingProxyType(
            {case_id: test_digests[case_id] for case_id in ids}
        ),
    )

    # Reuse the exact preflight snapshots for every case. The local runner
    # repeats its checks, while these wrappers prevent a mutable external
    # provider from swapping the approved record or frozen pins mid-suite.
    class _FrozenRightsProvider(RightsEvidenceProvider):
        def load_for(self, requested_item):
            if requested_item.canonical_digest() != item.canonical_digest():
                return None
            return approved

    class _FrozenAuthorizationProvider(LocalCaseRunnerAuthorizationProvider):
        def load_for(self, requested_item, *, config_digest, image_digest):
            if (requested_item.canonical_digest() != item.canonical_digest() or
                    config_digest != qualification.config_digest or image_digest != qualification.image_digest):
                return None
            return frozen_pinned

    frozen_rights_provider = _FrozenRightsProvider()
    frozen_authorization_provider = _FrozenAuthorizationProvider()

    records: list[EvaluationCaseEvidence] = []
    previous = starting_record_digest
    for case_id in ids:
        record = run_python_case(
            case_id=case_id, item=item, candidate_source=candidate_source,
            test_source=checked_sources[case_id], rights_provider=frozen_rights_provider,
            authorization_provider=frozen_authorization_provider, policy=policy,
            previous_record_digest=previous,
        )
        records.append(record)
        previous = record.record_digest
    return EvaluatorCaseSet(
        schema_version="guru-evaluator-case-set-v1",
        item_digest=item.canonical_digest(), test_suite_digest=pinned.test_suite_digest,
        config_digest=config_digest, starting_record_digest=starting_record_digest,
        expected_case_ids=ids, cases=records,
    )


def _is_digest(value: str) -> bool:
    return (isinstance(value, str) and len(value) == 64 and
            all(character in "0123456789abcdef" for character in value))


def _validate_test_suite(source: str) -> list[dict[str, Any]]:
    """Validate the data-only function-call test format before Docker I/O."""
    def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON object key: {key}")
            result[key] = value
        return result

    def reject_constant(value: str):
        raise ValueError(f"invalid JSON constant: {value}")

    try:
        suite = json.loads(
            source, object_pairs_hook=reject_duplicate_keys,
            parse_constant=reject_constant,
        )
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise CaseRunnerAuthorizationError("test suite must be valid JSON") from exc
    if (not isinstance(suite, dict) or set(suite) != {"version", "cases"} or
            type(suite.get("version")) is not int or suite.get("version") != 1):
        raise CaseRunnerAuthorizationError("test suite must use version 1 schema")
    cases = suite.get("cases")
    if not isinstance(cases, list) or not cases:
        raise CaseRunnerAuthorizationError("test suite must contain at least one case")
    for case in cases:
        if (not isinstance(case, dict) or
                set(case) != {"function", "args", "kwargs", "expected"} or
                not isinstance(case.get("function"), str) or
                not case["function"].isidentifier() or
                not isinstance(case.get("args"), list) or
                not isinstance(case.get("kwargs"), dict)):
            raise CaseRunnerAuthorizationError("test case has invalid call shape")
    return cases
