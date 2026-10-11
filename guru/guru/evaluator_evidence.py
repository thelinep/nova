"""Canonical integrity-checked persistence and mapping for evaluator cases.

This module records evidence only. It does not execute candidate code or
qualify a backend. Stored records contain output digests and lengths, never
stdout or stderr bytes.
"""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
from typing import Iterator

from pydantic import ValidationError

from guru.schemas.evaluator_evidence import (
    CaseStatus,
    EvaluationCaseEvidence,
)
from guru.schemas.quality import AutoCheckName, AutoCheckResult


_ZERO_DIGEST = "0" * 64
_locks_guard = threading.Lock()
_path_locks: dict[str, threading.Lock] = {}


class EvidenceLogError(ValueError):
    """Evidence log is malformed, tampered, truncated, or inconsistent."""


def _canonical_bytes(value: dict) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _record_payload(record: EvaluationCaseEvidence | dict) -> dict:
    if isinstance(record, EvaluationCaseEvidence):
        value = record.model_dump(mode="json")
    else:
        value = dict(record)
    value.pop("record_digest", None)
    return value


def seal_case(record: EvaluationCaseEvidence | dict, *, previous_record_digest: str = _ZERO_DIGEST) -> EvaluationCaseEvidence:
    """Validate and seal a record with a chain link to the preceding case."""
    if len(previous_record_digest) != 64 or any(c not in "0123456789abcdef" for c in previous_record_digest):
        raise ValueError("previous_record_digest must be a lowercase SHA-256 digest")
    payload = _record_payload(record)
    payload["previous_record_digest"] = previous_record_digest
    payload["record_digest"] = _ZERO_DIGEST
    # Normalize through the strict schema before hashing (notably UTC timestamps
    # are serialized canonically as Z by Pydantic).
    normalized = EvaluationCaseEvidence.model_validate(payload).model_dump(mode="json")
    normalized.pop("record_digest")
    # Compute the record digest over the complete normalized payload.
    normalized["record_digest"] = _digest(_canonical_bytes(normalized))
    return EvaluationCaseEvidence.model_validate(normalized)


def _validate_sealed(record: dict, expected_previous: str) -> EvaluationCaseEvidence:
    try:
        parsed = EvaluationCaseEvidence.model_validate(record)
    except ValidationError as exc:
        raise EvidenceLogError("evaluator evidence schema validation failed") from exc
    if parsed.previous_record_digest != expected_previous:
        raise EvidenceLogError("evaluator evidence chain link mismatch")
    payload = parsed.model_dump(mode="json")
    expected = payload.pop("record_digest")
    if _digest(_canonical_bytes(payload)) != expected:
        raise EvidenceLogError("evaluator evidence integrity digest mismatch")
    return parsed


def replay_cases(path: str | Path) -> list[EvaluationCaseEvidence]:
    """Read and verify every canonical JSONL record, including chain order."""
    path = Path(path)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return []
    if raw and not raw.endswith(b"\n"):
        raise EvidenceLogError("evaluator evidence log has a truncated final line")
    result: list[EvaluationCaseEvidence] = []
    seen: set[str] = set()
    previous = _ZERO_DIGEST
    for line_number, line in enumerate(raw.splitlines(), start=1):
        if not line:
            raise EvidenceLogError(f"empty evaluator evidence line at {line_number}")
        try:
            value = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise EvidenceLogError(f"invalid evaluator evidence JSON at line {line_number}") from exc
        if not isinstance(value, dict):
            raise EvidenceLogError(f"evaluator evidence line {line_number} is not an object")
        parsed = _validate_sealed(value, previous)
        if parsed.case_id in seen:
            raise EvidenceLogError(f"duplicate evaluator case_id at line {line_number}")
        if _canonical_bytes(parsed.model_dump(mode="json")) != line:
            raise EvidenceLogError(f"non-canonical evaluator evidence at line {line_number}")
        result.append(parsed)
        seen.add(parsed.case_id)
        previous = parsed.record_digest
    return result


def _get_lock(path: Path) -> threading.Lock:
    key = str(path.resolve())
    with _locks_guard:
        return _path_locks.setdefault(key, threading.Lock())


@contextmanager
def _exclusive_file_lock(path: Path) -> Iterator[None]:
    lock_path = path.with_name(path.name + ".lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def append_case_atomic(path: str | Path, record: EvaluationCaseEvidence | dict) -> EvaluationCaseEvidence:
    """Atomically append a new case by verified read-copy-replace.

    A sidecar advisory lock prevents concurrent writers from overwriting each
    other's records. The temporary file is fsynced before replacement and the
    containing directory is fsynced afterwards.
    """
    path = Path(path)
    if not path.parent.is_dir():
        raise FileNotFoundError("evaluator evidence directory must already exist")
    lock = _get_lock(path)
    with lock, _exclusive_file_lock(path):
        existing = replay_cases(path)
        if any(item.case_id == _record_payload(record).get("case_id") for item in existing):
            raise EvidenceLogError("duplicate evaluator case_id")
        previous = existing[-1].record_digest if existing else _ZERO_DIGEST
        sealed = seal_case(record, previous_record_digest=previous)
        # Verify status, schema, and all caller-supplied record invariants before writing.
        line = _canonical_bytes(sealed.model_dump(mode="json")) + b"\n"
        old = path.read_bytes() if path.exists() else b""
        fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(old)
                stream.write(line)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_name, path)
            directory_fd = os.open(path.parent, os.O_RDONLY)
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
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise
        return sealed


def map_evidence_to_tests_check(
    record: EvaluationCaseEvidence | dict,
    *,
    expected_previous_record_digest: str = _ZERO_DIGEST,
) -> AutoCheckResult:
    """Map one case to TESTS; only sealed, complete PASS evidence passes."""
    try:
        parsed = record if isinstance(record, EvaluationCaseEvidence) else EvaluationCaseEvidence.model_validate(record)
        # For this standalone mapper, recompute integrity. A dict without a valid
        # chain/digest cannot be trusted even if its status says pass.
        payload = parsed.model_dump(mode="json")
        supplied_digest = payload.pop("record_digest")
        integrity_ok = (
            _digest(_canonical_bytes(payload)) == supplied_digest
            and parsed.previous_record_digest == expected_previous_record_digest
        )
    except (ValidationError, TypeError, ValueError):
        parsed = None
        integrity_ok = False
    passed = bool(
        parsed is not None and integrity_ok
        and parsed.status is CaseStatus.PASS
        and parsed.exit_code == 0
        and parsed.cleanup_confirmed
        and not parsed.output_limited
        and not parsed.stdout_truncated
        and not parsed.stderr_truncated
    )
    if parsed is None:
        return AutoCheckResult(name=AutoCheckName.TESTS, passed=False)
    detail = _digest((f"{parsed.status.value}:{parsed.exit_code}:{int(integrity_ok)}").encode())
    return AutoCheckResult(
        name=AutoCheckName.TESTS, passed=passed,
        evidence_digest=parsed.record_digest,
        detail_digest=detail,
    )
