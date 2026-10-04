"""Offline tests for Guru-Code's experimental data and proposal evaluator."""
import json
import hashlib
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from guru.coding import (CodingDataError, evaluate, read_tasks, validate_plan,
                         canonical_sha256, write_sft)


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TASKS = os.path.join(ROOT, "data", "coding", "tasks.jsonl")


def proposal(path, symbol, test_description):
    return json.dumps({
        "summary": "Add requested helper.",
        "files": [{"path": path, "content": f"def {symbol}():\n    return None\n"}],
        "tests": [test_description],
    })


def reviewed_release_fixture(rows, tmp, *, train_uses=("train_sft",), eval_uses=("evaluation",)):
    rows = json.loads(json.dumps(rows))
    source_rows = {"source-train": [], "source-eval": []}
    for row in rows:
        source_id = "source-train" if row["split"] == "train" else "source-eval"
        row["leakage_group"] = f"group-{row['id']}"
        row["provenance"]["synthetic_fixture"] = False
        item_bytes = f"raw-item:{row['id']}".encode()
        item_path = os.path.join(tmp, f"item-{row['id']}.txt")
        with open(item_path, "wb") as f: f.write(item_bytes)
        row["provenance"]["source_refs"] = [{
            "source_id": source_id,
            "item_id": f"upstream-item-{row['id']}",
            "item_path": os.path.basename(item_path),
            "item_sha256": hashlib.sha256(item_bytes).hexdigest(),
            "transformation": "human-curated task from the pinned source item",
        }]
        source_rows[source_id].append(row)

    sources = []
    for source_id, source_tasks in source_rows.items():
        raw = f"immutable archive bytes for {source_id}".encode()
        license_text = b"Approved fixture license text."
        artifact_path = os.path.join(tmp, f"{source_id}.bin")
        license_path = os.path.join(tmp, f"{source_id}-LICENSE.txt")
        with open(artifact_path, "wb") as f: f.write(raw)
        with open(license_path, "wb") as f: f.write(license_text)
        sources.append({
            "source_id": source_id,
            "uri": f"https://example.invalid/{source_id}",
            "revision": "immutable-revision-1",
            "artifact_path": os.path.basename(artifact_path),
            "artifact_sha256": hashlib.sha256(raw).hexdigest(),
            "attribution": "Attribution retained in the internal release record.",
            "license": {
                "id": "LicenseRef-Reviewed-Fixture",
                "text_uri": "local:LICENSE.txt",
                "text_path": os.path.basename(license_path),
                "text_sha256": hashlib.sha256(license_text).hexdigest(),
            },
            "rights_review": {
                "status": "approved", "reviewer": "reviewer-1",
                "reviewed_at": "2026-10-04T12:00:00Z",
                "allowed_uses": list(train_uses if source_id == "source-train" else eval_uses),
            },
            "task_hashes": {row["id"]: canonical_sha256(row) for row in source_tasks},
        })
    manifest_path = os.path.join(tmp, "sources.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump({"schema_version": "guru-code-source-manifest-v1", "sources": sources}, f, sort_keys=True)
    return rows, manifest_path


class CodingDataTests(unittest.TestCase):
    def test_invented_starter_corpus_is_synthetic_valid_and_smoke_only(self):
        path = os.path.join(ROOT, "data", "coding", "invented-starter-v1.jsonl")
        rows = read_tasks(path)
        self.assertEqual(sum(row["split"] == "train" for row in rows), 4)
        self.assertEqual(sum(row["split"] == "eval" for row in rows), 2)
        self.assertTrue(all(row["provenance"]["synthetic_fixture"] is True for row in rows))
        for row in rows:
            if row["split"] == "train":
                valid, report = validate_plan(row["target"])
                self.assertTrue(valid, report)
                for item in row["target"]["files"]:
                    compile(item["content"], item["path"], "exec")
                    namespace = {}
                    exec(compile(item["content"], item["path"], "exec"), namespace)
                    if row["id"] == "starter-train-001":
                        self.assertTrue(namespace["parse_bool"](" YES "))
                        self.assertFalse(namespace["parse_bool"](0))
                        with self.assertRaises(ValueError): namespace["parse_bool"]("perhaps")
                    elif row["id"] == "starter-train-002":
                        self.assertEqual(namespace["paginate"]([1, 2, 3], 2, 2), [3])
                    elif row["id"] == "starter-train-003":
                        self.assertEqual(namespace["unique_by_key"]([{"k": 1}, {"k": 1}, {"k": 2}], "k"),
                                         [{"k": 1}, {"k": 2}])
                    elif row["id"] == "starter-train-004":
                        self.assertEqual(namespace["format_bytes"](1024), "1.0 KiB")
                        self.assertEqual(namespace["format_bytes"](1_048_575), "1.0 MiB")
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(write_sft(rows, os.path.join(tmp, "starter.jsonl")), 4)

    def test_fixtures_are_provenanced_and_eval_has_no_targets(self):
        rows = read_tasks(TASKS)
        self.assertEqual(len(rows), 5)
        self.assertEqual(sum(r["split"] == "train" for r in rows), 2)
        self.assertEqual(sum(r["split"] == "eval" for r in rows), 3)
        self.assertTrue(all(r["provenance"]["description"] for r in rows))
        self.assertTrue(all("target" not in r for r in rows if r["split"] == "eval"))

    def test_task_loader_rejects_duplicate_json_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "tasks.jsonl")
            with open(path, "w", encoding="utf-8") as f:
                f.write('{"id":"first","id":"second"}\n')
            with self.assertRaisesRegex(CodingDataError, "duplicate JSON object key"):
                read_tasks(path)

    def test_task_loader_rejects_nonstandard_json_constants(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "tasks.jsonl")
            with open(path, "w", encoding="utf-8") as f:
                f.write('{"id":"first","ignored":NaN}\n')
            with self.assertRaisesRegex(CodingDataError, "non-standard JSON numeric constant"):
                read_tasks(path)

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

    def test_smoke_sft_export_accepts_only_explicit_synthetic_fixtures(self):
        rows = read_tasks(TASKS)
        rows[0]["provenance"]["synthetic_fixture"] = False
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(CodingDataError, "only explicitly marked synthetic fixtures"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"))

    def test_release_sft_requires_manifest_and_leaves_no_output_on_failure(self):
        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            output = os.path.join(tmp, "pairs.jsonl")
            with self.assertRaisesRegex(CodingDataError, "requires --source-manifest"):
                write_sft(rows, output, profile="release")
            self.assertFalse(os.path.exists(output))

    def test_release_sft_rejects_duplicate_manifest_json_keys(self):
        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            manifest = os.path.join(tmp, "sources.json")
            with open(manifest, "w", encoding="utf-8") as f:
                f.write('{"schema_version":"wrong","schema_version":"guru-code-source-manifest-v1","sources":[]}')
            with self.assertRaisesRegex(CodingDataError, "duplicate JSON object key"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"), profile="release", source_manifest=manifest)

    def test_release_sft_binds_reviewed_sources_and_emits_provenance_sidecar(self):
        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            rows, manifest = reviewed_release_fixture(rows, tmp)
            output = os.path.join(tmp, "release-pairs.jsonl")
            self.assertEqual(write_sft(rows, output, profile="release", source_manifest=manifest), 2)
            with open(output, encoding="utf-8") as f:
                pairs = [json.loads(line) for line in f]
            with open(output + ".provenance.json", encoding="utf-8") as f:
                sidecar = json.load(f)
            self.assertEqual(len(pairs), 2)
            self.assertNotIn("eval-001", "\n".join(p["prompt"] for p in pairs))
            self.assertEqual(sidecar["profile"], "release")
            self.assertEqual(sidecar["task_ids"], ["train-001", "train-002"])
            self.assertEqual(sidecar["train_count"], 2)
            with open(output, "rb") as f: output_bytes = f.read()
            self.assertEqual(sidecar["sft_sha256"], hashlib.sha256(output_bytes).hexdigest())
            with self.assertRaisesRegex(CodingDataError, "already exists"):
                write_sft(rows, output, profile="release", source_manifest=manifest)
            os.unlink(output + ".provenance.json")
            self.assertEqual(write_sft(rows, output, profile="release", source_manifest=manifest), 2)
            self.assertTrue(os.path.exists(output + ".provenance.json"))

    def test_release_sft_rejects_unapproved_or_missing_training_permission(self):
        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            rows, manifest = reviewed_release_fixture(rows, tmp, train_uses=())
            with self.assertRaisesRegex(CodingDataError, "not approved for train_sft"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"), profile="release", source_manifest=manifest)

    def test_release_sft_requires_reviewed_evaluation_use_and_resolved_license(self):
        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            rows, manifest = reviewed_release_fixture(rows, tmp, eval_uses=())
            with self.assertRaisesRegex(CodingDataError, "not approved for evaluation"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"), profile="release", source_manifest=manifest)

    def test_release_sft_requires_a_held_out_eval_split(self):
        rows = [row for row in read_tasks(TASKS) if row["split"] == "train"]
        with tempfile.TemporaryDirectory() as tmp:
            rows, manifest = reviewed_release_fixture(rows, tmp)
            with self.assertRaisesRegex(CodingDataError, "both train and held-out eval"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"), profile="release", source_manifest=manifest)

    def test_release_sft_verifies_saved_source_item_bytes(self):
        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            rows, manifest = reviewed_release_fixture(rows, tmp)
            ref = rows[0]["provenance"]["source_refs"][0]
            with open(os.path.join(tmp, ref["item_path"]), "ab") as f: f.write(b"changed")
            with self.assertRaisesRegex(CodingDataError, "does not match its saved source item"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"), profile="release", source_manifest=manifest)

    def test_release_sft_rejects_duplicate_item_bytes_across_sources(self):
        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            rows, manifest = reviewed_release_fixture(rows, tmp)
            train_ref = rows[0]["provenance"]["source_refs"][0]
            eval_ref = rows[-1]["provenance"]["source_refs"][0]
            eval_ref["item_id"] = "renamed-duplicate-item"
            eval_ref["source_id"] = "source-train"
            eval_ref["item_path"] = train_ref["item_path"]
            eval_ref["item_sha256"] = train_ref["item_sha256"]
            with open(manifest, encoding="utf-8") as f: payload = json.load(f)
            payload["sources"][0]["rights_review"]["allowed_uses"].append("evaluation")
            payload["sources"][0]["task_hashes"][rows[-1]["id"]] = canonical_sha256(rows[-1])
            del payload["sources"][1]["task_hashes"][rows[-1]["id"]]
            with open(manifest, "w", encoding="utf-8") as f: json.dump(payload, f, sort_keys=True)
            with self.assertRaisesRegex(CodingDataError, "appears in both train and eval"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"), profile="release", source_manifest=manifest)

        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            rows, manifest = reviewed_release_fixture(rows, tmp)
            with open(manifest, encoding="utf-8") as f: payload = json.load(f)
            payload["sources"][0]["license"]["id"] = "REVIEW_REQUIRED"
            with open(manifest, "w", encoding="utf-8") as f: json.dump(payload, f)
            with self.assertRaisesRegex(CodingDataError, "license.id is unresolved"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"), profile="release", source_manifest=manifest)

    def test_release_sft_rejects_unsafe_manifest_paths_and_missing_task_links(self):
        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            rows, manifest = reviewed_release_fixture(rows, tmp)
            with open(manifest, encoding="utf-8") as f: payload = json.load(f)
            payload["sources"][0]["artifact_path"] = "../outside.bin"
            with open(manifest, "w", encoding="utf-8") as f: json.dump(payload, f)
            with self.assertRaisesRegex(CodingDataError, "stay inside the source manifest directory"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"), profile="release", source_manifest=manifest)

        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            rows, manifest = reviewed_release_fixture(rows, tmp)
            with open(manifest, encoding="utf-8") as f: payload = json.load(f)
            del payload["sources"][1]["task_hashes"]["eval-003"]
            with open(manifest, "w", encoding="utf-8") as f: json.dump(payload, f)
            with self.assertRaisesRegex(CodingDataError, "absent from the reviewed source manifest"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"), profile="release", source_manifest=manifest)

    def test_release_sft_rejects_stale_task_or_source_artifact_hashes(self):
        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            rows, manifest = reviewed_release_fixture(rows, tmp)
            rows[0]["target"]["summary"] = "Changed after rights review."
            with self.assertRaisesRegex(CodingDataError, "changed after source review"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"), profile="release", source_manifest=manifest)

        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            rows, manifest = reviewed_release_fixture(rows, tmp)
            with open(os.path.join(tmp, "source-train.bin"), "ab") as f: f.write(b"changed")
            with self.assertRaisesRegex(CodingDataError, "does not match the source artifact"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"), profile="release", source_manifest=manifest)

    def test_release_sft_rejects_cross_split_leakage_even_with_different_task_ids(self):
        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            rows, manifest = reviewed_release_fixture(rows, tmp)
            rows[0]["leakage_group"] = rows[-1]["leakage_group"]
            # Re-sign the changed row in its reviewed source. The split policy
            # must still reject it; a changed ID or manifest hash is not enough.
            with open(manifest, encoding="utf-8") as f: payload = json.load(f)
            payload["sources"][0]["task_hashes"][rows[0]["id"]] = canonical_sha256(rows[0])
            with open(manifest, "w", encoding="utf-8") as f: json.dump(payload, f, sort_keys=True)
            with self.assertRaisesRegex(CodingDataError, "leakage group"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"), profile="release", source_manifest=manifest)

    def test_release_sft_rejects_duplicate_prompt_or_source_item_across_splits(self):
        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            rows, manifest = reviewed_release_fixture(rows, tmp)
            rows[-1]["prompt"] = rows[0]["prompt"]
            rows[-1]["rubric"] = rows[0]["rubric"]
            with open(manifest, encoding="utf-8") as f: payload = json.load(f)
            payload["sources"][1]["task_hashes"][rows[-1]["id"]] = canonical_sha256(rows[-1])
            with open(manifest, "w", encoding="utf-8") as f: json.dump(payload, f, sort_keys=True)
            with self.assertRaisesRegex(CodingDataError, "prompt/rubric content is duplicated"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"), profile="release", source_manifest=manifest)

        rows = read_tasks(TASKS)
        with tempfile.TemporaryDirectory() as tmp:
            rows, manifest = reviewed_release_fixture(rows, tmp)
            rows[-1]["provenance"]["source_refs"][0]["item_id"] = rows[0]["provenance"]["source_refs"][0]["item_id"]
            rows[-1]["provenance"]["source_refs"][0]["source_id"] = "source-train"
            with open(manifest, encoding="utf-8") as f: payload = json.load(f)
            payload["sources"][0]["rights_review"]["allowed_uses"].append("evaluation")
            payload["sources"][0]["task_hashes"][rows[-1]["id"]] = canonical_sha256(rows[-1])
            del payload["sources"][1]["task_hashes"][rows[-1]["id"]]
            with open(manifest, "w", encoding="utf-8") as f: json.dump(payload, f, sort_keys=True)
            with self.assertRaisesRegex(CodingDataError, "appears in both train and eval"):
                write_sft(rows, os.path.join(tmp, "pairs.jsonl"), profile="release", source_manifest=manifest)

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
