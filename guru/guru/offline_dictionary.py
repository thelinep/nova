"""Local-only lookup for the small Guru multilingual coding glossary."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import unicodedata


DATA_PATH = Path(__file__).resolve().parents[1] / "data" / "dictionaries" / "coding-terms.v0.1.json"


def _normalise(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def load_dictionary(path: Path = DATA_PATH) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    language_tags = {language["tag"] for language in data["languages"]}
    ids: set[str] = set()
    for entry in data["entries"]:
        if entry["id"] in ids:
            raise ValueError(f"duplicate dictionary entry: {entry['id']}")
        ids.add(entry["id"])
        if set(entry["terms"]) != language_tags:
            raise ValueError(f"entry {entry['id']} must contain every dictionary language")
        for term in entry["terms"].values():
            if not term["preferred"].strip():
                raise ValueError(f"entry {entry['id']} contains an empty preferred term")
    return data


def lookup(data: dict, query: str, language: str | None = None) -> list[dict]:
    needle = _normalise(query)
    if not needle:
        return []
    matches = []
    for entry in data["entries"]:
        for tag, term in entry["terms"].items():
            if language and tag != language:
                continue
            candidates = [term["preferred"], *term["aliases"]]
            if any(_normalise(candidate) == needle for candidate in candidates):
                matches.append(entry)
                break
    return matches


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Search the offline Guru coding glossary.")
    parser.add_argument("query", nargs="?", help="a word in any supported language")
    parser.add_argument("--language", choices=("sa", "hi", "en", "ur", "ru", "zh-Hans"))
    parser.add_argument("--list-languages", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    data = load_dictionary()
    if args.list_languages:
        for language in data["languages"]:
            print(f"{language['tag']}\t{language['name']}\t{language['script']}")
        return 0
    if not args.query:
        print("Enter a term or use --list-languages.", file=sys.stderr)
        return 2
    matches = lookup(data, args.query, args.language)
    if not matches:
        print("No exact term found. Try another spelling or language.", file=sys.stderr)
        return 1
    for entry in matches:
        print(f"{entry['id']} — {entry['definition_en']}")
        for language in data["languages"]:
            term = entry["terms"][language["tag"]]
            aliases = f" (also: {', '.join(term['aliases'])})" if term["aliases"] else ""
            print(f"  {language['name']}: {term['preferred']}{aliases}")
        print(f"  Review: {entry['review_status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
