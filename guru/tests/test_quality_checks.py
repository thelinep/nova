from __future__ import annotations

from copy import deepcopy

import pytest

from guru.quality import checks
from guru.schemas.quality import AutoCheckName


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
        checks.provenance_check(_item(), pinned_manifest=None)
    pass_result = checks.provenance_check(
        _item(), pinned_manifest={"source-a": "a" * 64, "source-b": "b" * 64}
    )
    fail_result = checks.provenance_check(_item(), pinned_manifest={"source-b": "b" * 64})
    assert pass_result.name is AutoCheckName.PROVENANCE and pass_result.passed is True
    assert fail_result.passed is False


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


def test_leakage_check_fails_unavailable_group_key():
    raw = deepcopy(_item())
    raw["metadata"].pop("leakage_group")
    with pytest.raises(checks.CheckUnavailableError, match="no leakage_group"):
        checks.leakage_check(raw, group_assignments={"family-1": "train"})
