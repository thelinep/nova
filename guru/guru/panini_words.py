"""Distill searchable surface tokens from the pinned Ashtadhyayi text."""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path

from . import slp1, sutra


SCHEMA_VERSION = "guru-ashtadhyayi-surface-lexicon-v1"
SOURCE_COMMIT = "8da2f90bee3ce1c07505fa432fc3729e3f7e02ea"
DEFAULT_OUTPUT = Path(sutra.HERE) / "ashtadhyayi-surface-lexicon.v1.json"


def distill() -> dict:
    """Return a provenance-bound frequency index of source whitespace tokens.

    Tokens are kept as printed in the SLP1 source. This is not morphological
    analysis: compounds, sandhi, technical markers, and inflected forms remain
    intact and receive no inferred lemma or dictionary meaning.
    """
    source_path = Path(sutra.HERE) / sutra.FILES["ashtadhyayi"]
    source_bytes = source_path.read_bytes()
    occurrences: dict[str, int] = defaultdict(int)
    references: dict[str, list[str]] = defaultdict(list)
    total_tokens = 0

    for row in sutra.sutras():
        for token in row["slp1"].split():
            occurrences[token] += 1
            total_tokens += 1
            if not references[token] or references[token][-1] != row["id"]:
                references[token].append(row["id"])

    words = [
        {
            "slp1": token,
            "devanagari": slp1.to_devanagari(token),
            "iast": slp1.to_iast(token),
            "occurrences": occurrences[token],
            "sutra_count": len(references[token]),
            "sutras": references[token],
        }
        for token in sorted(occurrences, key=lambda value: (-occurrences[value], value))
    ]
    return {
        "schema_version": SCHEMA_VERSION,
        "title": "Ashtadhyayi surface-token frequency index",
        "source": {
            "path": "guru/data/panini/sutrapatha.tsv",
            "sha256": hashlib.sha256(source_bytes).hexdigest(),
            "repository": "https://github.com/ambuda-org/vidyut",
            "commit": SOURCE_COMMIT,
            "license": "MIT",
            "attribution": "Ashtadhyayi and related texts from Vidyut (ambuda.org), data originally shared by ashtadhyayi.com.",
        },
        "method": {
            "unit": "Whitespace-separated SLP1 surface token from each sutra.",
            "ordering": "Descending token occurrences, then SLP1 lexical order.",
            "normalization": "None beyond the source encoding; token spellings are preserved.",
            "limitations": [
                "A surface token is not necessarily a standalone dictionary headword.",
                "Sandhi, compounds, inflection, and technical markers are not split or analyzed.",
                "No meanings, translations, commentary, or grammatical labels are inferred.",
            ],
        },
        "counts": {
            "sutras": len(sutra.sutras()),
            "surface_token_occurrences": total_tokens,
            "unique_surface_tokens": len(words),
        },
        "words": words,
    }


def write_index(path: Path) -> dict:
    result = distill()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)
    result = write_index(args.out)
    print(json.dumps({"output": str(args.out), **result["counts"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
