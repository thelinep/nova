"""Fail-closed, no-write contract tests for reviewed trajectory bindings."""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import hashlib
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from guru.coding import SOURCE_MANIFEST_SCHEMA, canonical_sha256
from guru.trajectory_binding import (GOLD_BINDING_POLICY,
    TrajectoryBindingError, TrajectoryReviewBinding, TrajectoryTaskBinding,
    bind_trajectory_to_task)
from guru.schemas.trajectory import Trajectory
from guru.trajectories import SCHEMA_VERSION


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def object_sha(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def reseal_task_and_trajectory(inputs):
    """Resign structural pins so a negative case reaches its intended check."""
    task = inputs["task"]
    task_sha = canonical_sha256(task)
    inputs["trajectory"]["task_ref"]["task_sha256"] = task_sha
    for source in inputs["source_manifest"]["sources"]:
        source["task_hashes"] = {task["id"]: task_sha}
    inputs["expected_source_manifest_sha256"] = object_sha(inputs["source_manifest"])
    trajectory_sha = canonical_sha256(inputs["trajectory"])
    inputs["expected_trajectory_sha256"] = trajectory_sha
    inputs["review_binding"]["trajectory_sha256"] = trajectory_sha
    inputs["trajectory_set"] = [inputs["trajectory"]]
    return inputs


def make_inputs():
    item_sha = sha("curated source item")
    artifact_sha = sha("immutable source archive")
    model_sha = sha("approved local teacher model")
    decision = {
        "schema_version": "guru-source-rights-v2",
        "source_id": "source-a",
        "uri": "local:source-a",
        "revision": "revision-1",
        "artifact_sha256": artifact_sha,
        "provenance_statement": "Reviewed source artifact.",
        "authority_basis": "direct_permission",
        "authority_description": "Explicit local review fixture.",
        "rights": {
            "allow_training": True,
            "allow_evaluation": True,
            "allow_ephemeral_transformation": True,
            "allow_transformed_data_retention": False,
            "allow_provider_transmission": False,
            "allow_weight_distribution": False,
        },
        "reviewer": "rights-reviewer",
        "decided_at": "2026-10-13T10:00:00Z",
        "evidence_refs": [{"evidence_id": "source-license", "uri": "local:license",
                           "sha256": sha("license evidence")}],
    }
    decision_sha = object_sha(decision)
    task = {
        "schema_version": "guru-code-task-v1",
        "id": "task-001",
        "split": "train",
        "family_id": "family-001",
        "leakage_group": "group-001",
        "language": "python",
        "prompt": "Implement the reviewed task.",
        "provenance": {
            "kind": "reviewed-source",
            "description": "Task derived from one pinned source item.",
            "source_refs": [{"source_id": "source-a", "item_id": "item-001",
                             "item_sha256": item_sha, "item_path": "item.txt",
                             "transformation": "reviewed task formulation"}],
        },
        "rubric": {"expected_files": ["answer.py"], "required_symbols": {},
                   "required_test_snippets": ["expected result"]},
        "target": {"summary": "Implement the expected helper.", "files": [
            {"path": "answer.py", "content": "def answer():\n    return 1\n"}], "tests": ["assert answer() == 1"]},
    }
    task_sha = canonical_sha256(task)
    source_manifest = {
        "schema_version": SOURCE_MANIFEST_SCHEMA,
        "sources": [{
            "source_id": "source-a", "uri": "local:source-a", "revision": "revision-1",
            "artifact_sha256": artifact_sha, "attribution": "Local reviewed fixture.",
            "task_hashes": {"task-001": task_sha},
        }],
    }
    source_manifest_sha = object_sha(source_manifest)
    trajectory = {
        "schema_version": SCHEMA_VERSION,
        "trajectory_id": "trajectory-001",
        "split": "train",
        "task_ref": {"task_id": "task-001", "task_schema_version": task["schema_version"],
                     "task_sha256": task_sha, "family_id": "family-001", "split": "train"},
        "leakage_group": "group-001",
        "prompt_refs": [{"source_id": "source-a", "item_id": "item-001", "item_sha256": item_sha}],
        "context_refs": [{"source_id": "source-a", "item_id": "item-001", "item_sha256": item_sha}],
        "source_refs": [{"source_id": "source-a", "item_id": "item-001", "item_sha256": item_sha}],
        "rights_refs": [{"source_id": "source-a", "item_id": "item-001",
                          "item_sha256": item_sha, "rights_decision_sha256": decision_sha}],
        "turns": [{
            "turn_id": "turn-001", "speaker": "teacher-candidate", "role": "coder",
            "model": {"model_id": "teacher-candidate", "model_sha256": model_sha,
                      "adapter_sha256": None},
            "prompt_ref": {"source_id": "source-a", "item_id": "item-001", "item_sha256": item_sha},
            "context_refs": [{"source_id": "source-a", "item_id": "item-001", "item_sha256": item_sha}],
            "task_ref": {"source_id": "source-a", "item_id": "item-001", "item_sha256": item_sha},
            "action": {"kind": "message", "name": "propose", "result": "Implement the helper.",
                       "input_ref": {"source_id": "source-a", "item_id": "item-001", "item_sha256": item_sha}},
            "patch_refs": [], "review_disposition": "accepted",
            "evaluator_evidence": {"status": "passed", "refs": [
                {"source_id": "evaluator", "item_id": "case-001", "item_sha256": sha("case result")}]},
        }],
    }
    trajectory_sha = canonical_sha256(trajectory)
    review = {
        "trajectory_id": "trajectory-001",
        "project_snapshot": {"repository_id": "repo-a", "revision": "rev-a",
                             "snapshot_digest": item_sha, "file_digests": {}},
        "acceptance_checks": [{"check_id": "case-001", "description": "Expected result",
                               "required": True, "evidence_digest": sha("acceptance evidence")}],
        "turns": [{"turn_index": 0, "role": "human", "action_type": "decision",
                   "content": "Reviewed the evidence.", "evidence": []}],
        "human_adjudication": {"required": True, "decision": "approved",
                               "reviewer_id": "human-reviewer",
                               "decided_at": "2026-10-13T11:00:00Z",
                               "notes_digest": sha("review notes")},
        "final_outcome": "approved",
        "training_eligibility": {"eligible": True, "reason_codes": [],
                                 "policy_version": GOLD_BINDING_POLICY},
        "leakage_group": "group-001",
        "created_at": "2026-10-13T09:00:00Z",
    }
    teacher = {
        "teacher_id": "teacher-candidate", "model_name": "Local reviewed teacher",
        "license": "Reviewed local terms", "terms_url": None,
        "access_method": "local", "output_rights": "may_train",
        "review_status": "approved", "reviewed_by": "teacher-reviewer",
        "reviewed_at": "2026-10-13T08:00:00Z", "adapter_digests": [],
        "model_digest": [model_sha],
        "input_disclosure": {"allowed_input_types": ["traces"],
                              "confidentiality_required": False,
                              "provider_trains_on_inputs": False,
                              "retention_bounded": True, "retention_days": 0,
                              "logging_allowed": False},
    }
    return {
        "trajectory": trajectory,
        "trajectory_set": [trajectory],
        "expected_trajectory_sha256": trajectory_sha,
        "review_binding": {"schema_version": "guru-trajectory-review-binding-v1",
                           "trajectory_id": "trajectory-001",
                           "trajectory_sha256": trajectory_sha,
                           "review": review},
        "task": task,
        "source_manifest": source_manifest,
        "expected_source_manifest_sha256": source_manifest_sha,
        "rights_decisions": [decision],
        "teacher_lineages": [teacher],
    }


class TrajectoryTaskBindingTests(unittest.TestCase):
    def bind(self, inputs=None):
        return bind_trajectory_to_task(**(inputs or make_inputs()))

    def test_approved_complete_binding_returns_digest_only_i7_blocked_record(self):
        result = self.bind()
        self.assertIsInstance(result, TrajectoryTaskBinding)
        self.assertTrue(result.review_record_bound)
        self.assertFalse(result.human_adjudicated_candidate)
        self.assertFalse(result.gold_candidate_eligible)
        self.assertFalse(result.training_use_allowed)
        self.assertEqual(result.split, "train")
        self.assertEqual(result.blockers, [
            "qualified evaluator and bound case evidence are unavailable",
            "I7 denies persisted transformed-data retention and corpus assembly",
        ])
        self.assertRegex(result.trajectory_sha256, r"^[0-9a-f]{64}$")
        self.assertRegex(result.task_sha256, r"^[0-9a-f]{64}$")
        self.assertRegex(result.source_manifest_sha256, r"^[0-9a-f]{64}$")
        self.assertRegex(result.binding_sha256, r"^[0-9a-f]{64}$")
        self.assertNotIn("Implement the reviewed task", result.model_dump_json())
        self.assertNotIn("Implement the helper", result.model_dump_json())

    def test_binding_is_pure_and_performs_no_file_writes_or_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            before = set(os.listdir(directory))
            with patch("builtins.open", side_effect=AssertionError("file access")):
                result = self.bind()
            self.assertFalse(result.gold_candidate_eligible)
            self.assertEqual(set(os.listdir(directory)), before)

    def test_task_and_trajectory_digest_drift_block(self):
        inputs = make_inputs()
        inputs["trajectory"]["turns"][0]["action"]["result"] = "changed"
        with self.assertRaisesRegex(TrajectoryBindingError, "trajectory digest drift"):
            self.bind(inputs)

        inputs = make_inputs()
        inputs["task"]["prompt"] = "changed task"
        with self.assertRaisesRegex(TrajectoryBindingError, "task digest drift"):
            self.bind(inputs)

    def test_source_manifest_and_rights_digest_drift_block(self):
        inputs = make_inputs()
        inputs["source_manifest"]["sources"][0]["revision"] = "changed"
        with self.assertRaisesRegex(TrajectoryBindingError, "source manifest digest drift"):
            self.bind(inputs)

        inputs = make_inputs()
        inputs["rights_decisions"][0]["reviewer"] = "changed"
        with self.assertRaisesRegex(TrajectoryBindingError, "rights decision digest drift"):
            self.bind(inputs)

    def test_review_must_be_pinned_to_exact_trajectory_and_approved(self):
        inputs = make_inputs()
        inputs["review_binding"]["trajectory_sha256"] = sha("different trace")
        with self.assertRaisesRegex(TrajectoryBindingError, "human review does not bind exact trajectory digest"):
            self.bind(inputs)

        for outcome in ("pending", "rejected", "quarantined"):
            inputs = make_inputs()
            inputs["review_binding"]["review"]["final_outcome"] = outcome
            with self.subTest(outcome=outcome), self.assertRaisesRegex(
                TrajectoryBindingError, "human review record is missing or invalid|final outcome is not approved"
            ):
                self.bind(inputs)

    def test_trace_mutation_and_resealed_caller_pins_do_not_reuse_old_review(self):
        inputs = make_inputs()
        inputs["trajectory"]["turns"][0]["action"]["result"] = "mutated after review"
        inputs["expected_trajectory_sha256"] = canonical_sha256(inputs["trajectory"])
        inputs["trajectory_set"] = [inputs["trajectory"]]
        # The caller recomputed the ordinary trace pin, but the old, approved
        # review envelope remains bound to its original trace digest.
        with self.assertRaisesRegex(TrajectoryBindingError,
                                   "human review does not bind exact trajectory digest"):
            self.bind(inputs)

    def test_arbitrary_passed_evaluator_refs_never_qualify_gold(self):
        inputs = make_inputs()
        inputs["trajectory"]["turns"][0]["evaluator_evidence"] = {
            "status": "passed", "refs": [{
                "source_id": "attacker-controlled-evaluator",
                "item_id": "arbitrary-case-result", "item_sha256": sha("unqualified pass"),
            }],
        }
        reseal_task_and_trajectory(inputs)
        result = self.bind(inputs)
        self.assertTrue(result.review_record_bound)
        self.assertFalse(result.human_adjudicated_candidate)
        self.assertFalse(result.gold_candidate_eligible)
        self.assertIn("qualified evaluator and bound case evidence are unavailable", result.blockers)
        self.assertFalse(result.training_use_allowed)

    def test_every_source_bearing_reference_requires_rights_bound_task_artifact(self):
        mutations = (
            (lambda trace: trace["prompt_refs"].append({
                "source_id": "unreviewed", "item_id": "prompt", "item_sha256": sha("prompt")}),
             "global prompt_refs"),
            (lambda trace: trace["context_refs"].append({
                "source_id": "unreviewed", "item_id": "context", "item_sha256": sha("context")}),
             "global context_refs"),
            (lambda trace: trace["turns"][0].update(prompt_ref={
                "source_id": "unreviewed", "item_id": "prompt", "item_sha256": sha("turn prompt")}),
             "turn prompt_ref"),
            (lambda trace: trace["turns"][0]["context_refs"].append({
                "source_id": "unreviewed", "item_id": "context", "item_sha256": sha("turn context")}),
             "turn context_refs"),
            (lambda trace: trace["turns"][0]["action"].update(input_ref={
                "source_id": "unreviewed", "item_id": "input", "item_sha256": sha("action input")}),
             "action.input_ref"),
            (lambda trace: trace["turns"][0].update(task_ref={
                "source_id": "unreviewed", "item_id": "task", "item_sha256": sha("turn task")}),
             "turn task_ref"),
        )
        for mutate, label in mutations:
            inputs = make_inputs()
            mutate(inputs["trajectory"])
            reseal_task_and_trajectory(inputs)
            with self.subTest(reference=label), self.assertRaisesRegex(
                TrajectoryBindingError, "source-bearing trajectory reference lacks a matching task source artifact"
            ):
                self.bind(inputs)

    def test_untyped_patch_references_fail_closed_and_evaluator_refs_stay_untrusted(self):
        inputs = make_inputs()
        inputs["trajectory"]["turns"][0]["patch_refs"] = [{
            "path": "answer.py", "sha256": sha("generated patch"),
        }]
        reseal_task_and_trajectory(inputs)
        with self.assertRaisesRegex(TrajectoryBindingError, "patch_refs lack a typed source-rights classification"):
            self.bind(inputs)

        inputs = make_inputs()
        inputs["trajectory"]["turns"][0]["evaluator_evidence"]["refs"] = [{
            "source_id": "unreviewed-evaluator", "item_id": "case", "item_sha256": sha("case"),
        }]
        reseal_task_and_trajectory(inputs)
        result = self.bind(inputs)
        self.assertFalse(result.gold_candidate_eligible)
        self.assertNotIn("unreviewed-evaluator", result.model_dump_json())

    def test_pending_review_missing_reviewer_or_ineligible_record_blocks(self):
        inputs = make_inputs()
        inputs["review_binding"]["review"]["human_adjudication"]["decision"] = "pending"
        with self.assertRaisesRegex(
            TrajectoryBindingError,
            "human review binding envelope is missing or invalid|human adjudication does not approve",
        ):
            self.bind(inputs)

        inputs = make_inputs()
        inputs["review_binding"]["review"]["human_adjudication"]["reviewer_id"] = None
        with self.assertRaisesRegex(
            TrajectoryBindingError,
            "human review binding envelope is missing or invalid|human adjudication does not approve",
        ):
            self.bind(inputs)

        inputs = make_inputs()
        inputs["review_binding"]["review"]["training_eligibility"]["eligible"] = False
        with self.assertRaisesRegex(TrajectoryBindingError, "training eligibility is not approved"):
            self.bind(inputs)

    def test_required_acceptance_evidence_and_snapshot_lineage_are_required(self):
        inputs = make_inputs()
        inputs["review_binding"]["review"]["acceptance_checks"][0]["evidence_digest"] = None
        with self.assertRaisesRegex(TrajectoryBindingError, "acceptance-check evidence is incomplete"):
            self.bind(inputs)

        inputs = make_inputs()
        inputs["review_binding"]["review"]["project_snapshot"]["snapshot_digest"] = sha("unreferenced snapshot")
        with self.assertRaisesRegex(TrajectoryBindingError, "snapshot digest is missing"):
            self.bind(inputs)

    def test_task_identity_schema_family_group_and_train_split_must_match(self):
        for field, value, error in (
            ("id", "different-task", "task ID does not match"),
            ("schema_version", "guru-code-task-v2", "task schema version does not match"),
            ("family_id", "different-family", "family lineage mismatch"),
            ("leakage_group", "different-group", "leakage group mismatch"),
            ("split", "validation", "matching train split"),
        ):
            inputs = make_inputs()
            inputs["task"][field] = value
            if field == "split":
                inputs["task"]["schema_version"] = "guru-code-task-v2"
                inputs["trajectory"]["task_ref"]["task_schema_version"] = "guru-code-task-v2"
            reseal_task_and_trajectory(inputs)
            with self.subTest(field=field), self.assertRaisesRegex(TrajectoryBindingError, error):
                self.bind(inputs)

    def test_cross_split_task_family_or_group_conflicts_block(self):
        for changed in ("task", "family", "group"):
            inputs = make_inputs()
            peer = copy.deepcopy(inputs["trajectory"])
            peer["trajectory_id"] = "trajectory-002"
            peer["split"] = peer["task_ref"]["split"] = "eval"
            if changed == "task":
                peer["task_ref"]["task_id"] = inputs["task"]["id"]
                peer["task_ref"]["family_id"] = "family-other"
                peer["leakage_group"] = "group-other"
            elif changed == "family":
                peer["task_ref"]["task_id"] = "task-other"
                peer["task_ref"]["family_id"] = inputs["trajectory"]["task_ref"]["family_id"]
                peer["leakage_group"] = "group-other"
            else:
                peer["task_ref"]["task_id"] = "task-other"
                peer["task_ref"]["family_id"] = "family-other"
                peer["leakage_group"] = inputs["trajectory"]["leakage_group"]
            inputs["trajectory_set"] = [inputs["trajectory"], peer]
            with self.subTest(changed=changed), self.assertRaises(TrajectoryBindingError):
                self.bind(inputs)

    def test_missing_or_ambiguous_source_and_rights_lineage_blocks(self):
        inputs = make_inputs()
        inputs["trajectory"]["rights_refs"] = []
        with self.assertRaisesRegex(TrajectoryBindingError, "rights_refs must be a non-empty list"):
            self.bind(inputs)

        inputs = make_inputs()
        inputs["trajectory"]["rights_refs"][0].pop("rights_decision_sha256")
        inputs["expected_trajectory_sha256"] = canonical_sha256(inputs["trajectory"])
        inputs["review_binding"]["trajectory_sha256"] = inputs["expected_trajectory_sha256"]
        inputs["trajectory_set"] = [inputs["trajectory"]]
        with self.assertRaisesRegex(TrajectoryBindingError, "rights decision digest drift or missing"):
            self.bind(inputs)

        inputs = make_inputs()
        inputs["task"]["provenance"].pop("source_refs")
        reseal_task_and_trajectory(inputs)
        with self.assertRaisesRegex(TrajectoryBindingError, "task provenance source_refs are missing"):
            self.bind(inputs)

    def test_missing_source_manifest_task_binding_blocks(self):
        inputs = make_inputs()
        inputs["source_manifest"]["sources"][0]["task_hashes"]["task-001"] = sha("wrong task")
        inputs["expected_source_manifest_sha256"] = object_sha(inputs["source_manifest"])
        with self.assertRaisesRegex(TrajectoryBindingError, "task must resolve exactly once"):
            self.bind(inputs)

    def test_each_per_use_right_is_explicit_and_must_fit_i7(self):
        for field, value, message in (
            ("allow_training", False, "do not allow training"),
            ("allow_ephemeral_transformation", False, "do not allow ephemeral"),
            ("allow_evaluation", False, "do not allow evaluation"),
            ("allow_provider_transmission", True, "external-transmission denial"),
            ("allow_transformed_data_retention", True, "ephemeral-only retention"),
            ("allow_weight_distribution", True, "private-local weights"),
        ):
            inputs = make_inputs()
            inputs["rights_decisions"][0]["rights"][field] = value
            decision_sha = object_sha(inputs["rights_decisions"][0])
            inputs["trajectory"]["rights_refs"][0]["rights_decision_sha256"] = decision_sha
            inputs["expected_trajectory_sha256"] = canonical_sha256(inputs["trajectory"])
            inputs["review_binding"]["trajectory_sha256"] = inputs["expected_trajectory_sha256"]
            inputs["trajectory_set"] = [inputs["trajectory"]]
            with self.subTest(field=field), self.assertRaisesRegex(TrajectoryBindingError, message):
                self.bind(inputs)

    def test_teacher_must_be_admitted_local_and_exact_digest_with_trace_disclosure(self):
        mutations = (
            (lambda teacher: teacher.update(review_status="pending"), "not admitted for training"),
            (lambda teacher: teacher.update(access_method="api"), "external-transmission denial"),
            (lambda teacher: teacher.update(output_rights="research_only"), "not admitted for training"),
            (lambda teacher: teacher.update(model_digest=[sha("different model")]), "model digest mismatch"),
            (lambda teacher: teacher["input_disclosure"].update(allowed_input_types=["prompts"]),
             "does not allow trajectory traces"),
        )
        for mutate, message in mutations:
            inputs = make_inputs()
            mutate(inputs["teacher_lineages"][0])
            with self.subTest(message=message), self.assertRaisesRegex(TrajectoryBindingError, message):
                self.bind(inputs)

    def test_every_trajectory_turn_must_resolve_to_an_approved_teacher(self):
        inputs = make_inputs()
        inputs["teacher_lineages"] = []
        with self.assertRaisesRegex(TrajectoryBindingError, "missing approved teacher lineage"):
            self.bind(inputs)

    def test_non_train_task_is_not_a_gold_training_binding(self):
        inputs = make_inputs()
        inputs["trajectory"]["split"] = inputs["trajectory"]["task_ref"]["split"] = "validation"
        inputs["task"]["split"] = "validation"
        inputs["task"]["schema_version"] = "guru-code-task-v2"
        inputs["trajectory"]["task_ref"]["task_schema_version"] = "guru-code-task-v2"
        inputs["task"]["target"] = {"summary": "x", "files": [{"path": "x.py", "content": "x=1"}], "tests": ["x"]}
        reseal_task_and_trajectory(inputs)
        with self.assertRaisesRegex(TrajectoryBindingError, "task digest drift|matching train split"):
            self.bind(inputs)


if __name__ == "__main__":
    unittest.main()
