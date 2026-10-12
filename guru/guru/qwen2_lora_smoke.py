"""Offline PEFT LoRA smoke for a tiny, randomly initialized Qwen2 model.

This proves only compatibility with the Qwen2 architecture implementation in
the pinned test stack. It does not load or qualify the selected Qwen2.5-Coder
checkpoint, estimate model memory fit, qualify a trainer, or test coding
capability.
"""
from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path

import torch

from guru.ephemeral import training_scratch_root


def run_synthetic_qwen2_lora_smoke(*, seed: int = 23, steps: int = 2) -> dict:
    """Train/reload/continue a synthetic adapter without downloads or data files."""
    if type(seed) is not int or seed < 0:
        raise ValueError("seed must be a non-negative integer")
    if type(steps) is not int or steps < 2:
        raise ValueError("steps must be an integer of at least 2")

    scratch_root = training_scratch_root()
    try:
        from peft import LoraConfig, PeftModel, get_peft_model
        from transformers import Qwen2Config, Qwen2ForCausalLM
    except ImportError as exc:
        raise RuntimeError("synthetic Qwen2 LoRA smoke requires the full Guru test dependencies plus PEFT") from exc

    caller_rng_state = torch.get_rng_state()
    try:
        torch.manual_seed(seed)
        config = Qwen2Config(
            vocab_size=64,
            hidden_size=32,
            intermediate_size=64,
            num_hidden_layers=1,
            num_attention_heads=4,
            num_key_value_heads=2,
            max_position_embeddings=16,
            attention_dropout=0.0,
            use_cache=False,
            tie_word_embeddings=False,
        )
        base = Qwen2ForCausalLM(config)
        base_state = {name: value.detach().clone() for name, value in base.state_dict().items()}
        lora = LoraConfig(
            r=2,
            lora_alpha=4,
            lora_dropout=0.0,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
            task_type="CAUSAL_LM",
        )
        model = get_peft_model(base, lora)
    finally:
        torch.set_rng_state(caller_rng_state)

    model.train()
    trainable_names = [name for name, param in model.named_parameters() if param.requires_grad]
    if not trainable_names or any("lora_" not in name for name in trainable_names):
        raise RuntimeError("Qwen2 LoRA smoke unexpectedly exposed non-adapter trainable parameters")

    input_ids = torch.tensor(
        [[2, 7, 13, 19, 23, 31, 37, 41], [3, 11, 17, 29, 31, 43, 47, 53]],
        dtype=torch.long,
    )
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad), lr=1e-3)
    losses: list[float] = []
    for _ in range(steps):
        optimizer.zero_grad(set_to_none=True)
        loss = model(input_ids=input_ids, labels=input_ids).loss
        if not torch.isfinite(loss):
            raise RuntimeError("synthetic Qwen2 LoRA smoke produced a non-finite loss")
        loss.backward()
        optimizer.step()
        losses.append(float(loss.detach()))

    with tempfile.TemporaryDirectory(prefix="guru-qwen2-lora-smoke-", dir=scratch_root) as tmp:
        config.save_pretrained(tmp)
        lora.base_model_name_or_path = tmp
        output = Path(tmp) / "adapter"
        model.save_pretrained(output, safe_serialization=True)
        adapter_file = output / "adapter_model.safetensors"
        if not adapter_file.is_file() or adapter_file.is_symlink():
            raise RuntimeError("Qwen2 LoRA smoke did not save a regular safetensors adapter")
        digest = hashlib.sha256(adapter_file.read_bytes()).hexdigest()

        rng_before_reload = torch.get_rng_state()
        reload_base = Qwen2ForCausalLM(config)
        torch.set_rng_state(rng_before_reload)
        reload_base.load_state_dict(base_state)
        rng_before_adapter = torch.get_rng_state()
        reloaded = PeftModel.from_pretrained(reload_base, output, is_trainable=True)
        torch.set_rng_state(rng_before_adapter)
        model.eval()
        reloaded.eval()
        with torch.no_grad():
            expected = model(input_ids=input_ids).logits
            actual = reloaded(input_ids=input_ids).logits
        if not torch.equal(expected, actual):
            raise RuntimeError("reloaded Qwen2 LoRA adapter does not reproduce saved adapter output")

        reloaded.train()
        continued_optimizer = torch.optim.AdamW(
            (p for p in reloaded.parameters() if p.requires_grad), lr=1e-3
        )
        continued_optimizer.zero_grad(set_to_none=True)
        continued_loss = reloaded(input_ids=input_ids, labels=input_ids).loss
        continued_loss.backward()
        continued_optimizer.step()
        continued_loss_value = float(continued_loss.detach())
        if not torch.isfinite(torch.tensor(continued_loss_value)):
            raise RuntimeError("reloaded Qwen2 LoRA adapter did not continue training finitely")

    return {
        "schema_version": "guru-synthetic-qwen2-lora-smoke-v1",
        "synthetic_only": True,
        "transformed_real_data_used": False,
        "network_used": False,
        "selected_student_weights_loaded": False,
        "architecture": "random tiny Qwen2ForCausalLM config; not the selected Qwen2.5-Coder checkpoint",
        "architecture_compatibility_only": True,
        "method": "PEFT LoRA; adapter-only optimizer updates",
        "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj"],
        "steps_before_save": steps,
        "continued_steps_after_reload": 1,
        "trainable_parameters": sum(p.numel() for p in model.parameters() if p.requires_grad),
        "initial_loss_finite": all(torch.isfinite(torch.tensor(value)).item() for value in losses),
        "reload_logits_equal": True,
        "continued_loss_finite": True,
        "adapter_sha256": digest,
        "persistent_output_written": False,
        "trainer_qualified": False,
        "memory_fit_established": False,
        "coding_capability_established": False,
    }
