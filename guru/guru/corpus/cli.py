"""Readiness-only corpus command line interface."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from guru.corpus.assemble import preflight
from guru.schemas.corpus import CorpusKind


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m guru.corpus.cli")
    subparsers = parser.add_subparsers(dest="command", required=True)
    check = subparsers.add_parser("preflight")
    check.add_argument("kind", choices=[kind.value for kind in CorpusKind])
    check.add_argument("--task-manifest", type=Path)
    check.add_argument("--teacher-registry", type=Path)
    check.add_argument("--admission-audit", type=Path)
    check.add_argument("--items", type=Path,
                       help="JSONL corpus items used to replay admitted provenance evidence")
    check.add_argument("--task-manifest-digest",
                       help="SHA-256 pin for the task manifest bytes")
    check.add_argument("--source-manifest", type=Path,
                       help="pinned Guru source manifest used by provenance replay")
    check.add_argument("--source-manifest-digest",
                       help="SHA-256 pin for the source manifest bytes")
    args = parser.parse_args()
    report = preflight(
        kind=args.kind,
        task_manifest=args.task_manifest,
        teacher_registry=args.teacher_registry,
        admission_audit=args.admission_audit,
        items=args.items,
        task_manifest_digest=args.task_manifest_digest,
        source_manifest=args.source_manifest,
        source_manifest_digest=args.source_manifest_digest,
    )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
