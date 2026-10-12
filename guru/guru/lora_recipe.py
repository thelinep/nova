"""Strict, non-launchable LoRA/SFT recipe contract for the selected student.

This module validates proposal metadata only. It never loads model/data files,
downloads artifacts, trains, or treats a structurally valid proposal as an
approval to run.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


SCHEMA_VERSION = "guru-lora-sft-recipe-v1"
MODEL_ID = "Qwen/Qwen2.5-Coder-1.5B"
MODEL_REVISION = "ccb64f03a691be46ba6b4e4c91f396c247aa66c7"
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_GIT_COMMIT = re.compile(r"^[0-9a-f]{40}$")


class RecipeModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class ArtifactPin(RecipeModel):
    model_id: str = Field(min_length=1, max_length=256)
    revision: str = Field(min_length=40, max_length=40)
    weights_sha256: str | None
    tokenizer_sha256: str | None

    @model_validator(mode="after")
    def validate_pin(self) -> "ArtifactPin":
        if not _GIT_COMMIT.fullmatch(self.revision):
            raise ValueError("revision must be a full immutable Git commit")
        for name in ("weights_sha256", "tokenizer_sha256"):
            value = getattr(self, name)
            if value is not None and not _SHA256.fullmatch(value):
                raise ValueError(f"{name} must be a lowercase SHA-256 digest or null")
        return self


class LoraSettings(RecipeModel):
    rank: int = Field(ge=1, le=256)
    alpha: int = Field(ge=1, le=1024)
    dropout: float = Field(ge=0.0, lt=1.0)
    target_modules: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_targets(self) -> "LoraSettings":
        if any(not name or name.strip() != name for name in self.target_modules):
            raise ValueError("target_modules must contain non-empty trimmed names")
        if len(set(self.target_modules)) != len(self.target_modules):
            raise ValueError("target_modules must be unique")
        return self


class TrainingStack(RecipeModel):
    python: Literal["3.12.4"]
    torch: Literal["2.4.1"]
    transformers: Literal["4.45.2"]
    peft: Literal["0.13.2"]
    lockfile: Literal["requirements-test-full.lock"]
    lockfile_sha256: str

    @model_validator(mode="after")
    def validate_lock_digest(self) -> "TrainingStack":
        if not _SHA256.fullmatch(self.lockfile_sha256):
            raise ValueError("lockfile_sha256 must be a lowercase SHA-256 digest")
        return self


class SftSettings(RecipeModel):
    sequence_length: int = Field(ge=128, le=32768)
    micro_batch_size: int = Field(ge=1, le=256)
    gradient_accumulation_steps: int = Field(ge=1, le=4096)
    optimizer: Literal["AdamW"]
    learning_rate: float = Field(gt=0.0, le=1.0)
    beta1: float = Field(gt=0.0, lt=1.0)
    beta2: float = Field(gt=0.0, lt=1.0)
    epsilon: float = Field(gt=0.0)
    weight_decay: float = Field(ge=0.0, le=1.0)
    scheduler: Literal["cosine"]
    warmup_ratio: float = Field(ge=0.0, lt=1.0)
    precision: Literal["bfloat16"]
    gradient_checkpointing: bool
    seed: int = Field(ge=0, le=2**32 - 1)
    data_order: Literal["sha256(seed_ascii || NUL || task_id_utf8)_ascending"]
    data_sampling: Literal["uniform_per_approved_training_task"]
    training_data_manifest_sha256: str | None
    max_steps: int = Field(ge=1)
    max_training_tokens: int = Field(ge=1)
    checkpoint_every_steps: int = Field(ge=1)
    save_optimizer_scheduler_rng_state: Literal[True]
    save_global_step_and_task_sampler_position: Literal[True]
    validation_every_steps: int = Field(ge=1)
    validation_suite_sha256: str | None
    evaluator_config_sha256: str | None
    early_stopping_patience_evaluations: int = Field(ge=1)
    early_stopping_metric: Literal["validation_task_pass_rate"]
    early_stopping_direction: Literal["maximize"]
    validation_hook: Literal["local_qualified_evaluator"]

    @model_validator(mode="after")
    def validate_cadence(self) -> "SftSettings":
        expected_token_budget = (
            self.max_steps
            * self.micro_batch_size
            * self.gradient_accumulation_steps
            * self.sequence_length
        )
        if self.max_training_tokens != expected_token_budget:
            raise ValueError("max_training_tokens must equal max_steps × micro_batch_size × gradient_accumulation_steps × sequence_length")
        if self.checkpoint_every_steps > self.max_steps:
            raise ValueError("checkpoint cadence must not exceed max_steps")
        if self.validation_every_steps > self.max_steps:
            raise ValueError("validation cadence must not exceed max_steps")
        for name in ("training_data_manifest_sha256", "validation_suite_sha256", "evaluator_config_sha256"):
            value = getattr(self, name)
            if value is not None and not _SHA256.fullmatch(value):
                raise ValueError(f"{name} must be a lowercase SHA-256 digest or null")
        return self


class RecipeGates(RecipeModel):
    model_intake_approved: Literal[False]
    corpus_rights_approved: Literal[False]
    evaluator_qualified: Literal[False]
    compute_approved: Literal[False]
    run_authorized: Literal[False]


class LoraSftRecipe(RecipeModel):
    schema_version: Literal["guru-lora-sft-recipe-v1"]
    recipe_id: str = Field(min_length=1, max_length=128)
    status: Literal["draft"]
    hyperparameters_status: Literal["proposed_unqualified"]
    base_model: ArtifactPin
    training_stack: TrainingStack
    lora: LoraSettings
    sft: SftSettings
    gates: RecipeGates
    transformed_data_retention: Literal["ephemeral"]
    external_transmission: Literal["denied"]
    weight_distribution: Literal["denied"]
    checkpoint_storage: Literal["private_local_only"]

    @model_validator(mode="after")
    def validate_selected_candidate(self) -> "LoraSftRecipe":
        if self.base_model.model_id != MODEL_ID:
            raise ValueError(f"base_model.model_id must be the selected candidate {MODEL_ID!r}")
        if self.base_model.revision != MODEL_REVISION:
            raise ValueError("base_model.revision must match the selected immutable candidate revision")
        return self


class RecipeFormatError(ValueError):
    """Recipe file is malformed or has duplicate JSON object keys."""


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise RecipeFormatError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_lora_recipe(path: str | Path) -> LoraSftRecipe:
    """Load a local JSON recipe with duplicate-key rejection; no network access."""
    try:
        raw = Path(path).read_text(encoding="utf-8")
        payload = json.loads(raw, object_pairs_hook=_reject_duplicate_keys)
    except RecipeFormatError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RecipeFormatError("recipe file is unreadable or invalid JSON") from exc
    if not isinstance(payload, dict):
        raise RecipeFormatError("recipe root must be a JSON object")
    return LoraSftRecipe.model_validate(payload)


def canonical_recipe_bytes(recipe: LoraSftRecipe) -> bytes:
    """Return deterministic UTF-8 JSON for binding a recipe to a digest."""
    return json.dumps(
        recipe.model_dump(mode="json"),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def recipe_sha256(recipe: LoraSftRecipe) -> str:
    """Hash the canonical recipe; this is not a model or rights digest."""
    return hashlib.sha256(canonical_recipe_bytes(recipe)).hexdigest()


def verify_training_lock(recipe: LoraSftRecipe, guru_root: str | Path) -> None:
    """Verify the local test-stack lock bytes match the recipe's recorded pin."""
    lock_path = Path(guru_root) / recipe.training_stack.lockfile
    try:
        lock_bytes = lock_path.read_bytes()
    except OSError as exc:
        raise RecipeFormatError("pinned training lock is unreadable") from exc
    if hashlib.sha256(lock_bytes).hexdigest() != recipe.training_stack.lockfile_sha256:
        raise RecipeFormatError("pinned training lock digest mismatch")


def launch_blockers(recipe: LoraSftRecipe) -> list[str]:
    """Return explicit unmet gates. This proposal schema has no launch mode."""
    blockers = ["recipe is a draft and is not launchable"]
    if recipe.base_model.weights_sha256 is None:
        blockers.append("exact base-weight digest is missing")
    if recipe.base_model.tokenizer_sha256 is None:
        blockers.append("exact tokenizer digest is missing")
    if recipe.sft.training_data_manifest_sha256 is None:
        blockers.append("approved training data manifest is missing")
    if recipe.sft.validation_suite_sha256 is None:
        blockers.append("pinned validation suite is missing")
    if recipe.sft.evaluator_config_sha256 is None:
        blockers.append("qualified evaluator configuration digest is missing")
    if not recipe.gates.model_intake_approved:
        blockers.append("model intake is not approved")
    if not recipe.gates.corpus_rights_approved:
        blockers.append("corpus rights are not approved")
    if not recipe.gates.evaluator_qualified:
        blockers.append("local evaluator is not qualified")
    if not recipe.gates.compute_approved:
        blockers.append("training compute is not approved")
    if not recipe.gates.run_authorized:
        blockers.append("training run is not authorized")
    return blockers
