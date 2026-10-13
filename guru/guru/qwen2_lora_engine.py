"""Fail-closed selected-student Qwen2-family LoRA engine contracts.

These functions are deliberately unusable with the current draft recipe. No
synthetic bypass is provided here. The isolated random-model smoke owns its
model and fixed token fixtures privately in ``qwen2_lora_smoke``.
"""
from __future__ import annotations

import math
from pathlib import Path

import torch

from guru.lora_recipe import LoraSftRecipe, launch_blockers


class TrainingGateError(RuntimeError):
    """Raised when selected-student training gates or pinned artifacts are absent."""


def require_selected_student_launchable(
    recipe: LoraSftRecipe,
    *,
    model_artifact_dir: str | Path | None,
    tokenizer_artifact_dir: str | Path | None,
) -> None:
    """Fail closed before selected-model access or any training operation."""
    blockers = launch_blockers(recipe)
    if blockers:
        raise TrainingGateError("selected-student training is blocked: " + "; ".join(blockers))
    for name, value in (
        ("model", model_artifact_dir),
        ("tokenizer", tokenizer_artifact_dir),
    ):
        if not value:
            raise TrainingGateError(f"selected-student {name} artifact directory is missing")
        path = Path(value)
        if path.is_symlink() or not path.is_dir():
            raise TrainingGateError(f"selected-student {name} artifact directory is unavailable")


def _require_gate(
    recipe: LoraSftRecipe,
    model_artifact_dir: str | Path | None,
    tokenizer_artifact_dir: str | Path | None,
) -> None:
    require_selected_student_launchable(
        recipe,
        model_artifact_dir=model_artifact_dir,
        tokenizer_artifact_dir=tokenizer_artifact_dir,
    )


def validate_qwen2_targets(
    model: torch.nn.Module,
    recipe: LoraSftRecipe,
    *,
    model_artifact_dir: str | Path | None,
    tokenizer_artifact_dir: str | Path | None,
) -> None:
    """After the launch gate, require Qwen2 and the recipe's linear targets."""
    _require_gate(recipe, model_artifact_dir, tokenizer_artifact_dir)
    config = getattr(model, "config", None)
    if getattr(config, "model_type", None) != "qwen2":
        raise ValueError("LoRA engine supports only the Qwen2 model family")
    targets = recipe.lora.target_modules
    if not targets or len(set(targets)) != len(targets):
        raise ValueError("LoRA target modules must be non-empty and unique")
    modules = dict(model.named_modules())
    for target in targets:
        matches = [
            module
            for name, module in modules.items()
            if name == target or name.endswith("." + target)
        ]
        if not matches:
            raise ValueError(f"LoRA target module is missing from Qwen2 model: {target}")
        if any(not isinstance(module, torch.nn.Linear) for module in matches):
            raise ValueError(f"LoRA target module is not linear: {target}")


def attach_recipe_lora(
    model: torch.nn.Module,
    recipe: LoraSftRecipe,
    *,
    model_artifact_dir: str | Path | None,
    tokenizer_artifact_dir: str | Path | None,
) -> torch.nn.Module:
    """Attach recipe LoRA only after launch gate, artifact, and family checks."""
    validate_qwen2_targets(
        model,
        recipe,
        model_artifact_dir=model_artifact_dir,
        tokenizer_artifact_dir=tokenizer_artifact_dir,
    )
    try:
        from peft import LoraConfig, get_peft_model
    except ImportError as exc:
        raise RuntimeError("Qwen2 LoRA mechanics require PEFT") from exc
    config = LoraConfig(
        r=recipe.lora.rank,
        lora_alpha=recipe.lora.alpha,
        lora_dropout=recipe.lora.dropout,
        target_modules=list(recipe.lora.target_modules),
        task_type="CAUSAL_LM",
    )
    return get_peft_model(model, config)


def make_recipe_optimizer(
    model: torch.nn.Module,
    recipe: LoraSftRecipe,
    *,
    model_artifact_dir: str | Path | None,
    tokenizer_artifact_dir: str | Path | None,
) -> torch.optim.Optimizer:
    """Create recipe AdamW over adapter parameters after the launch gate."""
    _require_gate(recipe, model_artifact_dir, tokenizer_artifact_dir)
    trainable = [
        (name, parameter)
        for name, parameter in model.named_parameters()
        if parameter.requires_grad
    ]
    if not trainable:
        raise ValueError("LoRA model has no trainable parameters")
    if any("lora_" not in name for name, _ in trainable):
        raise ValueError("recipe optimizer refuses non-adapter trainable parameters")
    return torch.optim.AdamW(
        [parameter for _, parameter in trainable],
        lr=recipe.sft.learning_rate,
        betas=(recipe.sft.beta1, recipe.sft.beta2),
        eps=recipe.sft.epsilon,
        weight_decay=recipe.sft.weight_decay,
    )


def make_recipe_scheduler(
    optimizer: torch.optim.Optimizer,
    recipe: LoraSftRecipe,
    *,
    total_steps: int,
    model_artifact_dir: str | Path | None,
    tokenizer_artifact_dir: str | Path | None,
) -> torch.optim.lr_scheduler.LambdaLR:
    """Create recipe cosine schedule only after the launch gate."""
    _require_gate(recipe, model_artifact_dir, tokenizer_artifact_dir)
    if type(total_steps) is not int or total_steps < 1:
        raise ValueError("total_steps must be a positive integer")
    if recipe.sft.scheduler != "cosine":
        raise ValueError("unsupported recipe scheduler")
    warmup_steps = math.ceil(total_steps * recipe.sft.warmup_ratio)

    def scale(step: int) -> float:
        if warmup_steps and step < warmup_steps:
            return min(1.0, (step + 1) / warmup_steps)
        decay_steps = max(1, total_steps - warmup_steps)
        progress = min(1.0, max(0.0, (step - warmup_steps) / decay_steps))
        return max(0.0, 0.5 * (1.0 + math.cos(math.pi * progress)))

    return torch.optim.lr_scheduler.LambdaLR(optimizer, scale)


def supervised_training_step(
    model: torch.nn.Module,
    optimizer: torch.optim.Optimizer,
    recipe: LoraSftRecipe,
    *,
    input_ids: torch.Tensor,
    labels: torch.Tensor,
    model_artifact_dir: str | Path | None,
    tokenizer_artifact_dir: str | Path | None,
) -> float:
    """Run a supervised step only after checking the selected-student gate."""
    _require_gate(recipe, model_artifact_dir, tokenizer_artifact_dir)
    if input_ids.ndim != 2 or labels.shape != input_ids.shape:
        raise ValueError("input_ids and labels must be same-shaped rank-2 tensors")
    model.train()
    optimizer.zero_grad(set_to_none=True)
    result = model(input_ids=input_ids, labels=labels)
    loss = getattr(result, "loss", None)
    if not isinstance(loss, torch.Tensor) or loss.ndim != 0 or not torch.isfinite(loss):
        raise RuntimeError("supervised step produced an invalid loss")
    loss.backward()
    trainable = [parameter for parameter in model.parameters() if parameter.requires_grad]
    if not trainable or any(
        parameter.grad is not None and not torch.isfinite(parameter.grad).all()
        for parameter in trainable
    ):
        optimizer.zero_grad(set_to_none=True)
        raise RuntimeError("supervised step produced invalid adapter gradients")
    optimizer.step()
    return float(loss.detach())


def training_checkpoint_state(
    *,
    recipe: LoraSftRecipe,
    model_artifact_dir: str | Path | None,
    tokenizer_artifact_dir: str | Path | None,
    global_step: int,
    sampler,
    optimizer: torch.optim.Optimizer,
    scheduler: torch.optim.lr_scheduler.LRScheduler,
) -> dict:
    """Create checkpoint state only after the selected-student launch gate."""
    _require_gate(recipe, model_artifact_dir, tokenizer_artifact_dir)
    if type(global_step) is not int or global_step < 0:
        raise ValueError("global_step must be a non-negative integer")
    sampler_state = sampler.state_dict()
    sampler_position = getattr(sampler, "draws", None)
    if type(sampler_position) is not int or sampler_position < 0:
        raise ValueError("sampler must expose a non-negative integer draws position")
    return {
        "global_step": global_step,
        "task_sampler_position": sampler_position,
        "task_sampler": sampler_state,
        "optimizer": optimizer.state_dict(),
        "scheduler": scheduler.state_dict(),
        "cpu_rng_state": torch.get_rng_state().clone(),
    }


def restore_training_checkpoint_state(
    checkpoint: object,
    *,
    recipe: LoraSftRecipe,
    model_artifact_dir: str | Path | None,
    tokenizer_artifact_dir: str | Path | None,
    expected_global_step: int,
    sampler,
    optimizer: torch.optim.Optimizer,
    scheduler: torch.optim.lr_scheduler.LRScheduler,
) -> torch.Tensor:
    """Restore checkpoint state only after the selected-student launch gate."""
    _require_gate(recipe, model_artifact_dir, tokenizer_artifact_dir)
    required = {
        "global_step", "task_sampler_position", "task_sampler",
        "optimizer", "scheduler", "cpu_rng_state",
    }
    if (
        type(checkpoint) is not dict
        or set(checkpoint) != required
        or type(checkpoint["global_step"]) is not int
        or checkpoint["global_step"] != expected_global_step
        or type(checkpoint["task_sampler_position"]) is not int
        or not isinstance(checkpoint["cpu_rng_state"], torch.Tensor)
        or checkpoint["cpu_rng_state"].dtype != torch.uint8
        or checkpoint["cpu_rng_state"].device.type != "cpu"
    ):
        raise ValueError("training checkpoint structure is invalid")
    sampler.load_state_dict(checkpoint["task_sampler"])
    if sampler.draws != checkpoint["task_sampler_position"]:
        raise ValueError("training checkpoint sampler position does not match its state")
    scheduler.load_state_dict(checkpoint["scheduler"])
    optimizer.load_state_dict(checkpoint["optimizer"])
    return checkpoint["cpu_rng_state"].clone()
