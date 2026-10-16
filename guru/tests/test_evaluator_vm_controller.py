from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
from unittest.mock import patch

import pytest

from guru.evaluator_vm.controller import (
    GIB,
    MIN_FREE_BYTES,
    OUTPUT_DISK_BYTES,
    VmConfig,
    VmControllerError,
    destroy_run,
    prepare_run,
    recover_runs,
)


def _config(tmp_path: Path, *, base: Path | None = None, run_root: Path | None = None) -> VmConfig:
    image = base or tmp_path / "base.qcow2"
    if not image.exists():
        image.write_bytes(b"synthetic-base-image")
    qemu_img = tmp_path / "qemu-img"
    if not qemu_img.exists():
        qemu_img.write_text("test double; never executed\n")
        qemu_img.chmod(0o700)
    return VmConfig(
        base_image=image,
        base_image_sha256=hashlib.sha256(image.read_bytes()).hexdigest(),
        run_root=run_root or tmp_path / "private-runs",
        qemu_img=qemu_img,
    )


def _fake_qemu_img(command: list[str]) -> subprocess.CompletedProcess[str]:
    if command[1:3] == ["info", "--output=json"]:
        return subprocess.CompletedProcess(command, 0, json.dumps({"format": "qcow2", "virtual-size": 4 * GIB}), "")
    if command[1] == "create" and "-b" in command:
        Path(command[-1]).write_bytes(b"synthetic-overlay")
    elif command[1] == "create":
        Path(command[-2]).write_bytes(b"\0" * int(command[-1]))
    else:
        raise AssertionError(f"unexpected qemu-img command: {command}")
    return subprocess.CompletedProcess(command, 0, "", "")


def _plenty_of_space():
    class Usage:
        total = 100 * GIB
        used = 50 * GIB
        free = 50 * GIB
    return Usage()


def test_prepare_run_checks_image_and_creates_bounded_run_disks(tmp_path):
    config = _config(tmp_path)
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
        result = prepare_run(config, run_id="a" * 32, command_runner=_fake_qemu_img)

    run_dir = result["run_dir"]
    assert result["state"] == "prepared_not_booted"
    assert (run_dir / "overlay.qcow2").read_bytes() == b"synthetic-overlay"
    assert (run_dir / "output.raw").stat().st_size == OUTPUT_DISK_BYTES
    assert run_dir.stat().st_mode & 0o777 == 0o700
    receipt = json.loads((run_dir / "lifecycle-receipt.json").read_text())
    assert receipt["state"] == "prepared_not_booted"
    assert receipt["policy"]["network_devices"] == 0
    assert receipt["policy"]["shared_folders"] == 0
    assert receipt["policy"]["maximum_overlay_file_bytes"] == 8 * GIB
    assert len(receipt["receipt_digest"]) == 64
    assert [event["event"] for event in receipt["events"]] == [
        "run_directory_created", "base_verified", "overlay_created", "output_disk_created"
    ]


def test_prepare_run_fails_before_run_creation_when_base_digest_is_wrong(tmp_path):
    config = _config(tmp_path)
    config = VmConfig(**{**config.__dict__, "base_image_sha256": "0" * 64})
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
        with pytest.raises(VmControllerError, match="base_image_digest_mismatch"):
            prepare_run(config, run_id="b" * 32, command_runner=_fake_qemu_img)
    assert not (config.run_root / ("b" * 32)).exists()


def test_prepare_run_fails_closed_below_free_space_floor(tmp_path):
    config = _config(tmp_path)
    low = _plenty_of_space()
    low.free = MIN_FREE_BYTES - 1
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=low):
        with pytest.raises(VmControllerError, match="insufficient_free_disk_space"):
            prepare_run(config, run_id="c" * 32, command_runner=_fake_qemu_img)
    assert not (config.run_root / ("c" * 32)).exists()


def test_prepare_run_does_not_allow_lowering_ten_gib_free_space_floor(tmp_path):
    config = _config(tmp_path)
    config = VmConfig(**{**config.__dict__, "minimum_free_bytes": 1})
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
        with pytest.raises(VmControllerError, match="invalid_disk_policy"):
            prepare_run(config, run_id="7" * 32, command_runner=_fake_qemu_img)


def test_prepare_run_rejects_base_virtual_size_over_eight_gib(tmp_path):
    config = _config(tmp_path)
    def too_large(command):
        return subprocess.CompletedProcess(command, 0, json.dumps({"format": "qcow2", "virtual-size": 9 * GIB}), "")
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
        with pytest.raises(VmControllerError, match="base_virtual_disk_exceeds_policy"):
            prepare_run(config, run_id="d" * 32, command_runner=too_large)


def test_prepare_run_rejects_digest_mismatch_and_never_calls_create(tmp_path):
    config = _config(tmp_path)
    commands = []
    def wrong_image(command):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, json.dumps({"format": "raw", "virtual-size": 4 * GIB}), "")
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
        with pytest.raises(VmControllerError, match="base_image_must_be_qcow2"):
            prepare_run(config, run_id="e" * 32, command_runner=wrong_image)
    assert len(commands) == 1


def test_prepare_run_rejects_non_uuid_run_id_and_does_not_touch_disk(tmp_path):
    config = _config(tmp_path)
    with pytest.raises(VmControllerError, match="invalid_run_id"):
        prepare_run(config, run_id="../unsafe", command_runner=_fake_qemu_img)
    assert not config.run_root.exists()


def test_destroy_run_removes_only_selected_managed_directory(tmp_path):
    config = _config(tmp_path)
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
        first = prepare_run(config, run_id="1" * 32, command_runner=_fake_qemu_img)
        second = prepare_run(config, run_id="2" * 32, command_runner=_fake_qemu_img)

    receipt = json.loads((first["run_dir"] / "lifecycle-receipt.json").read_text())
    result = destroy_run(config.run_root, first["run_id"])
    assert result["destroyed"] is True
    assert len(result["destruction_receipt_digest"]) == 64
    durable_receipt_path = config.run_root / "receipts" / f"{first['run_id']}.json"
    durable_receipt = json.loads(durable_receipt_path.read_text())
    assert durable_receipt["destruction_receipt_digest"] == result["destruction_receipt_digest"]
    assert durable_receipt["artifacts_removed"] is True
    assert not first["run_dir"].exists()
    assert second["run_dir"].exists()
    assert len(receipt["receipt_digest"]) == 64


def test_destroy_run_rejects_tampered_receipt_without_deleting_artifacts(tmp_path):
    config = _config(tmp_path)
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
        result = prepare_run(config, run_id="3" * 32, command_runner=_fake_qemu_img)
    receipt_path = result["run_dir"] / "lifecycle-receipt.json"
    receipt = json.loads(receipt_path.read_text())
    receipt["state"] = "qualified"
    receipt_path.write_text(json.dumps(receipt))
    with pytest.raises(VmControllerError, match="lifecycle_receipt_digest_mismatch"):
        destroy_run(config.run_root, result["run_id"])
    assert result["run_dir"].exists()


def test_recover_runs_destroys_only_uuid_run_directories(tmp_path):
    config = _config(tmp_path)
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
        first = prepare_run(config, run_id="4" * 32, command_runner=_fake_qemu_img)
    unrelated = config.run_root / "keep-this-note"
    unrelated.write_text("not a managed run")

    recovered = recover_runs(config.run_root)
    assert len(recovered) == 1
    assert recovered[0]["run_id"] == first["run_id"]
    assert recovered[0]["destroyed"] is True
    assert len(recovered[0]["destruction_receipt_digest"]) == 64
    assert not first["run_dir"].exists()
    assert unrelated.read_text() == "not a managed run"


def test_recover_runs_reaps_run_without_receipt_and_records_why(tmp_path):
    config = _config(tmp_path)
    config.run_root.mkdir(mode=0o700)
    abandoned = config.run_root / ("5" * 32)
    abandoned.mkdir(mode=0o700)
    (abandoned / "overlay.qcow2").write_bytes(b"left behind by a crash before the first receipt")

    recovered = recover_runs(config.run_root)
    assert [r["run_id"] for r in recovered] == ["5" * 32]
    assert recovered[0]["destroyed"] is True
    assert recovered[0]["receipt_status"] == "lifecycle_receipt_missing"
    assert recovered[0]["origin"] == "recovery"
    assert not abandoned.exists()


def test_one_damaged_run_does_not_stop_recovery_of_the_others(tmp_path):
    config = _config(tmp_path)
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
        damaged = prepare_run(config, run_id="0" * 32, command_runner=_fake_qemu_img)
        tampered = prepare_run(config, run_id="a" * 32, command_runner=_fake_qemu_img)
        intact = prepare_run(config, run_id="f" * 32, command_runner=_fake_qemu_img)
    # A crash part-way through deletion removed the receipt but left the overlay.
    (damaged["run_dir"] / "lifecycle-receipt.json").unlink()
    receipt_path = tampered["run_dir"] / "lifecycle-receipt.json"
    receipt = json.loads(receipt_path.read_text())
    receipt["state"] = "qualified"
    receipt_path.write_text(json.dumps(receipt))

    recovered = {r["run_id"]: r for r in recover_runs(config.run_root)}
    assert recovered["0" * 32]["receipt_status"] == "lifecycle_receipt_missing"
    assert recovered["a" * 32]["receipt_status"] == "lifecycle_receipt_digest_mismatch"
    assert recovered["f" * 32]["receipt_status"] == "verified"
    assert recovered["f" * 32]["previous_lifecycle_receipt_digest"]
    for run in (damaged, tampered, intact):
        assert not run["run_dir"].exists()
        assert (config.run_root / "receipts" / f"{run['run_id']}.json").is_file()


def test_destroy_leaves_no_pending_intent_after_success(tmp_path):
    config = _config(tmp_path)
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
        run = prepare_run(config, run_id="7" * 32, command_runner=_fake_qemu_img)
    result = destroy_run(config.run_root, run["run_id"])
    assert result["receipt_status"] == "verified"
    assert result["completed_by_recovery"] is False
    assert len(result["intent_digest"]) == 64
    assert not list((config.run_root / "receipts").glob("*.pending.json"))


def test_recovery_completes_a_destruction_interrupted_after_deletion(tmp_path):
    config = _config(tmp_path)
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
        run = prepare_run(config, run_id="8" * 32, command_runner=_fake_qemu_img)
    receipts = config.run_root / "receipts"
    receipts.mkdir(mode=0o700)
    intent = {"schema_version": "guru-evaluator-vm-destruction-intent-v1", "run_id": run["run_id"],
              "origin": "explicit", "receipt_status": "verified", "previous_lifecycle_receipt_digest": "b" * 64}
    (receipts / f"{run['run_id']}.pending.json").write_text(json.dumps(intent))
    import shutil as _shutil
    _shutil.rmtree(run["run_dir"])  # deletion finished, then the controller died

    recovered = recover_runs(config.run_root)
    assert len(recovered) == 1
    assert recovered[0]["completed_by_recovery"] is True
    assert recovered[0]["destroyed"] is True
    assert recovered[0]["previous_lifecycle_receipt_digest"] == "b" * 64
    assert not (receipts / f"{run['run_id']}.pending.json").exists()


def test_recovery_removes_a_symlink_entry_without_following_it(tmp_path):
    config = _config(tmp_path)
    config.run_root.mkdir(mode=0o700)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("must survive")
    (config.run_root / ("9" * 32)).symlink_to(outside)

    recovered = recover_runs(config.run_root)
    assert recovered[0]["receipt_status"] == "unsafe_entry_not_a_directory"
    assert not (config.run_root / ("9" * 32)).is_symlink()
    assert (outside / "keep.txt").read_text() == "must survive"


def test_a_second_controller_cannot_touch_a_locked_run_root(tmp_path):
    import fcntl
    config = _config(tmp_path)
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
        run = prepare_run(config, run_id="c" * 32, command_runner=_fake_qemu_img)
    fd = os.open(config.run_root / ".controller.lock", os.O_RDWR)
    fcntl.flock(fd, fcntl.LOCK_EX)
    try:
        with pytest.raises(VmControllerError, match="run_root_locked_by_another_controller"):
            recover_runs(config.run_root)
        with pytest.raises(VmControllerError, match="run_root_locked_by_another_controller"):
            destroy_run(config.run_root, run["run_id"])
        with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
            with pytest.raises(VmControllerError, match="run_root_locked_by_another_controller"):
                prepare_run(config, run_id="d" * 32, command_runner=_fake_qemu_img)
        assert run["run_dir"].exists()
        assert not (config.run_root / ("d" * 32)).exists()
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def test_prepare_run_rejects_qemu_img_symlink(tmp_path):
    config = _config(tmp_path)
    link = tmp_path / "qemu-img-link"
    link.symlink_to(config.qemu_img)
    config = VmConfig(**{**config.__dict__, "qemu_img": link})
    with patch("guru.evaluator_vm.controller.shutil.disk_usage", return_value=_plenty_of_space()):
        with pytest.raises(VmControllerError, match="qemu_img_tool_unavailable_or_untrusted_path"):
            prepare_run(config, run_id="6" * 32, command_runner=_fake_qemu_img)
