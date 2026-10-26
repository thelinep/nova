"""Boot a prepared run's overlay once under fixed QEMU restrictions.

This is a *smoke boot* of a disposable run: it proves that a prepared overlay
boots with no network device, no shared folders, no QEMU default devices and
no monitor, under a host-enforced wall-clock limit, and that the QEMU process
is gone afterwards. It never passes candidate code, tasks, tests or corpus
data to the guest, and a smoke boot is not evaluator qualification.
"""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import time
from typing import Callable, Sequence

from .controller import (
    GIB,
    RUN_ID_RE,
    VmControllerError,
    _RunRootLock,
    _append_event,
    _managed_root,
    _sha256,
    _verified_lifecycle_receipt,
    _write_receipt,
)

DEFAULT_WALL_SECONDS = 15 * 60
MAX_WALL_SECONDS = 60 * 60
PopenFactory = Callable[..., subprocess.Popen]


def _trusted_file(path: Path, label: str) -> Path:
    candidate = path.expanduser().absolute()
    if candidate.is_symlink() or not candidate.is_file():
        raise VmControllerError(f"{label}_unavailable_or_symlink")
    return candidate.resolve(strict=True)


def qemu_command(qemu_system: Path, firmware: Path, overlay: Path, output_disk: Path, *, accel: str = "hvf") -> list[str]:
    """The only QEMU command line this module ever runs.

    -nodefaults drops every implicit device (NIC, USB, display, CD-ROM,
    monitor); -nic none states the absence of networking explicitly; there are
    no -virtfs/-fsdev/-device virtio-9p shares; the serial console is the
    caller's terminal and the QEMU monitor is disabled.
    """
    if accel not in {"hvf", "tcg"}:
        raise VmControllerError("unsupported_accelerator")
    return [
        str(qemu_system),
        "-machine", "virt",
        "-accel", accel,
        "-cpu", "host" if accel == "hvf" else "max",
        "-smp", "2",
        "-m", str(4 * GIB // (1024 * 1024)),
        "-nodefaults",
        "-nic", "none",
        "-display", "none",
        "-monitor", "none",
        "-serial", "stdio",
        "-bios", str(firmware),
        "-drive", f"if=none,id=root,file={overlay},format=qcow2",
        "-device", "virtio-blk-pci,drive=root",
        "-drive", f"if=none,id=out,file={output_disk},format=raw",
        "-device", "virtio-blk-pci,drive=out",
    ]


def smoke_boot(
    run_root: Path,
    run_id: str,
    *,
    base_image_sha256: str,
    qemu_system: Path,
    firmware: Path,
    wall_seconds: int = DEFAULT_WALL_SECONDS,
    accel: str = "hvf",
    popen: PopenFactory = subprocess.Popen,
) -> dict:
    """Boot the run's overlay once, holding the run-root lock throughout."""
    if not RUN_ID_RE.fullmatch(run_id):
        raise VmControllerError("invalid_run_id")
    if not (0 < int(wall_seconds) <= MAX_WALL_SECONDS):
        raise VmControllerError("wall_limit_outside_policy")
    root = _managed_root(run_root)
    qemu = _trusted_file(qemu_system, "qemu_system")
    bios = _trusted_file(firmware, "firmware")
    with _RunRootLock(root):
        run_dir = root / run_id
        if run_dir.is_symlink() or not run_dir.is_dir():
            raise VmControllerError("managed_run_directory_invalid")
        receipt, _ = _verified_lifecycle_receipt(run_dir, run_id)
        if receipt.get("state") != "prepared_not_booted":
            raise VmControllerError("run_not_in_prepared_state")
        if receipt.get("base_image_sha256") != base_image_sha256:
            raise VmControllerError("base_image_digest_mismatch")
        base = None
        for event in receipt.get("events", []):
            if event.get("event") == "base_verified":
                base = event.get("details", {})
        overlay = run_dir / "overlay.qcow2"
        output_disk = run_dir / "output.raw"
        if not overlay.is_file() or overlay.is_symlink() or not output_disk.is_file() or output_disk.is_symlink():
            raise VmControllerError("run_disks_missing")
        backing = receipt.get("base_image_path")
        if backing:  # re-check the base right before boot: the overlay only names it by path
            if _sha256(Path(backing)) != base_image_sha256:
                raise VmControllerError("base_image_changed_since_prepare")
        command = qemu_command(qemu, bios, overlay, output_disk, accel=accel)
        receipt["state"] = "booting"
        _append_event(receipt, "boot_started", {
            "argv": command, "wall_seconds": int(wall_seconds), "base_verified": bool(base),
            "qemu_system_sha256": _sha256(qemu), "firmware_sha256": _sha256(bios),
        })
        _write_receipt(run_dir, receipt)
        started = time.monotonic()
        process = popen(command, start_new_session=True)
        timed_out = False
        try:
            exit_code = process.wait(timeout=int(wall_seconds))
        except subprocess.TimeoutExpired:
            timed_out = True
            process.kill()
            exit_code = process.wait(timeout=30)
        except KeyboardInterrupt:
            process.kill()
            exit_code = process.wait(timeout=30)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=30)
        elapsed = round(time.monotonic() - started, 1)
        try:  # the whole QEMU process group must be gone
            os.killpg(process.pid, 0)
            group_alive = True
        except (ProcessLookupError, PermissionError):
            group_alive = False
        receipt["state"] = "booted_and_stopped"
        _append_event(receipt, "boot_finished", {
            "exit_code": exit_code, "timed_out": timed_out, "elapsed_seconds": elapsed,
            "qemu_process_running": process.poll() is None, "process_group_alive": group_alive,
        })
        _write_receipt(run_dir, receipt)
    return {"run_id": run_id, "exit_code": exit_code, "timed_out": timed_out,
            "elapsed_seconds": elapsed, "process_group_alive": group_alive}
