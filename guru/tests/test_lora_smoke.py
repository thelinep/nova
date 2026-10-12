from pathlib import Path

import pytest
import torch

from guru.lora_smoke import run_synthetic_lora_smoke


def test_synthetic_lora_smoke_trains_saves_reloads_and_continues_offline(monkeypatch):
    pytest.importorskip("peft")
    import tempfile

    created_dirs = []
    real_temporary_directory = tempfile.TemporaryDirectory

    def track_temporary_directory(*args, **kwargs):
        directory = real_temporary_directory(*args, **kwargs)
        created_dirs.append(directory.name)
        return directory

    monkeypatch.setattr("guru.lora_smoke.tempfile.TemporaryDirectory", track_temporary_directory)
    torch_rng_before = torch.get_rng_state().clone()
    result = run_synthetic_lora_smoke(seed=17, steps=2)

    assert result["schema_version"] == "guru-synthetic-lora-smoke-v1"
    assert result["synthetic_only"] is True
    assert result["network_used"] is False
    assert result["selected_student_weights_loaded"] is False
    assert result["steps_before_save"] == 2
    assert result["continued_steps_after_reload"] == 1
    assert result["trainable_parameters"] > 0
    assert result["initial_loss_finite"] is True
    assert result["reload_logits_equal"] is True
    assert result["continued_loss_finite"] is True
    assert len(result["adapter_sha256"]) == 64
    assert result["persistent_output_written"] is False
    assert len(created_dirs) == 1
    assert not Path(created_dirs[0]).exists()
    assert torch.equal(torch_rng_before, torch.get_rng_state())


@pytest.mark.parametrize("steps", [0, 1, True, 2.0])
def test_synthetic_lora_smoke_rejects_invalid_step_count_before_import(steps):
    with pytest.raises(ValueError, match="at least 2"):
        run_synthetic_lora_smoke(steps=steps)


@pytest.mark.parametrize("seed", [-1, True, 1.5])
def test_synthetic_lora_smoke_rejects_invalid_seed_before_import(seed):
    with pytest.raises(ValueError, match="non-negative integer"):
        run_synthetic_lora_smoke(seed=seed)


def test_synthetic_lora_smoke_rejects_in_checkout_temp_root_before_training(monkeypatch):
    repo_root = Path(__file__).resolve().parents[1]
    monkeypatch.setattr("guru.lora_smoke.tempfile.tempdir", str(repo_root / ".tmp-smoke"))

    with pytest.raises(RuntimeError, match="outside the Guru checkout"):
        run_synthetic_lora_smoke(seed=17, steps=2)

    assert not (repo_root / ".tmp-smoke").exists()
