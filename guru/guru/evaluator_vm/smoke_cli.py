"""One disposable smoke boot: recover -> prepare -> boot -> destroy.

    python -m guru.evaluator_vm.smoke_cli --base IMAGE.qcow2 --run-root DIR \
        --qemu-img PATH --qemu-system PATH --firmware PATH [--wall-seconds N]

The base digest is computed here and pinned for this one run only; it is the
operator's own pin, not an independently reviewed image digest. Nothing but
the base image is given to the guest. This is not evaluator qualification.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from .controller import VmConfig, VmControllerError, _sha256, destroy_run, prepare_run, recover_runs
from .launch import DEFAULT_WALL_SECONDS, smoke_boot


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="guru.evaluator_vm.smoke_cli")
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--qemu-img", type=Path, required=True)
    parser.add_argument("--qemu-system", type=Path, required=True)
    parser.add_argument("--firmware", type=Path, required=True)
    parser.add_argument("--wall-seconds", type=int, default=DEFAULT_WALL_SECONDS)
    args = parser.parse_args(argv)

    summary: dict = {"qualification": "none (smoke boot only)"}
    try:
        reaped = recover_runs(args.run_root)
        summary["recovered_before_start"] = [r["run_id"] for r in reaped]
        print("== Checking base image (SHA-256)…", flush=True)
        digest = _sha256(args.base.expanduser())
        summary["base_image_sha256"] = digest
        config = VmConfig(base_image=args.base, base_image_sha256=digest,
                          run_root=args.run_root, qemu_img=args.qemu_img)
        prepared = prepare_run(config)
        run_id = prepared["run_id"]
        summary["run_id"] = run_id
        print(f"== Run {run_id}: fresh overlay ready. Booting with no network and no shared folders.", flush=True)
        print(f"   Time limit {args.wall_seconds // 60} min. To stop early: Ctrl-C, or run 'sudo poweroff' in the VM.\n", flush=True)
        try:
            summary["boot"] = smoke_boot(args.run_root, run_id, base_image_sha256=digest,
                                         qemu_system=args.qemu_system, firmware=args.firmware,
                                         wall_seconds=args.wall_seconds)
        finally:
            destroyed = destroy_run(args.run_root, run_id)
            summary["destroyed"] = destroyed["destroyed"]
            summary["destruction_receipt_digest"] = destroyed["destruction_receipt_digest"]
            summary["run_directory_left"] = (args.run_root.expanduser() / run_id).exists()
    except VmControllerError as error:
        summary["error"] = str(error)
        print("\n" + json.dumps(summary, indent=2))
        return 1
    print("\n" + json.dumps(summary, indent=2))
    boot = summary.get("boot", {})
    clean = summary.get("destroyed") and not summary.get("run_directory_left") and not boot.get("process_group_alive")
    return 0 if clean else 1


if __name__ == "__main__":
    sys.exit(main())
