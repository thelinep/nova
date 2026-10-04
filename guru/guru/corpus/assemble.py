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


def _read_admission_rows(source: str | Path | Iterable[dict] | None) -> list[dict]:
    if source is None:
        return []
    if isinstance(source, (str, Path)):
        path = Path(source)
        if not path.is_file():
            return []
        return _jsonl_rows(path)
    return _jsonl_rows(source)


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
    decisions: dict[str, dict] = {}
    for row in _read_admission_rows(DEFAULT_ADMISSION_AUDIT if source is None else source):
        if row.get("event") in ("item_admission", None) and isinstance(row.get("item_id"), str):
            decisions[row["item_id"]] = row
    return decisions


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
    check = preflight(kind=corpus_kind, task_manifest=task_manifest,
                      teacher_registry=teacher_registry, admission_audit=admission_audit)
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
    task_ids = _task_ids(task_manifest)
    admitted: list[CorpusItem] = []
    exclusions: dict[str, str] = {}
    teachers_used: set[str] = set()
    for item in _read_items(items):
        if task_ids and item.task_id not in task_ids:
            raise CorpusAssemblyError(f"item {item.item_id!r} references a task absent from task_manifest")
        record = decisions.get(item.item_id)
        outcome = record.get("decision") if record else None
        if outcome in ADMITTED_DECISIONS:
            admitted.append(item)
            if item.teacher_lineage_id:
                teachers_used.add(item.teacher_lineage_id)
        else:
            exclusions[item.task_id] = f"item {item.item_id} did not have an admitted quality decision"
    if not admitted:
        raise CorpusAssemblyBlocked(["no admitted items are available for assembly"])

    buckets: dict[str, list[CorpusItem]] = {"train": [], "val": [], "test": []}
    for item in sorted(admitted, key=lambda entry: (entry.task_id, entry.item_id)):
        bucket = int(hashlib.sha256(f"{split_seed}:{item.task_id}".encode("utf-8")).hexdigest(), 16) % 100
        split = "train" if bucket < 80 else "val" if bucket < 90 else "test"
        buckets[split].append(item)

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
        split_rule="sha256(f'{split_seed}:{task_id}') mod 100; <80 train, <90 val, otherwise test",
        item_count=len(admitted), split_counts={name: len(rows) for name, rows in buckets.items()},
        teacher_ids=sorted(teachers_used), excluded_task_ids=sorted(exclusions),
        exclusion_reasons=exclusions, item_file_digests=file_digests, items_digest=items_digest,
    )
    manifest_path = destination / "manifest.json"
    manifest_path.write_text(json.dumps(manifest.model_dump(mode="json"), ensure_ascii=False,
                                        sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return manifest
