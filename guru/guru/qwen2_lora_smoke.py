"""Offline PEFT LoRA resume smoke for a tiny random Qwen2 model.

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
    """Compare interrupted/resumed training with an uninterrupted synthetic run."""
    if type(seed) is not int or seed < 0:
        raise ValueError("seed must be a non-negative integer")
    if type(steps) is not int or steps < 2:
        raise ValueError("steps must be an integer of at least 2")
    if steps > 32:
        raise ValueError("steps must be no greater than 32 for the bounded smoke")

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
        initial_base = Qwen2ForCausalLM(config)
        base_state = {name: value.detach().clone() for name, value in initial_base.state_dict().items()}
        del initial_base
        lora = LoraConfig(
            r=2,
            lora_alpha=4,
            lora_dropout=0.0,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
            task_type="CAUSAL_LM",
        )

        def make_model():
            # Reuse fixed random adapter initialization while keeping the full
            # smoke's RNG effects private to this function.
            torch.manual_seed(seed + 1)
            base = Qwen2ForCausalLM(config)
            base.load_state_dict(base_state)
            return get_peft_model(base, lora)

        def make_optimizer(model):
            optimizer = torch.optim.AdamW(
                (param for param in model.parameters() if param.requires_grad), lr=1e-3
            )
            scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
                optimizer, T_max=steps + 1, eta_min=0.0
            )
            return optimizer, scheduler

        input_ids = torch.tensor(
            [[2, 7, 13, 19, 23, 31, 37, 41], [3, 11, 17, 29, 31, 43, 47, 53]],
            dtype=torch.long,
        )

        def take_steps(model, optimizer, scheduler, count):
            model.train()
            losses = []
            for _ in range(count):
                optimizer.zero_grad(set_to_none=True)
                loss = model(input_ids=input_ids, labels=input_ids).loss
                if not torch.isfinite(loss):
                    raise RuntimeError("synthetic Qwen2 LoRA smoke produced a non-finite loss")
                loss.backward()
                optimizer.step()
                scheduler.step()
                losses.append(float(loss.detach()))
            return losses

        # Reference run is continuous for the same (steps + one) update window.
        reference = make_model()
        ref_optimizer, ref_scheduler = make_optimizer(reference)
        reference_losses = take_steps(reference, ref_optimizer, ref_scheduler, steps + 1)

        # The comparison run is interrupted after `steps` and then restored.
        model = make_model()
        trainable_names = [name for name, param in model.named_parameters() if param.requires_grad]
        if not trainable_names or any("lora_" not in name for name in trainable_names):
            raise RuntimeError("Qwen2 LoRA smoke unexpectedly exposed non-adapter trainable parameters")
        optimizer, scheduler = make_optimizer(model)
        losses_before_save = take_steps(model, optimizer, scheduler, steps)

        with tempfile.TemporaryDirectory(prefix="guru-qwen2-lora-smoke-", dir=scratch_root) as tmp:
            config.save_pretrained(tmp)
            lora.base_model_name_or_path = tmp
            adapter_path = Path(tmp) / "adapter-before-resume"
            model.save_pretrained(adapter_path, safe_serialization=True)
            adapter_file = adapter_path / "adapter_model.safetensors"
            if not adapter_file.is_file() or adapter_file.is_symlink():
                raise RuntimeError("Qwen2 LoRA smoke did not save a regular safetensors adapter")

            training_state_path = Path(tmp) / "training-state.pt"
            torch.save(
                {
                    "global_step": steps,
                    "task_sampler_position": steps,
                    "optimizer": optimizer.state_dict(),
                    "scheduler": scheduler.state_dict(),
                    "cpu_rng_state": torch.get_rng_state().clone(),
                },
                training_state_path,
            )
            saved_logits_rng = torch.get_rng_state().clone()
            model.eval()
            with torch.no_grad():
                expected_saved_logits = model(input_ids=input_ids).logits

            resume_base = Qwen2ForCausalLM(config)
            resume_base.load_state_dict(base_state)
            resumed = PeftModel.from_pretrained(resume_base, adapter_path, is_trainable=True)
            resumed_optimizer, resumed_scheduler = make_optimizer(resumed)
            checkpoint = torch.load(training_state_path, map_location="cpu", weights_only=True)
            if (type(checkpoint) is not dict
                    or set(checkpoint) != {
                        "global_step", "task_sampler_position", "optimizer", "scheduler", "cpu_rng_state"
                    }
                    or checkpoint["global_step"] != steps
                    or checkpoint["task_sampler_position"] != steps
                    or not isinstance(checkpoint["cpu_rng_state"], torch.Tensor)
                    or checkpoint["cpu_rng_state"].dtype != torch.uint8):
                raise RuntimeError("Qwen2 LoRA smoke checkpoint structure is invalid")
            resumed_scheduler.load_state_dict(checkpoint["scheduler"])
            resumed_optimizer.load_state_dict(checkpoint["optimizer"])
            torch.set_rng_state(saved_logits_rng)
            resumed.eval()
            with torch.no_grad():
                actual_saved_logits = resumed(input_ids=input_ids).logits
            if not torch.equal(expected_saved_logits, actual_saved_logits):
                raise RuntimeError("reloaded Qwen2 LoRA adapter does not reproduce saved adapter output")

            # Restore the captured RNG after model construction and verification
            # inference, then continue one update from the saved global step.
            torch.set_rng_state(checkpoint["cpu_rng_state"])
            resumed_losses = take_steps(resumed, resumed_optimizer, resumed_scheduler, 1)
            adapter_after_resume = Path(tmp) / "adapter-after-resume"
            resumed.save_pretrained(adapter_after_resume, safe_serialization=True)
            final_adapter_file = adapter_after_resume / "adapter_model.safetensors"
            if not final_adapter_file.is_file() or final_adapter_file.is_symlink():
                raise RuntimeError("resumed Qwen2 LoRA smoke did not save a regular adapter")
            digest = hashlib.sha256(final_adapter_file.read_bytes()).hexdigest()

            reference.eval()
            resumed.eval()
            with torch.no_grad():
                reference_logits = reference(input_ids=input_ids).logits
                resumed_logits = resumed(input_ids=input_ids).logits
            if not torch.equal(reference_logits, resumed_logits):
                raise RuntimeError("resumed Qwen2 LoRA output differs from uninterrupted training")
            reference_trainable = [
                (name, param) for name, param in reference.named_parameters() if param.requires_grad
            ]
            resumed_trainable = [
                (name, param) for name, param in resumed.named_parameters() if param.requires_grad
            ]
            resumed_matches_reference = (
                [name for name, _ in reference_trainable]
                == [name for name, _ in resumed_trainable]
                and len(reference_trainable) == len(resumed_trainable)
                and all(
                    torch.equal(ref_param.detach(), resumed_param.detach())
                    for (_, ref_param), (_, resumed_param) in zip(reference_trainable, resumed_trainable)
                )
            )
            if not resumed_matches_reference:
                raise RuntimeError("resumed Qwen2 LoRA adapter state differs from uninterrupted training")
            continued_loss_value = resumed_losses[0]
    finally:
        torch.set_rng_state(caller_rng_state)

    return {
        "schema_version": "guru-synthetic-qwen2-lora-smoke-v2",
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
        "resume_state_restored": True,
        "resumed_training_matches_uninterrupted": True,
        "trainable_parameters": sum(p.numel() for p in model.parameters() if p.requires_grad),
        "initial_loss_finite": all(
            torch.isfinite(torch.tensor(value)).item()
            for value in reference_losses + losses_before_save
        ),
        "reload_logits_equal": True,
        "continued_loss_finite": torch.isfinite(torch.tensor(continued_loss_value)).item(),
        "adapter_sha256": digest,
        "persistent_output_written": False,
        "trainer_qualified": False,
        "memory_fit_established": False,
        "coding_capability_established": False,
    }
