from pathlib import Path

import pytest
import torch

from guru.qwen2_lora_smoke import run_synthetic_qwen2_lora_smoke


def test_synthetic_qwen2_lora_smoke_roundtrips_and_continues_offline(monkeypatch):
    pytest.importorskip("peft")
    import tempfile

    created_dirs = []
    real_temporary_directory = tempfile.TemporaryDirectory

    def track_temporary_directory(*args, **kwargs):
        directory = real_temporary_directory(*args, **kwargs)
        created_dirs.append(directory.name)
        return directory

    monkeypatch.setattr("guru.qwen2_lora_smoke.tempfile.TemporaryDirectory", track_temporary_directory)
    rng_before = torch.get_rng_state().clone()
    result = run_synthetic_qwen2_lora_smoke(seed=23, steps=2)

    assert result["schema_version"] == "guru-synthetic-qwen2-lora-smoke-v2"
    assert result["synthetic_only"] is True
    assert result["transformed_real_data_used"] is False
    assert result["network_used"] is False
    assert result["selected_student_weights_loaded"] is False
    assert result["architecture_compatibility_only"] is True
    assert result["trainer_qualified"] is False
    assert result["memory_fit_established"] is False
    assert result["coding_capability_established"] is False
    assert result["target_modules"] == ["q_proj", "k_proj", "v_proj", "o_proj"]
    assert result["steps_before_save"] == 2
    assert result["continued_steps_after_reload"] == 1
    assert result["trainable_parameters"] > 0
    assert result["initial_loss_finite"] is True
    assert result["reload_logits_equal"] is True
    assert result["resume_state_restored"] is True
    assert result["resumed_training_matches_uninterrupted"] is True
    assert result["continued_loss_finite"] is True
    assert len(result["adapter_sha256"]) == 64
    assert result["persistent_output_written"] is False
    assert len(created_dirs) == 1
    assert not Path(created_dirs[0]).exists()
    assert torch.equal(rng_before, torch.get_rng_state())


@pytest.mark.parametrize("steps", [0, 1, True, 2.0])
def test_synthetic_qwen2_lora_smoke_rejects_invalid_steps(steps):
    with pytest.raises(ValueError, match="at least 2"):
        run_synthetic_qwen2_lora_smoke(steps=steps)


def test_synthetic_qwen2_lora_smoke_rejects_unbounded_step_count():
    with pytest.raises(ValueError, match="no greater than 32"):
        run_synthetic_qwen2_lora_smoke(steps=33)


@pytest.mark.parametrize("seed", [-1, True, 1.5])
def test_synthetic_qwen2_lora_smoke_rejects_invalid_seed(seed):
    with pytest.raises(ValueError, match="non-negative integer"):
        run_synthetic_qwen2_lora_smoke(seed=seed)


def test_synthetic_qwen2_lora_smoke_rejects_in_checkout_temp_root(monkeypatch):
    repo_root = Path(__file__).resolve().parents[1]
    monkeypatch.setattr("guru.ephemeral.tempfile.tempdir", str(repo_root / ".tmp-qwen2-smoke"))

    with pytest.raises(RuntimeError, match="outside the Guru checkout"):
        run_synthetic_qwen2_lora_smoke(seed=23, steps=2)

    assert not (repo_root / ".tmp-qwen2-smoke").exists()
