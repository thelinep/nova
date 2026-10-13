from __future__ import annotations

from datetime import datetime, timezone
import unittest

from pydantic import ValidationError

from guru.schemas.rights_decision import RightsDecision


def valid_record() -> dict:
    return {
        "schema_version": "guru-source-rights-v2",
        "source_id": "source-one",
        "uri": "https://example.invalid/repository",
        "revision": "commit:0123456789abcdef",
        "artifact_sha256": "a" * 64,
        "provenance_statement": "Imported from the named repository at the pinned revision.",
        "authority_basis": "license_text",
        "authority_description": "Reviewer assessed the saved license text and source provenance.",
        "rights": {
            "allow_training": True,
            "allow_evaluation": True,
            "allow_ephemeral_transformation": True,
            "allow_transformed_data_retention": False,
            "allow_provider_transmission": False,
            "allow_weight_distribution": False,
        },
        "reviewer": "reviewer@example.invalid",
        "decided_at": datetime(2026, 10, 12, tzinfo=timezone.utc).isoformat(),
        "evidence_refs": [{
            "evidence_id": "license-copy",
            "uri": "evidence/license.txt",
            "sha256": "b" * 64,
        }],
    }


class RightsDecisionTests(unittest.TestCase):
    def test_explicit_versioned_rights_decision_parses(self) -> None:
        decision = RightsDecision.model_validate(valid_record())
        self.assertEqual(decision.schema_version, "guru-source-rights-v2")
        self.assertTrue(decision.rights.allow_training)
        self.assertFalse(decision.rights.allow_provider_transmission)

    def test_schema_version_is_required_and_exact(self) -> None:
        record = valid_record()
        record.pop("schema_version")
        with self.assertRaises(ValidationError):
            RightsDecision.model_validate(record)
        record["schema_version"] = "guru-source-rights-v1"
        with self.assertRaises(ValidationError):
            RightsDecision.model_validate(record)

    def test_every_permission_must_be_an_explicit_strict_boolean(self) -> None:
        for rights in ({"allow_training": True},
                       {**valid_record()["rights"], "allow_training": "unknown"},
                       {**valid_record()["rights"], "allow_training": 1}):
            with self.subTest(rights=rights):
                record = valid_record()
                record["rights"] = rights
                with self.assertRaises(ValidationError):
                    RightsDecision.model_validate(record)

    def test_ephemeral_transformation_permission_is_required(self) -> None:
        record = valid_record()
        record["rights"].pop("allow_ephemeral_transformation")
        with self.assertRaises(ValidationError):
            RightsDecision.model_validate(record)

    def test_unknown_authority_basis_and_extra_fields_are_rejected(self) -> None:
        record = valid_record()
        record["authority_basis"] = "unknown"
        with self.assertRaises(ValidationError):
            RightsDecision.model_validate(record)
        record = valid_record()
        record["license_permissions_inferred"] = True
        with self.assertRaises(ValidationError):
            RightsDecision.model_validate(record)

    def test_digests_and_reviewer_evidence_are_required(self) -> None:
        record = valid_record()
        record["artifact_sha256"] = "NOASSERTION"
        with self.assertRaises(ValidationError):
            RightsDecision.model_validate(record)
        record = valid_record()
        record["evidence_refs"] = []
        with self.assertRaises(ValidationError):
            RightsDecision.model_validate(record)
        record = valid_record()
        record["reviewer"] = " "
        with self.assertRaises(ValidationError):
            RightsDecision.model_validate(record)

    def test_decision_timestamp_requires_timezone(self) -> None:
        record = valid_record()
        record["decided_at"] = "2026-10-12T12:00:00"
        with self.assertRaisesRegex(ValidationError, "decided_at must include a timezone"):
            RightsDecision.model_validate(record)

    def test_duplicate_evidence_references_are_rejected(self) -> None:
        record = valid_record()
        record["evidence_refs"].append(dict(record["evidence_refs"][0]))
        with self.assertRaisesRegex(ValidationError, "unique evidence_id"):
            RightsDecision.model_validate(record)


if __name__ == "__main__":
    unittest.main()
