"""Synthetic schema checks; these do not evaluate language understanding."""
from copy import deepcopy

import pytest
from pydantic import ValidationError

from guru.schemas.multilingual_intent import SemanticIntent


@pytest.fixture
def deduplicate_intent():
    return {
        "task_id": "synthetic-deduplicate-001",
        "operation": "deduplicate_preserving_order",
        "input_types": ["list[int]"],
        "constraints": ["preserve_first_occurrence", "preserve_order"],
        "acceptance_conditions": ["output_contains_each_input_value_once"],
        "utterances": [
            {
                "language": "hi",
                "script": "Devanagari",
                "text": "सूची से दोहराए गए तत्व हटाकर पहली बार का क्रम बनाए रखें।",
            },
            {
                "language": "sa",
                "script": "Devanagari",
                "text": "सूचिकायाः पुनरावृत्तानि तत्त्वानि निष्कास्य प्रथमक्रमं रक्षतु।",
            },
        ],
    }


def test_synthetic_hindi_sanskrit_variants_share_one_canonical_intent(deduplicate_intent):
    record = SemanticIntent.model_validate(deduplicate_intent)
    assert record.task_id == "synthetic-deduplicate-001"
    assert {utterance.language.value for utterance in record.utterances} == {"hi", "sa"}
    assert record.operation == "deduplicate_preserving_order"
    assert record.target_language == "python"


def test_semantic_intent_rejects_missing_language_pair(deduplicate_intent):
    record = deepcopy(deduplicate_intent)
    record["utterances"] = record["utterances"][:1]
    with pytest.raises(ValidationError, match="at least 2 items"):
        SemanticIntent.model_validate(record)


def test_semantic_intent_rejects_script_mismatch(deduplicate_intent):
    record = deepcopy(deduplicate_intent)
    record["utterances"][0]["script"] = "Latin"
    with pytest.raises(ValidationError, match="Hindi and Sanskrit v1 fixtures"):
        SemanticIntent.model_validate(record)


def test_semantic_intent_rejects_unreviewed_extra_fields(deduplicate_intent):
    record = deepcopy(deduplicate_intent)
    record["prompt_for_training"] = True
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        SemanticIntent.model_validate(record)
