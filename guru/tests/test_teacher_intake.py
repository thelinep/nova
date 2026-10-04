from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
import unittest

from pydantic import ValidationError

from guru.schemas.teacher_lineage import AccessMethod, InputDisclosure, InputType, OutputRights, ReviewStatus, TeacherLineage
from guru.schemas.trajectory import ActionType, FinalOutcome, ProjectSnapshot, Role, Trajectory, Turn
from guru.teacher.intake import load_registry, validate_teacher


def approved_teacher(**overrides: Any) -> TeacherLineage:
    values = {
        "teacher_id": "t-1", "model_name": "approved-teacher",
        "license": "Apache-2.0",
        "access_method": AccessMethod.WEIGHTS, "output_rights": OutputRights.MAY_TRAIN,
        "review_status": ReviewStatus.APPROVED, "reviewed_by": "reviewer",
        "reviewed_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "model_digest": "a" * 64,
        "input_disclosure": InputDisclosure(allowed_input_types=[InputType.SOURCE_CODE]),
    }
    values.update(overrides)
    return TeacherLineage(**values)


class TeacherIntakeTests(unittest.TestCase):
    def test_unapproved_teacher_is_rejected(self) -> None:
        teacher = approved_teacher(review_status=ReviewStatus.PENDING, reviewed_by=None, reviewed_at=None)
        result = validate_teacher(teacher)
        self.assertFalse(result["admissible"])
        self.assertIn("review_status is not APPROVED", result["blockers"])

    def test_approved_but_missing_reviewer_is_rejected(self) -> None:
        valid = approved_teacher()
        teacher = TeacherLineage.model_construct(**{
            **valid.model_dump(), "input_disclosure": valid.input_disclosure,
            "reviewed_by": None, "reviewed_at": None,
        })
        result = validate_teacher(teacher)
        self.assertFalse(result["admissible"])
        self.assertTrue(any("missing reviewed_by" in blocker for blocker in result["blockers"]))

    def test_research_only_rights_are_rejected(self) -> None:
        result = validate_teacher(approved_teacher(
            output_rights=OutputRights.RESEARCH_ONLY, license="Internal Research-Only License",
        ))
        self.assertFalse(result["admissible"])
        self.assertIn("output_rights does not permit training", result["blockers"])

    def test_valid_approved_teacher_is_admissible(self) -> None:
        result = validate_teacher(approved_teacher())
        self.assertEqual(result, {"admissible": True, "blockers": [], "warnings": []})

    def test_teacher_lineage_requires_license(self) -> None:
        record = approved_teacher().model_dump(mode="json")
        record.pop("license")
        with self.assertRaises(ValidationError):
            TeacherLineage.model_validate(record)

    def test_terms_url_optional(self) -> None:
        teacher = approved_teacher()
        self.assertIsNone(teacher.terms_url)
        self.assertTrue(validate_teacher(teacher)["admissible"])

    def test_intake_rejects_may_train_on_research_license(self) -> None:
        result = validate_teacher(approved_teacher(
            license="Mistral AI Non-Production License", output_rights=OutputRights.MAY_TRAIN,
        ))
        self.assertFalse(result["admissible"])
        self.assertIn("license does not grant training rights", result["blockers"])

    def test_intake_warns_on_apache_with_research_only(self) -> None:
        result = validate_teacher(approved_teacher(
            license="Apache-2.0", output_rights=OutputRights.RESEARCH_ONLY,
        ))
        self.assertFalse(result["admissible"])
        self.assertIn("output_rights does not permit training", result["blockers"])
        self.assertIn("license is more permissive than output_rights; review", result["warnings"])

    def test_weights_access_requires_model_digest_and_registry_skips_blank_lines(self) -> None:
        valid = approved_teacher()
        teacher = TeacherLineage.model_construct(**{
            **valid.model_dump(), "input_disclosure": valid.input_disclosure, "model_digest": [],
        })
        self.assertIn("weights access has no model_digest", validate_teacher(teacher)["blockers"])
        with TemporaryDirectory() as directory:
            path = Path(directory) / "teachers.jsonl"
            path.write_text("\n" + json.dumps(approved_teacher().model_dump(mode="json")) + "\n")
            self.assertEqual(len(load_registry(path)), 1)

    def test_digest_inputs_normalize_to_string_lists(self) -> None:
        teacher = TeacherLineage(
            teacher_id="t", model_name="m", access_method="weights", output_rights="may_train",
            license="Apache-2.0",
            review_status="approved", reviewed_by="reviewer", reviewed_at="2026-01-01T00:00:00Z",
            model_digest="a" * 64, adapter_digests=None,
        )
        self.assertEqual(teacher.model_digest, ["a" * 64])
        self.assertEqual(teacher.adapter_digests, [])

    def test_approved_review_and_confidentiality_invariants(self) -> None:
        with self.assertRaises(ValueError):
            TeacherLineage(
                teacher_id="t", model_name="m", access_method="api", output_rights="may_train",
                license="Apache-2.0",
                review_status="approved", reviewed_by=None, reviewed_at=None,
            )
        with self.assertRaises(ValueError):
            InputDisclosure(confidentiality_required=True)

    def test_trajectory_rejects_private_reasoning_and_nonmonotonic_turns(self) -> None:
        with self.assertRaises(ValueError):
            Turn(turn_index=0, role=Role.CODER, action_type=ActionType.MESSAGE,
                 content="chain of thought: hidden reasoning")
        snapshot = ProjectSnapshot(repository_id="repo", revision="rev", snapshot_digest="a" * 64)
        with self.assertRaises(ValueError):
            Trajectory(
                trajectory_id="trajectory-1", project_snapshot=snapshot,
                turns=[Turn(turn_index=2, role=Role.CODER, action_type=ActionType.MESSAGE),
                       Turn(turn_index=1, role=Role.TESTER, action_type=ActionType.MESSAGE)],
            )

    def test_approved_trajectory_requires_decided_human_adjudication(self) -> None:
        snapshot = ProjectSnapshot(repository_id="repo", revision="rev", snapshot_digest="a" * 64)
        with self.assertRaises(ValueError):
            Trajectory(trajectory_id="trajectory-1", project_snapshot=snapshot,
                       turns=[Turn(turn_index=0, role=Role.CODER, action_type=ActionType.MESSAGE)],
                       final_outcome=FinalOutcome.APPROVED)
        approved = Trajectory(
            trajectory_id="trajectory-2", project_snapshot=snapshot,
            turns=[Turn(turn_index=0, role=Role.CODER, action_type=ActionType.MESSAGE)],
            final_outcome=FinalOutcome.APPROVED,
            human_adjudication={"required": True, "decision": "approved", "reviewer_id": "human-1",
                                "decided_at": "2026-01-01T00:00:00Z"},
        )
        self.assertEqual(approved.final_outcome, FinalOutcome.APPROVED)


if __name__ == "__main__":
    unittest.main()
