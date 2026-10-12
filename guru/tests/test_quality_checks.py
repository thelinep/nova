from __future__ import annotations

from copy import deepcopy
import ast
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path

import pytest

from guru.quality import checks
from guru.quality.providers import (
    ApprovedRightsInputs, EvaluatorEvidenceProvider, PinnedEvaluatorInputs,
    RightsEvidenceProvider,
)
from guru.schemas.corpus_item import CorpusItem
from guru.schemas.evaluator_evidence import (
    EvaluationCaseEvidence, EvaluatorCaseSet, EvaluatorQualificationEvidence,
)
from guru.schemas.rights_decision import (
    RightsAuthorityBasis, RightsDecision, RightsEvidenceReference, SourceRights,
)
from guru.schemas.teacher_lineage import (
    AccessMethod, InputDisclosure, InputType, OutputRights, ReviewStatus, TeacherLineage,
)
from guru.schemas.quality import AdmissionDecision, AutoCheckName, QualityTier, REQUIRED_AUTO_CHECKS

from guru.evaluator_evidence import _ZERO_DIGEST, seal_case


def _item(**overrides):
    value = {
        "item_id": "item-1",
        "task_id": "task-1",
        "prompt": "Print a greeting.",
        "target": "print('नमस्ते')\n",
        "target_source": "synthetic",
        "source_digest": "a" * 64,
        "language": "python",
        "metadata": {"leakage_group": "family-1", "split": "train"},
    }
    value.update(overrides)
    return value


def _source_manifest(tmp_path: Path) -> tuple[Path, str, str]:
    artifact = b"synthetic pinned source artifact"
    license_text = b"Synthetic fixture license text"
    artifact_path = tmp_path / "artifact.bin"
    license_path = tmp_path / "LICENSE.txt"
    artifact_path.write_bytes(artifact)
    license_path.write_bytes(license_text)
    manifest = {
        "schema_version": "guru-code-source-manifest-v1",
        "sources": [{
            "source_id": "source-1",
            "uri": "https://example.invalid/source-1",
            "revision": "immutable-rev-1",
            "artifact_path": artifact_path.name,
            "artifact_sha256": hashlib.sha256(artifact).hexdigest(),
            "attribution": "Synthetic test fixture attribution",
            "license": {
                "id": "LicenseRef-Test-Only",
                "text_uri": "local:LICENSE.txt",
                "text_path": license_path.name,
                "text_sha256": hashlib.sha256(license_text).hexdigest(),
            },
            "rights_review": {
                "status": "approved",
                "reviewer": "synthetic-fixture-reviewer",
                "reviewed_at": "2026-10-12T00:00:00Z",
                "allowed_uses": ["train_sft"],
            },
            "task_hashes": {"synthetic-task": "b" * 64},
        }],
    }
    manifest_path = tmp_path / "source-manifest.json"
    manifest_path.write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
    manifest_digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    return manifest_path, manifest_digest, hashlib.sha256(artifact).hexdigest()


def _case_record(item: CorpusItem, case_id: str, *, status: str, previous_digest: str,
                 test_digest: str, task_digest: str, image_digest: str, config_digest: str) -> dict:
    started = datetime(2026, 10, 12, tzinfo=timezone.utc)
    return {
        "schema_version": "guru-evaluator-case-v3", "case_id": case_id,
        "item_digest": item.canonical_digest(), "task_digest": task_digest,
        "candidate_digest": hashlib.sha256(item.target.encode("utf-8")).hexdigest(),
        "test_digest": test_digest, "test_suite_digest": "c" * 64,
        "image_digest": image_digest, "config_digest": config_digest,
        "command": ["/runner", "--fixed-json-stdin"],
        "limits": {"timeout_ms": 10_000, "memory_bytes": 512 * 1024 * 1024,
                   "cpu_millis": 1000, "pids": 32, "output_bytes": 4096,
                   "input_bytes": 65_536},
        "started_at": started.isoformat(),
        "finished_at": (started + timedelta(milliseconds=10)).isoformat(),
        "status": status, "exit_code": 0 if status == "pass" else 1,
        "cleanup_confirmed": True, "output_limited": False,
        "stdout_truncated": False, "stderr_truncated": False,
        "stdout_bytes": 0, "stderr_bytes": 0,
        "stdout_digest": "1" * 64, "stderr_digest": "2" * 64,
        "previous_record_digest": previous_digest, "record_digest": "0" * 64,
    }


def _evaluator_inputs(item: CorpusItem, *, statuses=("pass", "pass"), **overrides) -> PinnedEvaluatorInputs:
    config_digest, image_digest, task_digest = "e" * 64, "d" * 64, "a" * 64
    case_ids = ("case-1", "case-2")
    test_digests = {"case-1": "4" * 64, "case-2": "5" * 64}
    cases = []
    previous = _ZERO_DIGEST
    for case_id, status in zip(case_ids, statuses, strict=True):
        case = seal_case(_case_record(item, case_id, status=status, previous_digest=previous,
                                      test_digest=test_digests[case_id], task_digest=task_digest,
                                      image_digest=image_digest, config_digest=config_digest),
                         previous_record_digest=previous)
        cases.append(case)
        previous = case.record_digest
    case_set = EvaluatorCaseSet(
        schema_version="guru-evaluator-case-set-v1", item_digest=item.canonical_digest(),
        test_suite_digest="c" * 64, config_digest=config_digest,
        starting_record_digest=_ZERO_DIGEST, expected_case_ids=list(case_ids), cases=cases,
    )
    qualification = EvaluatorQualificationEvidence(
        schema_version="guru-evaluator-qualification-v1", qualification_id="synthetic-qualification",
        config_digest=config_digest, image_digest=image_digest, report_digest="f" * 64,
        qualified_at=datetime(2026, 10, 12, tzinfo=timezone.utc),
    )
    qdigest = checks._digest(qualification.model_dump(mode="json"))
    values = PinnedEvaluatorInputs(
        case_set=case_set, qualification=qualification, qualification_digest=qdigest,
        trusted_qualification_digest=qdigest, test_suite_digest="c" * 64,
        trusted_test_suite_digest="c" * 64, expected_case_ids=case_ids,
        expected_case_test_digests=test_digests, task_digest=task_digest,
    )
    return replace(values, **overrides) if overrides else values


class _FakeEvaluatorProvider(EvaluatorEvidenceProvider):
    def __init__(self, value: PinnedEvaluatorInputs):
        self.value = value

    def load_for(self, item: CorpusItem) -> PinnedEvaluatorInputs:
        return self.value


def _approved_teacher(*, status=ReviewStatus.APPROVED) -> TeacherLineage:
    return TeacherLineage(
        teacher_id="teacher-1", model_name="synthetic-teacher", license="Fixture",
        access_method=AccessMethod.WEIGHTS, output_rights=OutputRights.MAY_TRAIN,
        review_status=status, reviewed_by="owner" if status is ReviewStatus.APPROVED else None,
        reviewed_at=datetime(2026, 10, 12, tzinfo=timezone.utc) if status is ReviewStatus.APPROVED else None,
        model_digest=["3" * 64], input_disclosure=InputDisclosure(
            allowed_input_types=[InputType.SOURCE_CODE], retention_bounded=True),
    )


def _rights_inputs(item: CorpusItem, *, allow_training=True, allow_retention=True,
                   artifact_digest=None, approved_artifact_digest=None, manifest_digest="9" * 64,
                   trusted_manifest_digest="9" * 64, teacher_registry_digest="8" * 64,
                   trusted_teacher_registry_digest="8" * 64,
                   teacher_status=ReviewStatus.APPROVED) -> ApprovedRightsInputs:
    decision = RightsDecision(
        schema_version="guru-source-rights-v1", source_id="synthetic-source",
        uri="local:synthetic-source", revision="fixture-v1",
        artifact_sha256=artifact_digest or item.source_digest,
        provenance_statement="synthetic fixture only", authority_basis=RightsAuthorityBasis.OWNER_ATTESTATION,
        authority_description="synthetic test approval", rights=SourceRights(
            allow_training=allow_training, allow_evaluation=True,
            allow_transformed_data_retention=allow_retention,
            allow_provider_transmission=False, allow_weight_distribution=False),
        reviewer="synthetic-owner", decided_at=datetime(2026, 10, 12, tzinfo=timezone.utc),
        evidence_refs=[RightsEvidenceReference(evidence_id="fixture", uri="local:fixture", sha256="7" * 64)],
    )
    teachers = (_approved_teacher(status=teacher_status),) if item.teacher_lineage_id else ()
    return ApprovedRightsInputs(
        decision=decision, approved_artifact_digest=approved_artifact_digest or item.source_digest,
        rights_manifest_digest=manifest_digest,
        trusted_rights_manifest_digest=trusted_manifest_digest,
        teachers=teachers, teacher_registry_digest=teacher_registry_digest if teachers else None,
        trusted_teacher_registry_digest=(trusted_teacher_registry_digest if teachers else None),
    )


class _FakeRightsProvider(RightsEvidenceProvider):
    def __init__(self, value: ApprovedRightsInputs):
        self.value = value

    def load_for(self, item: CorpusItem) -> ApprovedRightsInputs:
        return self.value


def _runner_report(tmp_path: Path, *, raw_item=None, evaluator_provider=None, rights_provider=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    manifest_path, manifest_digest, source_digest = _source_manifest(tmp_path)
    item = CorpusItem.model_validate(raw_item or _item(source_digest=source_digest))
    return checks.run_deterministic_checks(
        item, source_manifest_path=manifest_path, source_manifest_digest=manifest_digest,
        corpus_items=[], group_assignments={"family-1": "train"},
        evaluator_provider=evaluator_provider or _FakeEvaluatorProvider(_evaluator_inputs(item)),
        rights_provider=rights_provider,
    ), item


def test_schema_check_passes_and_hashes_unicode_input():
    result = checks.schema_check(_item())
    assert result.name is AutoCheckName.SCHEMA
    assert result.passed is True
    assert result.item_digest == checks._item_binding(_item())
    assert result.evidence_digest and len(result.evidence_digest) == 64


def test_schema_check_fails_invalid_corpus_item():
    raw = _item()
    raw["source_digest"] = "not-a-digest"
    result = checks.schema_check(raw)
    assert result.name is AutoCheckName.SCHEMA
    assert result.passed is False
    assert result.item_digest == checks._item_binding(raw)
    assert result.evidence_digest


def test_schema_check_rejects_uncanonicalizable_malformed_data():
    raw = _item()
    raw["unknown"] = object()
    with pytest.raises(checks.CheckInputError):
        checks.schema_check(raw)


def test_python_ast_check_passes_valid_unicode_source_and_rejects_syntax_error():
    valid = checks.syntax_check(_item())
    invalid = checks.syntax_check(_item(target="def broken(:\n    pass"))
    assert valid.name is AutoCheckName.SYNTAX and valid.passed is True
    assert invalid.name is AutoCheckName.SYNTAX and invalid.passed is False
    assert valid.evidence_digest != invalid.evidence_digest


def test_python_ast_check_is_unavailable_for_other_languages():
    with pytest.raises(checks.CheckUnavailableError, match="only for Python"):
        checks.syntax_check(_item(language="rust", target="fn main() {}"))


def test_no_cot_check_scans_prompt_and_target_case_insensitively():
    assert checks.no_cot_check(_item()).passed is True
    result = checks.no_cot_check(_item(target="<THINK>secret reasoning</THINK>"))
    assert result.name is AutoCheckName.SECURITY
    assert result.passed is False
    assert result.evidence_digest


def test_secret_scan_uses_disclosure_patterns_without_raw_secret_evidence():
    secret = "AKIA1234567890ABCDEF"
    clean = checks.secret_check(_item(target="print('hello')"))
    found = checks.secret_check(_item(target=f"key = '{secret}'"))
    assert clean.name is AutoCheckName.SECURITY and clean.passed is True
    assert found.name is AutoCheckName.SECURITY and found.passed is False
    assert found.evidence_digest
    assert secret not in found.model_dump_json()


def test_secret_scanner_failure_fails_closed(monkeypatch):
    class BrokenPattern:
        def findall(self, _text):
            raise RuntimeError("scanner unavailable")

    monkeypatch.setattr(checks.redact, "SECRET_PATTERNS", (("broken", BrokenPattern(), "x"),))
    result = checks.secret_check(_item())
    assert result.name is AutoCheckName.SECURITY
    assert result.passed is False
    assert result.evidence_digest


def test_combined_security_check_is_one_fail_closed_security_result():
    assert checks.security_check(_item()).passed is True
    assert checks.security_check(_item(target="<think>reasoning</think>")).passed is False
    assert checks.security_check(_item(target="token = 'AKIA1234567890ABCDEF'")).passed is False


def test_each_direct_producer_binds_exact_canonical_item_digest(tmp_path):
    manifest_path, manifest_digest, source_digest = _source_manifest(tmp_path)
    item = _item(source_digest=source_digest)
    item_digest = checks._item_binding(item)
    results = [
        checks.schema_check(item),
        checks.syntax_check(item),
        checks.no_cot_check(item),
        checks.secret_check(item),
        checks.security_check(item),
        checks.provenance_check(item, manifest_path=manifest_path,
                                expected_manifest_digest=manifest_digest),
        checks.duplicate_check(item, corpus_items=[]),
        checks.leakage_check(item, group_assignments={"family-1": "train"}),
    ]
    assert all(result.item_digest == item_digest for result in results)


def test_item_mutation_changes_binding_and_stales_prior_check_evidence():
    from guru.quality import gate

    original = _item()
    changed = _item(target="print('changed')\n")
    old_result = checks.syntax_check(original)
    old_digest = checks._item_binding(original)
    changed_digest = checks._item_binding(changed)
    assert old_digest != changed_digest
    assert old_result.item_digest == old_digest
    current_checks = [
        checks.AutoCheckResult(name=name, passed=True, item_digest=changed_digest,
                               evidence_digest="a" * 64, tool_version="test-tool/1",
                               policy_version="test-policy/1")
        for name in AutoCheckName
    ]
    stale_index = next(index for index, check in enumerate(current_checks)
                       if check.name is old_result.name)
    current_checks[stale_index] = old_result
    with pytest.raises(gate.QualityInputError, match="bind to the decision item_digest"):
        gate.item_decision(item_id="item-1", item_digest=changed_digest,
                           tier=QualityTier.C, auto_checks=current_checks,
                           human_review=None)


def test_provenance_requires_pinned_manifest_and_matches_digest_membership():
    with pytest.raises(checks.CheckUnavailableError, match="not supplied"):
        checks.provenance_check(_item(), manifest_path=None, expected_manifest_digest=None)


def test_provenance_requires_digest_pin_and_validated_manifest(tmp_path):
    manifest_path, manifest_digest, source_digest = _source_manifest(tmp_path)
    with pytest.raises(checks.CheckUnavailableError, match="digest pin"):
        checks.provenance_check(_item(source_digest=source_digest),
                                manifest_path=manifest_path, expected_manifest_digest=None)
    item = _item(source_digest=source_digest)
    passed = checks.provenance_check(item, manifest_path=manifest_path,
                                     expected_manifest_digest=manifest_digest)
    wrong_pin = checks.provenance_check(item, manifest_path=manifest_path,
                                        expected_manifest_digest="0" * 64)
    absent_member = checks.provenance_check(_item(source_digest="c" * 64),
                                            manifest_path=manifest_path,
                                            expected_manifest_digest=manifest_digest)
    assert passed.name is AutoCheckName.PROVENANCE and passed.passed is True
    assert wrong_pin.passed is False
    assert absent_member.passed is False


def test_provenance_rejects_invalid_manifest_contract(tmp_path):
    bad_path = tmp_path / "bad.json"
    bad_path.write_text('{"schema_version":"wrong","sources":[]}', encoding="utf-8")
    with pytest.raises(checks.CheckInputError, match="failed Guru release validation"):
        checks.provenance_check(_item(), manifest_path=bad_path,
                                expected_manifest_digest=hashlib.sha256(bad_path.read_bytes()).hexdigest())


def test_duplicate_check_detects_exact_model_facing_pair_and_requires_corpus():
    candidate = _item()
    same_payload = _item(item_id="item-2", task_id="other-task")
    changed = _item(item_id="item-3", target="print('different')")
    with pytest.raises(checks.CheckUnavailableError, match="not supplied"):
        checks.duplicate_check(candidate, corpus_items=None)
    duplicate = checks.duplicate_check(candidate, corpus_items=[same_payload, changed])
    clean = checks.duplicate_check(candidate, corpus_items=[changed])
    assert duplicate.name is AutoCheckName.DUPLICATE and duplicate.passed is False
    assert clean.passed is True


def test_leakage_check_rejects_cross_split_group_and_missing_assignments():
    candidate = _item()
    with pytest.raises(checks.CheckUnavailableError, match="not supplied"):
        checks.leakage_check(candidate, group_assignments=None)
    valid = checks.leakage_check(candidate, group_assignments={"family-1": "train"})
    cross_split = checks.leakage_check(candidate, group_assignments={"family-1": ["train", "test"]})
    wrong_declared = checks.leakage_check(candidate, group_assignments={"family-1": "validation"})
    assert valid.name is AutoCheckName.LEAKAGE and valid.passed is True
    assert cross_split.passed is False
    assert wrong_declared.passed is False


def test_leakage_check_rejects_unknown_split_label():
    with pytest.raises(checks.CheckInputError, match="train, validation, or test"):
        checks.leakage_check(_item(), group_assignments={"family-1": "eval"})
    with pytest.raises(checks.CheckInputError, match="train, validation, or test"):
        checks.leakage_check(_item(), group_assignments={"family-1": "dev"})
    with pytest.raises(checks.CheckInputError, match="item split"):
        checks.leakage_check(_item(metadata={"leakage_group": "family-1", "split": "eval"}),
                             group_assignments={"family-1": "train"})


def test_leakage_check_fails_unavailable_group_key():
    raw = deepcopy(_item())
    raw["metadata"].pop("leakage_group")
    with pytest.raises(checks.CheckUnavailableError, match="no leakage_group"):
        checks.leakage_check(raw, group_assignments={"family-1": "train"})


def test_evidence_digest_includes_stable_tool_and_policy_versions(monkeypatch):
    before = checks.schema_check(_item())
    monkeypatch.setattr(checks, "TOOL_VERSION", "guru-deterministic-checks/test")
    after = checks.schema_check(_item())
    assert checks.POLICY_VERSIONS[AutoCheckName.SCHEMA] == "corpus-item-schema-v1"
    assert before.evidence_digest != after.evidence_digest


def test_runner_reports_tri_state_and_never_converts_incomplete_checks():
    item = _item()
    report = checks.run_deterministic_checks(
        item, corpus_items=[item], group_assignments={"family-1": "train"}
    )
    statuses = {record.name: record.status for record in report.records}
    expected_item_digest = checks._item_binding(item)
    assert all(record.item_digest == expected_item_digest for record in report.records)
    assert statuses[AutoCheckName.SCHEMA] is checks.CheckRunStatus.PASS
    assert statuses[AutoCheckName.SECURITY] is checks.CheckRunStatus.PASS
    assert statuses[AutoCheckName.TESTS] is checks.CheckRunStatus.UNAVAILABLE
    assert statuses[AutoCheckName.LICENSE] is checks.CheckRunStatus.UNAVAILABLE
    assert statuses[AutoCheckName.PROVENANCE] is checks.CheckRunStatus.UNAVAILABLE
    with pytest.raises(checks.IncompleteCheckRunError, match="cannot be converted"):
        report.as_auto_checks()


def test_runner_marks_missing_required_inputs_unavailable():
    report = checks.run_deterministic_checks(_item())
    statuses = {record.name: record.status for record in report.records}
    expected_item_digest = checks._item_binding(_item())
    assert all(record.item_digest == expected_item_digest for record in report.records)
    assert statuses[AutoCheckName.PROVENANCE] is checks.CheckRunStatus.UNAVAILABLE
    assert statuses[AutoCheckName.DUPLICATE] is checks.CheckRunStatus.UNAVAILABLE
    assert statuses[AutoCheckName.LEAKAGE] is checks.CheckRunStatus.UNAVAILABLE
    assert statuses[AutoCheckName.TESTS] is checks.CheckRunStatus.UNAVAILABLE
    assert statuses[AutoCheckName.LICENSE] is checks.CheckRunStatus.UNAVAILABLE
    assert len(report.records) == len(checks.REQUIRED_AUTO_CHECKS)


def test_complete_measured_failure_converts_and_quality_gate_quarantines(tmp_path, monkeypatch):
    from guru.quality import gate

    # Synthetic complete evidence isolates conversion behavior; it is not a
    # qualified evaluator or owner/source rights claim.
    audit_path = tmp_path / "isolated-quality.jsonl"
    monkeypatch.setattr(gate, "AUDIT_PATH", audit_path)
    records = tuple(
        checks.CheckStatusRecord(
            name=name,
            status=(checks.CheckRunStatus.FAIL if name is AutoCheckName.SYNTAX
                    else checks.CheckRunStatus.PASS),
            evidence_digest=(str(index + 1) * 64),
            item_digest="d" * 64,
            tool_version=checks.TOOL_VERSION,
            policy_version=checks.POLICY_VERSIONS[name],
        )
        for index, name in enumerate(sorted(REQUIRED_AUTO_CHECKS, key=lambda value: value.value))
    )
    report = checks.CheckRunReport(records)
    auto_checks = report.as_auto_checks()
    assert len(auto_checks) == len(REQUIRED_AUTO_CHECKS)
    assert all(check.passed is (check.name is not AutoCheckName.SYNTAX) for check in auto_checks)
    assert all(check.item_digest == "d" * 64 for check in auto_checks)

    decision = gate.item_decision(
        item_id="synthetic-failed-item",
        item_digest="d" * 64,
        tier=QualityTier.C,
        auto_checks=auto_checks,
        human_review=None,
    )
    assert decision.decision is AdmissionDecision.QUARANTINE
    assert "failed_auto_check:syntax" in decision.reason_codes
    audit_rows = [json.loads(line) for line in audit_path.read_text(encoding="utf-8").splitlines()]
    assert len(audit_rows) == 1
    assert audit_rows[0]["decision"] == AdmissionDecision.QUARANTINE.value


def test_mixed_item_run_is_rejected_before_any_audit_write(tmp_path, monkeypatch):
    from guru.quality import gate

    audit_path = tmp_path / "mixed-run-audit.jsonl"
    monkeypatch.setattr(gate, "AUDIT_PATH", audit_path)
    records = tuple(
        checks.CheckStatusRecord(
            name=name,
            status=checks.CheckRunStatus.PASS,
            evidence_digest=(str(index + 1) * 64),
            item_digest=("a" * 64 if index < len(REQUIRED_AUTO_CHECKS) - 1 else "b" * 64),
            tool_version=checks.TOOL_VERSION,
            policy_version=checks.POLICY_VERSIONS[name],
        )
        for index, name in enumerate(sorted(REQUIRED_AUTO_CHECKS, key=lambda value: value.value))
    )
    mixed_auto_checks = checks.CheckRunReport(records).as_auto_checks()
    with pytest.raises(gate.QualityInputError, match="bind to the decision item_digest"):
        gate.item_decision(item_id="synthetic-mixed-item", item_digest="a" * 64,
                           tier=QualityTier.C, auto_checks=mixed_auto_checks,
                           human_review=None)
    assert not audit_path.exists()


def test_orchestrator_without_typed_providers_writes_no_decision_or_audit(tmp_path, monkeypatch):
    from guru.quality import gate, runner

    audit_path = tmp_path / "unavailable-audit.jsonl"
    monkeypatch.setattr(gate, "AUDIT_PATH", audit_path)
    report = checks.run_deterministic_checks(
        _item(), corpus_items=[_item()], group_assignments={"family-1": "train"})
    assert {r.name: r.status for r in report.records}[AutoCheckName.TESTS] is checks.CheckRunStatus.UNAVAILABLE
    assert {r.name: r.status for r in report.records}[AutoCheckName.LICENSE] is checks.CheckRunStatus.UNAVAILABLE
    with pytest.raises(checks.IncompleteCheckRunError):
        monkeypatch.setattr(runner, "item_decision", lambda **kwargs: pytest.fail("decision must not run"))
        runner.run_item_quality(_item(), tier=QualityTier.C, corpus_items=[_item()],
                                group_assignments={"family-1": "train"})
    assert not audit_path.exists()


def test_untyped_request_time_evidence_cannot_self_pin_tests_or_license():
    report = checks.run_deterministic_checks(
        _item(), evaluator_provider=object(), rights_provider=object(),
        corpus_items=[_item()], group_assignments={"family-1": "train"})
    statuses = {record.name: record.status for record in report.records}
    assert statuses[AutoCheckName.TESTS] is checks.CheckRunStatus.UNAVAILABLE
    assert statuses[AutoCheckName.LICENSE] is checks.CheckRunStatus.UNAVAILABLE


def test_fake_provider_aggregates_complete_pinned_case_set_pass_and_fail(tmp_path):
    item = CorpusItem.model_validate(_item(source_digest=hashlib.sha256(b"synthetic pinned source artifact").hexdigest()))
    passed, _ = _runner_report(tmp_path / "pass", raw_item=item.model_dump(mode="json"),
                               evaluator_provider=_FakeEvaluatorProvider(_evaluator_inputs(item)))
    statuses = {record.name: record.status for record in passed.records}
    assert statuses[AutoCheckName.TESTS] is checks.CheckRunStatus.PASS

    failed_root = tmp_path / "fail"
    failed_root.mkdir()
    failed_inputs = _evaluator_inputs(item, statuses=("pass", "fail"))
    failed, _ = _runner_report(failed_root, raw_item=item.model_dump(mode="json"),
                               evaluator_provider=_FakeEvaluatorProvider(failed_inputs))
    assert {record.name: record.status for record in failed.records}[AutoCheckName.TESTS] is checks.CheckRunStatus.FAIL


@pytest.mark.parametrize("override", [
    {"trusted_qualification_digest": "0" * 64},
    {"trusted_test_suite_digest": "0" * 64},
    {"expected_case_ids": ("case-1", "missing-case")},
    {"expected_case_test_digests": {"case-1": "0" * 64, "case-2": "5" * 64}},
    {"task_digest": "0" * 64},
])
def test_invalid_evaluator_trust_pins_and_case_bindings_stay_unavailable(tmp_path, override):
    item = CorpusItem.model_validate(_item(source_digest=hashlib.sha256(b"synthetic pinned source artifact").hexdigest()))
    inputs = _evaluator_inputs(item, **override)
    report, _ = _runner_report(tmp_path, raw_item=item.model_dump(mode="json"),
                               evaluator_provider=_FakeEvaluatorProvider(inputs))
    assert {record.name: record.status for record in report.records}[AutoCheckName.TESTS] is checks.CheckRunStatus.UNAVAILABLE


@pytest.mark.parametrize("case_binding", ["item", "candidate", "image", "config", "suite"])
def test_case_item_candidate_image_config_and_suite_mismatches_do_not_pass(tmp_path, case_binding):
    item = CorpusItem.model_validate(_item(source_digest=hashlib.sha256(b"synthetic pinned source artifact").hexdigest()))
    inputs = _evaluator_inputs(item)
    case_set = inputs.case_set
    case = case_set.cases[0]
    changed = case.model_dump(mode="json")
    if case_binding == "item":
        changed["item_digest"] = "0" * 64
    elif case_binding == "candidate":
        changed["candidate_digest"] = "0" * 64
    elif case_binding == "image":
        changed["image_digest"] = "0" * 64
    elif case_binding == "config":
        changed["config_digest"] = "0" * 64
    else:
        changed["test_suite_digest"] = "0" * 64
    cases = [seal_case(changed, previous_record_digest=_ZERO_DIGEST), case_set.cases[1]]
    # Rechain the second case after changing the first record.
    cases[1] = seal_case(cases[1], previous_record_digest=cases[0].record_digest)
    corrupted_set = case_set.model_copy(update={"cases": cases})
    report, _ = _runner_report(
        tmp_path, raw_item=item.model_dump(mode="json"),
        evaluator_provider=_FakeEvaluatorProvider(replace(inputs, case_set=corrupted_set)))
    assert {record.name: record.status for record in report.records}[AutoCheckName.TESTS] is checks.CheckRunStatus.UNAVAILABLE


def test_rights_provider_requires_exact_manifest_artifact_and_approved_teacher(tmp_path):
    teacher_item = CorpusItem.model_validate(_item(
        target_source="teacher", teacher_lineage_id="teacher-1",
        source_digest=hashlib.sha256(b"synthetic pinned source artifact").hexdigest()))
    approved = _FakeRightsProvider(_rights_inputs(teacher_item))
    report, _ = _runner_report(tmp_path, raw_item=teacher_item.model_dump(mode="json"),
                               rights_provider=approved)
    assert {record.name: record.status for record in report.records}[AutoCheckName.LICENSE] is checks.CheckRunStatus.PASS

    failures = [
        _rights_inputs(teacher_item, artifact_digest="0" * 64),
        _rights_inputs(teacher_item, approved_artifact_digest="0" * 64),
        _rights_inputs(teacher_item, trusted_manifest_digest="0" * 64),
        _rights_inputs(teacher_item, trusted_teacher_registry_digest="0" * 64),
        _rights_inputs(teacher_item, teacher_status=ReviewStatus.PENDING),
    ]
    for inputs in failures:
        failed_report, _ = _runner_report(
            tmp_path, raw_item=teacher_item.model_dump(mode="json"),
            rights_provider=_FakeRightsProvider(inputs))
        assert {record.name: record.status for record in failed_report.records}[AutoCheckName.LICENSE] is checks.CheckRunStatus.UNAVAILABLE


@pytest.mark.parametrize("allow_training,allow_retention", [(False, True), (True, False)])
def test_rights_provider_denied_training_or_retention_is_measured_fail(tmp_path, allow_training, allow_retention):
    item = CorpusItem.model_validate(_item(source_digest=hashlib.sha256(b"synthetic pinned source artifact").hexdigest()))
    provider = _FakeRightsProvider(_rights_inputs(
        item, allow_training=allow_training, allow_retention=allow_retention))
    report, _ = _runner_report(tmp_path, raw_item=item.model_dump(mode="json"), rights_provider=provider)
    assert {record.name: record.status for record in report.records}[AutoCheckName.LICENSE] is checks.CheckRunStatus.FAIL


def test_runner_with_partial_provider_evidence_never_decides_or_audits(tmp_path, monkeypatch):
    from guru.quality import gate, runner

    audit_path = tmp_path / "partial-provider-audit.jsonl"
    monkeypatch.setattr(gate, "AUDIT_PATH", audit_path)
    item = CorpusItem.model_validate(_item(source_digest=hashlib.sha256(b"synthetic pinned source artifact").hexdigest()))
    provider = _FakeEvaluatorProvider(_evaluator_inputs(item))
    monkeypatch.setattr(runner, "item_decision", lambda **kwargs: pytest.fail("incomplete run decided"))
    root = tmp_path / "partial"
    root.mkdir()
    with pytest.raises(checks.IncompleteCheckRunError, match="unavailable check"):
        runner.run_item_quality(item, tier=QualityTier.C, evaluator_provider=provider,
                                corpus_items=[], group_assignments={"family-1": "train"},
                                source_manifest_path=_source_manifest(root)[0],
                                source_manifest_digest=_source_manifest(root)[1])
    assert not audit_path.exists()


def test_only_quality_runner_calls_low_level_item_decision():
    package_root = Path(__file__).resolve().parents[1] / "guru"
    callers = []
    for source_path in package_root.rglob("*.py"):
        if "tests" in source_path.parts:
            continue
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                function = node.func
                called_name = function.id if isinstance(function, ast.Name) else (
                    function.attr if isinstance(function, ast.Attribute) else None)
                if called_name == "item_decision":
                    callers.append(source_path.relative_to(package_root).as_posix())
    assert callers == ["quality/runner.py"]
