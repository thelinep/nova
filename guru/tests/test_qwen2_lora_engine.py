"""Fail-closed selected-student Qwen2 engine boundary tests."""
from __future__ import annotations

from pathlib import Path

import pytest
import torch

from guru.lora_recipe import load_lora_recipe
from guru.qwen2_lora_engine import (
    TrainingGateError,
    attach_recipe_lora,
    make_recipe_optimizer,
    make_recipe_scheduler,
    require_selected_student_launchable,
    restore_training_checkpoint_state,
    supervised_training_step,
    training_checkpoint_state,
    validate_qwen2_targets,
)


RECIPE_PATH = (
    Path(__file__).parents[1]
    / "experiments"
    / "recipes"
    / "qwen25_coder_15b_lora_sft.v1.json"
)


class UntouchableModel:
    """Any inspection or execution before the launch gate fails the test."""

    def __getattr__(self, _name):
        raise AssertionError("model was inspected before the selected-student gate")


class UntouchableSampler:
    def state_dict(self):
        raise AssertionError("sampler was inspected before the selected-student gate")


def test_draft_recipe_and_missing_artifacts_fail_closed(tmp_path):
    recipe = load_lora_recipe(RECIPE_PATH)
    with pytest.raises(TrainingGateError, match="model artifact directory is missing"):
        require_selected_student_launchable(
            recipe, model_artifact_dir=None, tokenizer_artifact_dir=None
        )

    missing = tmp_path / "does-not-exist"
    with pytest.raises(TrainingGateError, match="model artifact directory is unavailable"):
        require_selected_student_launchable(
            recipe, model_artifact_dir=missing, tokenizer_artifact_dir=missing
        )

    model_dir = tmp_path / "model"
    tokenizer_dir = tmp_path / "tokenizer"
    model_dir.mkdir()
    tokenizer_dir.mkdir()
    with pytest.raises(TrainingGateError, match="recipe is a draft and is not launchable"):
        require_selected_student_launchable(
            recipe,
            model_artifact_dir=model_dir,
            tokenizer_artifact_dir=tokenizer_dir,
        )


def test_no_engine_api_has_a_synthetic_bypass_for_models_or_tensors(tmp_path):
    recipe = load_lora_recipe(RECIPE_PATH)
    model_dir = tmp_path / "model"
    tokenizer_dir = tmp_path / "tokenizer"
    model_dir.mkdir()
    tokenizer_dir.mkdir()
    paths = {
        "model_artifact_dir": model_dir,
        "tokenizer_artifact_dir": tokenizer_dir,
    }
    model = UntouchableModel()
    optimizer = torch.optim.SGD([torch.nn.Parameter(torch.zeros(()))], lr=0.1)
    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lambda _: 1.0)
    tensors = torch.tensor([[999, -1]], dtype=torch.long)
    checkpoint = object()
    sampler = UntouchableSampler()

    guarded_calls = [
        lambda: validate_qwen2_targets(model, recipe, **paths),
        lambda: attach_recipe_lora(model, recipe, **paths),
        lambda: make_recipe_optimizer(model, recipe, **paths),
        lambda: make_recipe_scheduler(
            optimizer, recipe, total_steps=1, **paths
        ),
        lambda: supervised_training_step(
            model,
            optimizer,
            recipe,
            input_ids=tensors,
            labels=tensors,
            **paths,
        ),
        lambda: training_checkpoint_state(
            recipe=recipe,
            global_step=0,
            sampler=sampler,
            optimizer=optimizer,
            scheduler=scheduler,
            **paths,
        ),
        lambda: restore_training_checkpoint_state(
            checkpoint,
            recipe=recipe,
            expected_global_step=0,
            sampler=sampler,
            optimizer=optimizer,
            scheduler=scheduler,
            **paths,
        ),
    ]
    for call in guarded_calls:
        with pytest.raises(TrainingGateError, match="recipe is a draft and is not launchable"):
            call()
