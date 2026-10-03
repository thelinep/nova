"""Experimental Guru-Code task data and offline proposal evaluation.

This module deliberately does not execute generated code. Predictions are
untrusted data; the checks here cover JSON shape, path safety, Python syntax,
and hand-authored fixture expectations only.
"""
from __future__ import annotations

import ast
import json
import os
from pathlib import PurePosixPath, PureWindowsPath

SCHEMA_VERSION = "guru-code-task-v1"
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


class CodingDataError(ValueError):
    pass


def read_tasks(path: str) -> list[dict]:
    """Load and validate Guru-Code JSONL tasks. Blank lines are ignored."""
    rows, seen = [], set()
    with open(path, encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                validate_task(row)
            except (json.JSONDecodeError, CodingDataError) as exc:
                raise CodingDataError(f"{path}:{line_no}: {exc}") from exc
            if row["id"] in seen:
                raise CodingDataError(f"{path}:{line_no}: duplicate task id {row['id']!r}")
            seen.add(row["id"])
            rows.append(row)
    if not rows:
        raise CodingDataError(f"{path}: no tasks found")
    return rows


def validate_task(row: object) -> None:
    if not isinstance(row, dict):
        raise CodingDataError("task must be a JSON object")
    required = {"schema_version", "id", "split", "language", "prompt", "provenance", "rubric"}
    missing = required - row.keys()
    if missing:
        raise CodingDataError(f"missing fields: {', '.join(sorted(missing))}")
    if row["schema_version"] != SCHEMA_VERSION:
        raise CodingDataError(f"schema_version must be {SCHEMA_VERSION!r}")
    if not isinstance(row["id"], str) or not row["id"].strip():
        raise CodingDataError("id must be a non-empty string")
    if row["split"] not in ("train", "eval"):
        raise CodingDataError("split must be 'train' or 'eval'")
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
    if row["split"] == "train":
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


def write_sft(tasks: list[dict], destination: str) -> int:
    """Write the existing Guru teach-compatible prompt/answer JSONL format."""
    rows = [r for r in tasks if r["split"] == "train"]
    if not rows:
        raise CodingDataError("no train tasks available for instruction tuning")
    os.makedirs(os.path.dirname(os.path.abspath(destination)), exist_ok=True)
    with open(destination, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps({"prompt": task_prompt(row), "answer": json.dumps(row["target"], ensure_ascii=False)},
                               ensure_ascii=False) + "\n")
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
        return json.loads(text), None
    except json.JSONDecodeError as exc:
        return None, f"output is not strict JSON: {exc.msg}"


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
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise CodingDataError(f"{path}:{line_no}: invalid JSON: {exc.msg}") from exc
            if not isinstance(row, dict):
                raise CodingDataError(f"{path}:{line_no}: prediction must be an object")
            rows.append(row)
    return rows
