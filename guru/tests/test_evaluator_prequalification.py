from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from guru.evaluator_prequalification import (
    canonical_digest,
    promote_qualification,
    replay_report,
    run_prequalification,
    seal_report,
    verify_report,
    write_report_atomic,
)
from guru.evaluator_qualification_cli import _parser
from guru.schemas.evaluator_prequalification import (
    DisposableWorkerAttestation,
    EXPECTED_PROBE_CODES,
    EXTERNAL_PROBE_IDS,
    EvaluatorPrequalificationReport,
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


NOW = datetime(2026, 10, 13, 12, 0, tzinfo=timezone.utc)
IMAGE = "python@sha256:" + "a" * 64
DIGESTS = {
    "report": "1" * 64,
    "endpoint": "2" * 64,
    "config": "3" * 64,
    "policy": "4" * 64,
    "probe_set": "5" * 64,
    "worker": "6" * 64,
    "profile": "7" * 64,
    "os_image": "8" * 64,
    "reset": "9" * 64,
    "receipt_destroy": "a" * 64,
    "receipt_create": "b" * 64,
    "risk": "c" * 64,
}


def _probe(probe_id: QualificationProbeId, *, status=ProbeStatus.PASS, cleanup=True):
    expected = EXPECTED_PROBE_CODES[probe_id]
    expected_exit = 7 if probe_id is QualificationProbeId.SYNTHETIC_EXIT_NONZERO else 0
    unavailable = status is ProbeStatus.UNAVAILABLE
    return QualificationProbeEvidence(
        probe_id=probe_id, status=status, started_at=NOW, finished_at=NOW + timedelta(seconds=1),
        expected_code=expected,
        observed_code="not_executed" if unavailable else (expected if status is ProbeStatus.PASS else "wrong"),
        exit_code=None if unavailable else (expected_exit if status is ProbeStatus.PASS else 2),
        timed_out=probe_id is QualificationProbeId.WALL_TIMEOUT and status is ProbeStatus.PASS,
        output_limited=probe_id is QualificationProbeId.OUTPUT_LIMIT and status is ProbeStatus.PASS,
        cleanup_confirmed=False if unavailable else cleanup,
        remaining_managed_container_count=None,
        stdout_bytes=0, stderr_bytes=0,
        stdout_sha256=hashlib.sha256(b"").hexdigest(), stderr_sha256=hashlib.sha256(b"").hexdigest(),
        detail_code="external_required" if unavailable else "probe_test_fixture",
        external_evidence_digest=(
            canonical_digest({
                "destruction_receipt_digest": DIGESTS["receipt_destroy"],
                "recreation_receipt_digest": DIGESTS["receipt_create"],
            }) if probe_id is QualificationProbeId.DISPOSABLE_WORKER_LIFECYCLE and not unavailable
            else ("f" * 64 if probe_id in EXTERNAL_PROBE_IDS and not unavailable else None)
        ),
    )


def _report(*, all_pass=True, failed_probe=None, worker_bound=True):
    probes = []
    for probe_id in map(QualificationProbeId, REQUIRED_PROBE_IDS):
        if failed_probe == probe_id:
            probes.append(_probe(probe_id, status=ProbeStatus.FAIL, cleanup=False))
        elif all_pass:
            probes.append(_probe(probe_id))
        else:
            probes.append(_probe(probe_id, status=ProbeStatus.UNAVAILABLE))
    blockers = ["disposable_worker_attestation_missing", "independent_review_missing"]
    status = PrequalificationStatus.PREQUALIFICATION
    if failed_probe is not None:
        blockers.insert(0, f"probe_failed:{failed_probe.value}")
        status = PrequalificationStatus.BLOCKED
    profile_fields = {
        "worker_id_digest": DIGESTS["worker"] if worker_bound else None,
        "worker_profile_digest": DIGESTS["profile"] if worker_bound else None,
        "worker_os_image_digest": DIGESTS["os_image"] if worker_bound else None,
        "reset_policy_digest": DIGESTS["reset"] if worker_bound else None,
    }
    return seal_report(EvaluatorPrequalificationReport(
        schema_version="guru-evaluator-prequalification-v1", report_id="test-report",
        created_at=NOW, finished_at=NOW + timedelta(seconds=1), tool_version="test-v1",
        probe_set_digest=DIGESTS["probe_set"], policy_digest=DIGESTS["policy"],
        config_digest=DIGESTS["config"], image_ref=IMAGE, image_digest="a" * 64,
        endpoint_digest=DIGESTS["endpoint"], docker_client_version="1", docker_server_version="1",
        kernel_release="Linux-test", architecture="aarch64", **profile_fields,
        probes=probes, status=status, blockers=blockers, report_digest=ZERO_DIGEST,
    ))


def _attestation(*, lifecycle=WorkerLifecycle.DISPOSABLE_LINUX_VM):
    return DisposableWorkerAttestation(
        schema_version="guru-disposable-worker-attestation-v1", attestation_id="worker-att-1",
        worker_id_digest=DIGESTS["worker"], worker_profile_digest=DIGESTS["profile"],
        worker_os_image_digest=DIGESTS["os_image"], worker_os="linux", lifecycle=lifecycle,
        reset_policy_digest=DIGESTS["reset"], controller_identity="approved-local-controller",
        operator_identity="operator@example.invalid", approved_by="owner@example.invalid",
        approved_at=NOW - timedelta(hours=2), valid_from=NOW - timedelta(hours=1),
        valid_until=NOW + timedelta(days=1), before_instance_digest="d" * 64,
        after_instance_digest="e" * 64, destruction_receipt_digest=DIGESTS["receipt_destroy"],
        recreation_receipt_digest=DIGESTS["receipt_create"],
    )


def _review(report, attestation):
    return IndependentEvaluatorReview(
        schema_version="guru-evaluator-independent-review-v1", review_id="review-1",
        report_digest=report.report_digest, config_digest=report.config_digest,
        image_digest=report.image_digest, probe_set_digest=report.probe_set_digest,
        worker_id_digest=attestation.worker_id_digest, reviewer_identity="reviewer@example.invalid",
        reviewer_authority="independent security reviewer", reviewed_at=NOW + timedelta(minutes=1),
        disposition=ReviewDisposition.ACCEPTED, residual_risks_digest=DIGESTS["risk"],
        accepted_exceptions=[],
    )


def test_report_digest_write_replay_and_tamper_detection(tmp_path):
    report = _report(all_pass=False)
    assert verify_report(report)
    target = tmp_path / "prequalification.json"
    write_report_atomic(target, report)
    assert replay_report(target) == report

    raw = json.loads(target.read_text())
    raw["architecture"] = "forged"
    target.write_text(json.dumps(raw, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")
    with pytest.raises(ValueError, match="integrity digest"):
        replay_report(target)


def test_replay_rejects_duplicate_keys_and_noncanonical_or_truncated_file(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text('{"schema_version":"a","schema_version":"b"}\n')
    with pytest.raises(ValueError, match="JSON or schema"):
        replay_report(path)
    path.write_bytes(b'{"truncated":')
    with pytest.raises(ValueError, match="truncated"):
        replay_report(path)


def test_schema_rejects_missing_duplicate_or_reordered_probe_set():
    report = _report(all_pass=False).model_dump(mode="json")
    report["probes"] = report["probes"][:-1]
    with pytest.raises(ValidationError, match="fixed ordered probe set"):
        EvaluatorPrequalificationReport.model_validate(report)

    report = _report(all_pass=False).model_dump(mode="json")
    report["probes"][1] = report["probes"][0]
    with pytest.raises(ValidationError, match="fixed ordered probe set"):
        EvaluatorPrequalificationReport.model_validate(report)


def test_probe_pass_requires_expected_outcome_and_cleanup():
    with pytest.raises(ValidationError, match="confirmed cleanup"):
        _probe(QualificationProbeId.EFFECTIVE_CONTAINER_ISOLATION, cleanup=False)
    bad = _probe(QualificationProbeId.OUTPUT_LIMIT).model_dump(mode="json")
    bad["output_limited"] = False
    with pytest.raises(ValidationError, match="output-limit probe"):
        QualificationProbeEvidence.model_validate(bad)

    external = _probe(QualificationProbeId.DAEMON_RESTART_REAP).model_dump(mode="json")
    external["external_evidence_digest"] = None
    with pytest.raises(ValidationError, match="external probe requires an evidence digest"):
        QualificationProbeEvidence.model_validate(external)


def test_runner_uses_only_fixed_probe_ids_and_leaves_external_work_unavailable():
    seen = []

    def fake_evaluate(payload, policy, *, local_endpoint):
        request = json.loads(payload)
        assert set(request) == {"probe_id"}
        probe_id = QualificationProbeId(request["probe_id"])
        seen.append(probe_id)
        assert local_endpoint == "unix:///tmp/fake-docker.sock"
        assert policy.image == IMAGE
        assert policy.entrypoint == "/usr/local/bin/python"
        assert policy.command[:2] == ("-I", "-c")
        if probe_id is QualificationProbeId.OUTPUT_LIMIT:
            return SimpleNamespace(exit_code=-9, timed_out=False, output_limited=True,
                                   stdout=b"x" * 1024, stderr=b"", container_removed=True)
        if probe_id is QualificationProbeId.WALL_TIMEOUT:
            return SimpleNamespace(exit_code=-9, timed_out=True, output_limited=False,
                                   stdout=b"", stderr=b"", container_removed=True)
        code = 7 if probe_id is QualificationProbeId.SYNTHETIC_EXIT_NONZERO else 0
        return SimpleNamespace(exit_code=code, timed_out=False, output_limited=False,
                               stdout=b"guru-probe-ok\n" if code == 0 else b"",
                               stderr=b"", container_removed=True)

    with patch("guru.evaluator_prequalification.APPROVED_PROBE_IMAGE_REF", IMAGE), \
         patch("guru.evaluator_prequalification._docker_versions", return_value=("1", "1", "Linux", "arm64")), \
         patch("guru.evaluator_prequalification.evaluate", side_effect=fake_evaluate):
        report = run_prequalification(endpoint="unix:///tmp/fake-docker.sock", image_ref=IMAGE,
                                      require_socket=False)
    assert verify_report(report)
    assert report.status is PrequalificationStatus.PREQUALIFICATION
    assert set(seen) == {
        QualificationProbeId.EFFECTIVE_CONTAINER_ISOLATION,
        QualificationProbeId.NETWORK_AND_HOST_ISOLATION,
        QualificationProbeId.RESOURCE_LIMITS,
        QualificationProbeId.OUTPUT_LIMIT,
        QualificationProbeId.WALL_TIMEOUT,
        QualificationProbeId.FRESH_CONTAINER_CLEANUP,
        QualificationProbeId.SYNTHETIC_EXIT_ZERO,
        QualificationProbeId.SYNTHETIC_EXIT_NONZERO,
    }
    probes = {probe.probe_id: probe for probe in report.probes}
    for probe_id in (
        QualificationProbeId.DISPOSABLE_WORKER_LIFECYCLE,
        QualificationProbeId.CANCELLATION_CLEANUP,
        QualificationProbeId.RUNNER_CRASH_ORPHAN_REAP,
        QualificationProbeId.DAEMON_RESTART_REAP,
        QualificationProbeId.HOST_RESTART_AND_RESET,
        QualificationProbeId.ADVERSARIAL_ACCEPTANCE_SUITE,
        QualificationProbeId.CASE_TEST_PASS_MAPPING,
        QualificationProbeId.CASE_TEST_FAIL_MAPPING,
        QualificationProbeId.FROZEN_RUNTIME_POLICY,
    ):
        assert probes[probe_id].status is ProbeStatus.UNAVAILABLE
    assert all("raw" not in name for name in EvaluatorPrequalificationReport.model_fields)


def test_runner_fails_closed_when_backend_probe_fails():
    def failed(payload, policy, *, local_endpoint):
        return SimpleNamespace(exit_code=1, timed_out=False, output_limited=False,
                               stdout=b"private output", stderr=b"details", container_removed=False)

    with patch("guru.evaluator_prequalification.APPROVED_PROBE_IMAGE_REF", IMAGE), \
         patch("guru.evaluator_prequalification._docker_versions", return_value=(None, None, None, None)), \
         patch("guru.evaluator_prequalification.evaluate", side_effect=failed):
        report = run_prequalification(endpoint="unix:///tmp/fake.sock", image_ref=IMAGE, require_socket=False)
    assert report.status is PrequalificationStatus.BLOCKED
    assert "probe_failed:effective_container_isolation" in report.blockers
    assert all(probe.stdout_bytes <= 1024 * 1024 and probe.stderr_bytes <= 1024 * 1024 for probe in report.probes)
    assert "probe_image_not_independently_reviewed" not in report.blockers


def test_unreviewed_image_emits_unavailable_probes_without_touching_docker():
    with patch("guru.evaluator_prequalification.APPROVED_PROBE_IMAGE_REF", None), \
         patch("guru.evaluator_prequalification._docker_versions",
               side_effect=AssertionError("must not contact Docker")), \
         patch("guru.evaluator_prequalification.evaluate",
               side_effect=AssertionError("must not execute an unreviewed image")):
        report = run_prequalification(
            endpoint="unix:///tmp/fake.sock", image_ref=IMAGE, require_socket=False,
        )
    assert report.status is PrequalificationStatus.PREQUALIFICATION
    assert "probe_image_not_independently_reviewed" in report.blockers
    assert all(
        probe.status is ProbeStatus.UNAVAILABLE
        for probe in report.probes
        if probe.probe_id is not QualificationProbeId.EVIDENCE_INTEGRITY_REPLAY
    )
    assert next(probe for probe in report.probes
                if probe.probe_id is QualificationProbeId.EVIDENCE_INTEGRITY_REPLAY).status is ProbeStatus.PASS


def test_cli_has_no_candidate_or_approval_or_promotion_arguments():
    parser = _parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["run", "--endpoint", "unix:///tmp/fake.sock", "--image", IMAGE,
                          "--output", "report.json", "--approve"])
    with pytest.raises(SystemExit):
        parser.parse_args(["run", "--endpoint", "unix:///tmp/fake.sock", "--image", IMAGE,
                          "--output", "report.json", "--candidate-source", "x=1"])
    with pytest.raises(SystemExit):
        parser.parse_args(["promote", "--report", "report.json"])


def test_promotion_stays_prequalification_without_worker_attestation_or_review():
    report = _report()
    decision = promote_qualification(
        report, None, None, now=NOW + timedelta(hours=1),
    )
    assert decision.status is PromotionStatus.PREQUALIFICATION
    assert "worker_attestation_missing" in decision.blockers
    assert "independent_review_missing" in decision.blockers


def test_promotion_does_not_ignore_unavailable_restart_probes_or_unknown_report_blockers():
    report = _report(all_pass=False)
    attestation = _attestation()
    review = _review(report, attestation)
    decision = promote_qualification(
        report, attestation, review, now=NOW + timedelta(hours=1),
    )
    assert decision.status is PromotionStatus.BLOCKED
    assert "required_probe_not_passed:daemon_restart_reap" in decision.blockers

    mutated = report.model_dump(mode="json")
    mutated["blockers"].append("unrecognized_external_approval")
    report_with_unknown = seal_report(mutated)
    review_with_unknown = _review(report_with_unknown, attestation)
    decision = promote_qualification(
        report_with_unknown, attestation, review_with_unknown, now=NOW + timedelta(hours=1),
    )
    assert "report_contains_unrecognized_blockers" in decision.blockers


@pytest.mark.parametrize("lifecycle", [WorkerLifecycle.PERSISTENT_WORKSTATION])
def test_promotion_rejects_persistent_worker_even_if_attestation_is_pinned(lifecycle):
    report = _report()
    attestation = _attestation(lifecycle=lifecycle)
    review = _review(report, attestation)
    decision = promote_qualification(
        report, attestation, review, now=NOW + timedelta(hours=1),
    )
    assert decision.status is PromotionStatus.PREQUALIFICATION
    assert "worker_is_not_disposable_linux_vm" in decision.blockers


def test_promotion_rejects_stale_or_mismatched_attestation_and_review():
    report = _report()
    attestation = _attestation()
    review = _review(report, attestation).model_copy(update={"config_digest": DIGESTS["policy"]})
    decision = promote_qualification(
        report, attestation, review, now=NOW + timedelta(days=100),
    )
    assert decision.status is PromotionStatus.PREQUALIFICATION
    assert "authenticated_trust_root_unavailable" in decision.blockers
    assert "worker_attestation_expired" in decision.blockers
    assert "review_config_digest_mismatch" in decision.blockers

    changed_receipts = attestation.model_copy(update={"destruction_receipt_digest": "d" * 64})
    changed_review = _review(report, changed_receipts)
    receipt_decision = promote_qualification(
        report, changed_receipts, changed_review, now=NOW + timedelta(hours=1),
    )
    assert "worker_reset_receipts_do_not_match_lifecycle_probe" in receipt_decision.blockers


def test_promotion_blocks_failed_probe_or_unconfirmed_cleanup():
    failed_report = _report(failed_probe=QualificationProbeId.EFFECTIVE_CONTAINER_ISOLATION)
    attestation = _attestation()
    review = _review(failed_report, attestation)
    decision = promote_qualification(
        failed_report, attestation, review, now=NOW + timedelta(hours=1),
    )
    assert decision.status is PromotionStatus.BLOCKED
    assert "report_has_failed_probes" in decision.blockers
    assert "probe_cleanup_unconfirmed:effective_container_isolation" in decision.blockers


def test_promotion_never_qualifies_without_authenticated_trust_root():
    report = _report()
    attestation = _attestation()
    review = _review(report, attestation)
    decision = promote_qualification(
        report, attestation, review, now=NOW + timedelta(hours=1),
    )
    assert decision.status is PromotionStatus.PREQUALIFICATION
    assert "authenticated_trust_root_unavailable" in decision.blockers

    same_operator_review = review.model_copy(update={"reviewer_identity": attestation.operator_identity})
    rejected = promote_qualification(
        report, attestation, same_operator_review, now=NOW + timedelta(hours=1),
    )
    assert rejected.status is PromotionStatus.PREQUALIFICATION
    assert "reviewer_is_not_independent_of_worker_approval" in rejected.blockers
