from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path

import pytest

from guru.quality import checks
from guru.schemas.quality import AdmissionDecision, AutoCheckName, QualityTier, REQUIRED_AUTO_CHECKS


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


def test_schema_check_passes_and_hashes_unicode_input():
    result = checks.schema_check(_item())
    assert result.name is AutoCheckName.SCHEMA
    assert result.passed is True
    assert result.evidence_digest and len(result.evidence_digest) == 64


def test_schema_check_fails_invalid_corpus_item():
    raw = _item()
    raw["source_digest"] = "not-a-digest"
    result = checks.schema_check(raw)
    assert result.name is AutoCheckName.SCHEMA
    assert result.passed is False
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
            tool_version=checks.TOOL_VERSION,
            policy_version=checks.POLICY_VERSIONS[name],
        )
        for index, name in enumerate(sorted(REQUIRED_AUTO_CHECKS, key=lambda value: value.value))
    )
    report = checks.CheckRunReport(records)
    auto_checks = report.as_auto_checks()
    assert len(auto_checks) == len(REQUIRED_AUTO_CHECKS)
    assert all(check.passed is (check.name is not AutoCheckName.SYNTAX) for check in auto_checks)

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
