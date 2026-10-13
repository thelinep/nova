"""Synthetic-only evaluator prequalification; deliberately not a quality gate.

The runner accepts no candidate, task, corpus, or test-suite input. It can emit
prequalification evidence, but only a separate trusted composition root may
promote a report after disposable-worker attestation and independent review.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
from typing import Any
from urllib.parse import urlparse

from pydantic import ValidationError

from guru.code_evaluator import EvaluationPolicy, evaluate
from guru.schemas.evaluator_prequalification import (
    DisposableWorkerAttestation,
    EXPECTED_PROBE_CODES,
    EvaluatorPrequalificationReport,
    EvaluatorPromotionDecision,
    IndependentEvaluatorReview,
    PrequalificationStatus,
    ProbeStatus,
    PromotionStatus,
    QualificationProbeEvidence,
    QualificationProbeId,
    REQUIRED_PROBE_IDS,
    ReviewDisposition,
    WorkerLifecycle,
    ZERO_DIGEST,
)


TOOL_VERSION = "guru-evaluator-prequalification-v1"
MAX_REVIEW_AGE = timedelta(days=90)
# No runtime image has independent security approval. Until an owner/reviewer
# approves one and that exact digest is added in a reviewed code change, the
# CLI emits unavailable probes without contacting Docker.
APPROVED_PROBE_IMAGE_REF: str | None = None
PINNED_IMAGE = re.compile(
    r"^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?"
    r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$"
)
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()

# The program is fixed in the package. Input to it is only a probe ID plus
# constants below; arbitrary source/test text is never accepted by this API.
_PROBE_PROGRAM = r'''import json, os, pathlib, sys, time
request = json.load(sys.stdin)
probe = request.get("probe_id")
def status_fields():
    out = {}
    for line in pathlib.Path("/proc/self/status").read_text().splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            if key in {"Uid", "Gid", "NoNewPrivs", "Seccomp", "CapEff"}:
                out[key] = value.strip()
    return out
def cgroup(name):
    candidates = [pathlib.Path("/sys/fs/cgroup") / name,
                  pathlib.Path("/sys/fs/cgroup/cpu") / name]
    for path in candidates:
        try:
            return path.read_text().strip()
        except OSError:
            pass
    raise RuntimeError("cgroup_value_unavailable")
if probe == "effective_container_isolation":
    fields = status_fields()
    if not (fields.get("Uid", "").split()[0] == "65534" and
            fields.get("Gid", "").split()[0] == "65534" and
            fields.get("NoNewPrivs") == "1" and fields.get("Seccomp") == "2" and
            fields.get("CapEff") == "0000000000000000"):
        raise SystemExit(21)
    try:
        pathlib.Path("/guru-readonly-probe").write_text("x")
    except OSError:
        pass
    else:
        raise SystemExit(22)
    print("guru-probe-ok")
elif probe == "network_and_host_isolation":
    interfaces = {path.name for path in pathlib.Path("/sys/class/net").iterdir()}
    if interfaces - {"lo"}:
        raise SystemExit(23)
    routes = pathlib.Path("/proc/net/route").read_text().splitlines()[1:]
    if any(len(row.split()) > 1 and row.split()[1] == "00000000" for row in routes):
        raise SystemExit(24)
    if pathlib.Path("/var/run/docker.sock").exists():
        raise SystemExit(25)
    print("guru-probe-ok")
elif probe == "resource_limits":
    cpu = cgroup("cpu.max")
    memory = cgroup("memory.max")
    pids = cgroup("pids.max")
    if cpu.split() != ["50000", "100000"]:
        raise SystemExit(26)
    if memory != str(64 * 1024 * 1024) or pids != "16":
        raise SystemExit(27)
    children = []
    pid_limit_blocked = False
    try:
        for _ in range(32):
            try:
                child = os.fork()
            except OSError:
                pid_limit_blocked = True
                break
            if child == 0:
                time.sleep(30)
                os._exit(0)
            children.append(child)
    finally:
        for child in children:
            try:
                os.kill(child, 9)
            except OSError:
                pass
        for child in children:
            try:
                os.waitpid(child, 0)
            except OSError:
                pass
    if not pid_limit_blocked:
        raise SystemExit(31)
    # Fill the one-MiB scratch mount and require ENOSPC before it exceeds cap.
    target = pathlib.Path("/tmp/guru-scratch-probe")
    written = 0
    try:
        with target.open("wb") as stream:
            chunk = b"x" * 65536
            while written <= 1024 * 1024:
                stream.write(chunk)
                written += len(chunk)
    except OSError as error:
        if error.errno != 28 or written > 2 * 1024 * 1024:
            raise SystemExit(28)
    else:
        raise SystemExit(29)
    try:
        target.unlink()
    except OSError:
        pass
    print("guru-probe-ok")
elif probe == "output_limit":
    sys.stdout.write("X" * 65536)
    sys.stdout.flush()
elif probe == "wall_timeout":
    time.sleep(4)
elif probe == "fresh_container_cleanup":
    print("guru-probe-ok")
elif probe == "synthetic_exit_zero":
    print("guru-probe-ok")
elif probe == "synthetic_exit_nonzero":
    raise SystemExit(7)
else:
    raise SystemExit(30)
'''

_LIVE_PROBES = {
    QualificationProbeId.EFFECTIVE_CONTAINER_ISOLATION,
    QualificationProbeId.NETWORK_AND_HOST_ISOLATION,
    QualificationProbeId.RESOURCE_LIMITS,
    QualificationProbeId.OUTPUT_LIMIT,
    QualificationProbeId.WALL_TIMEOUT,
    QualificationProbeId.FRESH_CONTAINER_CLEANUP,
    QualificationProbeId.SYNTHETIC_EXIT_ZERO,
    QualificationProbeId.SYNTHETIC_EXIT_NONZERO,
}
_EXTERNAL_PROBE_CODES = {
    QualificationProbeId.DISPOSABLE_WORKER_LIFECYCLE: "owner_attested_worker_required",
    QualificationProbeId.CANCELLATION_CLEANUP: "external_cancellation_driver_required",
    QualificationProbeId.RUNNER_CRASH_ORPHAN_REAP: "external_crash_driver_required",
    QualificationProbeId.DAEMON_RESTART_REAP: "external_daemon_restart_required",
    QualificationProbeId.HOST_RESTART_AND_RESET: "external_host_reset_receipts_required",
    QualificationProbeId.ADVERSARIAL_ACCEPTANCE_SUITE: "approved_external_adversarial_matrix_required",
    QualificationProbeId.CASE_TEST_PASS_MAPPING: "isolated_case_test_adapter_not_qualified",
    QualificationProbeId.CASE_TEST_FAIL_MAPPING: "isolated_case_test_adapter_not_qualified",
    QualificationProbeId.EVIDENCE_INTEGRITY_REPLAY: "local_contract_test_only_not_runtime_qualification",
    QualificationProbeId.FROZEN_RUNTIME_POLICY: "independent_runtime_lock_review_required",
}


def _canonical_bytes(value: Any) -> bytes:
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def canonical_digest(value: Any) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _payload_without_digest(model: Any, field_name: str) -> dict[str, Any]:
    value = model.model_dump(mode="json")
    value.pop(field_name)
    return value


def seal_report(report: EvaluatorPrequalificationReport | dict[str, Any]) -> EvaluatorPrequalificationReport:
    """Return a normalized report whose digest covers every other field."""
    value = report.model_dump(mode="json") if isinstance(report, EvaluatorPrequalificationReport) else dict(report)
    value["report_digest"] = ZERO_DIGEST
    normalized = EvaluatorPrequalificationReport.model_validate(value).model_dump(mode="json")
    normalized.pop("report_digest")
    normalized["report_digest"] = hashlib.sha256(_canonical_bytes(normalized)).hexdigest()
    return EvaluatorPrequalificationReport.model_validate(normalized)


def verify_report(report: EvaluatorPrequalificationReport) -> bool:
    if not isinstance(report, EvaluatorPrequalificationReport):
        return False
    payload = _payload_without_digest(report, "report_digest")
    return canonical_digest(payload) == report.report_digest


def seal_decision(decision: EvaluatorPromotionDecision | dict[str, Any]) -> EvaluatorPromotionDecision:
    value = decision.model_dump(mode="json") if isinstance(decision, EvaluatorPromotionDecision) else dict(decision)
    value["decision_digest"] = ZERO_DIGEST
    normalized = EvaluatorPromotionDecision.model_validate(value).model_dump(mode="json")
    normalized.pop("decision_digest")
    normalized["decision_digest"] = hashlib.sha256(_canonical_bytes(normalized)).hexdigest()
    return EvaluatorPromotionDecision.model_validate(normalized)


def verify_decision(decision: EvaluatorPromotionDecision) -> bool:
    if not isinstance(decision, EvaluatorPromotionDecision):
        return False
    return canonical_digest(_payload_without_digest(decision, "decision_digest")) == decision.decision_digest


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def write_report_atomic(path: str | os.PathLike[str], report: EvaluatorPrequalificationReport) -> None:
    """Persist only canonical digest-bound metadata, never probe output bytes."""
    if not verify_report(report):
        raise ValueError("cannot write report with invalid integrity digest")
    target = Path(path)
    if not target.parent.is_dir():
        raise FileNotFoundError("report parent directory must already exist")
    content = _canonical_bytes(report) + b"\n"
    fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        directory_fd = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def replay_report(path: str | os.PathLike[str]) -> EvaluatorPrequalificationReport:
    """Load only canonical JSON with a valid self-digest; reject duplicate keys."""
    raw = Path(path).read_bytes()
    if not raw.endswith(b"\n"):
        raise ValueError("report has a truncated final line")
    try:
        value = json.loads(raw, object_pairs_hook=_reject_duplicate_keys)
        report = EvaluatorPrequalificationReport.model_validate(value)
    except (UnicodeDecodeError, json.JSONDecodeError, ValidationError, ValueError) as exc:
        raise ValueError("report JSON or schema validation failed") from exc
    if _canonical_bytes(report) + b"\n" != raw:
        raise ValueError("report is not canonical JSON")
    if not verify_report(report):
        raise ValueError("report integrity digest mismatch")
    return report


def _digest_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _validate_local_endpoint(endpoint: str, *, require_socket: bool = True) -> str:
    if not isinstance(endpoint, str) or "\x00" in endpoint:
        raise ValueError("an explicit local Unix Docker endpoint is required")
    parsed = urlparse(endpoint)
    if parsed.scheme != "unix" or parsed.netloc or not parsed.path.startswith("/") or parsed.query or parsed.fragment:
        raise ValueError("endpoint must be a local unix:///absolute/path socket")
    socket_path = Path(parsed.path)
    if ".." in socket_path.parts or socket_path.is_symlink():
        raise ValueError("Docker socket path must not traverse parent segments or symlinks")
    if require_socket and (not socket_path.exists() or not stat_is_socket(socket_path)):
        raise ValueError("explicit Docker endpoint must exist as a Unix socket")
    return endpoint


def stat_is_socket(path: Path) -> bool:
    import stat
    try:
        return stat.S_ISSOCK(path.stat().st_mode)
    except OSError:
        return False


def _docker_versions(endpoint: str) -> tuple[str | None, str | None, str | None, str | None]:
    """Read bounded, non-secret runtime metadata from the explicitly selected daemon."""
    commands = [
        ["docker", "--host", endpoint, "version", "--format", "{{.Client.Version}}|{{.Server.Version}}"],
        ["docker", "--host", endpoint, "info", "--format", "{{.KernelVersion}}|{{.Architecture}}"],
    ]
    values: list[str | None] = []
    for argv in commands:
        try:
            result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=5,
                                    shell=False, check=False, env={k: v for k, v in os.environ.items()
                                    if k not in {"DOCKER_HOST", "DOCKER_CONTEXT"}})
            output = result.stdout[:1024].decode("utf-8", "replace").strip()
            if result.returncode != 0 or len(result.stdout) > 1024 or len(result.stderr) > 1024:
                values.append(None)
            else:
                values.extend((output.split("|", 1) + [None])[:2])
        except (OSError, subprocess.SubprocessError):
            values.extend((None, None))
    return (values[0], values[1], values[2], values[3])


def _probe_policy(image_ref: str, *, probe_id: QualificationProbeId) -> EvaluationPolicy:
    timeout = 1.0 if probe_id is QualificationProbeId.WALL_TIMEOUT else 8.0
    output_limit = 1024
    return EvaluationPolicy(
        image=image_ref,
        command=("-I", "-c", _PROBE_PROGRAM),
        # Override a digest-pinned image's configured entrypoint so an image
        # cannot silently ignore the fixed probe argv. Image review remains an
        # external gate and this runner cannot qualify an unreviewed image.
        entrypoint="/usr/local/bin/python",
        timeout_seconds=timeout,
        memory_bytes=64 * 1024 * 1024,
        cpu_count=0.5,
        pids_limit=16,
        tmpfs_bytes=1024 * 1024,
        input_limit_bytes=4096,
        output_limit_bytes=output_limit,
        control_timeout_seconds=5.0,
    )


def _expected_code(probe_id: QualificationProbeId) -> str:
    return EXPECTED_PROBE_CODES[probe_id]


def _unavailable_probe(
    probe_id: QualificationProbeId,
    now: datetime | None = None,
    *,
    detail_code: str | None = None,
) -> QualificationProbeEvidence:
    now = now or datetime.now(timezone.utc)
    return QualificationProbeEvidence(
        probe_id=probe_id, status=ProbeStatus.UNAVAILABLE,
        started_at=now, finished_at=now,
        expected_code=_expected_code(probe_id), observed_code="not_executed",
        cleanup_confirmed=False, remaining_managed_container_count=None,
        stdout_bytes=0, stderr_bytes=0, stdout_sha256=EMPTY_SHA256, stderr_sha256=EMPTY_SHA256,
        detail_code=detail_code or _EXTERNAL_PROBE_CODES.get(
            probe_id, "probe_not_implemented_in_local_harness"
        ),
    )


def _live_probe(endpoint: str, image_ref: str, probe_id: QualificationProbeId) -> QualificationProbeEvidence:
    started = datetime.now(timezone.utc)
    expected = _expected_code(probe_id)
    payload = json.dumps({"probe_id": probe_id.value}, separators=(",", ":")).encode("utf-8")
    policy = _probe_policy(image_ref, probe_id=probe_id)
    result = None
    try:
        result = evaluate(payload, policy, local_endpoint=endpoint)
        if probe_id is QualificationProbeId.OUTPUT_LIMIT:
            passed = result.output_limited and result.container_removed
            observed = "output_limit_enforced" if result.output_limited else "output_limit_not_observed"
        elif probe_id is QualificationProbeId.WALL_TIMEOUT:
            passed = result.timed_out and result.container_removed
            observed = "wall_timeout_enforced" if result.timed_out else "wall_timeout_not_observed"
        elif probe_id is QualificationProbeId.SYNTHETIC_EXIT_ZERO:
            passed = result.exit_code == 0 and not result.timed_out and result.container_removed
            observed = "exit_zero" if result.exit_code == 0 else "unexpected_exit"
        elif probe_id is QualificationProbeId.SYNTHETIC_EXIT_NONZERO:
            passed = result.exit_code == 7 and not result.timed_out and result.container_removed
            observed = "exit_nonzero" if result.exit_code == 7 else "unexpected_exit"
        else:
            expected_stdout = b"guru-probe-ok\n"
            passed = (result.exit_code == 0 and not result.timed_out and not result.output_limited
                      and result.stdout == expected_stdout and result.container_removed)
            observed = expected if passed else "probe_condition_not_observed"
        stdout, stderr = result.stdout, result.stderr
        cleanup = result.container_removed
        exit_code = result.exit_code
        timed_out = result.timed_out
        output_limited = result.output_limited
        signal_number = -result.exit_code if result.exit_code is not None and result.exit_code < 0 else None
        detail = "probe_pass" if passed else ("cleanup_unconfirmed" if not cleanup else "expected_outcome_not_observed")
    except Exception as exc:  # Report failure class only; never persist exception text.
        passed = False
        observed = "backend_execution_error"
        stdout = stderr = b""
        cleanup = False
        exit_code = None
        timed_out = False
        output_limited = False
        signal_number = None
        detail = "backend_error_" + type(exc).__name__[:80]
    finished = max(datetime.now(timezone.utc), started)
    return QualificationProbeEvidence(
        probe_id=probe_id,
        status=ProbeStatus.PASS if passed else ProbeStatus.FAIL,
        started_at=started,
        finished_at=finished,
        expected_code=expected,
        observed_code=observed,
        exit_code=exit_code,
        signal=signal_number,
        timed_out=timed_out,
        output_limited=output_limited,
        cleanup_confirmed=cleanup,
        remaining_managed_container_count=None,
        stdout_bytes=len(stdout), stderr_bytes=len(stderr),
        stdout_sha256=hashlib.sha256(stdout).hexdigest(),
        stderr_sha256=hashlib.sha256(stderr).hexdigest(),
        detail_code=detail,
    )


def _evidence_integrity_probe(now: datetime) -> QualificationProbeEvidence:
    started = now
    sample = {"schema_version": "qualification-integrity-probe-v1", "value": "synthetic"}
    digest = canonical_digest(sample)
    tampered = {**sample, "value": "changed"}
    passed = digest != canonical_digest(tampered)
    marker = b"digest-tamper-rejected" if passed else b"digest-tamper-not-rejected"
    return QualificationProbeEvidence(
        probe_id=QualificationProbeId.EVIDENCE_INTEGRITY_REPLAY,
        status=ProbeStatus.PASS if passed else ProbeStatus.FAIL,
        started_at=started, finished_at=max(datetime.now(timezone.utc), started),
        expected_code=EXPECTED_PROBE_CODES[QualificationProbeId.EVIDENCE_INTEGRITY_REPLAY],
        observed_code=EXPECTED_PROBE_CODES[QualificationProbeId.EVIDENCE_INTEGRITY_REPLAY] if passed else "tamper_not_detected",
        exit_code=0 if passed else 1, cleanup_confirmed=True, remaining_managed_container_count=None,
        stdout_bytes=len(marker), stderr_bytes=0, stdout_sha256=hashlib.sha256(marker).hexdigest(),
        stderr_sha256=EMPTY_SHA256, detail_code="canonical_digest_self_check",
    )


def _policy_digest(image_ref: str, endpoint: str) -> str:
    policies = {
        probe_id.value: {
            "command": list((policy := _probe_policy(image_ref, probe_id=probe_id)).command),
            "entrypoint": policy.entrypoint,
            "timeout_seconds": policy.timeout_seconds,
            "memory_bytes": policy.memory_bytes,
            "cpu_count": policy.cpu_count,
            "pids_limit": policy.pids_limit,
            "tmpfs_bytes": policy.tmpfs_bytes,
            "input_limit_bytes": policy.input_limit_bytes,
            "output_limit_bytes": policy.output_limit_bytes,
            "control_timeout_seconds": policy.control_timeout_seconds,
        }
        for probe_id in _LIVE_PROBES
    }
    return canonical_digest({
        "tool_version": TOOL_VERSION,
        "image_ref": image_ref,
        "image_digest": image_ref.rsplit("@sha256:", 1)[1],
        "endpoint_digest": _digest_text(endpoint),
        "probes": policies,
    })


def run_prequalification(
    *, endpoint: str, image_ref: str, require_socket: bool = True,
) -> EvaluatorPrequalificationReport:
    """Run only fixed synthetic probes; external lifecycle checks stay unavailable."""
    endpoint = _validate_local_endpoint(endpoint, require_socket=require_socket)
    if not isinstance(image_ref, str) or not PINNED_IMAGE.fullmatch(image_ref):
        raise ValueError("image must be pinned by sha256 digest")
    created = datetime.now(timezone.utc)
    approved_image = APPROVED_PROBE_IMAGE_REF is not None and image_ref == APPROVED_PROBE_IMAGE_REF
    if approved_image:
        client, server, kernel, architecture = _docker_versions(endpoint)
    else:
        # A caller-supplied digest is only an identifier, not image approval.
        # Do not execute an unreviewed image, even for synthetic probes.
        client = server = kernel = architecture = None
    probes: list[QualificationProbeEvidence] = []
    for probe_id in QualificationProbeId:
        if not approved_image and probe_id in _LIVE_PROBES:
            probes.append(_unavailable_probe(
                probe_id, detail_code="probe_image_not_independently_reviewed"
            ))
        elif probe_id in _LIVE_PROBES:
            probes.append(_live_probe(endpoint, image_ref, probe_id))
        elif probe_id is QualificationProbeId.EVIDENCE_INTEGRITY_REPLAY:
            probes.append(_evidence_integrity_probe(datetime.now(timezone.utc)))
        else:
            probes.append(_unavailable_probe(probe_id))
    failed = [probe for probe in probes if probe.status is ProbeStatus.FAIL]
    blockers = [f"probe_failed:{probe.probe_id.value}" for probe in failed]
    blockers.extend(
        f"probe_unavailable:{probe.probe_id.value}"
        for probe in probes if probe.status is ProbeStatus.UNAVAILABLE
    )
    blockers.extend(("disposable_worker_attestation_missing", "independent_review_missing"))
    if not approved_image:
        blockers.append("probe_image_not_independently_reviewed")
    finished = max(datetime.now(timezone.utc), created)
    image_digest = image_ref.rsplit("@sha256:", 1)[1]
    report = EvaluatorPrequalificationReport(
        schema_version="guru-evaluator-prequalification-v1",
        report_id=secrets.token_hex(16), created_at=created, finished_at=finished,
        tool_version=TOOL_VERSION,
        probe_set_digest=canonical_digest(list(REQUIRED_PROBE_IDS)),
        policy_digest=_policy_digest(image_ref, endpoint),
        config_digest=canonical_digest({
            "policy_digest": _policy_digest(image_ref, endpoint),
            "docker_client_version": client,
            "docker_server_version": server,
            "kernel_release": kernel,
            "architecture": architecture,
        }),
        image_ref=image_ref, image_digest=image_digest,
        endpoint_digest=_digest_text(endpoint),
        docker_client_version=client, docker_server_version=server,
        kernel_release=kernel, architecture=architecture,
        worker_id_digest=None, worker_profile_digest=None, reset_policy_digest=None,
        worker_os_image_digest=None,
        probes=probes,
        status=PrequalificationStatus.BLOCKED if failed else PrequalificationStatus.PREQUALIFICATION,
        blockers=blockers,
        report_digest=ZERO_DIGEST,
    )
    return seal_report(report)


def promote_qualification(
    report: EvaluatorPrequalificationReport,
    worker_attestation: DisposableWorkerAttestation | None,
    independent_review: IndependentEvaluatorReview | None,
    *,
    now: datetime | None = None,
) -> EvaluatorPromotionDecision:
    """Validate a promotion candidate but fail closed until trust roots exist.

    This repository has no authenticated worker/reviewer trust store or
    privileged composition root. Caller-supplied record hashes are not trust
    anchors, so this function never emits ``qualified``.
    """
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    blockers: list[str] = ["authenticated_trust_root_unavailable"]
    report_valid = verify_report(report)
    if not report_valid:
        blockers.append("report_integrity_invalid")
    if report.status is PrequalificationStatus.BLOCKED:
        blockers.append("report_has_failed_probes")
    allowed_run_blockers = {
        "disposable_worker_attestation_missing", "independent_review_missing",
        "probe_image_not_independently_reviewed",
    }
    allowed_run_blockers.update(
        f"probe_unavailable:{probe.probe_id.value}"
        for probe in report.probes if probe.status is ProbeStatus.UNAVAILABLE
    )
    if set(report.blockers) - allowed_run_blockers:
        blockers.append("report_contains_unrecognized_blockers")
    if [probe.probe_id.value for probe in report.probes] != list(REQUIRED_PROBE_IDS):
        blockers.append("required_probe_set_incomplete")
    for probe in report.probes:
        if probe.status is not ProbeStatus.PASS:
            blockers.append(f"required_probe_not_passed:{probe.probe_id.value}")
        if not probe.cleanup_confirmed:
            blockers.append(f"probe_cleanup_unconfirmed:{probe.probe_id.value}")

    attestation_digest = None
    if worker_attestation is None:
        blockers.append("worker_attestation_missing")
    else:
        attestation_digest = canonical_digest(worker_attestation)
        if worker_attestation.lifecycle is not WorkerLifecycle.DISPOSABLE_LINUX_VM:
            blockers.append("worker_is_not_disposable_linux_vm")
        if report.worker_id_digest != worker_attestation.worker_id_digest:
            blockers.append("worker_identity_does_not_match_report")
        if report.worker_profile_digest != worker_attestation.worker_profile_digest:
            blockers.append("worker_profile_does_not_match_report")
        if report.worker_os_image_digest != worker_attestation.worker_os_image_digest:
            blockers.append("worker_os_image_does_not_match_report")
        if report.reset_policy_digest != worker_attestation.reset_policy_digest:
            blockers.append("reset_policy_does_not_match_report")
        lifecycle_probe = next((probe for probe in report.probes
                                if probe.probe_id is QualificationProbeId.DISPOSABLE_WORKER_LIFECYCLE), None)
        expected_lifecycle_evidence = canonical_digest({
            "destruction_receipt_digest": worker_attestation.destruction_receipt_digest,
            "recreation_receipt_digest": worker_attestation.recreation_receipt_digest,
        })
        if lifecycle_probe is None or lifecycle_probe.external_evidence_digest != expected_lifecycle_evidence:
            blockers.append("worker_reset_receipts_do_not_match_lifecycle_probe")
        if (worker_attestation.valid_from > report.created_at or worker_attestation.valid_until < report.finished_at
                or worker_attestation.approved_at > report.created_at):
            blockers.append("worker_attestation_not_valid_for_run")
        if worker_attestation.valid_until < now:
            blockers.append("worker_attestation_expired")

    review_digest = None
    if independent_review is None:
        blockers.append("independent_review_missing")
    else:
        review_digest = canonical_digest(independent_review)
        if independent_review.disposition is not ReviewDisposition.ACCEPTED:
            blockers.append("independent_review_rejected")
        if independent_review.accepted_exceptions:
            blockers.append("independent_review_contains_exceptions")
        if independent_review.report_digest != report.report_digest:
            blockers.append("review_report_digest_mismatch")
        if independent_review.config_digest != report.config_digest:
            blockers.append("review_config_digest_mismatch")
        if independent_review.image_digest != report.image_digest:
            blockers.append("review_image_digest_mismatch")
        if independent_review.probe_set_digest != report.probe_set_digest:
            blockers.append("review_probe_set_digest_mismatch")
        if worker_attestation and independent_review.worker_id_digest != worker_attestation.worker_id_digest:
            blockers.append("review_worker_identity_mismatch")
        if worker_attestation and independent_review.reviewer_identity in {
            worker_attestation.operator_identity, worker_attestation.approved_by,
        }:
            blockers.append("reviewer_is_not_independent_of_worker_approval")
        if (independent_review.reviewed_at < report.finished_at or independent_review.reviewed_at > now
                or now - independent_review.reviewed_at > MAX_REVIEW_AGE):
            blockers.append("independent_review_stale_or_predates_report")

    blockers = list(dict.fromkeys(blockers))
    if not blockers:
        status = PromotionStatus.QUALIFIED
    elif any("probe_" in blocker or "probe" in blocker for blocker in blockers):
        status = PromotionStatus.BLOCKED
    elif "report_has_failed_probes" in blockers or "report_integrity_invalid" in blockers:
        status = PromotionStatus.BLOCKED
    else:
        status = PromotionStatus.PREQUALIFICATION
    decision = EvaluatorPromotionDecision(
        schema_version="guru-evaluator-promotion-decision-v1",
        status=status,
        report_digest=report.report_digest,
        worker_attestation_digest=attestation_digest,
        independent_review_digest=review_digest,
        decided_at=now,
        blockers=blockers,
        decision_digest=ZERO_DIGEST,
    )
    return seal_decision(decision)
