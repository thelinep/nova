"""Local-only, metadata-only inventory checks for pinned model artifacts.

No network client or model runtime is imported here. The SHA-256 value is a
Guru-defined digest of a canonical inventory, not a Hugging Face file or Git
LFS object digest. Callers must provide the exact expected file list for the
pinned snapshot; this module never discovers or downloads that list remotely.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from guru.lora_recipe import LoraSftRecipe, verify_training_lock

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ArtifactInspectionError(ValueError):
    """A local artifact tree is unsafe, incomplete, or not pinned exactly."""


@dataclass(frozen=True)
class ArtifactFile:
    path: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class ArtifactInventory:
    files: tuple[ArtifactFile, ...]
    inventory_sha256: str

    def as_dict(self) -> dict:
        return {
            "files": [
                {"path": item.path, "size_bytes": item.size_bytes, "sha256": item.sha256}
                for item in self.files
            ],
            "inventory_sha256": self.inventory_sha256,
            "digest_semantics": "sha256(canonical-json(sorted path,size_bytes,file_sha256))",
            "approval_status": "pending_review",
        }


def _safe_relative_path(value: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ArtifactInspectionError("expected artifact paths must be POSIX-relative paths")
    path = Path(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in value.split("/")):
        raise ArtifactInspectionError("expected artifact paths must not escape the artifact root")
    if path.as_posix() != value:
        raise ArtifactInspectionError("expected artifact path is not canonical")
    return value


def _expected_paths(values: Iterable[str]) -> tuple[str, ...]:
    try:
        paths = tuple(sorted(_safe_relative_path(value) for value in values))
    except TypeError as exc:
        raise ArtifactInspectionError("expected artifact file list is invalid") from exc
    if not paths or len(paths) != len(set(paths)):
        raise ArtifactInspectionError("expected artifact file list must be non-empty and unique")
    return paths


def _signature(info: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (
        info.st_dev, info.st_ino, info.st_mode, info.st_size,
        info.st_mtime_ns, info.st_ctime_ns,
    )


def _open_dir_at(parent_fd: int, name: str, expected: os.stat_result | None = None) -> int:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        child_fd = os.open(name, flags, dir_fd=parent_fd)
        actual = os.fstat(child_fd)
        if not stat.S_ISDIR(actual.st_mode) or (expected is not None and _signature(actual) != _signature(expected)):
            os.close(child_fd)
            raise ArtifactInspectionError("artifact tree changed during inspection")
        return child_fd
    except ArtifactInspectionError:
        raise
    except OSError as exc:
        raise ArtifactInspectionError("symlink or directory replacement detected during inspection") from exc


def _hash_regular_at(root_fd: int, relative: str, expected: os.stat_result) -> tuple[int, str]:
    parts = relative.split("/")
    directory_fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            child_fd = _open_dir_at(directory_fd, part)
            os.close(directory_fd)
            directory_fd = child_fd
        try:
            file_fd = os.open(
                parts[-1], os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=directory_fd
            )
        except OSError as exc:
            raise ArtifactInspectionError(f"{relative} is unreadable or is a symlink") from exc
        with os.fdopen(file_fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or _signature(before) != _signature(expected):
                raise ArtifactInspectionError(f"{relative} changed during inspection")
            digest = hashlib.sha256()
            size = 0
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                digest.update(chunk)
            after = os.fstat(stream.fileno())
        try:
            after_path = os.stat(parts[-1], dir_fd=directory_fd, follow_symlinks=False)
        except OSError as exc:
            raise ArtifactInspectionError(f"{relative} changed during inspection") from exc
        if _signature(after) != _signature(expected) or _signature(after_path) != _signature(expected) or size != expected.st_size:
            raise ArtifactInspectionError(f"{relative} changed during inspection")
        return size, digest.hexdigest()
    finally:
        os.close(directory_fd)


def inspect_artifact_tree(
    root: str | Path,
    *,
    expected_files: Iterable[str],
    expected_inventory_sha256: str,
) -> ArtifactInventory:
    """Inventory and compare a local tree against caller-supplied file paths and pin.

    This function follows no symlinks, accepts only regular files/directories,
    rejects missing or additional files/directories, and checks for file changes
    during reads. The root must already exist and must not itself be a symlink.
    """
    if not isinstance(expected_inventory_sha256, str) or not _SHA256.fullmatch(expected_inventory_sha256):
        raise ArtifactInspectionError("a non-null lowercase SHA-256 inventory pin is required")
    expected = _expected_paths(expected_files)
    root_path = Path(root).absolute()
    try:
        root_stat = root_path.lstat()
    except OSError as exc:
        raise ArtifactInspectionError("artifact root is unavailable") from exc
    if not stat.S_ISDIR(root_stat.st_mode):
        raise ArtifactInspectionError("artifact root must be a real directory, not a symlink")

    try:
        root_fd = os.open(
            root_path,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
        )
    except OSError as exc:
        raise ArtifactInspectionError("artifact root must be a real directory, not a symlink") from exc
    if _signature(os.fstat(root_fd)) != _signature(root_stat):
        os.close(root_fd)
        raise ArtifactInspectionError("artifact root changed during inspection")

    found_files: list[str] = []
    found_dirs: list[str] = []
    snapshot: dict[str, os.stat_result] = {}

    def walk(directory_fd: int, prefix: str = "") -> None:
        try:
            entries = sorted(os.listdir(directory_fd))
        except OSError as exc:
            raise ArtifactInspectionError("artifact directory is unreadable") from exc
        for name in entries:
            relative = f"{prefix}/{name}" if prefix else name
            _safe_relative_path(relative)
            try:
                info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            except OSError as exc:
                raise ArtifactInspectionError("artifact entry is unreadable") from exc
            if stat.S_ISLNK(info.st_mode):
                raise ArtifactInspectionError(f"symlink is not allowed in artifact tree: {relative}")
            snapshot[relative] = info
            if stat.S_ISDIR(info.st_mode):
                found_dirs.append(relative)
                child_fd = _open_dir_at(directory_fd, name, info)
                try:
                    walk(child_fd, relative)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(info.st_mode):
                found_files.append(relative)
            else:
                raise ArtifactInspectionError(f"special file is not allowed in artifact tree: {relative}")

    try:
        walk(root_fd)
        actual = tuple(sorted(found_files))
        if actual != expected:
            missing = sorted(set(expected) - set(actual))
            extra = sorted(set(actual) - set(expected))
            raise ArtifactInspectionError(f"artifact file set mismatch (missing={missing}, extra={extra})")
        expected_dirs = sorted({"/".join(path.split("/")[:index]) for path in expected for index in range(1, len(path.split("/")))})
        if sorted(found_dirs) != expected_dirs:
            raise ArtifactInspectionError("artifact directory structure does not match expected files")

        first_snapshot = snapshot.copy()
        files = []
        for relative in actual:
            size, file_digest = _hash_regular_at(root_fd, relative, first_snapshot[relative])
            files.append(ArtifactFile(relative, size, file_digest))

        # Re-enumerate through the pinned root descriptor to catch replacement,
        # additions/removals and concurrent changes without following path links.
        found_files.clear()
        found_dirs.clear()
        snapshot.clear()
        walk(root_fd)
        if (
            tuple(sorted(found_files)) != expected
            or sorted(found_dirs) != expected_dirs
            or any(_signature(snapshot[path]) != _signature(first_snapshot[path]) for path in first_snapshot)
            or _signature(os.fstat(root_fd)) != _signature(root_stat)
            or _signature(root_path.lstat()) != _signature(root_stat)
        ):
            raise ArtifactInspectionError("artifact tree changed during inspection")
    finally:
        os.close(root_fd)

    canonical = json.dumps(
        [{"path": item.path, "size_bytes": item.size_bytes, "sha256": item.sha256} for item in files],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    inventory_digest = hashlib.sha256(canonical).hexdigest()
    if inventory_digest != expected_inventory_sha256:
        raise ArtifactInspectionError("artifact inventory digest mismatch")
    return ArtifactInventory(tuple(files), inventory_digest)


def inspect_recipe_artifacts(
    recipe: LoraSftRecipe,
    *,
    model_artifact_dir: str | Path,
    tokenizer_artifact_dir: str | Path,
    expected_model_files: Iterable[str],
    expected_tokenizer_files: Iterable[str],
    guru_root: str | Path,
) -> dict:
    """Verify recipe pins and lock bytes, returning pending-review evidence only.

    This is intentionally not wired to the training engine: the current recipe
    is non-launchable. The returned metadata cannot approve intake, permissions,
    compute, or a training run.
    """
    if recipe.base_model.weights_sha256 is None or recipe.base_model.tokenizer_sha256 is None:
        raise ArtifactInspectionError("recipe must pin both model and tokenizer inventory digests")
    try:
        verify_training_lock(recipe, guru_root)
    except ValueError as exc:
        raise ArtifactInspectionError(f"training lock verification failed: {exc}") from exc
    model = inspect_artifact_tree(
        model_artifact_dir,
        expected_files=expected_model_files,
        expected_inventory_sha256=recipe.base_model.weights_sha256,
    )
    tokenizer = inspect_artifact_tree(
        tokenizer_artifact_dir,
        expected_files=expected_tokenizer_files,
        expected_inventory_sha256=recipe.base_model.tokenizer_sha256,
    )
    return {
        "recipe_id": recipe.recipe_id,
        "model_id": recipe.base_model.model_id,
        "revision": recipe.base_model.revision,
        "model": model.as_dict(),
        "tokenizer": tokenizer.as_dict(),
        "training_lock": "verified",
        "approval_status": "pending_review",
        "training_status": "not_started",
    }
