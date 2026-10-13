"""Fail-closed binding tests for the owner-selected student model."""
import json
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from guru import __main__ as guru_cli
from guru.lora_recipe import LoraSftRecipe, recipe_sha256
from guru.student_intake_binding import bind_student_intake, inspect_student_intake_files
from test_model_intake import complete_record, sha


RECIPE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "experiments",
                           "recipes", "qwen25_coder_15b_lora_sft.v1.json")


def selected_recipe():
    with open(RECIPE_PATH, encoding="utf-8") as stream:
        recipe = json.load(stream)
    recipe["base_model"]["weights_sha256"] = sha("a")
    recipe["base_model"]["tokenizer_sha256"] = sha("b")
    return recipe


def pending_student_record(recipe):
    record = complete_record("student_base")
    record["model_id"] = recipe["base_model"]["model_id"]
    record["model_revision"] = recipe["base_model"]["revision"]
    record["model_sha256"] = recipe["base_model"]["weights_sha256"]
    record["tokenizer"] = {
        "id": recipe["base_model"]["model_id"],
        "revision": recipe["base_model"]["revision"],
        "sha256": recipe["base_model"]["tokenizer_sha256"],
    }
    record["review"] = {"status": "pending_review", "reviewer": None,
                        "reviewed_at": None, "notes_ref": None}
    record["permissions"]["weights_use"] = "pending_review"
    record["permissions"]["weights_modification"] = "pending_review"
    record["recipe_binding"] = {
        "recipe_id": recipe["recipe_id"],
        "recipe_schema_version": recipe["schema_version"],
        "recipe_sha256": recipe_sha256(LoraSftRecipe.model_validate(recipe)),
    }
    record["license"] = "Apache-2.0"
    return record


def approved_student_record(recipe):
    record = pending_student_record(recipe)
    covered_permissions = list(record["permissions"]["evidence_refs"][0]["covers"])
    record["review"] = {
        "status": "approved", "reviewer": "owner-reviewer",
        "reviewed_at": "2026-10-13T10:00:00Z",
        "notes_ref": {"ref_id": "approval-notes", "kind": "review-record",
                      "sha256": sha("f"), "covers": covered_permissions},
    }
    record["permissions"]["weights_use"] = "approved"
    record["permissions"]["weights_modification"] = "approved"
    return record


class StudentIntakeBindingTests(unittest.TestCase):
    def test_fully_matching_approved_student_intake_can_match(self):
        recipe = selected_recipe()
        report = bind_student_intake(approved_student_record(recipe), recipe)
        self.assertEqual(report["status"], "matched")
        self.assertEqual(report["blockers"], [])
        for field in ("model_loading", "tokenizer_loading", "download_started", "training_started"):
            self.assertIs(report[field], False)

    def test_matching_pending_intake_blocks_until_review_and_permissions(self):
        recipe = selected_recipe()
        report = bind_student_intake(pending_student_record(recipe), recipe)
        self.assertEqual(report["status"], "blocked")
        self.assertIn("Student-base intake review is not approved.", report["blockers"])
        self.assertIn("Student-base weight-use permission is not approved.", report["blockers"])
        self.assertIn("Student-base weight-modification permission is not approved.", report["blockers"])

    def test_missing_intake_file_blocks_and_never_creates_it(self):
        recipe = selected_recipe()
        with tempfile.TemporaryDirectory() as directory:
            intake_path = os.path.join(directory, "student-base-intake.json")
            recipe_path = os.path.join(directory, "recipe.json")
            with open(recipe_path, "w", encoding="utf-8") as stream:
                json.dump(recipe, stream)
            report = inspect_student_intake_files("student-base-intake.json", "recipe.json", guru_root=directory)
            self.assertEqual(report["status"], "blocked")
            self.assertTrue(any("unavailable" in blocker for blocker in report["blockers"]))
            self.assertFalse(os.path.exists(intake_path))

    def test_intake_symlink_is_rejected(self):
        recipe = selected_recipe()
        with tempfile.TemporaryDirectory() as directory:
            record_path = os.path.join(directory, "record.json")
            intake_path = os.path.join(directory, "student-base-intake.json")
            recipe_path = os.path.join(directory, "recipe.json")
            with open(record_path, "w", encoding="utf-8") as stream:
                json.dump(pending_student_record(recipe), stream)
            with open(recipe_path, "w", encoding="utf-8") as stream:
                json.dump(recipe, stream)
            os.symlink(record_path, intake_path)
            report = inspect_student_intake_files("student-base-intake.json", "recipe.json", guru_root=directory)
            self.assertEqual(report["status"], "blocked")
            self.assertTrue(any("symbolic links" in blocker for blocker in report["blockers"]))

    def test_duplicate_identity_or_rights_keys_are_rejected_for_both_json_files(self):
        recipe = selected_recipe()
        with tempfile.TemporaryDirectory() as directory:
            intake_path = os.path.join(directory, "student-base-intake.json")
            recipe_path = os.path.join(directory, "recipe.json")
            with open(intake_path, "w", encoding="utf-8") as stream:
                stream.write('{"schema_version":"one","schema_version":"two"}')
            with open(recipe_path, "w", encoding="utf-8") as stream:
                json.dump(recipe, stream)
            intake_report = inspect_student_intake_files("student-base-intake.json", "recipe.json", guru_root=directory)
            self.assertEqual(intake_report["status"], "blocked")
            self.assertTrue(any("duplicate JSON key: schema_version" in x for x in intake_report["blockers"]))

            with open(intake_path, "w", encoding="utf-8") as stream:
                json.dump(approved_student_record(recipe), stream)
            with open(recipe_path, "w", encoding="utf-8") as stream:
                stream.write('{"recipe_id":"one","recipe_id":"two"}')
            recipe_report = inspect_student_intake_files("student-base-intake.json", "recipe.json", guru_root=directory)
            self.assertEqual(recipe_report["status"], "blocked")
            self.assertTrue(any("duplicate JSON key: recipe_id" in x for x in recipe_report["blockers"]))

    def test_symlinked_parent_directory_is_rejected(self):
        recipe = selected_recipe()
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            os.mkdir(os.path.join(directory, "data"))
            outside_record = os.path.join(outside, "student-base-intake.json")
            with open(outside_record, "w", encoding="utf-8") as stream:
                json.dump(pending_student_record(recipe), stream)
            os.symlink(outside, os.path.join(directory, "data", "coding"))
            recipe_path = os.path.join(directory, "recipe.json")
            with open(recipe_path, "w", encoding="utf-8") as stream:
                json.dump(recipe, stream)
            intake_path = os.path.join(directory, "data", "coding", "student-base-intake.json")
            report = inspect_student_intake_files(os.path.join("data", "coding", "student-base-intake.json"),
                                                  "recipe.json", guru_root=directory)
            self.assertEqual(report["status"], "blocked")
            self.assertTrue(any("symbolic link" in blocker for blocker in report["blockers"]))

    def test_wrong_id_revision_and_artifact_digests_block(self):
        recipe = selected_recipe()
        for field, value, expected in (
            ("model_id", "another/model", "Intake model id does not match"),
            ("model_revision", "f" * 40, "Intake model revision does not match"),
            ("model_sha256", sha("c"), "Intake model-weight digest does not match"),
        ):
            record = pending_student_record(recipe)
            record[field] = value
            with self.subTest(field=field):
                self.assertTrue(any(expected in x for x in bind_student_intake(record, recipe)["blockers"]))
        record = pending_student_record(recipe)
        record["tokenizer"]["sha256"] = sha("d")
        self.assertIn("Intake tokenizer digest does not match the selected recipe.",
                      bind_student_intake(record, recipe)["blockers"])

    def test_wrong_recipe_identity_or_digest_blocks(self):
        recipe = selected_recipe()
        record = pending_student_record(recipe)
        record["recipe_binding"]["recipe_id"] = "other-recipe"
        record["recipe_binding"]["recipe_sha256"] = sha("e")
        report = bind_student_intake(record, recipe)
        self.assertIn("Intake recipe id does not match the selected recipe.", report["blockers"])
        self.assertIn("Intake recipe digest does not match the selected recipe.", report["blockers"])

    def test_approved_review_with_insufficient_permissions_blocks(self):
        recipe = selected_recipe()
        record = pending_student_record(recipe)
        record["review"] = {"status": "approved", "reviewer": "reviewer",
                            "reviewed_at": "2026-10-13T10:00:00Z",
                            "notes_ref": {"ref_id": "notes", "kind": "review",
                                          "sha256": sha("f"),
                                          "covers": ["weights_use", "weights_modification"]}}
        record["permissions"]["weights_use"] = "approved"
        record["permissions"]["weights_modification"] = "denied"
        report = bind_student_intake(record, recipe)
        self.assertTrue(any("approved review conflicts with required permissions: weights_modification" in blocker
                            for blocker in report["blockers"]))

    def test_license_never_substitutes_for_explicit_rights_or_approval(self):
        recipe = selected_recipe()
        record = pending_student_record(recipe)
        record["license"] = "Apache-2.0"
        report = bind_student_intake(record, recipe)
        self.assertEqual(report["status"], "blocked")
        self.assertTrue(any("permission is not approved" in blocker for blocker in report["blockers"]))

    def test_recipe_missing_exact_pins_blocks_even_if_intake_has_digests(self):
        recipe = selected_recipe()
        recipe["base_model"]["weights_sha256"] = None
        recipe["base_model"]["tokenizer_sha256"] = None
        record = pending_student_record(selected_recipe())
        report = bind_student_intake(record, recipe)
        self.assertTrue(any("digest is missing from the selected recipe" in blocker for blocker in report["blockers"]))

    def test_report_proves_no_download_load_or_training(self):
        report = bind_student_intake(pending_student_record(selected_recipe()), selected_recipe())
        for field in ("model_loading", "tokenizer_loading", "download_started", "training_started"):
            self.assertIs(report[field], False)

    def test_student_intake_preflight_cli_success_is_metadata_only(self):
        recipe = selected_recipe()
        with tempfile.TemporaryDirectory(prefix="student-intake-cli-") as directory:
            intake_path = os.path.join(directory, "student-base-intake.json")
            recipe_path = os.path.join(directory, "recipe.json")
            with open(intake_path, "w", encoding="utf-8") as stream:
                json.dump(approved_student_record(recipe), stream)
            with open(recipe_path, "w", encoding="utf-8") as stream:
                json.dump(recipe, stream)
            output = io.StringIO()
            with patch.object(guru_cli, "HERE", directory), redirect_stdout(output):
                guru_cli.main(["student-intake-preflight", "--intake", intake_path,
                               "--recipe", recipe_path])
            report = json.loads(output.getvalue())
            self.assertEqual(report["status"], "matched")
            self.assertEqual(report["blockers"], [])
            for field in ("model_loading", "tokenizer_loading", "download_started", "training_started"):
                self.assertIs(report[field], False)


if __name__ == "__main__":
    unittest.main()
