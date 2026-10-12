"""Offline LoRA plumbing smoke test using synthetic data and random weights.

This is not a Guru training run and does not load or qualify the selected
Qwen student candidate. All adapter files are written beneath a temporary
directory and removed before this function returns.
"""
from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path

import torch


def run_synthetic_lora_smoke(*, seed: int = 17, steps: int = 2) -> dict:
    """Train, save, reload, and update a tiny random GPT-2 LoRA adapter.

    No tokenizer, model weights, dataset files, network access, or persistent
    output path are used. The generated token IDs are synthetic fixtures.
    """
    if type(seed) is not int or seed < 0:
        raise ValueError("seed must be a non-negative integer")
    if type(steps) is not int or steps < 2:
        raise ValueError("steps must be an integer of at least 2")

    try:
        from peft import LoraConfig, PeftModel, get_peft_model
        from transformers import GPT2Config, GPT2LMHeadModel
    except ImportError as exc:
        raise RuntimeError("synthetic LoRA smoke requires the full Guru test dependencies plus PEFT") from exc

    caller_rng_state = torch.get_rng_state()
    torch.manual_seed(seed)
    config = GPT2Config(
        vocab_size=64,
        n_positions=16,
        n_ctx=16,
        n_embd=16,
        n_layer=1,
        n_head=2,
        resid_pdrop=0.0,
        embd_pdrop=0.0,
        attn_pdrop=0.0,
        use_cache=False,
    )
    base = GPT2LMHeadModel(config)
    base_state = {name: value.detach().clone() for name, value in base.state_dict().items()}
    lora = LoraConfig(
        r=2,
        lora_alpha=4,
        lora_dropout=0.0,
        target_modules=["c_attn"],
        fan_in_fan_out=True,
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(base, lora)
    torch.set_rng_state(caller_rng_state)
    model.train()
    trainable_names = [name for name, param in model.named_parameters() if param.requires_grad]
    if not trainable_names or any("lora_" not in name for name in trainable_names):
        raise RuntimeError("LoRA smoke unexpectedly exposed non-adapter trainable parameters")

    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad), lr=1e-3)
    # Fixed, locally generated token IDs: no source corpus or tokenizer involved.
    input_ids = torch.tensor(
        [[3, 7, 11, 19, 23, 29, 31, 37], [5, 13, 17, 23, 29, 31, 41, 43]],
        dtype=torch.long,
    )
    losses: list[float] = []
    for _ in range(steps):
        optimizer.zero_grad(set_to_none=True)
        loss = model(input_ids=input_ids, labels=input_ids).loss
        if not torch.isfinite(loss):
            raise RuntimeError("synthetic LoRA smoke produced a non-finite loss")
        loss.backward()
        optimizer.step()
        losses.append(float(loss.detach()))

    with tempfile.TemporaryDirectory(prefix="guru-lora-smoke-") as tmp:
        config.save_pretrained(tmp)
        lora.base_model_name_or_path = tmp
        output = Path(tmp) / "adapter"
        model.save_pretrained(output, safe_serialization=True)
        adapter_file = output / "adapter_model.safetensors"
        if not adapter_file.is_file() or adapter_file.is_symlink():
            raise RuntimeError("LoRA smoke did not save a regular safetensors adapter")
        digest = hashlib.sha256(adapter_file.read_bytes()).hexdigest()
        caller_rng_state = torch.get_rng_state()
        reload_base = GPT2LMHeadModel(config)
        torch.set_rng_state(caller_rng_state)
        reload_base.load_state_dict(base_state)
        adapter_rng_state = torch.get_rng_state()
        reloaded = PeftModel.from_pretrained(reload_base, output, is_trainable=True)
        torch.set_rng_state(adapter_rng_state)
        reloaded.eval()
        model.eval()
        with torch.no_grad():
            expected = model(input_ids=input_ids).logits
            actual = reloaded(input_ids=input_ids).logits
        if not torch.equal(expected, actual):
            raise RuntimeError("reloaded LoRA adapter does not reproduce saved adapter output")

        # Exercise another adapter-only optimizer step after local reload.
        reloaded.train()
        resumed_optimizer = torch.optim.AdamW(
            (p for p in reloaded.parameters() if p.requires_grad), lr=1e-3
        )
        resumed_optimizer.zero_grad(set_to_none=True)
        resumed_loss = reloaded(input_ids=input_ids, labels=input_ids).loss
        resumed_loss.backward()
        resumed_optimizer.step()
        resumed_loss_value = float(resumed_loss.detach())
        if not torch.isfinite(torch.tensor(resumed_loss_value)):
            raise RuntimeError("reloaded LoRA adapter did not continue training finitely")

    return {
        "schema_version": "guru-synthetic-lora-smoke-v1",
        "synthetic_only": True,
        "network_used": False,
        "selected_student_weights_loaded": False,
        "model": "random GPT-2 configuration; not a Guru or Qwen checkpoint",
        "method": "PEFT LoRA; adapter-only optimizer updates",
        "steps_before_save": steps,
        "continued_steps_after_reload": 1,
        "trainable_parameters": sum(p.numel() for p in model.parameters() if p.requires_grad),
        "initial_loss_finite": all(torch.isfinite(torch.tensor(value)).item() for value in losses),
        "reload_logits_equal": True,
        "continued_loss_finite": True,
        "adapter_sha256": digest,
        "persistent_output_written": False,
    }
