"""Command-line entry point for fixed, synthetic evaluator prequalification.

This CLI has no approval/promotion command and accepts no task, candidate, or
corpus input. A successful invocation writes a report whose status is at most
``prequalification``; it never authorizes `tests_pass` or quality admission.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from guru.evaluator_prequalification import replay_report, run_prequalification, write_report_atomic


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m guru.evaluator_qualification_cli",
        description="Run only fixed synthetic evaluator prequalification probes.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="run fixed local synthetic probes and write a report")
    run.add_argument("--endpoint", required=True, help="explicit unix:///absolute/path Docker socket")
    run.add_argument("--image", required=True, help="image reference pinned with @sha256:<64 hex>")
    run.add_argument("--output", required=True, type=Path, help="private report path; parent directory must exist")
    verify = commands.add_parser("verify", help="verify canonical report serialization and digest")
    verify.add_argument("--report", required=True, type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "run":
            report = run_prequalification(endpoint=args.endpoint, image_ref=args.image)
            write_report_atomic(args.output, report)
            print(json.dumps({
                "status": report.status.value,
                "report_digest": report.report_digest,
                "report_path": str(args.output),
                "blockers": report.blockers,
                "qualified": False,
                "notice": "Synthetic prequalification only; no task data or candidate code was evaluated.",
            }, ensure_ascii=False, sort_keys=True))
            # Nonzero means evidence was written but the qualification gate is
            # still pending or failed; this is not a successful qualification.
            return 2
        report = replay_report(args.report)
        print(json.dumps({
            "valid": True,
            "status": report.status.value,
            "report_digest": report.report_digest,
            "qualified": False,
        }, ensure_ascii=False, sort_keys=True))
        return 0
    except (OSError, ValueError) as exc:
        print(json.dumps({"error": str(exc), "qualified": False}, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
