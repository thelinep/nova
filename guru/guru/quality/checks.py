"""Deterministic, non-executing quality check producers.

These helpers produce individual automatic check results. They deliberately
do not assemble all required checks, execute code, make rights decisions, or
write admission/audit records. A missing authoritative input raises a typed
error; a scanner failure becomes a failed check.
"""
from __future__ import annotations

import ast
import hashlib
import json
from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import ValidationError

from guru.disclosure import redact
from guru.schemas.corpus_item import CorpusItem
from guru.schemas.quality import AutoCheckName, AutoCheckResult


class CheckInputError(ValueError):
    """An input is malformed or internally inconsistent."""


class CheckUnavailableError(ValueError):
    """A required authoritative input for a check was not supplied."""


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
    return AutoCheckResult(name=name, passed=passed, evidence_digest=_digest(evidence))


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
        return _result(AutoCheckName.SCHEMA, False, {"raw_item": raw_item})
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
    pinned_manifest: Mapping[str, str] | None,
) -> AutoCheckResult:
    """Require the item's source digest to occur in an explicitly pinned map.

    The supplied mapping is interpreted as ``artifact identifier -> SHA-256``.
    This verifies membership only; it does not establish licensing or rights.
    """
    item = _valid_item(raw_item)
    if pinned_manifest is None:
        raise CheckUnavailableError("pinned provenance manifest was not supplied")
    if not isinstance(pinned_manifest, Mapping) or not pinned_manifest:
        raise CheckInputError("pinned provenance manifest must be a non-empty mapping")
    normalized: dict[str, str] = {}
    for key, value in pinned_manifest.items():
        if not isinstance(key, str) or not key.strip():
            raise CheckInputError("pinned manifest artifact identifiers must be non-empty strings")
        if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise CheckInputError("pinned manifest values must be lowercase SHA-256 digests")
        normalized[key] = value
    return _result(AutoCheckName.PROVENANCE, item.source_digest in normalized.values(), {
        "item_digest": item.canonical_digest(), "source_digest": item.source_digest,
        "manifest_digest": _digest(normalized), "policy": "source-membership-v1",
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
    exactly one split; if metadata also has ``split``, it must match.
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
        if not splits or any(not isinstance(split, str) or not split.strip() for split in splits):
            raise CheckInputError("leakage group splits must be non-empty strings")
        normalized[group_id] = sorted(set(splits))
    assigned = normalized[group]
    declared_split = item.metadata.get("split")
    passed = len(assigned) == 1 and (declared_split is None or declared_split == assigned[0])
    return _result(AutoCheckName.LEAKAGE, passed, {
        "item_digest": item.canonical_digest(), "group_id_digest": _digest(group),
        "group_splits": assigned,
        "declared_split_digest": _digest(declared_split) if declared_split is not None else None,
        "assignments_digest": _digest(normalized), "policy": "single-split-per-leakage-group-v1",
    })
