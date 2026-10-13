"""Read-only binding of a student model-intake record to the selected recipe.

This checks identity, artifact digests, and the independently reviewed
student-base permissions. It does not infer permissions from a model license,
fetch artifacts, load a model/tokenizer, or authorize training.
"""
from __future__ import annotations

import hashlib
import json
import errno
import os
import stat
from pathlib import Path
from typing import Any

from .lora_recipe import LoraSftRecipe, canonical_recipe_bytes
from .model_intake import ModelIntakeError, validate_model_intake


class DuplicateJsonKeyError(ValueError):
    """A JSON input repeats an identity or policy key."""


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateJsonKeyError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _read_json(path: str | Path, root: str | Path) -> dict[str, Any]:
    root_lexical = Path(os.path.abspath(root))
    root_path = root_lexical.resolve(strict=True)
    candidate = Path(path)
    if ".." in candidate.parts:
        raise ValueError("intake and recipe files must remain within the Guru repository")
    if candidate.is_absolute():
        candidate = Path(os.path.abspath(candidate))
    try:
        relative = candidate.relative_to(root_lexical) if candidate.is_absolute() else candidate
    except ValueError as exc:
        raise ValueError("intake and recipe files must remain within the Guru repository") from exc
    if not relative.parts or any(part in (".", "..") for part in relative.parts):
        raise ValueError("intake and recipe files must remain within the Guru repository")

    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    file_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    directory_fd = None
    try:
        directory_fd = os.open(root_path, directory_flags)
        for component in relative.parts[:-1]:
            next_fd = os.open(component, directory_flags, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = next_fd
        fd = os.open(relative.parts[-1], file_flags, dir_fd=directory_fd)
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError("intake and recipe paths must be regular local files")
            value = json.load(stream, object_pairs_hook=_reject_duplicate_keys)
    except FileNotFoundError as exc:
        raise ValueError("required local record file is absent") from exc
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            raise ValueError("intake and recipe paths must not contain symbolic links or non-directory components") from exc
        raise ValueError("intake or recipe file cannot be read") from exc
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("intake or recipe file is unreadable or invalid JSON") from exc
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
    if not isinstance(value, dict):
        raise ValueError("intake or recipe root must be a JSON object")
    return value


def bind_student_intake(record: object, recipe: object) -> dict[str, Any]:
    """Compare a supplied intake with exact selected recipe and artifact pins.

    The report is evidence only. Pending review or missing permissions always
    block, even when identities and digests match.
    """
    blockers: list[str] = []
    if not isinstance(recipe, dict):
        return _report(["Selected recipe is invalid."])
    try:
        validated_recipe = LoraSftRecipe.model_validate(recipe)
    except Exception:
        return _report(["Selected recipe is invalid or does not match the owner-selected candidate."])
    recipe = validated_recipe.model_dump(mode="json")
    base = recipe.get("base_model")
    if not isinstance(base, dict):
        return _report(["Selected recipe base-model pins are missing."])
    for field, label in (("weights_sha256", "Exact model-weight digest"),
                         ("tokenizer_sha256", "Exact tokenizer digest")):
        if not isinstance(base.get(field), str) or len(base[field]) != 64:
            blockers.append(f"{label} is missing from the selected recipe.")

    try:
        validate_model_intake(record)
    except ModelIntakeError as exc:
        return _report(blockers + [f"Student-base intake is invalid: {exc}."])
    assert isinstance(record, dict)

    if record.get("student_base") is not True:
        blockers.append("Intake record is not explicitly assigned the student_base role.")
    if record.get("model_id") != base.get("model_id"):
        blockers.append("Intake model id does not match the selected recipe.")
    model_revision = record.get("model_revision")
    if model_revision != base.get("revision"):
        blockers.append("Intake model revision does not match the selected recipe.")
    if record.get("model_sha256") != base.get("weights_sha256"):
        blockers.append("Intake model-weight digest does not match the selected recipe.")

    tokenizer = record.get("tokenizer", {})
    if tokenizer.get("id") != base.get("model_id"):
        blockers.append("Intake tokenizer id does not match the selected model.")
    if tokenizer.get("revision") != base.get("revision"):
        blockers.append("Intake tokenizer revision does not match the selected recipe.")
    if tokenizer.get("sha256") != base.get("tokenizer_sha256"):
        blockers.append("Intake tokenizer digest does not match the selected recipe.")

    binding = record.get("recipe_binding")
    expected_recipe_digest = hashlib.sha256(canonical_recipe_bytes(validated_recipe)).hexdigest()
    if not isinstance(binding, dict):
        blockers.append("Intake does not bind to the selected recipe identity and digest.")
    else:
        if binding.get("recipe_id") != recipe.get("recipe_id"):
            blockers.append("Intake recipe id does not match the selected recipe.")
        if binding.get("recipe_schema_version") != recipe.get("schema_version"):
            blockers.append("Intake recipe schema version does not match the selected recipe.")
        if binding.get("recipe_sha256") != expected_recipe_digest:
            blockers.append("Intake recipe digest does not match the selected recipe.")

    review = record.get("review", {})
    permissions = record.get("permissions", {})
    if review.get("status") != "approved":
        blockers.append("Student-base intake review is not approved.")
    if permissions.get("weights_use") != "approved":
        blockers.append("Student-base weight-use permission is not approved.")
    if permissions.get("weights_modification") != "approved":
        blockers.append("Student-base weight-modification permission is not approved.")

    return _report(blockers)


def inspect_student_intake_files(intake_path: str | Path,
                                 recipe_path: str | Path,
                                 *, guru_root: str | Path) -> dict[str, Any]:
    """Read local JSON files and return a fail-closed binding report."""
    try:
        record = _read_json(intake_path, guru_root)
    except ValueError as exc:
        return _report([f"Student-base intake is unavailable: {exc}."])
    try:
        recipe = _read_json(recipe_path, guru_root)
    except ValueError as exc:
        return _report([f"Selected recipe is unavailable: {exc}."])
    return bind_student_intake(record, recipe)


def _report(blockers: list[str]) -> dict[str, Any]:
    return {
        "schema": "guru-student-intake-binding-v1",
        "status": "blocked" if blockers else "matched",
        "blockers": blockers,
        "model_loading": False,
        "tokenizer_loading": False,
        "download_started": False,
        "training_started": False,
    }
