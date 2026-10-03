"""Offline tests for Guru-Code's experimental data and proposal evaluator."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from guru.coding import (CodingDataError, evaluate, read_tasks, validate_plan,
                         write_sft)


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TASKS = os.path.join(ROOT, "data", "coding", "tasks.jsonl")


def proposal(path, symbol, test_description):
    return json.dumps({
        "summary": "Add requested helper.",
        "files": [{"path": path, "content": f"def {symbol}():\n    return None\n"}],
        "tests": [test_description],
    })


class CodingDataTests(unittest.TestCase):
    def test_fixtures_are_provenanced_and_eval_has_no_targets(self):
        rows = read_tasks(TASKS)
        self.assertEqual(len(rows), 5)
        self.assertEqual(sum(r["split"] == "train" for r in rows), 2)
        self.assertEqual(sum(r["split"] == "eval" for r in rows), 3)
        self.assertTrue(all(r["provenance"]["description"] for r in rows))
        self.assertTrue(all("target" not in r for r in rows if r["split"] == "eval"))

    def test_model_metadata_does_not_claim_a_checkpoint_or_capability(self):
        path = os.path.join(ROOT, "data", "coding", "model.json")
        with open(path, encoding="utf-8") as f:
            metadata = json.load(f)
        self.assertIsNone(metadata["trained_checkpoint"])
        self.assertFalse(metadata["coding_capability_established"])
        self.assertFalse(metadata["held_out_evaluation"]["certifies_capability"])

    def test_sft_export_includes_train_only_and_guru_prompt_contract(self):
        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "pairs.jsonl")
            self.assertEqual(write_sft(rows, out), 2)
            with open(out, encoding="utf-8") as f:
                pairs = [json.loads(line) for line in f]
        self.assertEqual(len(pairs), 2)
        self.assertIn("exactly one JSON object", pairs[0]["prompt"])
        self.assertNotIn("eval-001", "\n".join(p["prompt"] for p in pairs))

    def test_plan_rejects_traversal_and_invalid_python(self):
        base = {"summary": "change", "tests": ["check"], "files": []}
        traversal = {**base, "files": [{"path": "../escape.py", "content": "x=1"}]}
        ok, report = validate_plan(traversal)
        self.assertFalse(ok)
        self.assertFalse(report["safe_paths"])
        broken = {**base, "files": [{"path": "safe.py", "content": "def broken(:\n"}]}
        ok, report = validate_plan(broken)
        self.assertFalse(ok)
        self.assertFalse(report["syntax_valid"])
        self.assertTrue(report["schema_valid"])

    def test_eval_reports_structured_syntax_and_rubric_signals(self):
        rows = read_tasks(TASKS)
        predictions = [
            {"id": "eval-001", "output": proposal("clamp.py", "clamp", "Check lower and upper bounds.")},
            {"id": "eval-002", "output": proposal("positive.py", "parse_positive_ints", "Check invalid values.")},
            {"id": "eval-003", "output": proposal("slug.py", "slugify", "Check punctuation and surrounding spaces.")},
        ]
        report = evaluate(rows, predictions)
        self.assertEqual(report["cases"], 3)
        self.assertEqual(report["prediction_coverage"], 1)
        self.assertEqual(report["structured_rate"], 1)
        self.assertEqual(report["python_syntax_rate"], 1)
        self.assertEqual(report["pass_rate"], 1)
        self.assertIn("not a capability certification", report["warning"])

    def test_eval_counts_missing_and_duplicate_outputs_as_nonpassing(self):
        rows = read_tasks(TASKS)
        report = evaluate(rows, [
            {"id": "eval-001", "output": "not JSON"},
            {"id": "eval-001", "output": "{}"},
        ])
        self.assertEqual(report["duplicate_prediction_ids"], ["eval-001"])
        self.assertEqual(report["prediction_coverage"], 1 / 3)
        self.assertEqual(report["pass_rate"], 0)
        self.assertFalse(report["results"][0]["structured"])
        self.assertFalse(report["results"][1]["present"])

    def test_eval_fixture_target_leak_is_rejected(self):
        rows = read_tasks(TASKS)
        eval_row = next(r for r in rows if r["split"] == "eval")
        eval_row["target"] = {}
        with self.assertRaises(CodingDataError):
            from guru.coding import validate_task
            validate_task(eval_row)


if __name__ == "__main__":
    unittest.main()
