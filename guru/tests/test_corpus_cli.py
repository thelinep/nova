import json
from pathlib import Path

from guru.corpus import cli


def test_preflight_cli_forwards_provenance_replay_inputs(monkeypatch, capsys):
    forwarded = {}

    def fake_preflight(**kwargs):
        forwarded.update(kwargs)
        return {"ready": True, "blockers": [], "warnings": []}

    monkeypatch.setattr(cli, "preflight", fake_preflight)
    monkeypatch.setattr("sys.argv", [
        "guru-corpus", "preflight", "c_rd",
        "--task-manifest", "tasks.jsonl",
        "--teacher-registry", "teachers.jsonl",
        "--admission-audit", "quality.jsonl",
        "--items", "items.jsonl",
        "--task-manifest-digest", "a" * 64,
        "--source-manifest", "sources.json",
        "--source-manifest-digest", "b" * 64,
    ])

    assert cli.main() == 0
    assert forwarded == {
        "kind": "c_rd",
        "task_manifest": Path("tasks.jsonl"),
        "teacher_registry": Path("teachers.jsonl"),
        "admission_audit": Path("quality.jsonl"),
        "items": Path("items.jsonl"),
        "task_manifest_digest": "a" * 64,
        "source_manifest": Path("sources.json"),
        "source_manifest_digest": "b" * 64,
    }
    assert json.loads(capsys.readouterr().out) == {
        "ready": True, "blockers": [], "warnings": []
    }


def test_preflight_cli_preserves_defaults_and_returns_failure_for_blockers(monkeypatch, capsys):
    forwarded = {}

    def fake_preflight(**kwargs):
        forwarded.update(kwargs)
        return {"ready": False, "blockers": ["missing admission audit"], "warnings": []}

    monkeypatch.setattr(cli, "preflight", fake_preflight)
    monkeypatch.setattr("sys.argv", ["guru-corpus", "preflight", "c_rd"])

    assert cli.main() == 1
    assert forwarded == {
        "kind": "c_rd",
        "task_manifest": None,
        "teacher_registry": None,
        "admission_audit": None,
        "items": None,
        "task_manifest_digest": None,
        "source_manifest": None,
        "source_manifest_digest": None,
    }
    assert json.loads(capsys.readouterr().out) == {
        "ready": False,
        "blockers": ["missing admission audit"],
        "warnings": [],
    }
