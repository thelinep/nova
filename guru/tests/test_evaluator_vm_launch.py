from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from guru.evaluator_vm.controller import VmControllerError, destroy_run, prepare_run
from guru.evaluator_vm.launch import qemu_command, smoke_boot
from test_evaluator_vm_controller import _config, _fake_qemu_img, _plenty_of_space


class FakeQemu:
    """Stands in for the QEMU process; never executes anything."""

    def __init__(self, *, hang: bool):
        self.hang = hang
        self.killed = False
        self.pid = 999_999_999  # no such process group, so the group check reports it gone
        self.argv = None

    def __call__(self, argv, **kwargs):
        self.argv = argv
        assert kwargs.get("start_new_session") is True
        return self

    def wait(self, timeout=None):
        if self.hang and not self.killed:
            raise subprocess.TimeoutExpired(self.argv, timeout)
        return -9 if self.killed else 0

    def kill(self):
        self.killed = True

    def poll(self):
        return (-9 if self.killed else 0) if (self.killed or not self.hang) else None


def _prepared(tmp_path, run_id):
    config = _config(tmp_path)
    tools = tmp_path / "tools"
    tools.mkdir()
    for name in ("qemu-system-aarch64", "edk2-aarch64-code.fd"):
        (tools / name).write_bytes(b"test double; never executed\n")
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
        prepare_run(config, run_id=run_id, command_runner=_fake_qemu_img)
    return config, tools / "qemu-system-aarch64", tools / "edk2-aarch64-code.fd"


def test_qemu_command_has_no_network_shares_monitor_or_default_devices(tmp_path):
    argv = qemu_command(Path("/q"), Path("/fw"), tmp_path / "o.qcow2", tmp_path / "out.raw")
    joined = " ".join(argv)
    assert "-nodefaults" in argv and argv[argv.index("-nic") + 1] == "none"
    assert argv[argv.index("-monitor") + 1] == "none"
    assert argv[argv.index("-smp") + 1] == "2" and argv[argv.index("-m") + 1] == "4096"
    for forbidden in ("-netdev", "user,", "-virtfs", "-fsdev", "9p", "hostfwd", "-chardev socket", "-qmp", "-gdb"):
        assert forbidden not in joined


def test_smoke_boot_records_a_clean_boot_and_then_destroys(tmp_path):
    config, qemu, firmware = _prepared(tmp_path, "1" * 32)
    fake = FakeQemu(hang=False)
    result = smoke_boot(config.run_root, "1" * 32, base_image_sha256=config.base_image_sha256,
                        qemu_system=qemu, firmware=firmware, popen=fake)
    assert result == {"run_id": "1" * 32, "exit_code": 0, "timed_out": False,
                      "elapsed_seconds": result["elapsed_seconds"], "process_group_alive": False}
    receipt = json.loads((config.run_root / ("1" * 32) / "lifecycle-receipt.json").read_text())
    assert receipt["state"] == "booted_and_stopped"
    assert [e["event"] for e in receipt["events"]][-2:] == ["boot_started", "boot_finished"]
    assert destroy_run(config.run_root, "1" * 32)["destroyed"] is True


def test_smoke_boot_kills_qemu_at_the_wall_limit(tmp_path):
    config, qemu, firmware = _prepared(tmp_path, "2" * 32)
    fake = FakeQemu(hang=True)
    result = smoke_boot(config.run_root, "2" * 32, base_image_sha256=config.base_image_sha256,
                        qemu_system=qemu, firmware=firmware, wall_seconds=1, popen=fake)
    assert fake.killed and result["timed_out"] is True and result["exit_code"] == -9


def test_smoke_boot_refuses_when_the_base_changed_after_prepare(tmp_path):
    config, qemu, firmware = _prepared(tmp_path, "3" * 32)
    config.base_image.write_bytes(b"swapped base image")
    with pytest.raises(VmControllerError, match="base_image_changed_since_prepare"):
        smoke_boot(config.run_root, "3" * 32, base_image_sha256=config.base_image_sha256,
                   qemu_system=qemu, firmware=firmware, popen=FakeQemu(hang=False))


def test_smoke_boot_runs_a_prepared_overlay_only_once(tmp_path):
    config, qemu, firmware = _prepared(tmp_path, "4" * 32)
    smoke_boot(config.run_root, "4" * 32, base_image_sha256=config.base_image_sha256,
               qemu_system=qemu, firmware=firmware, popen=FakeQemu(hang=False))
    with pytest.raises(VmControllerError, match="run_not_in_prepared_state"):
        smoke_boot(config.run_root, "4" * 32, base_image_sha256=config.base_image_sha256,
                   qemu_system=qemu, firmware=firmware, popen=FakeQemu(hang=False))
