"""Non-launching exact Python/package-stack preflight tests."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from guru.lora_recipe import load_lora_recipe
import guru.training_stack_inspector as inspector
from guru.training_stack_inspector import (
    TrainingStackInspectionError,
    _parse_locked_versions,
    compare_training_stack,
    inspect_training_stack,
    inspect_training_stack_from_recipe_file,
)


GURU_ROOT = Path(__file__).parents[1]
RECIPE_PATH = GURU_ROOT / "experiments" / "recipes" / "qwen25_coder_15b_lora_sft.v1.json"


def test_parser_reads_exact_package_pins_and_normalizes_names():
    assert _parse_locked_versions(
        "Foo_Bar==1.2.3 \\\n# via fixture\nBaz==4.5"
    ) == {"foo-bar": "1.2.3", "baz": "4.5"}


@pytest.mark.parametrize("lock", [
    "# no pins\n", "foo==1.0\nFoo==2.0\n", "foo==1.0 unsupported\n",
])
def test_parser_rejects_empty_or_conflicting_locks(lock):
    with pytest.raises(TrainingStackInspectionError):
        _parse_locked_versions(lock)


def test_parser_rejects_unsupported_active_requirement_syntax():
    with pytest.raises(TrainingStackInspectionError, match="unsupported active line"):
        _parse_locked_versions('foo==1.2; python_version < "3.13"\n')


def test_stack_comparison_reports_python_version_drift_missing_and_changed_packages():
    assert compare_training_stack(
        expected_python="3.12.4",
        actual_python="3.12.1",
        locked_versions={"peft": "0.13.2", "torch": "2.4.1"},
        installed_versions={"peft": "0.13.1", "torch": None},
    ) == [
        "python: expected 3.12.4, found 3.12.1",
        "peft: expected 0.13.2, found 0.13.1",
        "torch: missing (lock requires 2.4.1)",
    ]


def test_exact_runtime_match_is_pending_model_artifact_review(monkeypatch):
    recipe = load_lora_recipe(RECIPE_PATH)
    locked = _parse_locked_versions((GURU_ROOT / recipe.training_stack.lockfile).read_text())
    monkeypatch.setattr(inspector.platform, "python_version", lambda: recipe.training_stack.python)
    monkeypatch.setattr(inspector.importlib.metadata, "version", lambda package: locked[package])

    report = inspect_training_stack(recipe, guru_root=GURU_ROOT)

    assert report["training_stack_status"] == "metadata_match"
    assert report["locked_package_count"] == len(locked)
    assert report["blockers"] == []
    assert report["selected_artifact_status"] == "not_inspected"
    assert report["selected_model_compatibility"] == "unverified_without_exact_artifacts"
    assert report["model_weights_loaded"] is False
    assert report["tokenizer_loaded"] is False
    assert report["training_started"] is False
    assert report["approval_status"] == "pending_review"


def test_actual_stack_drift_blocks_and_never_loads_artifacts(monkeypatch):
    recipe = load_lora_recipe(RECIPE_PATH)
    locked = _parse_locked_versions((GURU_ROOT / recipe.training_stack.lockfile).read_text())
    monkeypatch.setattr(inspector.platform, "python_version", lambda: "3.12.1")

    def version(package: str) -> str:
        if package == "peft":
            return "0.13.1"
        if package == "torch":
            raise inspector.importlib.metadata.PackageNotFoundError(package)
        return locked[package]

    monkeypatch.setattr(inspector.importlib.metadata, "version", version)
    report = inspect_training_stack(recipe, guru_root=GURU_ROOT)

    assert report["training_stack_status"] == "blocked"
    assert "python: expected 3.12.4, found 3.12.1" in report["blockers"]
    assert "peft: expected 0.13.2, found 0.13.1" in report["blockers"]
    assert "torch: missing (lock requires 2.4.1)" in report["blockers"]
    assert report["model_weights_loaded"] is False
    assert report["tokenizer_loaded"] is False
    assert report["training_started"] is False


def test_lock_digest_mismatch_fails_before_installed_package_inspection(monkeypatch):
    recipe = load_lora_recipe(RECIPE_PATH)
    monkeypatch.setattr(
        inspector, "verify_training_lock",
        lambda _recipe, _root: (_ for _ in ()).throw(ValueError("digest mismatch")),
    )
    monkeypatch.setattr(
        inspector.importlib.metadata, "version",
        lambda _package: pytest.fail("package metadata read before lock verification"),
    )

    report = inspect_training_stack(recipe, guru_root=GURU_ROOT)

    assert report["training_stack_status"] == "blocked"
    assert report["blockers"] == ["training lock verification failed: digest mismatch"]
    assert report["locked_package_count"] == 0
    assert report["model_weights_loaded"] is False
    assert report["training_started"] is False


def test_malformed_recipe_returns_structured_blocked_report(tmp_path):
    recipe_path = tmp_path / "recipe.json"
    recipe_path.write_text("{invalid", encoding="utf-8")

    report = inspect_training_stack_from_recipe_file(recipe_path, guru_root=GURU_ROOT)

    assert report["training_stack_status"] == "blocked"
    assert report["blockers"][0].startswith("recipe verification failed:")
    assert report["selected_artifact_status"] == "not_inspected"
    assert report["model_weights_loaded"] is False
    assert report["tokenizer_loaded"] is False
    assert report["training_started"] is False


def test_cli_emits_json_preflight_without_training():
    result = subprocess.run(
        [sys.executable, "-m", "guru", "trainer-stack-preflight"],
        cwd=GURU_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    report = json.loads(result.stdout)
    assert result.returncode == (0 if report["training_stack_status"] == "metadata_match" else 1)
    assert report["model_weights_loaded"] is False
    assert report["tokenizer_loaded"] is False
    assert report["training_started"] is False
    assert report["selected_model_compatibility"] == "unverified_without_exact_artifacts"
