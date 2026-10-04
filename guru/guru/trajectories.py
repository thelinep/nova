"""Versioned, bounded multi-agent coding trajectory records.

This module validates evidence references and lineage metadata only. It does
not resolve/approve rights, invoke models, or execute tool calls or code.
The format is separate from guru-code-task-v1/v2 and does not alter them.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict

SCHEMA_VERSION = "guru-code-trajectory-v1"
MAX_TURNS = 64
MAX_JSONL_BYTES = 8 * 1024 * 1024
MAX_TURN_BYTES = 64 * 1024
MAX_TEXT_CHARS = 16_384
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SPLITS = {"train", "validation", "eval"}
_REVIEW_DISPOSITIONS = {"none", "accepted", "changes_requested", "rejected", "deferred"}
_EVALUATOR_STATUSES = {"not_run", "passed", "failed", "inconclusive"}


class TrajectoryDataError(ValueError):
    """Malformed or unsafe-to-admit trajectory data."""


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise TrajectoryDataError(f"duplicate JSON object key {key!r}")
        result[key] = value
    return result


def _required_text(value: object, label: str, *, limit: int = 512) -> None:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise TrajectoryDataError(f"{label} must be a non-empty string of at most {limit} characters")


def _digest(value: object, label: str, *, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, str) or not _SHA256.fullmatch(value):
        raise TrajectoryDataError(f"{label} must be a lowercase SHA-256 digest" + (" or null" if nullable else ""))


def _ref(value: object, label: str, *, item_hash_required: bool = True) -> None:
    if not isinstance(value, dict):
        raise TrajectoryDataError(f"{label} must be an object reference")
    _required_text(value.get("source_id"), f"{label}.source_id")
    _required_text(value.get("item_id"), f"{label}.item_id")
    if item_hash_required:
        _digest(value.get("item_sha256"), f"{label}.item_sha256")


def _bounded_payload(value: object, label: str) -> int:
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise TrajectoryDataError(f"{label} must be JSON-serializable: {exc}") from exc
    if len(encoded) > MAX_TEXT_CHARS * 4:
        raise TrajectoryDataError(f"{label} exceeds the payload size limit")
    return len(encoded)


def _contains_target(value: object) -> bool:
    if isinstance(value, dict):
        return any(key == "target" or _contains_target(item) for key, item in value.items())
    if isinstance(value, list):
        return any(_contains_target(item) for item in value)
    return False


def validate_trajectory(row: object) -> None:
    """Validate one trajectory without asserting that its references are approved."""
    if not isinstance(row, dict):
        raise TrajectoryDataError("trajectory must be a JSON object")
    if row.get("schema_version") != SCHEMA_VERSION:
        raise TrajectoryDataError(f"schema_version must be {SCHEMA_VERSION!r}")
    for field in ("trajectory_id", "split"):
        _required_text(row.get(field), field)
    if row["split"] not in _SPLITS:
        raise TrajectoryDataError("split must be train, validation, or eval")
    if row["split"] == "eval" and _contains_target(row):
        raise TrajectoryDataError("held-out eval trajectories must not contain target-bearing fields")

    task = row.get("task_ref")
    if not isinstance(task, dict):
        raise TrajectoryDataError("task_ref must be an object")
    _required_text(task.get("task_id"), "task_ref.task_id")
    _required_text(task.get("task_schema_version"), "task_ref.task_schema_version")
    _digest(task.get("task_sha256"), "task_ref.task_sha256")
    _required_text(task.get("family_id"), "task_ref.family_id")
    _required_text(row.get("leakage_group"), "leakage_group")
    if task.get("split") != row["split"]:
        raise TrajectoryDataError("task_ref.split must match trajectory split")

    for field in ("prompt_refs", "context_refs", "source_refs", "rights_refs"):
        refs = row.get(field)
        if not isinstance(refs, list) or not refs:
            raise TrajectoryDataError(f"{field} must be a non-empty list of references")
        for index, ref in enumerate(refs):
            _ref(ref, f"{field}[{index}]")

    turns = row.get("turns")
    if not isinstance(turns, list) or not turns:
        raise TrajectoryDataError("turns must be a non-empty list")
    if len(turns) > MAX_TURNS:
        raise TrajectoryDataError(f"turns may contain at most {MAX_TURNS} entries")
    turn_ids = set()
    for index, turn in enumerate(turns):
        label = f"turns[{index}]"
        if not isinstance(turn, dict):
            raise TrajectoryDataError(f"{label} must be an object")
        size = _bounded_payload(turn, label)
        if size > MAX_TURN_BYTES:
            raise TrajectoryDataError(f"{label} exceeds {MAX_TURN_BYTES} bytes")
        for field in ("turn_id", "speaker", "role"):
            _required_text(turn.get(field), f"{label}.{field}")
        if turn["turn_id"] in turn_ids:
            raise TrajectoryDataError(f"duplicate {label}.turn_id")
        turn_ids.add(turn["turn_id"])
        model = turn.get("model")
        if not isinstance(model, dict):
            raise TrajectoryDataError(f"{label}.model lineage is required")
        _required_text(model.get("model_id"), f"{label}.model.model_id")
        _digest(model.get("model_sha256"), f"{label}.model.model_sha256")
        if "adapter_sha256" not in model:
            raise TrajectoryDataError(f"{label}.model.adapter_sha256 is required (null when no adapter)")
        _digest(model["adapter_sha256"], f"{label}.model.adapter_sha256", nullable=True)

        for field in ("prompt_ref", "task_ref"):
            _ref(turn.get(field), f"{label}.{field}")
        context_refs = turn.get("context_refs")
        if not isinstance(context_refs, list):
            raise TrajectoryDataError(f"{label}.context_refs must be a list")
        for ref_index, ref in enumerate(context_refs):
            _ref(ref, f"{label}.context_refs[{ref_index}]")

        action = turn.get("action")
        if not isinstance(action, dict):
            raise TrajectoryDataError(f"{label}.action must be an object")
        for field in ("kind", "name"):
            _required_text(action.get(field), f"{label}.action.{field}")
        if action["kind"] not in {"message", "tool_call", "tool_result", "patch", "review", "evaluation"}:
            raise TrajectoryDataError(f"{label}.action.kind is unsupported")
        if not isinstance(action.get("result"), str) or len(action["result"]) > MAX_TEXT_CHARS:
            raise TrajectoryDataError(f"{label}.action.result must be a string of at most {MAX_TEXT_CHARS} characters")
        if "input_ref" in action:
            _ref(action["input_ref"], f"{label}.action.input_ref")
        patch_refs = turn.get("patch_refs")
        if not isinstance(patch_refs, list):
            raise TrajectoryDataError(f"{label}.patch_refs must be a list")
        for ref_index, patch in enumerate(patch_refs):
            if not isinstance(patch, dict):
                raise TrajectoryDataError(f"{label}.patch_refs[{ref_index}] must be an object")
            _required_text(patch.get("path"), f"{label}.patch_refs[{ref_index}].path")
            _digest(patch.get("sha256"), f"{label}.patch_refs[{ref_index}].sha256")
        if turn.get("review_disposition") not in _REVIEW_DISPOSITIONS:
            raise TrajectoryDataError(f"{label}.review_disposition is unsupported")
        evidence = turn.get("evaluator_evidence")
        if not isinstance(evidence, dict) or evidence.get("status") not in _EVALUATOR_STATUSES:
            raise TrajectoryDataError(f"{label}.evaluator_evidence.status is unsupported")
        evidence_refs = evidence.get("refs")
        if not isinstance(evidence_refs, list):
            raise TrajectoryDataError(f"{label}.evaluator_evidence.refs must be a list")
        for ref_index, ref in enumerate(evidence_refs):
            _ref(ref, f"{label}.evaluator_evidence.refs[{ref_index}]")

    _bounded_payload(row, "trajectory")


def validate_trajectories(rows: list[dict]) -> None:
    """Validate rows and ensure linked task families/groups never cross splits."""
    if not isinstance(rows, list) or not rows:
        raise TrajectoryDataError("trajectory corpus must be a non-empty list")
    family_splits: dict[str, set[str]] = defaultdict(set)
    group_splits: dict[str, set[str]] = defaultdict(set)
    ids = set()
    for row in rows:
        validate_trajectory(row)
        trajectory_id = row["trajectory_id"]
        if trajectory_id in ids:
            raise TrajectoryDataError(f"duplicate trajectory_id {trajectory_id!r}")
        ids.add(trajectory_id)
        family_splits[row["task_ref"]["family_id"]].add(row["split"])
        group_splits[row["leakage_group"]].add(row["split"])
    if any(len(splits) > 1 for splits in family_splits.values()):
        raise TrajectoryDataError("linked task family appears across data splits")
    if any(len(splits) > 1 for splits in group_splits.values()):
        raise TrajectoryDataError("leakage_group appears across data splits")


def read_trajectories(path: str) -> list[dict]:
    """Read bounded JSONL records and validate cross-row split boundaries."""
    rows = []
    size = 0
    try:
        with open(path, "rb") as stream:
            for line_number, raw_line in enumerate(stream, 1):
                size += len(raw_line)
                if size > MAX_JSONL_BYTES:
                    raise TrajectoryDataError(f"{path}: corpus exceeds {MAX_JSONL_BYTES} bytes")
                if not raw_line.strip():
                    continue
                try:
                    row = json.loads(raw_line.decode("utf-8"), object_pairs_hook=_unique_object)
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise TrajectoryDataError(f"{path}:{line_number}: invalid JSONL: {exc}") from exc
                try:
                    validate_trajectory(row)
                except TrajectoryDataError as exc:
                    raise TrajectoryDataError(f"{path}:{line_number}: {exc}") from exc
                rows.append(row)
    except OSError:
        raise
    validate_trajectories(rows)
    return rows


def canonical_sha256(value: object) -> str:
    """Return a stable digest for a JSON-compatible task, patch, or evidence record."""
    try:
        payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise TrajectoryDataError(f"value cannot be canonically encoded: {exc}") from exc
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
