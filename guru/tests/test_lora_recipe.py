"""Tests for the draft-only selected-student LoRA/SFT recipe contract."""
from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from guru.lora_recipe import (
    RecipeFormatError,
    canonical_recipe_bytes,
    launch_blockers,
    load_lora_recipe,
    recipe_sha256,
    LoraSftRecipe,
    verify_training_lock,
)


RECIPE_PATH = Path(__file__).parents[1] / "experiments" / "recipes" / "qwen25_coder_15b_lora_sft.v1.json"


def test_checked_in_recipe_is_pinned_and_non_launchable():
    recipe = load_lora_recipe(RECIPE_PATH)

    assert recipe.base_model.model_id == "Qwen/Qwen2.5-Coder-1.5B"
    assert recipe.base_model.revision == "ccb64f03a691be46ba6b4e4c91f396c247aa66c7"
    assert recipe.status == "draft"
    assert recipe.hyperparameters_status == "proposed_unqualified"
    assert recipe.sft.sequence_length == 4096
    assert recipe.sft.max_training_tokens == 13_107_200
    assert recipe.sft.data_order == "sha256(seed_ascii || NUL || task_id_utf8)_ascending"
    assert recipe.sft.save_optimizer_scheduler_rng_state is True
    assert recipe.sft.save_global_step_and_task_sampler_position is True
    assert recipe.transformed_data_retention == "ephemeral"
    assert recipe.external_transmission == "denied"
    assert recipe.weight_distribution == "denied"
    assert recipe.checkpoint_storage == "private_local_only"
    assert recipe.gates.run_authorized is False
    assert "recipe is a draft and is not launchable" in launch_blockers(recipe)
    assert "exact base-weight digest is missing" in launch_blockers(recipe)
    assert "exact tokenizer digest is missing" in launch_blockers(recipe)
    assert "approved training data manifest is missing" in launch_blockers(recipe)
    assert "pinned validation suite is missing" in launch_blockers(recipe)
    assert "local evaluator is not qualified" in launch_blockers(recipe)
    assert "training compute is not approved" in launch_blockers(recipe)


def test_recipe_canonical_serialization_and_digest_are_stable():
    recipe = load_lora_recipe(RECIPE_PATH)
    payload = recipe.model_dump(mode="json")
    reversed_payload = dict(reversed(list(payload.items())))
    reordered = LoraSftRecipe.model_validate(reversed_payload)

    assert canonical_recipe_bytes(recipe) == canonical_recipe_bytes(reordered)
    assert recipe_sha256(recipe) == recipe_sha256(reordered)
    assert len(recipe_sha256(recipe)) == 64


def test_training_stack_lock_digest_matches_repository_file(tmp_path):
    recipe = load_lora_recipe(RECIPE_PATH)
    guru_root = RECIPE_PATH.parents[2]
    verify_training_lock(recipe, guru_root)

    altered_root = tmp_path / "guru"
    altered_root.mkdir()
    (altered_root / "requirements-test-full.lock").write_text("changed", encoding="utf-8")
    with pytest.raises(RecipeFormatError, match="lock digest mismatch"):
        verify_training_lock(recipe, altered_root)


def test_rejects_different_or_mutable_student_revision():
    payload = load_lora_recipe(RECIPE_PATH).model_dump(mode="json")
    payload["base_model"]["revision"] = "main"
    with pytest.raises(ValidationError):
        LoraSftRecipe.model_validate(payload)

    payload["base_model"]["revision"] = "0" * 40
    with pytest.raises(ValidationError, match="selected immutable candidate revision"):
        LoraSftRecipe.model_validate(payload)


@pytest.mark.parametrize(
    ("section", "field", "value"),
    [
        ("gates", "run_authorized", True),
        ("gates", "corpus_rights_approved", True),
        ("sft", "sequence_length", 32769),
        ("sft", "max_training_tokens", 1),
        ("lora", "target_modules", ["q_proj", "q_proj"]),
        ("base_model", "weights_sha256", "not-a-digest"),
    ],
)
def test_rejects_invalid_or_unapproved_recipe_values(section, field, value):
    payload = load_lora_recipe(RECIPE_PATH).model_dump(mode="json")
    payload[section][field] = value
    with pytest.raises(ValidationError):
        LoraSftRecipe.model_validate(payload)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("transformed_data_retention", "persistent"),
        ("external_transmission", "allowed"),
        ("weight_distribution", "allowed"),
        ("checkpoint_storage", "public"),
        ("status", "approved"),
    ],
)
def test_rejects_changes_to_owner_scope_or_draft_status(field, value):
    payload = load_lora_recipe(RECIPE_PATH).model_dump(mode="json")
    payload[field] = value
    with pytest.raises(ValidationError):
        LoraSftRecipe.model_validate(payload)


def test_recipe_loader_rejects_duplicate_keys(tmp_path):
    path = tmp_path / "duplicate.json"
    path.write_text('{"schema_version":"guru-lora-sft-recipe-v1","schema_version":"x"}', encoding="utf-8")

    with pytest.raises(RecipeFormatError, match="duplicate JSON key"):
        load_lora_recipe(path)


def test_recipe_loader_rejects_non_object_json(tmp_path):
    path = tmp_path / "array.json"
    path.write_text("[]", encoding="utf-8")

    with pytest.raises(RecipeFormatError, match="root must be a JSON object"):
        load_lora_recipe(path)


def test_recipe_schema_rejects_unknown_fields():
    payload = load_lora_recipe(RECIPE_PATH).model_dump(mode="json")
    payload["unreviewed_override"] = True

    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        LoraSftRecipe.model_validate(payload)
