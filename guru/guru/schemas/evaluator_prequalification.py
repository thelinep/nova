"""Strict evidence contracts for evaluator prequalification and promotion.

These records are deliberately separate from task-case evidence and quality
admission. A prequalification report is not permission to execute task data.
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import Field, field_validator, model_validator

from .teacher_lineage import StrictModel


SHA256 = r"^[0-9a-f]{64}$"
ZERO_DIGEST = "0" * 64


class QualificationProbeId(str, Enum):
    DISPOSABLE_WORKER_LIFECYCLE = "disposable_worker_lifecycle"
    EFFECTIVE_CONTAINER_ISOLATION = "effective_container_isolation"
    NETWORK_AND_HOST_ISOLATION = "network_and_host_isolation"
    RESOURCE_LIMITS = "resource_limits"
    OUTPUT_LIMIT = "output_limit"
    WALL_TIMEOUT = "wall_timeout"
    FRESH_CONTAINER_CLEANUP = "fresh_container_cleanup"
    CANCELLATION_CLEANUP = "cancellation_cleanup"
    RUNNER_CRASH_ORPHAN_REAP = "runner_crash_orphan_reap"
    DAEMON_RESTART_REAP = "daemon_restart_reap"
    HOST_RESTART_AND_RESET = "host_restart_and_reset"
    ADVERSARIAL_ACCEPTANCE_SUITE = "adversarial_acceptance_suite"
    SYNTHETIC_EXIT_ZERO = "synthetic_exit_zero"
    SYNTHETIC_EXIT_NONZERO = "synthetic_exit_nonzero"
    CASE_TEST_PASS_MAPPING = "case_test_pass_mapping"
    CASE_TEST_FAIL_MAPPING = "case_test_fail_mapping"
    EVIDENCE_INTEGRITY_REPLAY = "evidence_integrity_replay"
    FROZEN_RUNTIME_POLICY = "frozen_runtime_policy"


REQUIRED_PROBE_IDS = tuple(item.value for item in QualificationProbeId)
EXPECTED_PROBE_CODES = {
    QualificationProbeId.DISPOSABLE_WORKER_LIFECYCLE: "disposable_linux_worker_reset_proven",
    QualificationProbeId.EFFECTIVE_CONTAINER_ISOLATION: "container_controls_observed",
    QualificationProbeId.NETWORK_AND_HOST_ISOLATION: "no_external_route_or_runtime_socket",
    QualificationProbeId.RESOURCE_LIMITS: "cpu_memory_pids_and_tmpfs_limits_observed",
    QualificationProbeId.OUTPUT_LIMIT: "output_limit_enforced",
    QualificationProbeId.WALL_TIMEOUT: "wall_timeout_enforced",
    QualificationProbeId.FRESH_CONTAINER_CLEANUP: "fresh_container_removed",
    QualificationProbeId.CANCELLATION_CLEANUP: "cancelled_worker_reaped",
    QualificationProbeId.RUNNER_CRASH_ORPHAN_REAP: "orphan_reaped_after_runner_crash",
    QualificationProbeId.DAEMON_RESTART_REAP: "orphan_reaped_after_daemon_restart",
    QualificationProbeId.HOST_RESTART_AND_RESET: "worker_destroyed_and_recreated",
    QualificationProbeId.ADVERSARIAL_ACCEPTANCE_SUITE: "required_adversarial_suite_passed",
    QualificationProbeId.SYNTHETIC_EXIT_ZERO: "exit_zero",
    QualificationProbeId.SYNTHETIC_EXIT_NONZERO: "exit_nonzero",
    QualificationProbeId.CASE_TEST_PASS_MAPPING: "synthetic_case_test_pass_mapped",
    QualificationProbeId.CASE_TEST_FAIL_MAPPING: "synthetic_case_test_fail_mapped",
    QualificationProbeId.EVIDENCE_INTEGRITY_REPLAY: "tamper_rejected_on_replay",
    QualificationProbeId.FROZEN_RUNTIME_POLICY: "runtime_policy_digest_independently_frozen",
}
EXTERNAL_PROBE_IDS = {
    QualificationProbeId.DISPOSABLE_WORKER_LIFECYCLE,
    QualificationProbeId.CANCELLATION_CLEANUP,
    QualificationProbeId.RUNNER_CRASH_ORPHAN_REAP,
    QualificationProbeId.DAEMON_RESTART_REAP,
    QualificationProbeId.HOST_RESTART_AND_RESET,
    QualificationProbeId.ADVERSARIAL_ACCEPTANCE_SUITE,
    QualificationProbeId.CASE_TEST_PASS_MAPPING,
    QualificationProbeId.CASE_TEST_FAIL_MAPPING,
    QualificationProbeId.FROZEN_RUNTIME_POLICY,
}


class ProbeStatus(str, Enum):
    PASS = "pass"
    FAIL = "fail"
    UNAVAILABLE = "unavailable"


class PrequalificationStatus(str, Enum):
    BLOCKED = "blocked"
    PREQUALIFICATION = "prequalification"


class PromotionStatus(str, Enum):
    BLOCKED = "blocked"
    PREQUALIFICATION = "prequalification"
    QUALIFIED = "qualified"


class WorkerLifecycle(str, Enum):
    PERSISTENT_WORKSTATION = "persistent_workstation"
    DISPOSABLE_LINUX_VM = "disposable_linux_vm"


class ReviewDisposition(str, Enum):
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class QualificationProbeEvidence(StrictModel):
    schema_version: Literal["guru-evaluator-probe-v1"] = "guru-evaluator-probe-v1"
    probe_id: QualificationProbeId
    status: ProbeStatus
    started_at: datetime
    finished_at: datetime
    expected_code: str = Field(min_length=1, max_length=128)
    observed_code: str = Field(min_length=1, max_length=128)
    exit_code: int | None = Field(default=None, ge=-255, le=255)
    signal: int | None = Field(default=None, ge=1, le=64)
    timed_out: bool = False
    output_limited: bool = False
    cleanup_confirmed: bool
    remaining_managed_container_count: int | None = Field(default=None, ge=0, le=100_000)
    stdout_bytes: int = Field(ge=0, le=1024**2)
    stderr_bytes: int = Field(ge=0, le=1024**2)
    stdout_sha256: str = Field(pattern=SHA256)
    stderr_sha256: str = Field(pattern=SHA256)
    detail_code: str = Field(min_length=1, max_length=128)
    external_evidence_digest: str | None = Field(default=None, pattern=SHA256)

    @field_validator("started_at", "finished_at")
    @classmethod
    def aware_time(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("probe timestamps must be timezone-aware")
        return value

    @model_validator(mode="after")
    def coherent_probe(self) -> QualificationProbeEvidence:
        if self.finished_at < self.started_at:
            raise ValueError("probe finished_at cannot precede started_at")
        if self.expected_code != EXPECTED_PROBE_CODES[self.probe_id]:
            raise ValueError("probe expected_code does not match the fixed probe contract")
        if self.signal is not None and (self.exit_code is None or self.exit_code >= 0 or -self.exit_code != self.signal):
            raise ValueError("signal must match a negative process exit code")
        if self.status is ProbeStatus.PASS:
            if not self.cleanup_confirmed:
                raise ValueError("passing probe requires confirmed cleanup")
            if self.observed_code != self.expected_code:
                raise ValueError("passing probe observed_code must match expected_code")
            if self.expected_code == "exit_zero" and self.exit_code != 0:
                raise ValueError("exit_zero probe must observe exit code 0")
            if self.expected_code == "exit_nonzero" and (self.exit_code in (None, 0)):
                raise ValueError("exit_nonzero probe must observe a non-zero exit code")
            if self.expected_code == "output_limit_enforced" and not self.output_limited:
                raise ValueError("output-limit probe must observe output truncation")
            if self.expected_code == "wall_timeout_enforced" and not self.timed_out:
                raise ValueError("wall-time probe must observe timeout")
            if self.probe_id not in {
                QualificationProbeId.OUTPUT_LIMIT,
                QualificationProbeId.WALL_TIMEOUT,
                QualificationProbeId.SYNTHETIC_EXIT_NONZERO,
            } and (self.exit_code != 0 or self.timed_out or self.output_limited):
                if self.probe_id not in EXTERNAL_PROBE_IDS:
                    raise ValueError("passing ordinary probe requires clean exit 0")
            if self.probe_id in EXTERNAL_PROBE_IDS and self.external_evidence_digest is None:
                raise ValueError("passing external probe requires an evidence digest")
        elif self.status is ProbeStatus.FAIL:
            if self.cleanup_confirmed is False and self.detail_code == "cleanup_unconfirmed":
                return self
        else:
            if self.exit_code is not None or self.signal is not None:
                raise ValueError("unavailable probe cannot claim process execution")
            if self.cleanup_confirmed:
                raise ValueError("unavailable probe cannot claim cleanup")
            if (self.observed_code != "not_executed" or self.stdout_bytes or self.stderr_bytes
                    or self.external_evidence_digest is not None):
                raise ValueError("unavailable probe cannot claim observed output or external evidence")
        return self


class EvaluatorPrequalificationReport(StrictModel):
    schema_version: Literal["guru-evaluator-prequalification-v1"]
    report_id: str = Field(min_length=1, max_length=128)
    created_at: datetime
    finished_at: datetime
    tool_version: str = Field(min_length=1, max_length=64)
    probe_set_digest: str = Field(pattern=SHA256)
    policy_digest: str = Field(pattern=SHA256)
    config_digest: str = Field(pattern=SHA256)
    image_ref: str = Field(
        pattern=r"^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$",
        max_length=512,
    )
    image_digest: str = Field(pattern=SHA256)
    endpoint_digest: str = Field(pattern=SHA256)
    docker_client_version: str | None = Field(default=None, max_length=128)
    docker_server_version: str | None = Field(default=None, max_length=128)
    kernel_release: str | None = Field(default=None, max_length=256)
    architecture: str | None = Field(default=None, max_length=64)
    worker_id_digest: str | None = Field(default=None, pattern=SHA256)
    worker_profile_digest: str | None = Field(default=None, pattern=SHA256)
    worker_os_image_digest: str | None = Field(default=None, pattern=SHA256)
    reset_policy_digest: str | None = Field(default=None, pattern=SHA256)
    probes: list[QualificationProbeEvidence]
    status: PrequalificationStatus
    blockers: list[str] = Field(max_length=128)
    report_digest: str = Field(pattern=SHA256)

    @field_validator("created_at", "finished_at")
    @classmethod
    def aware_time(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("report timestamps must be timezone-aware")
        return value

    @model_validator(mode="after")
    def complete_probe_set_and_status(self) -> EvaluatorPrequalificationReport:
        if self.finished_at < self.created_at:
            raise ValueError("report finished_at cannot precede created_at")
        ids = [probe.probe_id.value for probe in self.probes]
        if ids != list(REQUIRED_PROBE_IDS):
            raise ValueError("report must contain the fixed ordered probe set exactly once")
        expected_image_digest = self.image_ref.rsplit("@sha256:", 1)[-1]
        if self.image_digest != expected_image_digest:
            raise ValueError("report image_digest must match its pinned image_ref")
        failed = any(probe.status is ProbeStatus.FAIL for probe in self.probes)
        expected_status = PrequalificationStatus.BLOCKED if failed else PrequalificationStatus.PREQUALIFICATION
        if self.status is not expected_status:
            raise ValueError("report status does not match probe outcomes")
        if self.status is PrequalificationStatus.BLOCKED and not self.blockers:
            raise ValueError("blocked report requires blockers")
        if self.status is PrequalificationStatus.PREQUALIFICATION and not self.blockers:
            raise ValueError("prequalification report must state unresolved qualification gates")
        if len(self.blockers) != len(set(self.blockers)):
            raise ValueError("report blockers must be unique")
        return self


class DisposableWorkerAttestation(StrictModel):
    """Owner/infra-controlled attestation; never generated by the CLI."""

    schema_version: Literal["guru-disposable-worker-attestation-v1"]
    attestation_id: str = Field(min_length=1, max_length=128)
    worker_id_digest: str = Field(pattern=SHA256)
    worker_profile_digest: str = Field(pattern=SHA256)
    worker_os_image_digest: str = Field(pattern=SHA256)
    worker_os: Literal["linux"]
    lifecycle: WorkerLifecycle
    reset_policy_digest: str = Field(pattern=SHA256)
    controller_identity: str = Field(min_length=1, max_length=256)
    operator_identity: str = Field(min_length=1, max_length=256)
    approved_by: str = Field(min_length=1, max_length=256)
    approved_at: datetime
    valid_from: datetime
    valid_until: datetime
    before_instance_digest: str = Field(pattern=SHA256)
    after_instance_digest: str = Field(pattern=SHA256)
    destruction_receipt_digest: str = Field(pattern=SHA256)
    recreation_receipt_digest: str = Field(pattern=SHA256)

    @model_validator(mode="after")
    def valid_attestation_window(self) -> DisposableWorkerAttestation:
        for value in (self.approved_at, self.valid_from, self.valid_until):
            if value.tzinfo is None or value.utcoffset() is None:
                raise ValueError("attestation timestamps must be timezone-aware")
        if self.valid_until <= self.valid_from:
            raise ValueError("attestation validity interval must be positive")
        if self.before_instance_digest == self.after_instance_digest:
            raise ValueError("disposable worker reset must produce a different instance digest")
        return self


class IndependentEvaluatorReview(StrictModel):
    """Independent review record bound to one immutable qualification report."""

    schema_version: Literal["guru-evaluator-independent-review-v1"]
    review_id: str = Field(min_length=1, max_length=128)
    report_digest: str = Field(pattern=SHA256)
    config_digest: str = Field(pattern=SHA256)
    image_digest: str = Field(pattern=SHA256)
    probe_set_digest: str = Field(pattern=SHA256)
    worker_id_digest: str = Field(pattern=SHA256)
    reviewer_identity: str = Field(min_length=1, max_length=256)
    reviewer_authority: str = Field(min_length=1, max_length=256)
    reviewed_at: datetime
    disposition: ReviewDisposition
    residual_risks_digest: str = Field(pattern=SHA256)
    accepted_exceptions: list[str] = Field(default_factory=list, max_length=32)

    @field_validator("reviewed_at")
    @classmethod
    def aware_review_time(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("reviewed_at must be timezone-aware")
        return value


class EvaluatorPromotionDecision(StrictModel):
    schema_version: Literal["guru-evaluator-promotion-decision-v1"]
    status: PromotionStatus
    report_digest: str = Field(pattern=SHA256)
    worker_attestation_digest: str | None = Field(default=None, pattern=SHA256)
    independent_review_digest: str | None = Field(default=None, pattern=SHA256)
    decided_at: datetime
    blockers: list[str] = Field(max_length=128)
    decision_digest: str = Field(pattern=SHA256)

    @field_validator("decided_at")
    @classmethod
    def aware_decision_time(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("decided_at must be timezone-aware")
        return value

    @model_validator(mode="after")
    def coherent_decision(self) -> EvaluatorPromotionDecision:
        if self.status is PromotionStatus.QUALIFIED and self.blockers:
            raise ValueError("qualified decision cannot contain blockers")
        if self.status is PromotionStatus.QUALIFIED and (
            self.worker_attestation_digest is None or self.independent_review_digest is None
        ):
            raise ValueError("qualified decision requires pinned worker and independent-review evidence")
        if self.status is not PromotionStatus.QUALIFIED and not self.blockers:
            raise ValueError("non-qualified decision must contain blockers")
        return self
