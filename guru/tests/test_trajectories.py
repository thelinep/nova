"""Focused validation tests for the separate multi-agent trajectory schema."""
import copy
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from guru.trajectories import (SCHEMA_VERSION, TrajectoryDataError,
                               read_trajectories, validate_trajectories,
                               validate_trajectory)


def digest(char):
    return char * 64


def ref(source="fixture-source", item="fixture-item", char="a"):
    return {"source_id": source, "item_id": item, "item_sha256": digest(char)}


def turn(turn_id="t1"):
    return {
        "turn_id": turn_id,
        "speaker": "coder-agent",
        "role": "coder",
        "model": {"model_id": "teacher-candidate", "model_sha256": digest("b"), "adapter_sha256": None},
        "prompt_ref": ref(item="prompt-1", char="c"),
        "context_refs": [ref(item="context-1", char="d")],
        "task_ref": ref(item="task-1", char="e"),
        "action": {"kind": "message", "name": "propose-change", "result": "Suggested patch summary."},
        "patch_refs": [{"path": "src/example.py", "sha256": digest("f")}],
        "review_disposition": "none",
        "evaluator_evidence": {"status": "not_run", "refs": []},
    }


def trajectory():
    return {
        "schema_version": SCHEMA_VERSION,
        "trajectory_id": "trajectory-001",
        "split": "train",
        "task_ref": {
            "task_id": "task-001", "task_schema_version": "guru-code-task-v2",
            "task_sha256": digest("1"), "family_id": "family-a", "split": "train",
        },
        "leakage_group": "repo-family-a",
        "prompt_refs": [ref(item="prompt-root", char="2")],
        "context_refs": [ref(item="snapshot", char="3")],
        "source_refs": [ref(item="curated-source", char="4")],
        "rights_refs": [ref(item="review-record", char="5")],
        "turns": [turn()],
    }


class TrajectoryTests(unittest.TestCase):
    def test_accepts_complete_versioned_trace_without_touching_task_schema(self):
        row = trajectory()
        validate_trajectory(row)
        self.assertEqual(row["task_ref"]["task_schema_version"], "guru-code-task-v2")

    def test_rejects_missing_model_or_adapter_lineage(self):
        row = trajectory()
        del row["turns"][0]["model"]["model_sha256"]
        with self.assertRaisesRegex(TrajectoryDataError, "model_sha256"):
            validate_trajectory(row)
        row = trajectory()
        del row["turns"][0]["model"]["adapter_sha256"]
        with self.assertRaisesRegex(TrajectoryDataError, "adapter_sha256"):
            validate_trajectory(row)

    def test_rejects_missing_source_refs_and_invalid_hashes(self):
        row = trajectory()
        row["source_refs"] = []
        with self.assertRaisesRegex(TrajectoryDataError, "source_refs"):
            validate_trajectory(row)
        row = trajectory()
        row["rights_refs"][0]["item_sha256"] = "bad"
        with self.assertRaisesRegex(TrajectoryDataError, "SHA-256"):
            validate_trajectory(row)

    def test_rejects_malformed_and_oversized_turns(self):
        row = trajectory()
        row["turns"][0]["action"]["kind"] = "unknown"
        with self.assertRaisesRegex(TrajectoryDataError, "unsupported"):
            validate_trajectory(row)
        row = trajectory()
        row["turns"][0]["action"]["result"] = "x" * 16_385
        with self.assertRaisesRegex(TrajectoryDataError, "at most"):
            validate_trajectory(row)
        row = trajectory()
        row["turns"] = [turn(f"t{index}") for index in range(65)]
        with self.assertRaisesRegex(TrajectoryDataError, "at most 64"):
            validate_trajectory(row)

    def test_held_out_rows_must_not_contain_targets_anywhere(self):
        row = trajectory()
        row["split"] = row["task_ref"]["split"] = "eval"
        row["turns"][0]["action"]["target"] = "hidden answer"
        with self.assertRaisesRegex(TrajectoryDataError, "target-bearing"):
            validate_trajectory(row)

    def test_task_family_and_leakage_group_may_not_cross_splits(self):
        first = trajectory()
        second = copy.deepcopy(first)
        second.update(trajectory_id="trajectory-002", split="eval")
        second["task_ref"]["split"] = "eval"
        second["task_ref"]["task_id"] = "task-002"
        with self.assertRaisesRegex(TrajectoryDataError, "family"):
            validate_trajectories([first, second])
        second["task_ref"]["family_id"] = "family-b"
        with self.assertRaisesRegex(TrajectoryDataError, "leakage_group"):
            validate_trajectories([first, second])

    def test_jsonl_reader_validates_and_rejects_duplicate_keys(self):
        with tempfile.TemporaryDirectory() as temp:
            path = os.path.join(temp, "traces.jsonl")
            with open(path, "w", encoding="utf-8") as stream:
                stream.write(json.dumps(trajectory()) + "\n")
            self.assertEqual(len(read_trajectories(path)), 1)
            with open(path, "w", encoding="utf-8") as stream:
                stream.write('{"schema_version":"wrong","schema_version":"also-wrong"}\n')
            with self.assertRaises(TrajectoryDataError):
                read_trajectories(path)


if __name__ == "__main__":
    unittest.main()
