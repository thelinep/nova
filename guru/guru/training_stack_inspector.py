"""Non-launching checks for the selected student's pinned Python package stack.

This module reads the local lock and installed distribution metadata only. It
does not import model runtimes, inspect model/tokenizer files, access the
network, load weights, or authorize training. A matching stack is preparation
evidence, not selected-model or training qualification.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import platform
import re
from pathlib import Path
from typing import Mapping

from guru.lora_recipe import LoraSftRecipe, load_lora_recipe, verify_training_lock

_PIN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_.-]*)==([^\\\s;]+)(?:\s+\\)?$")
_PACKAGE_NAME = re.compile(r"[-_.]+")
_HASH = re.compile(r"^--hash=sha256:[0-9a-f]{64}(?:\s+\\)?$")


class TrainingStackInspectionError(ValueError):
    """The recipe's training-stack lock cannot be inspected safely."""


def _normalize_package_name(value: str) -> str:
    return _PACKAGE_NAME.sub("-", value).lower()


def _parse_locked_versions(lock_text: str) -> dict[str, str]:
    pins: dict[str, str] = {}
    for line in lock_text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or _HASH.fullmatch(stripped):
            continue
        match = _PIN.fullmatch(stripped)
        if not match:
            raise TrainingStackInspectionError("unsupported active line in training lock")
        name, version = match.groups()
        normalized = _normalize_package_name(name)
        if normalized in pins:
            raise TrainingStackInspectionError(f"duplicate package pin in training lock: {normalized}")
        pins[normalized] = version
    if not pins:
        raise TrainingStackInspectionError("training lock contains no exact package pins")
    return pins


def compare_training_stack(
    *,
    expected_python: str,
    actual_python: str,
    locked_versions: Mapping[str, str],
    installed_versions: Mapping[str, str | None],
) -> list[str]:
    """Return deterministic environment mismatches for a lock and interpreter."""
    mismatches: list[str] = []
    if actual_python != expected_python:
        mismatches.append(f"python: expected {expected_python}, found {actual_python}")
    for package, expected in sorted(locked_versions.items()):
        actual = installed_versions.get(package)
        if actual is None:
            mismatches.append(f"{package}: missing (lock requires {expected})")
        elif actual != expected:
            mismatches.append(f"{package}: expected {expected}, found {actual}")
    return mismatches


def inspect_training_stack(recipe: LoraSftRecipe, *, guru_root: str | Path) -> dict:
    """Compare the active interpreter and installed packages with the recipe lock.

    The result deliberately leaves selected-artifact and training qualification
    false even when every local runtime pin matches.
    """
    root = Path(guru_root)
    lock_path = root / recipe.training_stack.lockfile
    try:
        verify_training_lock(recipe, root)
        lock_bytes = lock_path.read_bytes()
        lock_text = lock_bytes.decode("utf-8")
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        return {
            "recipe_id": recipe.recipe_id,
            "training_stack_status": "blocked",
            "blockers": [f"training lock verification failed: {exc}"],
            "lock_sha256": None,
            "locked_package_count": 0,
            "mismatches": [],
            "selected_artifact_status": "not_inspected",
            "selected_model_compatibility": "unverified_without_exact_artifacts",
            "model_weights_loaded": False,
            "tokenizer_loaded": False,
            "training_started": False,
            "approval_status": "pending_review",
        }

    try:
        locked = _parse_locked_versions(lock_text)
    except TrainingStackInspectionError as exc:
        return {
            "recipe_id": recipe.recipe_id,
            "training_stack_status": "blocked",
            "blockers": [str(exc)],
            "lock_sha256": hashlib.sha256(lock_bytes).hexdigest(),
            "locked_package_count": 0,
            "mismatches": [],
            "selected_artifact_status": "not_inspected",
            "selected_model_compatibility": "unverified_without_exact_artifacts",
            "model_weights_loaded": False,
            "tokenizer_loaded": False,
            "training_started": False,
            "approval_status": "pending_review",
        }

    installed: dict[str, str | None] = {}
    for package in locked:
        try:
            installed[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            installed[package] = None

    mismatches = compare_training_stack(
        expected_python=recipe.training_stack.python,
        actual_python=platform.python_version(),
        locked_versions=locked,
        installed_versions=installed,
    )
    return {
        "recipe_id": recipe.recipe_id,
        "training_stack_status": "metadata_match" if not mismatches else "blocked",
        "blockers": mismatches,
        "lock_sha256": hashlib.sha256(lock_bytes).hexdigest(),
        "locked_package_count": len(locked),
        "mismatches": mismatches,
        "selected_artifact_status": "not_inspected",
        "selected_model_compatibility": "unverified_without_exact_artifacts",
        "model_weights_loaded": False,
        "tokenizer_loaded": False,
        "training_started": False,
        "approval_status": "pending_review",
    }


def inspect_training_stack_from_recipe_file(
    recipe_path: str | Path,
    *,
    guru_root: str | Path,
) -> dict:
    """Load the fixed local recipe and return a structured fail-closed report."""
    try:
        recipe = load_lora_recipe(recipe_path)
    except (OSError, ValueError) as exc:
        return {
            "recipe_id": None,
            "training_stack_status": "blocked",
            "blockers": [f"recipe verification failed: {exc}"],
            "lock_sha256": None,
            "locked_package_count": 0,
            "mismatches": [],
            "selected_artifact_status": "not_inspected",
            "selected_model_compatibility": "unverified_without_exact_artifacts",
            "model_weights_loaded": False,
            "tokenizer_loaded": False,
            "training_started": False,
            "approval_status": "pending_review",
        }
    return inspect_training_stack(recipe, guru_root=guru_root)


def render_json_report(report: dict) -> str:
    """Render a deterministic CLI-ready report."""
    return json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2)
