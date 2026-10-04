"""Focused tests for standalone Guru model-intake structural validation."""
import copy
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from guru.model_intake import (ModelIntakeError, has_approved_review_record,
                               validate_model_intake)


def sha(char):
    return char * 64


def evidence(ref_id, covers):
    return {"ref_id": ref_id, "kind": "review-record", "sha256": sha("f"),
            "covers": list(covers), "uri": "local:review-record"}


def complete_record(role="teacher"):
    permissions = {
        "weights_use": "approved",
        "weights_modification": "not_applicable",
        "weights_distribution": "not_applicable",
        "teacher_output_training": "approved",
        "input_transmission": "approved",
        "input_retention": "denied",
        "provider_training_on_inputs": "denied",
    }
    roles = {"student_base": False, "teacher": False, "runtime_only": False}
    roles[role] = True
    if role == "student_base":
        permissions["weights_modification"] = "approved"
        permissions["teacher_output_training"] = "not_applicable"
        permissions["input_transmission"] = "not_applicable"
        permissions["input_retention"] = "not_applicable"
        permissions["provider_training_on_inputs"] = "not_applicable"
    elif role == "runtime_only":
        permissions["teacher_output_training"] = "not_applicable"
        permissions["input_transmission"] = "not_applicable"
        permissions["input_retention"] = "not_applicable"
        permissions["provider_training_on_inputs"] = "not_applicable"
    all_permissions = list(permissions)
    return {
        "schema_version": "guru-code-model-intake-v1",
        "intake_id": "model-intake-001", "model_id": "candidate-model",
        "model_sha256": sha("a"), "adapter_sha256": None,
        "intended_use": "local experiment",
        **roles,
        "tokenizer": {"id": "tokenizer", "revision": "rev-1", "sha256": sha("b")},
        "context_tokens": 4096,
        "runtime": {"name": "local-runtime", "version": "1.0", "artifact_sha256": sha("c")},
        "permissions": {
            **permissions, "permitted_scopes": ["local evaluation"],
            "evidence_refs": [evidence("permissions-1", all_permissions)],
        },
        "review": {"status": "approved", "reviewer": "reviewer-1",
                   "reviewed_at": "2026-10-04T12:00:00Z",
                   "notes_ref": evidence("approval-notes", all_permissions)},
        "lineage": {"base_model_intake_id": None, "parent_model_intake_ids": [],
                    "source_manifest_refs": ["source-manifest:sha256:abc"],
                    "task_refs": [], "trajectory_refs": [], "teacher_output_refs": [],
                    "derived_artifact_refs": []},
    }


class ModelIntakeTests(unittest.TestCase):
    def test_accepts_structurally_complete_approved_roles(self):
        for role in ("student_base", "teacher", "runtime_only"):
            with self.subTest(role=role):
                record = complete_record(role)
                validate_model_intake(record)
                self.assertTrue(has_approved_review_record(record))

    def test_rejects_blank_example_as_non_admitted(self):
        path = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                            "data", "coding", "model-intake.example.json")
        with open(path, encoding="utf-8") as stream:
            example = json.load(stream)
        with self.assertRaises(ModelIntakeError):
            validate_model_intake(example)
        self.assertFalse(example["student_base"] or example["teacher"] or example["runtime_only"])
        self.assertEqual(example["review"]["status"], "pending_review")

    def test_requires_exactly_one_role_and_real_booleans(self):
        record = complete_record()
        record["runtime_only"] = True
        with self.assertRaisesRegex(ModelIntakeError, "exactly one"):
            validate_model_intake(record)
        record = complete_record()
        record["teacher"] = 1
        with self.assertRaisesRegex(ModelIntakeError, "exactly one"):
            validate_model_intake(record)

    def test_requires_model_tokenizer_runtime_and_adapter_digests(self):
        for path in (("model_sha256",), ("tokenizer", "sha256"), ("runtime", "artifact_sha256")):
            record = complete_record()
            target = record
            for part in path[:-1]:
                target = target[part]
            target[path[-1]] = "not-a-digest"
            with self.subTest(path=path), self.assertRaisesRegex(ModelIntakeError, "SHA-256"):
                validate_model_intake(record)
        record = complete_record()
        record["adapter_sha256"] = "bad"
        with self.assertRaisesRegex(ModelIntakeError, "adapter_sha256"):
            validate_model_intake(record)

    def test_rejects_approval_while_any_permission_is_pending(self):
        record = complete_record()
        record["permissions"]["input_retention"] = "pending_review"
        with self.assertRaisesRegex(ModelIntakeError, "remain pending"):
            validate_model_intake(record)

    def test_approval_requires_role_specific_grants(self):
        record = complete_record("student_base")
        record["permissions"]["weights_modification"] = "denied"
        with self.assertRaisesRegex(ModelIntakeError, "weights_modification"):
            validate_model_intake(record)

    def test_evidence_refs_are_shape_checked_not_resolved(self):
        record = complete_record()
        record["permissions"]["evidence_refs"] = [{
            "ref_id": "anything", "kind": "review-record", "sha256": sha("f"),
            "covers": [name for name in record["permissions"]
                       if name in {"weights_use", "weights_modification", "weights_distribution",
                                   "teacher_output_training", "input_transmission", "input_retention"}],
            "uri": "https://example.invalid/not-fetched",
        }]
        with self.assertRaisesRegex(ModelIntakeError, "covering every permission"):
            validate_model_intake(record)
        record = complete_record()
        record["permissions"]["evidence_refs"][0]["uri"] = "https://example.invalid/locator"
        validate_model_intake(record)

    def test_pending_record_is_valid_but_not_admitted(self):
        record = complete_record("runtime_only")
        record["review"] = {"status": "pending_review", "reviewer": "", "reviewed_at": None,
                            "notes_ref": None}
        self.assertFalse(has_approved_review_record(record))


if __name__ == "__main__":
    unittest.main()
