"""Metadata-only artifact-tree inventory and pinning tests."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest

import guru.model_artifact_inspector as inspector
from guru.model_artifact_inspector import (
    ArtifactInspectionError,
    inspect_recipe_artifacts,
    inspect_artifact_tree,
)
from guru.lora_recipe import LoraSftRecipe, load_lora_recipe

RECIPE_PATH = Path(__file__).parents[1] / "experiments" / "recipes" / "qwen25_coder_15b_lora_sft.v1.json"


def _inventory_pin(files: dict[str, bytes]) -> str:
    entries = [
        {"path": name, "size_bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        for name, content in sorted(files.items())
    ]
    canonical = json.dumps(
        entries, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _write_tree(root, files: dict[str, bytes]) -> None:
    for name, content in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)


def test_inventory_is_stable_and_reports_pending_metadata(tmp_path):
    payload = {"config.json": b'{"model_type":"qwen2"}', "model.safetensors": b"synthetic weights"}
    root = tmp_path / "model"
    root.mkdir()
    _write_tree(root, payload)

    first = inspect_artifact_tree(
        root, expected_files=payload, expected_inventory_sha256=_inventory_pin(payload)
    )
    second = inspect_artifact_tree(
        root, expected_files=reversed(tuple(payload)), expected_inventory_sha256=_inventory_pin(payload)
    )

    assert first == second
    assert first.as_dict()["approval_status"] == "pending_review"
    assert first.as_dict()["digest_semantics"].startswith("sha256(canonical-json")
    assert [item.path for item in first.files] == sorted(payload)


@pytest.mark.parametrize(
    "files,expected,message",
    [
        ({"config.json": b"config"}, ("config.json", "weights.safetensors"), "file set mismatch"),
        ({"config.json": b"config", "weights.safetensors": b"weights", "surprise": b"x"},
         ("config.json", "weights.safetensors"), "file set mismatch"),
    ],
)
def test_missing_or_unmanifested_files_fail_closed(tmp_path, files, expected, message):
    root = tmp_path / "model"
    root.mkdir()
    _write_tree(root, files)
    with pytest.raises(ArtifactInspectionError, match=message):
        inspect_artifact_tree(root, expected_files=expected, expected_inventory_sha256="0" * 64)


def test_changed_contents_fail_against_inventory_pin(tmp_path):
    files = {"weights.safetensors": b"approved bytes"}
    root = tmp_path / "model"
    root.mkdir()
    _write_tree(root, files)
    (root / "weights.safetensors").write_bytes(b"changed bytes")

    with pytest.raises(ArtifactInspectionError, match="inventory digest mismatch"):
        inspect_artifact_tree(
            root, expected_files=files, expected_inventory_sha256=_inventory_pin(files)
        )


def test_tree_mutation_between_hash_and_final_scan_is_rejected(tmp_path, monkeypatch):
    files = {"weights.safetensors": b"approved bytes"}
    root = tmp_path / "model"
    root.mkdir()
    _write_tree(root, files)
    hash_file = inspector._hash_regular_at

    def mutate_after_hash(root_fd, relative, expected):
        result = hash_file(root_fd, relative, expected)
        (root / "unexpected.bin").write_bytes(b"appeared during scan")
        return result

    monkeypatch.setattr(inspector, "_hash_regular_at", mutate_after_hash)
    with pytest.raises(ArtifactInspectionError, match="changed during inspection"):
        inspect_artifact_tree(
            root, expected_files=files, expected_inventory_sha256=_inventory_pin(files)
        )


def test_directory_symlink_swap_before_open_is_rejected(tmp_path, monkeypatch):
    files = {"sub/weights.safetensors": b"approved bytes"}
    root = tmp_path / "model"
    outside = tmp_path / "outside"
    _write_tree(root, files)
    outside.mkdir()
    (outside / "weights.safetensors").write_bytes(b"outside bytes")
    open_dir = inspector._open_dir_at
    swapped = False

    def swap_then_open(parent_fd, name, expected=None):
        nonlocal swapped
        if name == "sub" and not swapped:
            (root / "sub").rename(root / "sub-original")
            (root / "sub").symlink_to(outside, target_is_directory=True)
            swapped = True
        return open_dir(parent_fd, name, expected)

    monkeypatch.setattr(inspector, "_open_dir_at", swap_then_open)
    with pytest.raises(ArtifactInspectionError, match="symlink|replacement"):
        inspect_artifact_tree(
            root, expected_files=files, expected_inventory_sha256=_inventory_pin(files)
        )


def test_same_size_rewrite_with_mtime_restore_is_rejected(tmp_path, monkeypatch):
    files = {"weights.safetensors": b"approved bytes"}
    root = tmp_path / "model"
    root.mkdir()
    _write_tree(root, files)
    hash_file = inspector._hash_regular_at

    def rewrite_after_hash(root_fd, relative, expected):
        result = hash_file(root_fd, relative, expected)
        target = root / relative
        target.write_bytes(b"mutated! bytes")
        os.utime(target, ns=(expected.st_atime_ns, expected.st_mtime_ns))
        return result

    monkeypatch.setattr(inspector, "_hash_regular_at", rewrite_after_hash)
    with pytest.raises(ArtifactInspectionError, match="changed during inspection"):
        inspect_artifact_tree(
            root, expected_files=files, expected_inventory_sha256=_inventory_pin(files)
        )


def test_symlink_file_and_symlink_root_are_rejected(tmp_path):
    target = tmp_path / "outside"
    target.write_bytes(b"x")
    root = tmp_path / "model"
    root.mkdir()
    (root / "weights.safetensors").symlink_to(target)
    with pytest.raises(ArtifactInspectionError, match="symlink is not allowed"):
        inspect_artifact_tree(
            root, expected_files=("weights.safetensors",), expected_inventory_sha256="0" * 64
        )

    root_link = tmp_path / "model-link"
    root_link.symlink_to(root, target_is_directory=True)
    with pytest.raises(ArtifactInspectionError, match="real directory"):
        inspect_artifact_tree(
            root_link, expected_files=("weights.safetensors",), expected_inventory_sha256="0" * 64
        )


@pytest.mark.parametrize("path", ["../outside", "/absolute/file", "a\\b", "./file"])
def test_unsafe_expected_paths_are_rejected(tmp_path, path):
    root = tmp_path / "model"
    root.mkdir()
    with pytest.raises(ArtifactInspectionError, match="POSIX-relative|escape|canonical"):
        inspect_artifact_tree(root, expected_files=(path,), expected_inventory_sha256="0" * 64)


def test_null_or_malformed_pin_is_rejected_before_scanning(tmp_path):
    with pytest.raises(ArtifactInspectionError, match="non-null"):
        inspect_artifact_tree(tmp_path / "absent", expected_files=("x",), expected_inventory_sha256=None)
    with pytest.raises(ArtifactInspectionError, match="non-null"):
        inspect_artifact_tree(tmp_path / "absent", expected_files=("x",), expected_inventory_sha256="not-a-digest")


def test_unexpected_directory_structure_and_special_files_are_rejected(tmp_path):
    files = {"config.json": b"{}"}
    root = tmp_path / "model"
    _write_tree(root, files)
    (root / "empty").mkdir()
    with pytest.raises(ArtifactInspectionError, match="directory structure"):
        inspect_artifact_tree(
            root, expected_files=files, expected_inventory_sha256=_inventory_pin(files)
        )
    (root / "empty").rmdir()
    fifo = root / "pipe"
    os.mkfifo(fifo)
    with pytest.raises(ArtifactInspectionError, match="special file"):
        inspect_artifact_tree(
            root, expected_files=files, expected_inventory_sha256=_inventory_pin(files)
        )


def test_recipe_artifact_preflight_binds_local_trees_and_lock_without_approval(tmp_path):
    recipe = load_lora_recipe(RECIPE_PATH)
    model_files = {"config.json": b'{"model_type":"qwen2"}', "weights.safetensors": b"fixture weights"}
    tokenizer_files = {"tokenizer.json": b"fixture tokenizer", "vocab.json": b"fixture vocab"}
    model_root = tmp_path / "model"
    tokenizer_root = tmp_path / "tokenizer"
    model_root.mkdir()
    tokenizer_root.mkdir()
    _write_tree(model_root, model_files)
    _write_tree(tokenizer_root, tokenizer_files)

    payload = recipe.model_dump(mode="json")
    payload["base_model"]["weights_sha256"] = _inventory_pin(model_files)
    payload["base_model"]["tokenizer_sha256"] = _inventory_pin(tokenizer_files)
    pinned_recipe = LoraSftRecipe.model_validate(payload)
    report = inspect_recipe_artifacts(
        pinned_recipe,
        model_artifact_dir=model_root,
        tokenizer_artifact_dir=tokenizer_root,
        expected_model_files=model_files,
        expected_tokenizer_files=tokenizer_files,
        guru_root=RECIPE_PATH.parents[2],
    )

    assert report["model"]["inventory_sha256"] == _inventory_pin(model_files)
    assert report["tokenizer"]["inventory_sha256"] == _inventory_pin(tokenizer_files)
    assert report["training_lock"] == "verified"
    assert report["approval_status"] == "pending_review"
    assert report["training_status"] == "not_started"


def test_recipe_artifact_preflight_rejects_null_pins_before_artifact_access(tmp_path):
    recipe = load_lora_recipe(RECIPE_PATH)
    with pytest.raises(ArtifactInspectionError, match="pin both"):
        inspect_recipe_artifacts(
            recipe,
            model_artifact_dir=tmp_path / "not-present",
            tokenizer_artifact_dir=tmp_path / "not-present",
            expected_model_files=("weights.safetensors",),
            expected_tokenizer_files=("tokenizer.json",),
            guru_root=RECIPE_PATH.parents[2],
        )
