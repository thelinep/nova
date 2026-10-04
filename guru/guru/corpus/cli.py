"""Readiness-only corpus command line interface."""
from __future__ import annotations

import argparse
import json

from guru.corpus.assemble import preflight
from guru.schemas.corpus import CorpusKind


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m guru.corpus.cli")
    subparsers = parser.add_subparsers(dest="command", required=True)
    check = subparsers.add_parser("preflight")
    check.add_argument("kind", choices=[kind.value for kind in CorpusKind])
    args = parser.parse_args()
    report = preflight(kind=args.kind)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
