"""Deterministic, non-executing quality check producers.

These helpers produce individual automatic check results. They deliberately
do not assemble all required checks, execute code, make rights decisions, or
write admission/audit records. A missing authoritative input raises a typed
error; a scanner failure becomes a failed check. The experiment split labels
are exactly ``train``, ``validation`` and ``test``. This module does not
interpret the separate legacy task-loader labels (``train``/``eval`` or its
versioned ``validation`` form).
"""
from __future__ import annotations

import ast
from dataclasses import dataclass
from enum import Enum
import hashlib
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from guru.disclosure import redact
from guru.schemas.corpus_item import CorpusItem
from guru.schemas.evaluator_evidence import CaseStatus, EvaluatorCaseSet, EvaluatorQualificationEvidence
from guru.schemas.rights_decision import RightsDecision
from guru.schemas.teacher_lineage import TeacherLineage
from guru.schemas.quality import AutoCheckName, AutoCheckResult, REQUIRED_AUTO_CHECKS
from guru.teacher.intake import validate_teacher
from guru.quality.providers import EvaluatorEvidenceProvider, RightsEvidenceProvider


TOOL_VERSION = "guru-deterministic-checks/1.1.0"
POLICY_VERSIONS: dict[AutoCheckName, str] = {
    AutoCheckName.SCHEMA: "corpus-item-schema-v1",
    AutoCheckName.SYNTAX: "python-ast-parse-v1",
    AutoCheckName.TESTS: "qualified-evaluator-required-v1",
    AutoCheckName.SECURITY: "security-cot-and-secrets-v1",
    AutoCheckName.LICENSE: "scoped-owner-rights-evidence-required-v1",
    AutoCheckName.PROVENANCE: "pinned-release-source-manifest-v1",
    AutoCheckName.DUPLICATE: "exact-model-facing-example-v1",
    AutoCheckName.LEAKAGE: "single-experiment-split-per-group-v1",
}
CANONICAL_SPLIT_LABELS = frozenset({"train", "validation", "test"})


class CheckInputError(ValueError):
    """An input is malformed or internally inconsistent."""


class CheckUnavailableError(ValueError):
    """A required authoritative input for a check was not supplied."""


class IncompleteCheckRunError(ValueError):
    """A partial or unavailable run cannot become admission-check inputs."""


class CheckRunStatus(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    UNAVAILABLE = "UNAVAILABLE"


@dataclass(frozen=True)
class CheckStatusRecord:
    name: AutoCheckName
    status: CheckRunStatus
    evidence_digest: str | None
    item_digest: str
    tool_version: str
    policy_version: str
    reason_code: str | None = None


@dataclass(frozen=True)
class CheckRunReport:
    """Status-only report. It has no audit side effects.

    Conversion requires one evidenced PASS or FAIL for every required check.
    The runner below always leaves evaluator and license checks UNAVAILABLE
    until authoritative providers are implemented, so current runner reports
    cannot be converted for admission. A complete measured failure can be
    converted so the separate quality gate can record a rejection/quarantine.
    """

    records: tuple[CheckStatusRecord, ...]

    def as_auto_checks(self) -> list[AutoCheckResult]:
        if {record.name for record in self.records} != REQUIRED_AUTO_CHECKS:
            raise IncompleteCheckRunError("check run does not contain each required check exactly once")
        if len(self.records) != len(REQUIRED_AUTO_CHECKS):
            raise IncompleteCheckRunError("check run contains duplicate check names")
        if any(record.status not in {CheckRunStatus.PASS, CheckRunStatus.FAIL}
               or not record.evidence_digest
               for record in self.records):
            raise IncompleteCheckRunError("incomplete or unavailable check run cannot be converted")
        return [AutoCheckResult(name=record.name,
                                passed=record.status is CheckRunStatus.PASS,
                                item_digest=record.item_digest,
                                evidence_digest=record.evidence_digest,
                                tool_version=record.tool_version,
                                policy_version=record.policy_version)
                for record in self.records]


def _canonical_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise CheckInputError("check evidence inputs are not canonical JSON") from exc


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _result(name: AutoCheckName, passed: bool, evidence: Any) -> AutoCheckResult:
    item_digest = evidence.get("item_digest") if isinstance(evidence, Mapping) else None
    if not isinstance(item_digest, str) or len(item_digest) != 64 or any(
        character not in "0123456789abcdef" for character in item_digest
    ):
        raise CheckInputError("check evidence must bind to a canonical item digest")
    versioned_evidence = {
        "item_digest": item_digest,
        "tool_version": TOOL_VERSION,
        "policy_version": POLICY_VERSIONS[name],
        "result": evidence,
    }
    return AutoCheckResult(name=name, passed=passed, item_digest=item_digest,
                           evidence_digest=_digest(versioned_evidence),
                           tool_version=TOOL_VERSION, policy_version=POLICY_VERSIONS[name])


def _raw_item_digest(raw_item: Mapping[str, Any]) -> str:
    """Bind invalid schema results to the exact canonicalizable input bytes."""
    return _digest(dict(raw_item))


def _item_binding(raw_item: CorpusItem | Mapping[str, Any]) -> str:
    if isinstance(raw_item, CorpusItem):
        return raw_item.canonical_digest()
    if not isinstance(raw_item, Mapping):
        raise CheckInputError("corpus item must be an object")
    try:
        return _as_item(raw_item).canonical_digest()
    except CheckInputError:
        return _raw_item_digest(raw_item)


def _as_item(raw_item: CorpusItem | Mapping[str, Any]) -> CorpusItem:
    try:
        if isinstance(raw_item, CorpusItem):
            return raw_item
        if not isinstance(raw_item, Mapping):
            raise CheckInputError("corpus item must be an object")
        return CorpusItem.model_validate(dict(raw_item))
    except ValidationError as exc:
        raise CheckInputError("corpus item schema validation failed") from exc


def schema_check(raw_item: CorpusItem | Mapping[str, Any]) -> AutoCheckResult:
    """Validate one raw item against the strict CorpusItem schema."""
    if not isinstance(raw_item, Mapping) and not isinstance(raw_item, CorpusItem):
        raise CheckInputError("corpus item must be an object")
    try:
        item = _as_item(raw_item)
    except CheckInputError:
        # Invalid raw input still receives a deterministic failure result when
        # it is canonicalizable; malformed/non-JSON data is a typed input error.
        return _result(AutoCheckName.SCHEMA, False, {
            "item_digest": _raw_item_digest(raw_item),
            "raw_item_digest": _raw_item_digest(raw_item),
        })
    return _result(AutoCheckName.SCHEMA, True, {"item_digest": item.canonical_digest()})


def _valid_item(raw_item: CorpusItem | Mapping[str, Any]) -> CorpusItem:
    item = _as_item(raw_item)
    return item


def syntax_check(raw_item: CorpusItem | Mapping[str, Any]) -> AutoCheckResult:
    """Parse Python target syntax only; never imports or executes the target."""
    item = _valid_item(raw_item)
    if item.language.casefold() not in {"python", "py"}:
        raise CheckUnavailableError("syntax check is available only for Python items")
    source_digest = _digest(item.target)
    try:
        ast.parse(item.target, filename=f"<corpus-item:{item.item_id}>", mode="exec")
    except (SyntaxError, ValueError, TypeError, UnicodeError):
        passed = False
    else:
        passed = True
    return _result(AutoCheckName.SYNTAX, passed, {
        "item_digest": item.canonical_digest(), "target_digest": source_digest,
        "language": item.language.casefold(), "parser": "python-ast-parse-v1",
    })


_COT_MARKERS = (
    "<think>", "</think>", "<|thinking|>", "<|analysis|>",
    "chain of thought", "let me think step by step",
)


def no_cot_check(raw_item: CorpusItem | Mapping[str, Any]) -> AutoCheckResult:
    """Reject known explicit reasoning markers in prompt or target text."""
    item = _valid_item(raw_item)
    combined = f"{item.prompt}\n{item.target}".casefold()
    found = [marker for marker in _COT_MARKERS if marker in combined]
    return _result(AutoCheckName.SECURITY, not found, {
        "item_digest": item.canonical_digest(), "policy": "cot-marker-v1",
        "matched_marker_digests": sorted(_digest(marker) for marker in found),
    })


def secret_check(raw_item: CorpusItem | Mapping[str, Any]) -> AutoCheckResult:
    """Scan prompt and target using the disclosure gate's secret patterns.

    The result contains only hashes and a count. Pattern IDs and matched text
    are intentionally omitted so secrets are not copied into evidence.
    """
    item = _valid_item(raw_item)
    text_digest = _digest({"prompt": item.prompt, "target": item.target})
    count = 0
    try:
        patterns = redact.SECRET_PATTERNS
        for _name, pattern, _replacement in patterns:
            count += len(pattern.findall(item.prompt))
            count += len(pattern.findall(item.target))
    except Exception:
        return _result(AutoCheckName.SECURITY, False, {
            "item_digest": item.canonical_digest(), "scanned_text_digest": text_digest,
            "policy": "disclosure-secret-patterns-v1", "scanner_error": True,
        })
    return _result(AutoCheckName.SECURITY, count == 0, {
        "item_digest": item.canonical_digest(), "scanned_text_digest": text_digest,
        "policy": "disclosure-secret-patterns-v1", "match_count": count,
    })


def security_check(raw_item: CorpusItem | Mapping[str, Any]) -> AutoCheckResult:
    """Produce the single SECURITY result expected by the quality schema.

    SECURITY covers both explicit CoT markers and disclosure secrets. The two
    component helpers are available for diagnostics, but callers should pass
    only this combined result to an admission record.
    """
    item = _valid_item(raw_item)
    cot = no_cot_check(item)
    secrets = secret_check(item)
    return _result(AutoCheckName.SECURITY, cot.passed and secrets.passed, {
        "item_digest": item.canonical_digest(), "policy": "security-v1",
        "cot_evidence_digest": cot.evidence_digest,
        "secret_evidence_digest": secrets.evidence_digest,
    })


def provenance_check(
    raw_item: CorpusItem | Mapping[str, Any], *,
    manifest_path: str | Path | None,
    expected_manifest_digest: str | None,
) -> AutoCheckResult:
    """Require source-digest membership in a validated, byte-pinned manifest.

    The manifest is parsed and its referenced artifact/license files are
    checked by Guru's release source-manifest validator. Membership compares
    ``CorpusItem.source_digest`` with a validated source ``artifact_sha256``.
    The caller's pin must equal the digest of the exact manifest bytes. This
    proves integrity relative to that supplied pin; it does not prove manifest
    authenticity, rights, or license permission.
    """
    item = _valid_item(raw_item)
    if manifest_path is None:
        raise CheckUnavailableError("source manifest path was not supplied")
    if expected_manifest_digest is None:
        raise CheckUnavailableError("source manifest digest pin was not supplied")
    if (not isinstance(expected_manifest_digest, str) or len(expected_manifest_digest) != 64
            or any(c not in "0123456789abcdef" for c in expected_manifest_digest)):
        raise CheckInputError("source manifest pin must be a lowercase SHA-256 digest")
    try:
        # Reuse the current release contract: source and saved license bytes
        # are digest-verified, rights review is structurally checked, and the
        # parsed source entries are returned only after manifest validation.
        from guru.coding import CodingDataError, _read_release_sources

        sources, actual_manifest_digest, _manifest_dir = _read_release_sources([], str(manifest_path))
    except (OSError, CodingDataError, ValueError) as exc:
        raise CheckInputError("source manifest failed Guru release validation") from exc
    pin_matches = actual_manifest_digest == expected_manifest_digest
    artifact_digests = sorted(source["artifact_sha256"] for source in sources.values())
    member = item.source_digest in artifact_digests
    return _result(AutoCheckName.PROVENANCE, pin_matches and member, {
        "item_digest": item.canonical_digest(), "source_digest": item.source_digest,
        "expected_manifest_digest": expected_manifest_digest,
        "actual_manifest_digest": actual_manifest_digest,
        "manifest_pin_matches": pin_matches,
        "artifact_membership": member,
        "artifact_digest_set_digest": _digest(artifact_digests),
    })


def _duplicate_fingerprint(item: CorpusItem) -> str:
    # Identifiers and provenance labels do not change the exact model-facing
    # training example. Keep whitespace and Unicode code points significant.
    return _digest({"language": item.language, "prompt": item.prompt, "target": item.target})


def duplicate_check(
    raw_item: CorpusItem | Mapping[str, Any], *,
    corpus_items: Sequence[CorpusItem | Mapping[str, Any]] | None,
) -> AutoCheckResult:
    """Detect an exact model-facing prompt/target/language duplicate."""
    item = _valid_item(raw_item)
    if corpus_items is None:
        raise CheckUnavailableError("comparison corpus items were not supplied")
    if isinstance(corpus_items, (str, bytes)) or not isinstance(corpus_items, Sequence):
        raise CheckInputError("comparison corpus must be a sequence of items")
    candidates = [_valid_item(value) for value in corpus_items]
    fingerprint = _duplicate_fingerprint(item)
    duplicates = sorted(candidate.item_id for candidate in candidates
                        if candidate.item_id != item.item_id
                        and _duplicate_fingerprint(candidate) == fingerprint)
    return _result(AutoCheckName.DUPLICATE, not duplicates, {
        "item_digest": item.canonical_digest(),
        "comparison_item_digests": sorted(candidate.canonical_digest() for candidate in candidates),
        "duplicate_id_digests": sorted(_digest(item_id) for item_id in duplicates),
        "policy": "exact-model-facing-example-v1",
    })


def leakage_check(
    raw_item: CorpusItem | Mapping[str, Any], *,
    group_assignments: Mapping[str, str | Sequence[str]] | None,
) -> AutoCheckResult:
    """Require a pinned leakage-group assignment with exactly one split.

    ``group_assignments`` maps group IDs to a split string (or an iterable of
    observed split strings). The item's ``metadata.leakage_group`` must map to
    exactly one split; if metadata also has ``split``, it must match. Accepted
    labels are exactly ``train``, ``validation`` and ``test``.
    """
    item = _valid_item(raw_item)
    if group_assignments is None:
        raise CheckUnavailableError("pinned leakage-group assignments were not supplied")
    if not isinstance(group_assignments, Mapping) or not group_assignments:
        raise CheckInputError("leakage-group assignments must be a non-empty mapping")
    group = item.metadata.get("leakage_group")
    if not group:
        raise CheckUnavailableError("item has no leakage_group assignment key")
    if group not in group_assignments:
        raise CheckUnavailableError("item leakage_group is absent from pinned assignments")
    normalized: dict[str, list[str]] = {}
    for group_id, value in group_assignments.items():
        if not isinstance(group_id, str) or not group_id.strip():
            raise CheckInputError("leakage group identifiers must be non-empty strings")
        if isinstance(value, str):
            splits = [value]
        elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            splits = list(value)
        else:
            raise CheckInputError("each leakage group assignment must be a split or split sequence")
        if not splits or any(not isinstance(split, str) or split not in CANONICAL_SPLIT_LABELS
                             for split in splits):
            raise CheckInputError("leakage group split must be train, validation, or test")
        normalized[group_id] = sorted(set(splits))
    assigned = normalized[group]
    declared_split = item.metadata.get("split")
    if declared_split is not None and declared_split not in CANONICAL_SPLIT_LABELS:
        raise CheckInputError("item split must be train, validation, or test")
    passed = len(assigned) == 1 and (declared_split is None or declared_split == assigned[0])
    return _result(AutoCheckName.LEAKAGE, passed, {
        "item_digest": item.canonical_digest(), "group_id_digest": _digest(group),
        "group_splits": assigned,
        "declared_split_digest": _digest(declared_split) if declared_split is not None else None,
        "assignments_digest": _digest(normalized),
    })


def _status_from_result(result: AutoCheckResult) -> CheckStatusRecord:
    return CheckStatusRecord(
        name=result.name,
        status=CheckRunStatus.PASS if result.passed else CheckRunStatus.FAIL,
        evidence_digest=result.evidence_digest,
        item_digest=result.item_digest,
        tool_version=TOOL_VERSION,
        policy_version=POLICY_VERSIONS[result.name],
    )


def _status_without_result(name: AutoCheckName, status: CheckRunStatus,
                           reason_code: str, *, item_digest: str) -> CheckStatusRecord:
    tool_version = TOOL_VERSION
    policy_version = POLICY_VERSIONS[name]
    evidence_digest = _digest({
        "check": name.value, "status": status.value,
        "item_digest": item_digest,
        "tool_version": tool_version, "policy_version": policy_version,
        "reason_code": reason_code, "inputs_present": False,
    })
    return CheckStatusRecord(name, status, evidence_digest, item_digest, tool_version,
                             policy_version, reason_code)


def _run_one(name: AutoCheckName, producer, raw_item, *, bound_item_digest: str,
             **kwargs) -> CheckStatusRecord:
    try:
        result = producer(raw_item, **kwargs)
        if result.item_digest != bound_item_digest:
            raise CheckInputError("producer returned a different item binding")
        return _status_from_result(result)
    except CheckUnavailableError as exc:
        return _status_without_result(name, CheckRunStatus.UNAVAILABLE, str(exc),
                                      item_digest=bound_item_digest)
    except CheckInputError as exc:
        return _status_without_result(name, CheckRunStatus.FAIL, str(exc),
                                      item_digest=bound_item_digest)


def run_deterministic_checks(
    raw_item: CorpusItem | Mapping[str, Any], *,
    source_manifest_path: str | Path | None = None,
    source_manifest_digest: str | None = None,
    corpus_items: Sequence[CorpusItem | Mapping[str, Any]] | None = None,
    group_assignments: Mapping[str, str | Sequence[str]] | None = None,
    evaluator_provider: EvaluatorEvidenceProvider | None = None,
    rights_provider: RightsEvidenceProvider | None = None,
) -> CheckRunReport:
    """Run available producers and report all required checks as tri-state.

    This function never invokes ``item_decision`` and never writes an audit.
    TESTS and LICENSE stay UNAVAILABLE unless separately controlled provider
    implementations load externally pinned qualification and approved rights
    records. There are no production provider implementations in this slice.
    Those states cannot be overridden by caller booleans or hand-built
    ``AutoCheckResult`` values. ``CheckRunReport.as_auto_checks`` refuses every
    incomplete or non-passing run.
    """
    item_digest = _item_binding(raw_item)
    tests_status = _status_without_result(AutoCheckName.TESTS, CheckRunStatus.UNAVAILABLE,
        "externally pinned evaluator qualification and complete case-set provider are unavailable",
        item_digest=item_digest)
    if evaluator_provider is not None:
        try:
            if not isinstance(evaluator_provider, EvaluatorEvidenceProvider):
                raise CheckUnavailableError("evaluator evidence provider is not trusted/typed")
            item_value = _valid_item(raw_item)
            supplied = evaluator_provider.load_for(item_value)
            if supplied is None:
                raise CheckUnavailableError("evaluator provider has no evidence for this item")
            evaluator_case_set = supplied.case_set
            evaluator_qualification = supplied.qualification
            expected_qualification_digest = supplied.qualification_digest
            expected_test_suite_digest = supplied.test_suite_digest
            expected_case_ids = supplied.expected_case_ids
            expected_case_test_digests = supplied.expected_case_test_digests
            expected_task_digest = supplied.task_digest
            if not isinstance(evaluator_case_set, EvaluatorCaseSet) or not isinstance(evaluator_qualification, EvaluatorQualificationEvidence):
                raise CheckUnavailableError("evaluator provider returned untyped evidence")
            qpayload = evaluator_qualification.model_dump(mode="json")
            qdigest = _digest(qpayload)
            if (expected_qualification_digest != qdigest or
                    supplied.trusted_qualification_digest != qdigest or
                    supplied.trusted_test_suite_digest != expected_test_suite_digest):
                raise CheckUnavailableError("evaluator qualification or test-suite digest is not externally pinned")
            if expected_case_ids is None or expected_case_test_digests is None:
                raise CheckUnavailableError("frozen expected case IDs and test digests are unavailable")
            if (evaluator_case_set.item_digest != item_digest or
                    evaluator_case_set.config_digest != evaluator_qualification.config_digest or
                    evaluator_case_set.test_suite_digest != expected_test_suite_digest or
                    evaluator_case_set.expected_case_ids != list(expected_case_ids) or
                    set(expected_case_test_digests) != set(expected_case_ids) or
                    any(case.test_digest != expected_case_test_digests.get(case.case_id)
                        for case in evaluator_case_set.cases) or
                    any(case.task_digest != expected_task_digest for case in evaluator_case_set.cases) or
                    any(case.candidate_digest != hashlib.sha256(item_value.target.encode("utf-8")).hexdigest()
                        for case in evaluator_case_set.cases) or
                    any(case.image_digest != evaluator_qualification.image_digest
                        for case in evaluator_case_set.cases)):
                raise CheckInputError("evaluator case set differs from item, pinned suite, or qualified config")
            from guru.evaluator_evidence import _validate_sealed
            previous = evaluator_case_set.starting_record_digest
            parsed_cases = []
            for case in evaluator_case_set.cases:
                parsed_cases.append(_validate_sealed(case.model_dump(mode="json"), previous))
                previous = case.record_digest
            if any(case.status not in {CaseStatus.PASS, CaseStatus.FAIL} or
                   not case.cleanup_confirmed or case.output_limited or
                   case.stdout_truncated or case.stderr_truncated for case in parsed_cases):
                raise CheckUnavailableError("case set contains incomplete or unbounded evaluator outcomes")
            failed = [case.case_id for case in parsed_cases if case.status is CaseStatus.FAIL]
            tests_status = _status_from_result(_result(AutoCheckName.TESTS, not failed, {
                "item_digest": item_digest, "test_suite_digest": evaluator_case_set.test_suite_digest,
                "config_digest": evaluator_case_set.config_digest,
                "qualification_digest": qdigest,
                "expected_case_ids_digest": _digest(evaluator_case_set.expected_case_ids),
                "case_record_digests": [case.record_digest for case in parsed_cases],
                "failed_case_ids_digest": _digest(failed),
            }))
        except CheckUnavailableError as exc:
            tests_status = _status_without_result(AutoCheckName.TESTS, CheckRunStatus.UNAVAILABLE,
                str(exc), item_digest=item_digest)
        except (ValueError, TypeError, AttributeError) as exc:
            tests_status = _status_without_result(AutoCheckName.TESTS, CheckRunStatus.UNAVAILABLE,
                "evaluator evidence invalid: " + str(exc), item_digest=item_digest)
    license_status = _status_without_result(AutoCheckName.LICENSE, CheckRunStatus.UNAVAILABLE,
        "typed owner/source rights evidence provider is unavailable", item_digest=item_digest)
    if rights_provider is not None:
        try:
            if not isinstance(rights_provider, RightsEvidenceProvider):
                raise CheckUnavailableError("rights evidence provider is not trusted/typed")
            item = _valid_item(raw_item)
            supplied_rights = rights_provider.load_for(item)
            if supplied_rights is None:
                raise CheckUnavailableError("rights provider has no approved record for this item artifact")
            rights_decision = supplied_rights.decision
            teacher_records = supplied_rights.teachers
            if not isinstance(rights_decision, RightsDecision):
                raise CheckUnavailableError("rights provider returned an untyped RightsDecision")
            rights_digest = _digest(rights_decision.model_dump(mode="json"))
            if (supplied_rights.rights_manifest_digest != supplied_rights.trusted_rights_manifest_digest or
                    supplied_rights.approved_artifact_digest != item.source_digest or
                    len(supplied_rights.trusted_rights_manifest_digest) != 64 or
                    any(c not in "0123456789abcdef" for c in supplied_rights.trusted_rights_manifest_digest) or
                    len(supplied_rights.rights_manifest_digest) != 64 or
                    any(c not in "0123456789abcdef" for c in supplied_rights.rights_manifest_digest)):
                raise CheckUnavailableError("rights record is not bound to the pinned approved manifest/artifact")
            item = _valid_item(raw_item)
            rights_ok = (supplied_rights.approved_artifact_digest == item.source_digest and
                         rights_decision.artifact_sha256 == supplied_rights.approved_artifact_digest and
                         rights_decision.rights.allow_training and
                         rights_decision.rights.allow_transformed_data_retention)
            teacher_ok = True
            if item.teacher_lineage_id is not None:
                if teacher_records is None:
                    raise CheckUnavailableError("separately validated teacher record is unavailable")
                if (supplied_rights.teacher_registry_digest is None or
                        supplied_rights.teacher_registry_digest != supplied_rights.trusted_teacher_registry_digest or
                        len(supplied_rights.teacher_registry_digest) != 64 or
                        any(c not in "0123456789abcdef" for c in supplied_rights.teacher_registry_digest)):
                    raise CheckUnavailableError("teacher record is not bound to the approved registry pin")
                matches = [t for t in teacher_records if isinstance(t, TeacherLineage)
                           and t.teacher_id == item.teacher_lineage_id]
                teacher_ok = len(matches) == 1 and validate_teacher(matches[0])["admissible"]
                if not teacher_ok:
                    raise CheckUnavailableError("separately validated teacher rights are not admissible")
            rdigest = rights_digest
            license_status = _status_from_result(_result(AutoCheckName.LICENSE, rights_ok, {
                "item_digest": item_digest, "artifact_digest": rights_decision.artifact_sha256,
                "rights_decision_digest": rdigest,
                "allow_training": rights_decision.rights.allow_training,
                "allow_transformed_data_retention": rights_decision.rights.allow_transformed_data_retention,
                "teacher_rights_validated": teacher_ok,
            }))
        except CheckUnavailableError as exc:
            license_status = _status_without_result(AutoCheckName.LICENSE, CheckRunStatus.UNAVAILABLE,
                str(exc), item_digest=item_digest)
        except (ValueError, TypeError, AttributeError) as exc:
            license_status = _status_without_result(AutoCheckName.LICENSE, CheckRunStatus.UNAVAILABLE,
                "rights evidence invalid: " + str(exc), item_digest=item_digest)
    records = [
        _run_one(AutoCheckName.SCHEMA, schema_check, raw_item, bound_item_digest=item_digest),
        _run_one(AutoCheckName.SYNTAX, syntax_check, raw_item, bound_item_digest=item_digest),
        tests_status,
        _run_one(AutoCheckName.SECURITY, security_check, raw_item, bound_item_digest=item_digest),
        license_status,
        _run_one(AutoCheckName.PROVENANCE, provenance_check, raw_item, bound_item_digest=item_digest,
                 manifest_path=source_manifest_path,
                 expected_manifest_digest=source_manifest_digest),
        _run_one(AutoCheckName.DUPLICATE, duplicate_check, raw_item, bound_item_digest=item_digest,
                 corpus_items=corpus_items),
        _run_one(AutoCheckName.LEAKAGE, leakage_check, raw_item, bound_item_digest=item_digest,
                 group_assignments=group_assignments),
    ]
    return CheckRunReport(tuple(records))
