"""Fail-closed disk lifecycle for a future local QEMU evaluator worker.

Only the base-image identity and run-local disk preparation/cleanup are
implemented here. VM launch remains intentionally unavailable until a
hardened, fixed guest runner and independently reviewed boot profile exist.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import uuid
import fcntl
from typing import Callable, Sequence


GIB = 1024 ** 3
MIB = 1024 ** 2
MAX_VIRTUAL_DISK_BYTES = 8 * GIB
MAX_OVERLAY_FILE_BYTES = 8 * GIB
OUTPUT_DISK_BYTES = 16 * MIB
MIN_FREE_BYTES = 10 * GIB
RUN_ID_RE = re.compile(r"^[0-9a-f]{32}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
RECEIPT_NAME = "lifecycle-receipt.json"
LOCK_NAME = ".controller.lock"


class VmControllerError(RuntimeError):
    """A precondition or lifecycle operation failed closed."""


@dataclass(frozen=True)
class VmConfig:
    base_image: Path
    base_image_sha256: str
    run_root: Path
    qemu_img: Path
    minimum_free_bytes: int = MIN_FREE_BYTES
    maximum_virtual_disk_bytes: int = MAX_VIRTUAL_DISK_BYTES
    maximum_overlay_file_bytes: int = MAX_OVERLAY_FILE_BYTES
    output_disk_bytes: int = OUTPUT_DISK_BYTES


CommandRunner = Callable[[Sequence[str]], subprocess.CompletedProcess[str]]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _run(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, capture_output=True, text=True, timeout=30)


def _run_root(config: VmConfig) -> Path:
    root = config.run_root.expanduser().absolute()
    if root.is_symlink():
        raise VmControllerError("run_root_must_not_be_symlink")
    if not root.parent.is_dir():
        raise VmControllerError("run_root_parent_must_exist")
    root.mkdir(mode=0o700, exist_ok=True)
    root = root.resolve(strict=True)
    root_stat = root.stat()
    if root_stat.st_uid != os.getuid():
        raise VmControllerError("run_root_not_owned_by_current_user")
    if root_stat.st_mode & 0o077:
        raise VmControllerError("run_root_permissions_must_be_private")
    return root


def _validated_tool(path: Path) -> Path:
    tool = path.expanduser().absolute()
    if tool.is_symlink() or not tool.is_file() or not os.access(tool, os.X_OK):
        raise VmControllerError("qemu_img_tool_unavailable_or_untrusted_path")
    return tool.resolve(strict=True)


def _validated_base(config: VmConfig) -> tuple[Path, str]:
    base = config.base_image.expanduser().absolute()
    if base.is_symlink() or not base.is_file():
        raise VmControllerError("base_image_unavailable_or_symlink")
    actual_digest = _sha256(base)
    if not SHA256_RE.fullmatch(config.base_image_sha256) or actual_digest != config.base_image_sha256:
        raise VmControllerError("base_image_digest_mismatch")
    return base.resolve(strict=True), actual_digest


def _append_event(receipt: dict, event: str, details: dict) -> None:
    previous = receipt["events"][-1]["event_digest"] if receipt["events"] else "0" * 64
    record = {
        "sequence": len(receipt["events"]),
        "event": event,
        "at": datetime.now(timezone.utc).isoformat(),
        "previous_event_digest": previous,
        "details": details,
    }
    record["event_digest"] = hashlib.sha256(_canonical_json(record)).hexdigest()
    receipt["events"].append(record)


def _write_receipt(run_dir: Path, receipt: dict) -> str:
    payload = dict(receipt)
    payload.pop("receipt_digest", None)
    receipt_digest = hashlib.sha256(_canonical_json(payload)).hexdigest()
    payload["receipt_digest"] = receipt_digest
    target = run_dir / RECEIPT_NAME
    temporary = run_dir / f".{RECEIPT_NAME}.{uuid.uuid4().hex}.tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(_canonical_json(payload) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return receipt_digest


def prepare_run(
    config: VmConfig,
    *,
    run_id: str | None = None,
    command_runner: CommandRunner = _run,
) -> dict:
    """Verify a pinned qcow2 base and prepare bounded, run-local disk images.

    This operation never starts QEMU. The caller must provide the independently
    recorded base-image digest. A physical file-size resource limit for the
    future QEMU process is recorded but is not applied until VM launch exists.
    """
    selected_id = run_id or uuid.uuid4().hex
    if not RUN_ID_RE.fullmatch(selected_id):
        raise VmControllerError("invalid_run_id")
    if (config.minimum_free_bytes < MIN_FREE_BYTES
            or config.maximum_virtual_disk_bytes <= 0
            or config.maximum_overlay_file_bytes <= 0):
        raise VmControllerError("invalid_disk_policy")
    if config.maximum_virtual_disk_bytes > MAX_VIRTUAL_DISK_BYTES:
        raise VmControllerError("virtual_disk_limit_exceeds_policy")
    if config.maximum_overlay_file_bytes > MAX_OVERLAY_FILE_BYTES:
        raise VmControllerError("overlay_file_limit_exceeds_policy")
    if config.output_disk_bytes != OUTPUT_DISK_BYTES:
        raise VmControllerError("output_disk_size_is_fixed")

    root = _run_root(config)
    with _RunRootLock(root):
        return _prepare_in_root(config, root, selected_id, command_runner)


def _prepare_in_root(config: VmConfig, root: Path, selected_id: str, command_runner: CommandRunner) -> dict:
    if shutil.disk_usage(root).free < config.minimum_free_bytes:
        raise VmControllerError("insufficient_free_disk_space")
    base, base_digest = _validated_base(config)
    qemu_img = _validated_tool(config.qemu_img)
    run_dir = root / selected_id
    if run_dir.exists() or run_dir.is_symlink():
        raise VmControllerError("run_directory_already_exists")
    run_dir.mkdir(mode=0o700)
    os.chmod(run_dir, 0o700)

    profile = {
        "architecture": "aarch64",
        "machine": "virt",
        "vcpu_limit": 2,
        "memory_bytes": 4 * GIB,
        "network_devices": 0,
        "shared_folders": 0,
        "default_devices": False,
        "base_image_sha256": base_digest,
        "maximum_virtual_disk_bytes": config.maximum_virtual_disk_bytes,
        "maximum_overlay_file_bytes": config.maximum_overlay_file_bytes,
        "output_disk_bytes": config.output_disk_bytes,
    }
    reset_policy = {
        "fresh_overlay_per_run": True,
        "delete_overlay_after_run": True,
        "reap_interrupted_runs_on_start": True,
        "base_image_read_only": True,
    }
    receipt = {
        "schema_version": "guru-evaluator-vm-lifecycle-v1",
        "run_id": selected_id,
        "state": "preparing",
        "base_image_sha256": base_digest,
        "worker_profile_digest": hashlib.sha256(_canonical_json(profile)).hexdigest(),
        "reset_policy_digest": hashlib.sha256(_canonical_json(reset_policy)).hexdigest(),
        "profile": profile,
        "reset_policy": reset_policy,
        "policy": {
            "minimum_free_bytes": config.minimum_free_bytes,
            "maximum_virtual_disk_bytes": config.maximum_virtual_disk_bytes,
            "maximum_overlay_file_bytes": config.maximum_overlay_file_bytes,
            "output_disk_bytes": config.output_disk_bytes,
            "vcpu_limit": 2,
            "memory_bytes": 4 * GIB,
            "network_devices": 0,
            "shared_folders": 0,
        },
        "events": [],
    }
    _append_event(receipt, "run_directory_created", {"mode": "0700"})
    _write_receipt(run_dir, receipt)

    try:
        info_result = command_runner([str(qemu_img), "info", "--output=json", str(base)])
        info = json.loads(info_result.stdout)
        if info.get("format") != "qcow2":
            raise VmControllerError("base_image_must_be_qcow2")
        virtual_size = info.get("virtual-size")
        if not isinstance(virtual_size, int) or not (0 < virtual_size <= config.maximum_virtual_disk_bytes):
            raise VmControllerError("base_virtual_disk_exceeds_policy")
        base_size = base.stat().st_size
        if base_size > config.maximum_overlay_file_bytes:
            raise VmControllerError("base_image_file_exceeds_policy")

        overlay = run_dir / "overlay.qcow2"
        output_disk = run_dir / "output.raw"
        command_runner([
            str(qemu_img), "create", "-f", "qcow2", "-F", "qcow2",
            "-b", str(base), str(overlay),
        ])
        command_runner([
            str(qemu_img), "create", "-f", "raw", str(output_disk),
            str(config.output_disk_bytes),
        ])
        if not overlay.is_file() or not output_disk.is_file():
            raise VmControllerError("qemu_img_did_not_create_expected_disks")
        if output_disk.stat().st_size != config.output_disk_bytes:
            raise VmControllerError("output_disk_size_mismatch")

        receipt["state"] = "prepared_not_booted"
        _append_event(receipt, "base_verified", {
            "sha256": base_digest,
            "format": "qcow2",
            "virtual_size_bytes": virtual_size,
        })
        _append_event(receipt, "overlay_created", {
            "sha256": _sha256(overlay),
            "virtual_size_bytes": virtual_size,
            "base_read_only_by_policy": True,
        })
        _append_event(receipt, "output_disk_created", {
            "sha256": _sha256(output_disk),
            "size_bytes": output_disk.stat().st_size,
        })
        _write_receipt(run_dir, receipt)
        return {"run_id": selected_id, "run_dir": run_dir, "state": receipt["state"]}
    except Exception as error:
        receipt["state"] = "preparation_failed"
        _append_event(receipt, "preparation_failed", {"error_type": type(error).__name__})
        _write_receipt(run_dir, receipt)
        raise


class _RunRootLock:
    """Exclusive, non-blocking lock on the managed run root.

    Prevents a second controller from preparing, destroying or recovering runs
    while another controller owns the root (for example, recovery deleting the
    disks of a run that is still in use). The lock file is never deleted.
    """

    def __init__(self, root: Path):
        self.path = root / LOCK_NAME
        self.fd: int | None = None

    def __enter__(self) -> "_RunRootLock":
        if self.path.is_symlink():
            raise VmControllerError("run_root_lock_must_not_be_symlink")
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise VmControllerError("run_root_locked_by_another_controller") from None
        self.fd = fd
        return self

    def __exit__(self, *_exc) -> None:
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None


def _managed_root(run_root: Path) -> Path:
    root = run_root.expanduser().absolute()
    if root.is_symlink() or not root.is_dir():
        raise VmControllerError("managed_run_root_unavailable_or_symlink")
    root = root.resolve(strict=True)
    if root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise VmControllerError("managed_run_root_permissions_invalid")
    return root


def _verified_lifecycle_receipt(run_dir: Path, run_id: str) -> tuple[dict, str]:
    """Return a lifecycle receipt whose self-digest verifies, or raise."""
    receipt_path = run_dir / RECEIPT_NAME
    if not receipt_path.is_file() or receipt_path.is_symlink():
        raise VmControllerError("lifecycle_receipt_missing")
    try:
        receipt = json.loads(receipt_path.read_text("utf-8"))
    except (OSError, ValueError):
        raise VmControllerError("lifecycle_receipt_unreadable") from None
    if not isinstance(receipt, dict) or receipt.get("run_id") != run_id:
        raise VmControllerError("lifecycle_receipt_run_id_mismatch")
    previous_digest = receipt.get("receipt_digest")
    if not isinstance(previous_digest, str) or not SHA256_RE.fullmatch(previous_digest):
        raise VmControllerError("lifecycle_receipt_digest_missing")
    receipt.pop("receipt_digest", None)
    if hashlib.sha256(_canonical_json(receipt)).hexdigest() != previous_digest:
        raise VmControllerError("lifecycle_receipt_digest_mismatch")
    return receipt, previous_digest


def _receipt_dir(root: Path) -> Path:
    receipt_dir = root / "receipts"
    if receipt_dir.is_symlink():
        raise VmControllerError("receipt_directory_must_not_be_symlink")
    receipt_dir.mkdir(mode=0o700, exist_ok=True)
    receipt_stat = receipt_dir.stat()
    if receipt_stat.st_uid != os.getuid():
        raise VmControllerError("receipt_directory_not_owned_by_current_user")
    if receipt_stat.st_mode & 0o077:
        raise VmControllerError("receipt_directory_permissions_must_be_private")
    return receipt_dir


def _write_private_json(target: Path, payload: dict) -> None:
    temporary = target.parent / f".{target.name}.{uuid.uuid4().hex}.tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(_canonical_json(payload) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _destroy_locked(root: Path, run_id: str, *, receipt_status: str, lifecycle: dict | None,
                    previous_digest: str | None, origin: str) -> dict:
    """Write a pending intent record, delete the run, then the final receipt.

    The intent record survives a crash during or right after deletion, so the
    destruction can still be evidenced and completed by recovery.
    """
    receipt_dir = _receipt_dir(root)
    final_path = receipt_dir / f"{run_id}.json"
    pending_path = receipt_dir / f"{run_id}.pending.json"
    if final_path.exists() or final_path.is_symlink():
        raise VmControllerError("destruction_receipt_already_exists")
    run_dir = root / run_id
    intent = {
        "schema_version": "guru-evaluator-vm-destruction-intent-v1",
        "run_id": run_id,
        "origin": origin,
        "receipt_status": receipt_status,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "worker_profile_digest": (lifecycle or {}).get("worker_profile_digest"),
        "reset_policy_digest": (lifecycle or {}).get("reset_policy_digest"),
        "previous_lifecycle_receipt_digest": previous_digest,
    }
    _write_private_json(pending_path, intent)
    if run_dir.is_symlink() or (run_dir.exists() and not run_dir.is_dir()):
        run_dir.unlink()  # removes the entry itself; never follows a link
    elif run_dir.exists():
        shutil.rmtree(run_dir)
    return _finalize_destruction(receipt_dir, intent, completed_by_recovery=False)


def _finalize_destruction(receipt_dir: Path, intent: dict, *, completed_by_recovery: bool) -> dict:
    run_id = intent["run_id"]
    run_dir = receipt_dir.parent / run_id
    destroyed = not (run_dir.exists() or run_dir.is_symlink())
    record = {
        "schema_version": "guru-evaluator-vm-destruction-receipt-v1",
        "run_id": run_id,
        "destroyed": destroyed,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "worker_profile_digest": intent.get("worker_profile_digest"),
        "reset_policy_digest": intent.get("reset_policy_digest"),
        "previous_lifecycle_receipt_digest": intent.get("previous_lifecycle_receipt_digest"),
        "artifacts_removed": destroyed,
        "receipt_status": intent.get("receipt_status", "verified"),
        "origin": intent.get("origin", "explicit"),
        "completed_by_recovery": completed_by_recovery,
        "intent_digest": hashlib.sha256(_canonical_json(intent)).hexdigest(),
    }
    payload = dict(record)
    payload["destruction_receipt_digest"] = hashlib.sha256(_canonical_json(record)).hexdigest()
    final_path = receipt_dir / f"{run_id}.json"
    if final_path.exists() or final_path.is_symlink():
        raise VmControllerError("destruction_receipt_already_exists")
    _write_private_json(final_path, payload)
    try:
        (receipt_dir / f"{run_id}.pending.json").unlink()
    except FileNotFoundError:
        pass
    if not destroyed:
        raise VmControllerError("run_artifacts_still_present_after_destroy")
    return payload


def destroy_run(run_root: Path, run_id: str) -> dict:
    """Delete only one UUID-named direct child of the private managed run root.

    An explicit destroy requires an intact lifecycle receipt and leaves the run
    untouched if it is missing or tampered. Startup recovery (recover_runs) is
    the path that reaps such damaged runs and records why.
    """
    if not RUN_ID_RE.fullmatch(run_id):
        raise VmControllerError("invalid_run_id")
    root = _managed_root(run_root)
    with _RunRootLock(root):
        run_dir = root / run_id
        if run_dir.is_symlink() or not run_dir.is_dir() or run_dir.resolve(strict=True).parent != root:
            raise VmControllerError("managed_run_directory_invalid")
        lifecycle, previous_digest = _verified_lifecycle_receipt(run_dir, run_id)
        return _destroy_locked(root, run_id, receipt_status="verified", lifecycle=lifecycle,
                               previous_digest=previous_digest, origin="explicit")


def recover_runs(run_root: Path) -> list[dict]:
    """Reap every UUID-named run left by an interrupted controller.

    Each run is destroyed even when its lifecycle receipt is missing, unreadable
    or tampered (for example after a crash mid-preparation or mid-deletion);
    the destruction receipt records which. One damaged run never stops the
    others from being reaped. Interrupted destructions whose intent record
    survived are completed. Entries not named like a run are left alone.
    """
    root = run_root.expanduser().absolute()
    if root.is_symlink() or not root.is_dir():
        return []
    root = _managed_root(root)
    recovered = []
    with _RunRootLock(root):
        receipt_dir = _receipt_dir(root)
        for pending in sorted(receipt_dir.glob("*.pending.json")):
            run_id = pending.name[: -len(".pending.json")]
            if not RUN_ID_RE.fullmatch(run_id) or pending.is_symlink():
                continue
            final_path = receipt_dir / f"{run_id}.json"
            if final_path.exists():
                pending.unlink()
                continue
            if (root / run_id).exists() or (root / run_id).is_symlink():
                continue  # still present: reaped below with a fresh intent
            try:
                intent = json.loads(pending.read_text("utf-8"))
            except (OSError, ValueError):
                intent = {"run_id": run_id, "receipt_status": "intent_unreadable", "origin": "recovery"}
            intent = {**intent, "run_id": run_id}
            recovered.append(_finalize_destruction(receipt_dir, intent, completed_by_recovery=True))
        for entry in sorted(root.iterdir(), key=lambda item: item.name):
            if not RUN_ID_RE.fullmatch(entry.name):
                continue
            pending = receipt_dir / f"{entry.name}.pending.json"
            if pending.exists():
                pending.unlink()  # superseded by the intent written below
            lifecycle = previous_digest = None
            if entry.is_symlink() or not entry.is_dir():
                status = "unsafe_entry_not_a_directory"
            else:
                try:
                    lifecycle, previous_digest = _verified_lifecycle_receipt(entry, entry.name)
                    status = "verified"
                except VmControllerError as error:
                    status = str(error)
            final_path = receipt_dir / f"{entry.name}.json"
            if final_path.exists():
                # A receipt exists but the run reappeared: keep the original
                # receipt and record this second removal under a suffixed name.
                final_path.rename(receipt_dir / f"{entry.name}.{uuid.uuid4().hex}.superseded.json")
            recovered.append(_destroy_locked(root, entry.name, receipt_status=status, lifecycle=lifecycle,
                                             previous_digest=previous_digest, origin="recovery"))
    return recovered
