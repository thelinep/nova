from pathlib import Path

import pytest
import torch

from guru.qwen2_lora_smoke import _SyntheticTaskSampler, run_synthetic_qwen2_lora_smoke


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
    assert len(result["sampled_task_indices"]) == 3
    assert result["sampler_draws_before_resume"] == 2
    assert result["sampler_draws_after_resume"] == 3
    assert result["continued_loss_finite"] is True
    assert len(result["adapter_sha256"]) == 64
    assert result["persistent_output_written"] is False
    assert len(created_dirs) == 1
    assert not Path(created_dirs[0]).exists()
    assert torch.equal(rng_before, torch.get_rng_state())


def test_synthetic_qwen2_lora_resume_matches_after_sampler_cycle():
    pytest.importorskip("peft")

    result = run_synthetic_qwen2_lora_smoke(seed=29, steps=4)
    expected_sampler = _SyntheticTaskSampler(4, seed=31)
    expected_indices = [expected_sampler.next_index() for _ in range(5)]

    assert result["sampled_task_indices"] == expected_indices
    assert result["sampler_draws_before_resume"] == 4
    assert result["sampler_draws_after_resume"] == 5
    assert result["resumed_training_matches_uninterrupted"] is True
    assert result["reload_logits_equal"] is True
    assert result["coding_capability_established"] is False


@pytest.mark.parametrize("steps", [0, 1, True, 2.0])
def test_synthetic_qwen2_lora_smoke_rejects_invalid_steps(steps):
    with pytest.raises(ValueError, match="at least 2"):
        run_synthetic_qwen2_lora_smoke(steps=steps)


def test_synthetic_qwen2_lora_smoke_rejects_unbounded_step_count():
    with pytest.raises(ValueError, match="no greater than 32"):
        run_synthetic_qwen2_lora_smoke(steps=33)


def test_synthetic_task_sampler_restores_next_task_and_rng_state():
    uninterrupted = _SyntheticTaskSampler(4, seed=25)
    first_cycle = [uninterrupted.next_index() for _ in range(4)]
    expected_after_checkpoint = [uninterrupted.next_index() for _ in range(7)]

    interrupted = _SyntheticTaskSampler(4, seed=25)
    observed_before_save = [interrupted.next_index() for _ in range(4)]
    checkpoint = interrupted.state_dict()
    resumed = _SyntheticTaskSampler(4, seed=25)
    resumed.load_state_dict(checkpoint)

    assert observed_before_save == first_cycle
    assert [resumed.next_index() for _ in range(7)] == expected_after_checkpoint
    assert resumed.draws == 11


@pytest.mark.parametrize("change", ["version", "task_count", "cursor", "draws", "permutation", "permutation_device", "generator_state"])
def test_synthetic_task_sampler_rejects_inconsistent_state(change):
    sampler = _SyntheticTaskSampler(4, seed=25)
    sampler.next_index()
    state = sampler.state_dict()
    if change == "version":
        state["version"] = True
    elif change == "task_count":
        state["task_count"] = True
    elif change == "cursor":
        state["cursor"] = 4
    elif change == "draws":
        state["draws"] = -1
    elif change == "permutation":
        state["permutation"] = torch.tensor([0, 0, 2, 3])
    elif change == "permutation_device":
        state["permutation"] = torch.empty(4, dtype=torch.int64, device="meta")
    else:
        state["generator_state"] = torch.ones(2, dtype=torch.float32)

    with pytest.raises(ValueError, match="checkpoint state is invalid"):
        sampler.load_state_dict(state)


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
