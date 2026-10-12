"""Preflight and deterministic corpus assembly for later human-authorized runs."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Iterable

from pydantic import ValidationError

from guru.schemas.corpus import CorpusKind, CorpusManifest, CorpusStatus
from guru.schemas.corpus_item import CorpusItem
from guru.schemas.teacher_lineage import TeacherLineage
from guru.teacher.intake import load_registry, validate_teacher

REPO_GURU_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TASK_MANIFEST = REPO_GURU_ROOT / "data" / "coding" / "tasks.jsonl"
DEFAULT_TEACHER_REGISTRY = REPO_GURU_ROOT / "data" / "coding" / "teacher-registry.jsonl"
DEFAULT_ADMISSION_AUDIT = REPO_GURU_ROOT / "audit" / "quality.jsonl"
ADMITTED_DECISIONS = {"admit", "admit_with_followup"}


class CorpusAssemblyBlocked(RuntimeError):
    def __init__(self, blockers: list[str]) -> None:
        self.blockers = blockers
        super().__init__("corpus assembly blocked: " + "; ".join(blockers))


class CorpusAssemblyError(ValueError):
    """Corpus input or output cannot be handled safely."""


def _jsonl_rows(source: str | Path | Iterable[dict] | dict | None) -> list[dict]:
    if source is None:
        return []
    if isinstance(source, dict):
        rows = source.get("tasks", source.get("items", []))
        return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
    if not isinstance(source, (str, Path)):
        return [row if isinstance(row, dict) else row.model_dump(mode="json") for row in source]
    path = Path(source)
    try:
        with path.open("r", encoding="utf-8") as stream:
            return [json.loads(line) for line in stream if line.strip()]
    except (OSError, json.JSONDecodeError) as exc:
        raise CorpusAssemblyError(f"cannot read JSONL input {path}") from exc


def _read_teacher_records(source: str | Path | Iterable[TeacherLineage | dict[str, Any]] | None) -> list[TeacherLineage]:
    if source is None:
        return []
    if isinstance(source, (str, Path)):
        path = Path(source)
        if not path.is_file():
            return []
        return load_registry(path)
    return [teacher if isinstance(teacher, TeacherLineage) else TeacherLineage.model_validate(teacher)
            for teacher in source]


def _teachers_by_id(teachers: Iterable[TeacherLineage]) -> dict[str, list[TeacherLineage]]:
    indexed: dict[str, list[TeacherLineage]] = {}
    for teacher in teachers:
        indexed.setdefault(teacher.teacher_id, []).append(teacher)
    return indexed


def _read_admission_rows(source: str | Path | Iterable[dict] | None) -> list[dict]:
    if source is None:
        return []
    if isinstance(source, (str, Path)):
        path = Path(source)
        if not path.is_file():
            return []
        return _jsonl_rows(path)
    return _jsonl_rows(source)


def _decision_rows_by_item(rows: Iterable[dict]) -> dict[str, dict]:
    decisions: dict[str, dict] = {}
    for row in rows:
        if row.get("event") in ("item_admission", None) and isinstance(row.get("item_id"), str):
            item_id = row["item_id"]
            if item_id in decisions:
                raise CorpusAssemblyError(f"duplicate quality decisions for item {item_id!r}")
            decisions[item_id] = row
    return decisions


def preflight(*, kind: CorpusKind | str,
              task_manifest: str | Path | Iterable[dict] | dict | None = None,
              teacher_registry: str | Path | Iterable | None = None,
              admission_audit: str | Path | Iterable[dict] | None = None) -> dict[str, Any]:
    try:
        corpus_kind = CorpusKind(kind)
    except ValueError as exc:
        raise CorpusAssemblyError("unknown corpus kind") from exc
    task_source = DEFAULT_TASK_MANIFEST if task_manifest is None else task_manifest
    teacher_source = DEFAULT_TEACHER_REGISTRY if teacher_registry is None else teacher_registry
    audit_source = DEFAULT_ADMISSION_AUDIT if admission_audit is None else admission_audit
    blockers: list[str] = []
    if isinstance(task_source, (str, Path)):
        if not Path(task_source).is_file():
            blockers.append("missing task manifest")
        else:
            task_rows = _jsonl_rows(task_source)
    else:
        task_rows = _jsonl_rows(task_source)
    if not task_rows:
        blockers.append("task manifest has no tasks")
    else:
        identifiers = [row.get("id", row.get("task_id")) for row in task_rows]
        if any(not isinstance(identifier, str) or not identifier.strip() for identifier in identifiers):
            blockers.append("task manifest contains a missing task ID")
        elif len(identifiers) != len(set(identifiers)):
            blockers.append("task manifest contains duplicate task IDs")

    if corpus_kind in {CorpusKind.C_RD, CorpusKind.C_TRACE}:
        teachers = _read_teacher_records(teacher_source)
        if not any(validate_teacher(teacher)["admissible"] for teacher in teachers):
            blockers.append("missing approved teacher")

    audit_rows = _read_admission_rows(audit_source)
    try:
        _decision_rows_by_item(audit_rows)
    except CorpusAssemblyError as exc:
        blockers.append(str(exc))
    if isinstance(audit_source, (str, Path)) and not Path(audit_source).is_file():
        blockers.append("missing admission audit")
    elif not audit_rows:
        blockers.append("admission audit has no decisions")
    admitted = [row for row in audit_rows if row.get("event") in ("item_admission", None)
                and row.get("decision") in ADMITTED_DECISIONS]
    if audit_rows and not admitted:
        blockers.append("admission audit contains no admitted items")
    return {"ready": not blockers, "blockers": blockers, "warnings": []}


def _task_ids(source: str | Path | Iterable[dict] | dict | None) -> set[str]:
    rows = _jsonl_rows(DEFAULT_TASK_MANIFEST if source is None else source)
    return {str(row.get("id", row.get("task_id", ""))) for row in rows
            if row.get("id", row.get("task_id")) is not None}


def _admission_map(source: str | Path | Iterable[dict] | None) -> dict[str, dict]:
    return _decision_rows_by_item(
        _read_admission_rows(DEFAULT_ADMISSION_AUDIT if source is None else source)
    )


def _read_items(source: str | Path | Iterable[dict | CorpusItem]) -> list[CorpusItem]:
    if isinstance(source, (str, Path)):
        raw_rows = _jsonl_rows(source)
    else:
        raw_rows = [row.model_dump(mode="json") if isinstance(row, CorpusItem) else row for row in source]
    try:
        items = [CorpusItem.model_validate(row) for row in raw_rows]
    except ValidationError as exc:
        raise CorpusAssemblyError("items contain an invalid CorpusItem") from exc
    ids = [item.item_id for item in items]
    if len(ids) != len(set(ids)):
        raise CorpusAssemblyError("item_id values must be unique")
    return items


def _write_jsonl(path: Path, rows: list[dict]) -> str:
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), allow_nan=False))
            stream.write("\n")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def assemble(*, kind: CorpusKind | str, task_manifest: str | Path | Iterable[dict] | dict | None,
             teacher_registry: str | Path | Iterable | None,
             admission_audit: str | Path | Iterable[dict] | None,
             items: str | Path | Iterable[dict | CorpusItem], corpus_id: str, version: str,
             split_seed: str, owner_approval: dict[str, str] | None = None,
             output_root: str | Path | None = None) -> CorpusManifest:
    try:
        corpus_kind = CorpusKind(kind)
    except ValueError as exc:
        raise CorpusAssemblyError("unknown corpus kind") from exc
    teacher_source = DEFAULT_TEACHER_REGISTRY if teacher_registry is None else teacher_registry
    teachers = _read_teacher_records(teacher_source)
    check = preflight(kind=corpus_kind, task_manifest=task_manifest,
                      teacher_registry=teachers, admission_audit=admission_audit)
    if not check["ready"]:
        raise CorpusAssemblyBlocked(check["blockers"])
    if items is None or (isinstance(items, (str, Path)) and not Path(items).is_file()):
        raise CorpusAssemblyBlocked(["missing corpus items"])
    for label, value in (("corpus_id", corpus_id), ("version", version)):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
            raise CorpusAssemblyError(f"{label} must be a safe path component")
    if not split_seed:
        raise CorpusAssemblyError("split_seed must be non-empty")
    if owner_approval is not None and not all(owner_approval.get(key, "").strip()
                                              for key in ("owner", "approval_ref", "approved_at")):
        raise CorpusAssemblyError("owner_approval requires owner, approval_ref, and approved_at")
    decisions = _admission_map(admission_audit)
    teachers_by_id = _teachers_by_id(teachers)
    task_ids = _task_ids(task_manifest)
    admitted: list[CorpusItem] = []
    exclusions: dict[str, str] = {}
    teachers_used: set[str] = set()
    for item in _read_items(items):
        if task_ids and item.task_id not in task_ids:
            raise CorpusAssemblyError(f"item {item.item_id!r} references a task absent from task_manifest")
        record = decisions.get(item.item_id)
        outcome = record.get("decision") if record else None
        if record is not None:
            recorded_digest = record.get("item_digest")
            if not isinstance(recorded_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", recorded_digest):
                raise CorpusAssemblyError(f"quality decision for item {item.item_id!r} is missing a valid item_digest")
            if recorded_digest != item.canonical_digest():
                raise CorpusAssemblyError(f"quality decision content digest does not match item {item.item_id!r}")
        if outcome in ADMITTED_DECISIONS:
            # Response-distillation and trajectory corpora are teacher-derived
            # training data. Human-only SFT may omit lineage; any lineage it
            # does declare is still resolved and rights-checked below.
            if corpus_kind in {CorpusKind.C_RD, CorpusKind.C_TRACE} and not item.teacher_lineage_id:
                raise CorpusAssemblyError(
                    f"admitted {corpus_kind.value} item {item.item_id!r} is missing teacher_lineage_id"
                )
            if item.teacher_lineage_id:
                matching_teachers = teachers_by_id.get(item.teacher_lineage_id, [])
                if not matching_teachers:
                    raise CorpusAssemblyError(
                        f"admitted item {item.item_id!r} references missing teacher "
                        f"{item.teacher_lineage_id!r}"
                    )
                if len(matching_teachers) > 1:
                    raise CorpusAssemblyError(
                        f"admitted item {item.item_id!r} references ambiguous duplicate teacher "
                        f"{item.teacher_lineage_id!r}"
                    )
                teacher = matching_teachers[0]
                teacher_check = validate_teacher(teacher)
                if not teacher_check["admissible"]:
                    raise CorpusAssemblyError(
                        f"admitted item {item.item_id!r} references inadmissible teacher "
                        f"{item.teacher_lineage_id!r}: {'; '.join(teacher_check['blockers'])}"
                    )
            admitted.append(item)
            if item.teacher_lineage_id:
                teachers_used.add(item.teacher_lineage_id)
        else:
            exclusions[item.task_id] = f"item {item.item_id} did not have an admitted quality decision"
    if not admitted:
        raise CorpusAssemblyBlocked(["no admitted items are available for assembly"])

    # Group related examples before splitting. The curator assigns one
    # transitive leakage_group ID to all items linked by repository, source,
    # task family, duplicate, or trajectory ancestry. The task constraint is
    # checked here as a second guard: one task cannot span groups/partitions.
    group_by_task: dict[str, str] = {}
    for item in admitted:
        group_id = item.metadata.get("leakage_group")
        if not isinstance(group_id, str) or not group_id.strip():
            raise CorpusAssemblyError(
                f"admitted item {item.item_id!r} is missing leakage_group metadata"
            )
        previous_group = group_by_task.setdefault(item.task_id, group_id)
        if previous_group != group_id:
            raise CorpusAssemblyError(
                f"task {item.task_id!r} is assigned to conflicting leakage groups"
            )
    group_ids_by_hash = sorted(
        {item.metadata["leakage_group"] for item in admitted},
        key=lambda group_id: (hashlib.sha256(group_id.encode("utf-8")).digest(), group_id),
    )
    train_end = len(group_ids_by_hash) * 80 // 100
    val_end = train_end + len(group_ids_by_hash) * 10 // 100
    split_by_group = {
        group_id: ("train" if index < train_end else "val" if index < val_end else "test")
        for index, group_id in enumerate(group_ids_by_hash)
    }
    for item in admitted:
        declared_split = item.metadata.get("split")
        normalized_declared = {"validation": "val"}.get(declared_split, declared_split)
        if normalized_declared is not None and normalized_declared != split_by_group[item.metadata["leakage_group"]]:
            raise CorpusAssemblyError(
                f"item {item.item_id!r} declares a split that conflicts with its leakage-group assignment"
            )
    buckets: dict[str, list[CorpusItem]] = {"train": [], "val": [], "test": []}
    for item in sorted(admitted, key=lambda entry: (entry.task_id, entry.item_id)):
        buckets[split_by_group[item.metadata["leakage_group"]]].append(item)
    assignment = {group_id: split_by_group[group_id] for group_id in group_ids_by_hash}
    split_group_counts = {split: sum(assigned == split for assigned in assignment.values())
                          for split in ("train", "val", "test")}
    split_assignment_digest = hashlib.sha256(json.dumps(
        assignment, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")).hexdigest()

    base = Path(output_root) if output_root is not None else REPO_GURU_ROOT / "corpora"
    corpus_parent = base / corpus_id
    destination = corpus_parent / version
    if corpus_parent.is_symlink() or destination.is_symlink() or (destination.exists() and (not destination.is_dir() or any(destination.iterdir()))):
        raise CorpusAssemblyError("destination already contains data; assembly never overwrites an existing corpus")
    destination.mkdir(parents=True, exist_ok=True)
    file_digests = {}
    for split in ("train", "val", "test"):
        rows = [item.model_dump(mode="json") for item in buckets[split]]
        file_digests[f"items.{split}.jsonl"] = _write_jsonl(destination / f"items.{split}.jsonl", rows)
    items_digest = hashlib.sha256("".join(file_digests[name] for name in sorted(file_digests)).encode("ascii")).hexdigest()
    manifest = CorpusManifest(
        corpus_id=corpus_id, version=version, kind=corpus_kind,
        status=CorpusStatus.FROZEN if owner_approval else CorpusStatus.DRAFT,
        owner_approval=owner_approval, split_seed=split_seed,
        split_rule=("split_seed is recorded as provenance only; assign transitive leakage_group IDs "
                    "before splitting; sort unique UTF-8 group IDs by SHA-256 digest (group ID breaks "
                    "ties); floor(0.8G) groups train, next floor(0.1G) validation, remainder test; "
                    "all items for a task/group stay together"),
        split_algorithm="leakage-group-sha256-v1", split_group_count=len(group_ids_by_hash),
        split_group_counts=split_group_counts,
        split_assignment_digest=split_assignment_digest,
        item_count=len(admitted), split_counts={name: len(rows) for name, rows in buckets.items()},
        teacher_ids=sorted(teachers_used), excluded_task_ids=sorted(exclusions),
        exclusion_reasons=exclusions, item_file_digests=file_digests, items_digest=items_digest,
    )
    manifest_path = destination / "manifest.json"
    manifest_path.write_text(json.dumps(manifest.model_dump(mode="json"), ensure_ascii=False,
                                        sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return manifest
