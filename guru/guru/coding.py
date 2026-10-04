"""Experimental Guru-Code task data and offline proposal evaluation.

This module deliberately does not execute generated code. Predictions are
untrusted data; the checks here cover JSON shape, path safety, Python syntax,
and hand-authored fixture expectations only.
"""
from __future__ import annotations

import ast
from datetime import datetime
import hashlib
import json
import os
import re
import tempfile
import unicodedata
from pathlib import PurePosixPath, PureWindowsPath

SCHEMA_VERSION = "guru-code-task-v1"
SCHEMA_VERSION_V2 = "guru-code-task-v2"
PLAN_SCHEMA = {
    "summary": "short string",
    "files": [{"path": "project-relative path", "content": "complete file contents"}],
    "tests": ["test command or check description"],
}
SYSTEM_PROMPT = (
    "You are an experimental code-change proposer. Return exactly one JSON object, "
    "with no Markdown fences or text outside it, matching this shape: "
    '{"summary":"...","files":[{"path":"relative/path","content":"complete contents"}],'
    '"tests":["..." ]}. Do not claim tests passed unless supplied evidence says so. '
    "Do not use absolute paths, parent-directory paths, or modify files outside the request."
)
SOURCE_MANIFEST_SCHEMA = "guru-code-source-manifest-v1"
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_ALLOWED_SOURCE_USES = {"train_sft", "evaluation", "release_weights"}


class CodingDataError(ValueError):
    pass


def _unique_json_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise CodingDataError(f"duplicate JSON object key {key!r}")
        value[key] = item
    return value


def _reject_json_constant(value):
    raise CodingDataError(f"non-standard JSON numeric constant {value!r} is not allowed")


def read_tasks(path: str) -> list[dict]:
    """Load and validate Guru-Code JSONL tasks. Blank lines are ignored."""
    rows, seen = [], set()
    with open(path, encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line, object_pairs_hook=_unique_json_object, parse_constant=_reject_json_constant)
                validate_task(row)
            except (json.JSONDecodeError, CodingDataError) as exc:
                raise CodingDataError(f"{path}:{line_no}: {exc}") from exc
            if row["id"] in seen:
                raise CodingDataError(f"{path}:{line_no}: duplicate task id {row['id']!r}")
            seen.add(row["id"])
            rows.append(row)
    if not rows:
        raise CodingDataError(f"{path}: no tasks found")
    versions = {row["schema_version"] for row in rows}
    if len(versions) > 1:
        raise CodingDataError(f"{path}: task corpus cannot mix schema versions")
    return rows


def validate_task(row: object) -> None:
    if not isinstance(row, dict):
        raise CodingDataError("task must be a JSON object")
    required = {"schema_version", "id", "split", "language", "prompt", "provenance", "rubric"}
    missing = required - row.keys()
    if missing:
        raise CodingDataError(f"missing fields: {', '.join(sorted(missing))}")
    if row["schema_version"] not in (SCHEMA_VERSION, SCHEMA_VERSION_V2):
        raise CodingDataError(f"schema_version must be {SCHEMA_VERSION!r} or {SCHEMA_VERSION_V2!r}")
    if not isinstance(row["id"], str) or not row["id"].strip():
        raise CodingDataError("id must be a non-empty string")
    version = row["schema_version"]
    allowed_splits = ("train", "eval") if version == SCHEMA_VERSION else ("train", "validation", "eval")
    if row["split"] not in allowed_splits:
        raise CodingDataError(f"split must be one of {', '.join(repr(split) for split in allowed_splits)}")
    if not isinstance(row["language"], str) or not row["language"].strip():
        raise CodingDataError("language must be a non-empty string")
    if not isinstance(row["prompt"], str) or not row["prompt"].strip():
        raise CodingDataError("prompt must be a non-empty string")
    provenance = row["provenance"]
    if not isinstance(provenance, dict) or not all(isinstance(provenance.get(k), str) and provenance[k].strip()
                                                    for k in ("kind", "description")):
        raise CodingDataError("provenance requires non-empty kind and description strings")
    rubric = row["rubric"]
    if not isinstance(rubric, dict):
        raise CodingDataError("rubric must be an object")
    if not isinstance(rubric.get("expected_files"), list) or not all(isinstance(x, str) for x in rubric["expected_files"]):
        raise CodingDataError("rubric.expected_files must be a list of paths")
    symbols = rubric.get("required_symbols", {})
    if not isinstance(symbols, dict) or any(not isinstance(p, str) or not isinstance(names, list) or
                                            not all(isinstance(n, str) for n in names)
                                            for p, names in symbols.items()):
        raise CodingDataError("rubric.required_symbols must map paths to lists of names")
    snippets = rubric.get("required_test_snippets", [])
    if not isinstance(snippets, list) or not all(isinstance(s, str) for s in snippets):
        raise CodingDataError("rubric.required_test_snippets must be a list of strings")
    if row["split"] in ("train", "validation"):
        target = row.get("target")
        if not isinstance(target, dict):
            raise CodingDataError("train tasks require a target plan object")
        ok, _ = validate_plan(target)
        if not ok:
            raise CodingDataError("train target does not match the plan schema")
    elif "target" in row:
        raise CodingDataError("eval tasks must not include target output")


def task_prompt(row: dict) -> str:
    return f"{SYSTEM_PROMPT}\n\nTask: {row['prompt']}"


def _normalize_json(value):
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n"))
    if isinstance(value, list):
        return [_normalize_json(item) for item in value]
    if isinstance(value, dict):
        return {_normalize_json(key): _normalize_json(item) for key, item in value.items()}
    return value


def canonical_sha256(value: object) -> str:
    try:
        canonical = json.dumps(_normalize_json(value), ensure_ascii=False, sort_keys=True,
                               separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise CodingDataError(f"value cannot be canonically encoded as JSON: {exc}") from exc
    return hashlib.sha256(canonical).hexdigest()


def _reviewed_file_sha256(manifest_dir: str, relative_path: object, label: str) -> str:
    if not isinstance(relative_path, str) or not relative_path.strip() or os.path.isabs(relative_path) or "\\" in relative_path or "\x00" in relative_path:
        raise CodingDataError(f"{label} must be a safe path relative to the source manifest")
    parts = PurePosixPath(relative_path).parts
    if ".." in parts or relative_path.startswith("~"):
        raise CodingDataError(f"{label} must stay inside the source manifest directory")
    candidate = os.path.join(manifest_dir, *parts)
    resolved = os.path.realpath(candidate)
    if os.path.commonpath((manifest_dir, resolved)) != manifest_dir or os.path.islink(candidate) or not os.path.isfile(resolved):
        raise CodingDataError(f"{label} must be a regular file inside the source manifest directory")
    digest = hashlib.sha256()
    with open(resolved, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_release_sources(tasks: list[dict], manifest_path: str) -> tuple[dict, str, str]:
    try:
        with open(manifest_path, "rb") as stream:
            raw = stream.read()
        manifest = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_json_object,
                              parse_constant=_reject_json_constant)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, CodingDataError) as exc:
        raise CodingDataError(f"cannot read source manifest {manifest_path}: {exc}") from exc
    if not isinstance(manifest, dict) or manifest.get("schema_version") != SOURCE_MANIFEST_SCHEMA:
        raise CodingDataError(f"source manifest schema_version must be {SOURCE_MANIFEST_SCHEMA!r}")
    sources = manifest.get("sources")
    if not isinstance(sources, list) or not sources:
        raise CodingDataError("source manifest requires a non-empty sources list")
    manifest_dir = os.path.realpath(os.path.dirname(os.path.abspath(manifest_path)))

    by_id = {}
    for i, source in enumerate(sources):
        label = f"source manifest sources[{i}]"
        if not isinstance(source, dict):
            raise CodingDataError(f"{label} must be an object")
        source_id = source.get("source_id")
        if not isinstance(source_id, str) or not source_id.strip():
            raise CodingDataError(f"{label}.source_id must be a non-empty string")
        if source_id in by_id:
            raise CodingDataError(f"duplicate source_id {source_id!r}")
        if not all(isinstance(source.get(key), str) and source[key].strip()
                   for key in ("uri", "revision", "attribution", "artifact_path")):
            raise CodingDataError(f"{label} requires uri, immutable revision, artifact_path, and attribution")
        if not _SHA256.fullmatch(str(source.get("artifact_sha256", ""))):
            raise CodingDataError(f"{label}.artifact_sha256 must be lowercase SHA-256")
        if _reviewed_file_sha256(manifest_dir, source["artifact_path"], f"{label}.artifact_path") != source["artifact_sha256"]:
            raise CodingDataError(f"{label}.artifact_sha256 does not match the source artifact")
        license_record = source.get("license")
        if not isinstance(license_record, dict) or not all(
                isinstance(license_record.get(key), str) and license_record[key].strip()
                for key in ("id", "text_uri", "text_path")):
            raise CodingDataError(f"{label}.license requires id, text_uri, and local text_path")
        license_id = license_record["id"]
        if license_id.strip().upper() in {"REVIEW_REQUIRED", "NOASSERTION", "UNKNOWN", "UNLICENSED"}:
            raise CodingDataError(f"{label}.license.id is unresolved")
        if license_id.startswith("LicenseRef-") and not re.fullmatch(r"LicenseRef-[A-Za-z0-9.-]+", license_id):
            raise CodingDataError(f"{label}.license.id has a malformed LicenseRef")
        if not _SHA256.fullmatch(str(license_record.get("text_sha256", ""))):
            raise CodingDataError(f"{label}.license.text_sha256 must be lowercase SHA-256")
        if _reviewed_file_sha256(manifest_dir, license_record["text_path"], f"{label}.license.text_path") != license_record["text_sha256"]:
            raise CodingDataError(f"{label}.license.text_sha256 does not match the saved license text")
        review = source.get("rights_review")
        if not isinstance(review, dict) or review.get("status") != "approved":
            raise CodingDataError(f"{label} rights review is not approved")
        if not isinstance(review.get("reviewer"), str) or not review["reviewer"].strip():
            raise CodingDataError(f"{label} rights review requires a reviewer")
        reviewed_at = review.get("reviewed_at")
        if not isinstance(reviewed_at, str) or not reviewed_at.strip():
            raise CodingDataError(f"{label} rights review requires reviewed_at")
        try:
            parsed_reviewed_at = datetime.fromisoformat(reviewed_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise CodingDataError(f"{label} rights review reviewed_at must be ISO-8601") from exc
        if parsed_reviewed_at.tzinfo is None or parsed_reviewed_at.utcoffset() is None:
            raise CodingDataError(f"{label} rights review reviewed_at must include a timezone")
        uses = review.get("allowed_uses")
        if not isinstance(uses, list) or not all(isinstance(use, str) and use in _ALLOWED_SOURCE_USES for use in uses):
            raise CodingDataError(f"{label}.rights_review.allowed_uses contains missing or unknown uses")
        if len(uses) != len(set(uses)):
            raise CodingDataError(f"{label}.rights_review.allowed_uses contains duplicates")
        task_hashes = source.get("task_hashes")
        if not isinstance(task_hashes, dict) or not task_hashes:
            raise CodingDataError(f"{label}.task_hashes must map reviewed task IDs to canonical SHA-256 values")
        if any(not isinstance(task_id, str) or not task_id.strip() or not isinstance(digest, str) or not _SHA256.fullmatch(digest)
               for task_id, digest in task_hashes.items()):
            raise CodingDataError(f"{label}.task_hashes contains an invalid task ID or digest")
        by_id[source_id] = source
    return by_id, hashlib.sha256(raw).hexdigest(), manifest_dir


def _validate_reviewed_tasks(tasks: list[dict], by_source: dict, manifest_dir: str) -> None:
    actual_ids = {row["id"] for row in tasks}
    seen_manifest_tasks = set()
    rows_by_id = {row["id"]: row for row in tasks}
    for source_id, source in by_source.items():
        for task_id, digest in source["task_hashes"].items():
            if task_id not in actual_ids:
                raise CodingDataError(f"source {source_id!r} refers to unknown task {task_id!r}")
            row = rows_by_id[task_id]
            if digest != canonical_sha256(row):
                raise CodingDataError(f"task {task_id!r} changed after source review")
            refs = row["provenance"].get("source_refs", [])
            if not any(isinstance(ref, dict) and ref.get("source_id") == source_id for ref in refs):
                raise CodingDataError(f"task {task_id!r} does not reference manifest source {source_id!r}")
            seen_manifest_tasks.add((source_id, task_id))

    seen_groups, seen_prompts, seen_items = {}, {}, {}
    versions = {row["schema_version"] for row in tasks}
    if len(versions) != 1:
        raise CodingDataError("release data cannot mix task schema versions")
    version = next(iter(versions))
    required_splits = {"train", "eval"} if version == SCHEMA_VERSION else {"train", "validation", "eval"}
    if {row["split"] for row in tasks} != required_splits:
        if version == SCHEMA_VERSION:
            raise CodingDataError("release data requires both train and held-out eval tasks")
        raise CodingDataError("v2 release data requires train, validation, and held-out eval tasks")
    manifest_task_ids = {task_id for _, task_id in seen_manifest_tasks}
    for row in tasks:
        if row["id"] not in manifest_task_ids:
            raise CodingDataError(f"task {row['id']!r} is absent from the reviewed source manifest")
        split = row["split"]
        group = row.get("leakage_group")
        if not isinstance(group, str) or not group.strip():
            raise CodingDataError(f"task {row['id']!r} requires a leakage_group for release data")
        if group in seen_groups and seen_groups[group] != split:
            raise CodingDataError(f"leakage group {group!r} appears in both {seen_groups[group]} and {split} splits")
        seen_groups[group] = split
        fingerprint = canonical_sha256({key: row[key] for key in ("language", "prompt", "rubric")})
        if fingerprint in seen_prompts and seen_prompts[fingerprint] != split:
            raise CodingDataError("task prompt/rubric content is duplicated across splits")
        seen_prompts[fingerprint] = split
        refs = row["provenance"].get("source_refs")
        if not isinstance(refs, list) or not refs:
            raise CodingDataError(f"task {row['id']!r} requires at least one reviewed source reference")
        used_refs = set()
        for ref in refs:
            if not isinstance(ref, dict) or set(ref) != {"source_id", "item_id", "item_path", "item_sha256", "transformation"}:
                raise CodingDataError(f"task {row['id']!r} has a malformed source reference")
            source_id = ref.get("source_id")
            if not isinstance(source_id, str) or not source_id.strip():
                raise CodingDataError(f"task {row['id']!r} source reference needs a source_id")
            source = by_source.get(source_id)
            if source is None:
                raise CodingDataError(f"task {row['id']!r} refers to unknown source {source_id!r}")
            if source["task_hashes"].get(row["id"]) != canonical_sha256(row):
                raise CodingDataError(f"task {row['id']!r} is not hash-bound to referenced source {source_id!r}")
            item_id, item_path, item_sha = ref.get("item_id"), ref.get("item_path"), ref.get("item_sha256")
            transformation = ref.get("transformation")
            if not isinstance(item_id, str) or not item_id.strip() or not _SHA256.fullmatch(str(item_sha or "")):
                raise CodingDataError(f"task {row['id']!r} source reference needs item_id and lowercase item SHA-256")
            if _reviewed_file_sha256(manifest_dir, item_path, f"task {row['id']!r} source_refs.item_path") != item_sha:
                raise CodingDataError(f"task {row['id']!r} item_sha256 does not match its saved source item")
            if not isinstance(transformation, str) or not transformation.strip():
                raise CodingDataError(f"task {row['id']!r} source reference needs a transformation description")
            key = (source_id, item_id)
            if key in used_refs:
                raise CodingDataError(f"task {row['id']!r} repeats source item {item_id!r}")
            used_refs.add(key)
            old_item = seen_items.get(key) or seen_items.get(("sha256", item_sha))
            if old_item:
                if old_item[0] != split:
                    raise CodingDataError(f"source item {item_id!r} appears in both {old_item[0]} and {split} splits")
                raise CodingDataError(f"source item {item_id!r} is referenced by more than one task")
            seen_items[key] = (split, row["id"])
            seen_items[("sha256", item_sha)] = (split, row["id"])
            required_use = "train_sft" if split == "train" else "evaluation"
            if required_use not in source["rights_review"]["allowed_uses"]:
                raise CodingDataError(f"source {source_id!r} is not approved for {required_use}")


def write_sft(tasks: list[dict], destination: str, *, profile: str = "smoke", source_manifest: str | None = None) -> int:
    """Write Guru teach pairs; release mode requires reviewed source evidence."""
    if profile not in ("smoke", "release"):
        raise CodingDataError("profile must be 'smoke' or 'release'")
    if not tasks:
        raise CodingDataError("no tasks available for instruction tuning")
    versions = {row["schema_version"] for row in tasks}
    if len(versions) > 1:
        raise CodingDataError("task corpus cannot mix schema versions")
    if profile == "release":
        if not source_manifest:
            raise CodingDataError("release SFT export requires --source-manifest")
        required_splits = {"train", "eval"} if next(iter(versions)) == SCHEMA_VERSION else {"train", "validation", "eval"}
        if {row["split"] for row in tasks} != required_splits:
            if required_splits == {"train", "eval"}:
                raise CodingDataError("release data requires both train and held-out eval tasks")
            raise CodingDataError("v2 release data requires train, validation, and held-out eval tasks")
        by_source, manifest_sha, manifest_dir = _read_release_sources(tasks, source_manifest)
        _validate_reviewed_tasks(tasks, by_source, manifest_dir)
    else:
        if source_manifest:
            raise CodingDataError("--source-manifest requires the explicit release profile")
        if any(row["split"] == "train" and row["provenance"].get("synthetic_fixture") is not True for row in tasks):
            raise CodingDataError("smoke SFT export accepts only explicitly marked synthetic fixtures")
        by_source, manifest_sha = {}, None
    rows = [r for r in tasks if r["split"] == "train"]
    if not rows:
        raise CodingDataError("no train tasks available for instruction tuning")
    pairs = "".join(json.dumps({"prompt": task_prompt(row), "answer": json.dumps(row["target"], ensure_ascii=False)},
                               ensure_ascii=False) + "\n" for row in rows).encode("utf-8")
    os.makedirs(os.path.dirname(os.path.abspath(destination)), exist_ok=True)
    if profile == "smoke":
        with open(destination, "wb") as f:
            f.write(pairs)
    else:
        sidecar_path = destination + ".provenance.json"
        sidecar = json.dumps({"schema_version": "guru-code-sft-provenance-v1", "profile": "release",
                              "source_manifest_sha256": manifest_sha, "sft_sha256": hashlib.sha256(pairs).hexdigest(),
                              "task_ids": [row["id"] for row in rows], "train_count": len(rows),
                              "task_hashes": {row["id"]: canonical_sha256(row) for row in rows},
                              "source_refs": {row["id"]: row["provenance"]["source_refs"] for row in rows}},
                             ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n"
        if os.path.lexists(sidecar_path):
            raise CodingDataError("release provenance sidecar already exists; choose a new path")
        recover_output = os.path.lexists(destination)
        if recover_output:
            if os.path.islink(destination) or not os.path.isfile(destination):
                raise CodingDataError("release SFT output already exists and is not a regular file")
            with open(destination, "rb") as existing:
                if existing.read() != pairs:
                    raise CodingDataError("release SFT output already exists with different bytes; choose a new path")
        temps = []
        created_sidecar = False
        created_output = False
        try:
            for content in (pairs, sidecar):
                with tempfile.NamedTemporaryFile(mode="wb", dir=os.path.dirname(os.path.abspath(destination)),
                                                 prefix=".guru-code-release-", delete=False) as f:
                    f.write(content)
                    temps.append(f.name)
            # Publish SFT bytes before the sidecar completion marker. If a
            # crash lands between links, an identical output can be resumed.
            if not recover_output:
                os.link(temps[0], destination)
                created_output = True
            os.link(temps[1], sidecar_path)
            created_sidecar = True
        except OSError:
            if created_output:
                try: os.unlink(destination)
                except OSError: pass
            if created_sidecar:
                try: os.unlink(sidecar_path)
                except OSError: pass
            for temp in temps:
                try: os.unlink(temp)
                except OSError: pass
            raise
        for temp in temps:
            try: os.unlink(temp)
            except OSError: pass
    return len(rows)


def validate_plan(value: object) -> tuple[bool, dict]:
    """Return structural and syntax findings for one generated plan."""
    issues: list[str] = []
    schema_ok = True
    if not isinstance(value, dict):
        return False, {"issues": ["plan must be a JSON object"], "files": {}, "safe_paths": False,
                       "syntax_valid": False, "schema_valid": False}
    if set(value) != {"summary", "files", "tests"}:
        issues.append("plan must contain exactly summary, files, and tests")
        schema_ok = False
    if not isinstance(value.get("summary"), str) or not value["summary"].strip():
        issues.append("summary must be a non-empty string")
        schema_ok = False
    files = value.get("files")
    if not isinstance(files, list) or not files:
        issues.append("files must be a non-empty list")
        schema_ok = False
        files = []
    if not isinstance(value.get("tests"), list) or not all(isinstance(x, str) for x in value["tests"]):
        issues.append("tests must be a list of strings")
        schema_ok = False
    file_map, all_safe, syntax_ok = {}, bool(files), True
    for i, item in enumerate(files):
        if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("content"), str):
            issues.append(f"files[{i}] requires string path and content")
            schema_ok = False
            all_safe = syntax_ok = False
            continue
        if set(item) != {"path", "content"}:
            issues.append(f"files[{i}] must contain exactly path and content")
            schema_ok = False
        raw_path = item["path"]
        path = PurePosixPath(raw_path)
        windows_path = PureWindowsPath(raw_path)
        safe = (bool(raw_path) and not path.is_absolute() and not windows_path.is_absolute() and
                not windows_path.drive and ".." not in path.parts and "\\" not in raw_path and
                "\x00" not in raw_path and not raw_path.startswith("~"))
        if not safe:
            issues.append(f"unsafe file path: {raw_path!r}")
            all_safe = False
        elif raw_path in file_map:
            issues.append(f"duplicate file path: {raw_path!r}")
        else:
            file_map[raw_path] = item["content"]
        if safe and raw_path.endswith(".py"):
            try:
                ast.parse(item["content"], filename=raw_path)
            except SyntaxError as exc:
                issues.append(f"Python syntax error in {raw_path}: {exc.msg} at line {exc.lineno}")
                syntax_ok = False
    ok = not issues
    return ok, {"issues": issues, "files": file_map, "safe_paths": all_safe,
                "syntax_valid": syntax_ok, "schema_valid": schema_ok}


def _parse_prediction(text: object) -> tuple[object | None, str | None]:
    if not isinstance(text, str):
        return None, "prediction output must be a string"
    try:
        return json.loads(text, object_pairs_hook=_unique_json_object), None
    except (json.JSONDecodeError, CodingDataError) as exc:
        return None, f"output is not strict JSON: {getattr(exc, 'msg', str(exc))}"


def evaluate(tasks: list[dict], predictions: list[dict]) -> dict:
    """Evaluate one output per held-out task; no generated code is executed."""
    expected = {r["id"]: r for r in tasks if r["split"] == "eval"}
    provided = {}
    duplicate_ids = set()
    for row in predictions:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            continue
        if row["id"] in provided:
            duplicate_ids.add(row["id"])
        provided[row["id"]] = row.get("output")
    results = []
    for task_id, task in expected.items():
        output, parse_error = _parse_prediction(provided.get(task_id))
        valid, details = validate_plan(output) if parse_error is None else (False, {
            "issues": [parse_error], "files": {}, "safe_paths": False,
            "syntax_valid": False, "schema_valid": False})
        issues = list(details["issues"])
        rubric = task["rubric"]
        missing_paths = sorted(set(rubric["expected_files"]) - details["files"].keys())
        if missing_paths:
            issues.append("missing expected files: " + ", ".join(missing_paths))
        missing_symbols = []
        for path, names in rubric.get("required_symbols", {}).items():
            content = details["files"].get(path, "")
            try:
                tree = ast.parse(content)
                found = {n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
                found |= {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
            except SyntaxError:
                found = set()
            missing_symbols.extend(f"{path}:{name}" for name in names if name not in found)
        if missing_symbols:
            issues.append("missing expected symbols: " + ", ".join(missing_symbols))
        required_tests = rubric.get("required_test_snippets", [])
        all_tests = "\n".join(output.get("tests", [])) if isinstance(output, dict) and isinstance(output.get("tests"), list) else ""
        missing_tests = [s for s in required_tests if s not in all_tests]
        if missing_tests:
            issues.append("missing test/check descriptions: " + ", ".join(missing_tests))
        structured = details["schema_valid"]
        results.append({"id": task_id, "present": task_id in provided, "structured": structured,
                        "safe_paths": details["safe_paths"], "syntax_valid": details["syntax_valid"],
                        "rubric_pass": not missing_paths and not missing_symbols and not missing_tests,
                        "pass": valid and not missing_paths and not missing_symbols and not missing_tests,
                        "issues": issues})
    n = len(results)
    denom = max(1, n)
    unknown_ids = sorted(set(provided) - set(expected))
    return {"schema_version": "guru-code-eval-v1", "warning": "Experimental offline checks only; generated code was not executed and this is not a capability certification.",
            "cases": n, "prediction_coverage": sum(r["present"] for r in results) / denom,
            "structured_rate": sum(r["structured"] for r in results) / denom,
            "safe_path_rate": sum(r["safe_paths"] for r in results) / denom,
            "python_syntax_rate": sum(r["syntax_valid"] for r in results) / denom,
            "rubric_rate": sum(r["rubric_pass"] for r in results) / denom,
            "pass_rate": sum(r["pass"] for r in results) / denom,
            "duplicate_prediction_ids": sorted(duplicate_ids), "unknown_prediction_ids": unknown_ids,
            "results": results}


def read_predictions(path: str) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line, object_pairs_hook=_unique_json_object)
            except (json.JSONDecodeError, CodingDataError) as exc:
                raise CodingDataError(f"{path}:{line_no}: invalid JSON: {getattr(exc, 'msg', str(exc))}") from exc
            if not isinstance(row, dict):
                raise CodingDataError(f"{path}:{line_no}: prediction must be an object")
            rows.append(row)
    return rows
