from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from guru.quality.use_scope import GURU_USE_SCOPE_POLICY
from guru.schemas.evaluator_evidence import EvaluatorQualificationEvidence
from guru.schemas.rights_decision import SourceRights


def _rights(**overrides):
    values = {
        "allow_training": True,
        "allow_evaluation": True,
        "allow_transformed_data_retention": True,
        "allow_provider_transmission": True,
        "allow_weight_distribution": True,
    }
    values.update(overrides)
    return SourceRights(**values)


def test_i7_scopes_override_permissive_source_rights():
    rights = _rights()

    assert GURU_USE_SCOPE_POLICY.permits_evaluation(rights, "local") is True
    assert GURU_USE_SCOPE_POLICY.permits_evaluation(rights, "remote") is False
    assert GURU_USE_SCOPE_POLICY.permits_external_transmission(rights) is False
    assert GURU_USE_SCOPE_POLICY.permits_transformed_data_retention(rights) is False
    assert GURU_USE_SCOPE_POLICY.permits_persisted_corpus() is False
    assert GURU_USE_SCOPE_POLICY.permits_weight_distribution(rights) is False


def test_i7_evaluator_qualification_schema_accepts_only_local_execution():
    common = {
        "schema_version": "guru-evaluator-qualification-v1",
        "qualification_id": "fixture-qualification",
        "config_digest": "a" * 64,
        "image_digest": "b" * 64,
        "report_digest": "c" * 64,
        "qualified_at": datetime(2026, 10, 12, tzinfo=timezone.utc),
    }

    evidence = EvaluatorQualificationEvidence(execution_scope="local", **common)
    assert evidence.execution_scope == "local"
    with pytest.raises(ValidationError):
        EvaluatorQualificationEvidence(execution_scope="remote", **common)
