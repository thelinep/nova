import json
import hashlib
import os
from pathlib import Path

import torch
import pytest
import numpy as np
from unittest.mock import patch

from guru.sft_smoke import ByteTokenizer, _model_state_digest, run_synthetic_sft_smoke
from guru.train import (
    PROMPT_TEMPLATE,
    SFTStream,
    _build_sft_training_identity,
    _canonical_synthetic_smoke_sft,
    _validate_sft_resume_identity,
    _train_impl,
    _train_synthetic_sft_smoke,
    sample,
    train,
)
from guru.config import GuruConfig
from guru.model import GuruForCausalLM


def _write_jsonl(path, rows):
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    return path


def test_sft_stream_masks_prompt_and_eos_answer_tokens_and_ignores_padding(tmp_path):
    rows = [
        {"prompt": "short", "answer": "x"},
        {"prompt": "a longer prompt", "answer": "long answer"},
    ]
    stream = SFTStream(_write_jsonl(tmp_path / "pairs.jsonl", rows), ByteTokenizer(), seq_len=128, seed=4)
    x, y, mask = stream.batch_indices([0, 1], "cpu")

    assert x.shape == y.shape == mask.shape
    assert mask.dtype == torch.float32
    for row_index, row in enumerate(rows):
        prompt_len = len(ByteTokenizer().encode(PROMPT_TEMPLATE.format(prompt=row["prompt"]), bos=True))
        answer_len = len(ByteTokenizer().encode(row["answer"], eos=True))
        true_length = len(stream.items[row_index][0]) - 1
        assert mask[row_index, :prompt_len - 1].sum().item() == 0
        assert mask[row_index, prompt_len - 1:true_length].sum().item() == answer_len
        assert torch.all(y[row_index, prompt_len - 1:true_length] != -100)
        if true_length < y.shape[1]:
            assert torch.all(y[row_index, true_length:] == -100)
            assert torch.all(mask[row_index, true_length:] == 0)
            assert torch.all(x[row_index, true_length:] == ByteTokenizer.eos_id)


@pytest.mark.parametrize(
    ("line", "message"),
    [
        ('{"answer":"x"}', "non-empty string prompt"),
        ('{"prompt":"x","answer":3}', "non-empty string answer"),
        ('{"prompt":"x","answer":"  "}', "non-empty string answer"),
        ('{"prompt":"x",', "not valid JSON"),
        ('[]', "must be a JSON object"),
    ],
)
def test_sft_stream_rejects_malformed_rows(tmp_path, line, message):
    path = tmp_path / "bad.jsonl"
    path.write_text(line + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match=message):
        SFTStream(path, ByteTokenizer(), seq_len=128)


def test_sft_stream_rejects_over_context_instead_of_truncating(tmp_path):
    path = _write_jsonl(tmp_path / "long.jsonl", [{"prompt": "tiny", "answer": "answer"}])
    with pytest.raises(ValueError, match="Refusing to truncate the answer"):
        SFTStream(path, ByteTokenizer(), seq_len=32)


def test_sft_stream_batch_sampling_is_repeatable_for_fixed_seed(tmp_path):
    path = _write_jsonl(tmp_path / "pairs.jsonl", [
        {"prompt": "first", "answer": "one"},
        {"prompt": "second", "answer": "two"},
    ])
    first = SFTStream(path, ByteTokenizer(), seq_len=128, seed=1234)
    second = SFTStream(path, ByteTokenizer(), seq_len=128, seed=1234)
    batch_a = first.batch(8, "cpu")
    batch_b = second.batch(8, "cpu")
    assert all(torch.equal(a, b) for a, b in zip(batch_a, batch_b))


def test_sft_stream_resume_restores_next_row_selection_not_initial_seed(tmp_path):
    path = _write_jsonl(tmp_path / "pairs.jsonl", [
        {"prompt": "first", "answer": "one"},
        {"prompt": "second", "answer": "two"},
    ])
    continuing = SFTStream(path, ByteTokenizer(), seq_len=128, seed=321)
    continuing.next_indices(1)  # one training batch was consumed before the checkpoint
    state = continuing.state_dict()
    expected_next = continuing.next_indices(12)

    resumed = SFTStream(path, ByteTokenizer(), seq_len=128, seed=321)
    resumed.load_state_dict(state)
    actual_next = resumed.next_indices(12)
    restarted_from_seed = SFTStream(path, ByteTokenizer(), seq_len=128, seed=321).next_indices(12)

    assert np.array_equal(actual_next, expected_next)
    assert not np.array_equal(actual_next, restarted_from_seed)


def test_public_train_rejects_persistent_sft_before_loading_or_writing(tmp_path):
    fixture = _write_jsonl(tmp_path / "pairs.jsonl", [{"prompt": "task", "answer": "answer"}])
    output = tmp_path / "out"
    with patch("guru.train.torch.load") as load_checkpoint:
        with pytest.raises(ValueError, match="disabled by I7.*ephemeral-only"):
            train(size="nano", data_dir=str(tmp_path), out_dir=str(output),
                  tokenizer_path=str(tmp_path / "tokenizer.json"), sft=str(fixture), device="cpu")
    load_checkpoint.assert_not_called()
    assert not output.exists()


def test_internal_train_impl_rejects_arbitrary_sft_without_smoke_authorization(tmp_path):
    fixture = _write_jsonl(tmp_path / "pairs.jsonl", [{"prompt": "task", "answer": "arbitrary"}])
    output = tmp_path / "out"
    with patch("guru.train.torch.load") as load_checkpoint:
        with pytest.raises(ValueError, match="disabled by I7"):
            _train_impl(size="nano", data_dir=str(tmp_path), out_dir=str(output),
                        tokenizer_path=str(tmp_path / "tokenizer.json"), sft=str(fixture), device="cpu")
    load_checkpoint.assert_not_called()
    assert not output.exists()


def test_cli_teach_rejects_pairs_and_panini_before_creating_or_reading_files(tmp_path):
    from guru.__main__ import main

    pairs = tmp_path / "pairs.jsonl"
    pairs.write_text('{"prompt":"task","answer":"answer"}\n', encoding="utf-8")
    generated = tmp_path / "teach-combined.jsonl"
    with patch("guru.__main__.DATA", str(tmp_path)):
        with pytest.raises(SystemExit, match="disabled by I7.*ephemeral-only"):
            main(["teach", "--pairs", str(pairs), "--panini"])
    assert not generated.exists()


@pytest.mark.parametrize("change", ["edit_data", "reorder_data", "tokenizer", "tokenizer_behavior",
                                    "recipe", "total_steps", "eval_every"])
def test_sft_training_identity_rejects_changed_data_tokenizer_or_recipe(tmp_path, change):
    rows = [
        {"prompt": "one", "answer": "first answer"},
        {"prompt": "two", "answer": "second answer"},
    ]
    data_path = _write_jsonl(tmp_path / "pairs.jsonl", rows)
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text('{"type":"byte-v1","vocab_size":258}\n', encoding="utf-8")
    tokenizer = ByteTokenizer()
    config = GuruConfig(name="guru-maataa-nano-instruct", vocab_size=258, d_model=32, n_layer=1,
                        n_head=4, n_kv_head=2, ffn_dim=64, max_seq_len=128, batch_tokens=128)

    def identity(micro_bs=1, total_steps=2, eval_every=1, tok=None):
        active_tokenizer = tok or tokenizer
        stream = SFTStream(data_path, active_tokenizer, seq_len=config.max_seq_len, seed=77)
        return _build_sft_training_identity(
            stream, active_tokenizer, tokenizer_path, config, micro_bs=micro_bs,
            accumulation=1, world=1, device="cpu", peak_lr=config.lr * 0.1,
            warmup=20, seed=77, total_steps=total_steps, eval_every=eval_every,
        )

    saved = identity()
    if change == "edit_data":
        _write_jsonl(data_path, [{**rows[0]}, {**rows[1], "answer": "changed answer"}])
    elif change == "reorder_data":
        _write_jsonl(data_path, list(reversed(rows)))
    elif change == "tokenizer":
        tokenizer_path.write_text('{"type":"byte-v2","vocab_size":258}\n', encoding="utf-8")
    elif change == "tokenizer_behavior":
        changed_tokenizer = ByteTokenizer()
        original_encode = changed_tokenizer.encode
        changed_tokenizer.encode = lambda text, bos=False, eos=False: original_encode(
            text.upper(), bos=bos, eos=eos
        )
        changed = identity(tok=changed_tokenizer)
        assert changed["tokenizer"] == saved["tokenizer"]
        assert changed["tokenized_stream_sha256"] != saved["tokenized_stream_sha256"]
        with pytest.raises(ValueError, match="identity mismatch"):
            _validate_sft_resume_identity({"sft_training_identity": saved}, changed)
        return
    elif change == "recipe":
        with pytest.raises(ValueError, match="identity mismatch"):
            _validate_sft_resume_identity({"sft_training_identity": saved}, identity(micro_bs=2))
        return
    elif change == "total_steps":
        with pytest.raises(ValueError, match="identity mismatch"):
            _validate_sft_resume_identity({"sft_training_identity": saved}, identity(total_steps=3))
        return
    elif change == "eval_every":
        with pytest.raises(ValueError, match="identity mismatch"):
            _validate_sft_resume_identity({"sft_training_identity": saved}, identity(eval_every=2))
        return

    with pytest.raises(ValueError, match="identity mismatch"):
        _validate_sft_resume_identity({"sft_training_identity": saved}, identity())


def test_sample_restores_prior_model_training_mode_with_dropout():
    config = GuruConfig(vocab_size=258, d_model=16, n_layer=1, n_head=2, n_kv_head=1,
                        ffn_dim=32, max_seq_len=96, dropout=0.4)
    model = GuruForCausalLM(config)
    tokenizer = ByteTokenizer()

    model.train()
    sample(model, tokenizer, "x", "cpu", n=1)
    assert model.training is True

    model.eval()
    sample(model, tokenizer, "x", "cpu", n=1)
    assert model.training is False


def test_sft_policy_blocks_before_ddp_process_group_initialization(tmp_path):
    fixture = _write_jsonl(tmp_path / "pairs.jsonl", [{"prompt": "tiny", "answer": "answer"}])
    with patch.dict(os.environ, {"WORLD_SIZE": "2"}):
        with patch("guru.train.dist.init_process_group") as init_group, \
                pytest.raises(ValueError, match="disabled by I7"):
            train(size="nano", data_dir=str(tmp_path), out_dir=str(tmp_path / "out"),
                  tokens=256, micro_bs=1, resume=True, device="cpu", sft=str(fixture),
                  tokenizer_override=ByteTokenizer())
    init_group.assert_not_called()


def test_sft_policy_blocks_before_device_selection_or_checkpoint_loading(tmp_path):
    fixture = _write_jsonl(tmp_path / "pairs.jsonl", [{"prompt": "tiny", "answer": "answer"}])
    with patch("guru.train.pick_device") as choose_device, \
            patch("guru.train.torch.load") as load_checkpoint:
        with pytest.raises(ValueError, match="disabled by I7"):
            train(size="nano", data_dir=str(tmp_path), out_dir=str(tmp_path / "out"),
                  tokens=256, micro_bs=1, resume=True, sft=str(fixture),
                  tokenizer_override=ByteTokenizer())
    choose_device.assert_not_called()
    load_checkpoint.assert_not_called()


def test_direct_sft_entrypoint_rejects_even_temporary_custom_fixture(tmp_path):
    fixture = _write_jsonl(tmp_path / "pairs.jsonl", [
        {"prompt": "write add", "answer": "def add(a, b): return a + b"},
    ])
    with pytest.raises(ValueError, match="disabled by I7"):
        train(size="nano", data_dir=str(tmp_path), out_dir=str(tmp_path / "out"),
              tokenizer_path=str(tmp_path / "tokenizer.json"), tokens=256, micro_bs=1,
              device="cpu", sft=str(fixture), tokenizer_override=ByteTokenizer())
    assert not (tmp_path / "out").exists()


def test_smoke_training_route_rejects_noncanonical_temp_fixture_before_training(tmp_path):
    fixture = _write_jsonl(tmp_path / "pairs.jsonl", [
        {"prompt": "task", "answer": "not the fixed smoke example"},
    ])
    tokenizer = tmp_path / "tokenizer.json"
    tokenizer.write_text("synthetic tokenizer placeholder", encoding="utf-8")
    with pytest.raises(ValueError, match="fixed authored fixture"):
        _train_synthetic_sft_smoke(
            sft=str(fixture), data_dir=str(tmp_path), out_dir=str(tmp_path / "out"),
            tokenizer_path=str(tokenizer), device="cpu", size="nano", tokens=256,
        )
    assert not (tmp_path / "out").exists()


def _seed_smoke_inputs(directory):
    directory.mkdir()
    fixture = directory / "synthetic-sft.jsonl"
    fixture.write_bytes(_canonical_synthetic_smoke_sft())
    tokenizer = directory / "synthetic-byte-tokenizer.json"
    tokenizer.write_text("synthetic tokenizer", encoding="utf-8")
    return fixture, tokenizer


def test_smoke_training_route_rejects_any_initial_checkpoint(tmp_path):
    fixture, tokenizer = _seed_smoke_inputs(tmp_path / "run")
    with patch("guru.train.torch.load") as load_checkpoint:
        with pytest.raises(ValueError, match="does not accept an initial checkpoint"):
            _train_synthetic_sft_smoke(
                sft=str(fixture), data_dir=str(fixture.parent), out_dir=str(fixture.parent),
                tokenizer_path=str(tokenizer), device="cpu", size="nano", tokens=256,
                init_from=str(tmp_path / "initial.pt"),
            )
    load_checkpoint.assert_not_called()
    assert set(path.name for path in fixture.parent.iterdir()) == {
        "synthetic-sft.jsonl", "synthetic-byte-tokenizer.json",
    }


def test_smoke_training_route_rejects_existing_unowned_output_contents(tmp_path):
    fixture, tokenizer = _seed_smoke_inputs(tmp_path / "run")
    unexpected = fixture.parent / "keep-me.txt"
    unexpected.write_text("pre-existing", encoding="utf-8")
    with patch("guru.train.torch.load") as load_checkpoint:
        with pytest.raises(ValueError, match="not fresh or is not owned"):
            _train_synthetic_sft_smoke(
                sft=str(fixture), data_dir=str(fixture.parent), out_dir=str(fixture.parent),
                tokenizer_path=str(tokenizer), device="cpu", size="nano", tokens=256,
            )
    load_checkpoint.assert_not_called()
    assert unexpected.read_text(encoding="utf-8") == "pre-existing"


def test_cpu_synthetic_sft_updates_reloads_and_resumes_to_exact_budget(tmp_path):
    output = tmp_path / "sft-run"
    manifest = run_synthetic_sft_smoke(output, total_steps=2, seed=77)

    assert manifest["schema_version"] == "guru-synthetic-sft-smoke-manifest-v4"
    assert manifest["synthetic"] is True
    assert manifest["qualification"] is False
    assert manifest["capability_claim"] is False
    assert manifest["training"]["device"] == "cpu"
    assert manifest["training"]["steps"] == 2
    assert manifest["training"]["loss_is_answer_only"] is True
    assert manifest["training"]["resume_verified"] is True
    assert manifest["training"]["sampler_state_resume_verified"] is True
    assert manifest["training"]["weights_finite"] is True
    assert manifest["training"]["weights_changed"] is True
    assert manifest["base_checkpoint_sha256"] is None
    assert set(manifest["digests"]["code_files_sha256"]) == {
        "sft_smoke.py", "train.py", "config.py", "model.py",
    }
    for key in ("config_sha256", "fixture_sha256", "tokenizer_sha256", "checkpoint_sha256",
                "sft_training_identity_sha256",
                "initial_weights_sha256", "trained_weights_sha256"):
        assert len(manifest["digests"][key]) == 64
    assert json.loads((output / "run-manifest.json").read_text(encoding="utf-8")) == manifest
    project_root = Path(__file__).resolve().parents[1]
    code_root = project_root / "guru"
    for name, expected in manifest["digests"]["code_files_sha256"].items():
        assert hashlib.sha256((code_root / name).read_bytes()).hexdigest() == expected
    config = json.loads((output / "config.json").read_text(encoding="utf-8"))
    canonical_config = (json.dumps(config, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    assert hashlib.sha256(canonical_config).hexdigest() == manifest["digests"]["config_sha256"]
    assert hashlib.sha256((output / "synthetic-sft.jsonl").read_bytes()).hexdigest() == manifest["digests"]["fixture_sha256"]
    assert hashlib.sha256((output / "synthetic-byte-tokenizer.json").read_bytes()).hexdigest() == manifest["digests"]["tokenizer_sha256"]
    assert hashlib.sha256((output / "best.pt").read_bytes()).hexdigest() == manifest["digests"]["checkpoint_sha256"]
    best = torch.load(output / "best.pt", map_location="cpu", weights_only=True)
    last = torch.load(output / "last.pt", map_location="cpu", weights_only=True)
    assert best["step"] == last["step"] == 2
    assert isinstance(last["optimizer"], dict)
    assert best["config"]["max_seq_len"] == 192
    assert last["sft_training_identity"]["recipe"]["total_optimizer_steps"] == 2
    assert last["sft_training_identity"]["recipe"]["evaluation_and_sampling_cadence_steps"] == 1
    trained_state_digest = _model_state_digest(best["model"])
    assert trained_state_digest == manifest["digests"]["trained_weights_sha256"]
    torch.manual_seed(manifest["training"]["seed"])
    initial_model = GuruForCausalLM(GuruConfig.from_dict(config))
    assert _model_state_digest(initial_model.state_dict()) == manifest["digests"]["initial_weights_sha256"]
    identity_bytes = (json.dumps(last["sft_training_identity"], sort_keys=True,
                                 ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    assert hashlib.sha256(identity_bytes).hexdigest() == manifest["digests"]["sft_training_identity_sha256"]


def test_cpu_synthetic_sft_refuses_output_outside_tempdir(tmp_path):
    # The repo-local out path is refused before the helper can create anything.
    with pytest.raises(ValueError, match="system temporary directory"):
        run_synthetic_sft_smoke(Path(__file__).resolve().parents[1] / "out" / "must-not-create", total_steps=2)
