"""I7 guards for persistent corpus transforms and base training paths."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from guru import data
from guru.__main__ import main
from guru.train import _train_impl, train
from guru import tokenizer


@pytest.mark.parametrize(
    "operation",
    ["fetch", "build", "tokenizer_input", "encode"],
)
def test_persistent_data_apis_deny_before_reads_network_or_writes(tmp_path, operation):
    data_dir = tmp_path / "missing-data"
    corpus = data_dir / "corpus.txt"
    output = data_dir / "transformed.txt"

    with patch.object(data, "_get") as download, \
            pytest.raises(PermissionError, match="disabled by I7.*ephemeral only"):
        if operation == "fetch":
            data.fetch_wikipedia(str(data_dir), langs=("en",))
        elif operation == "build":
            data.build_corpus(str(data_dir))
        elif operation == "tokenizer_input":
            data.write_tokenizer_input(str(corpus), str(output))
        else:
            data.encode_corpus(str(data_dir), str(data_dir / "missing-tokenizer.model"))

    download.assert_not_called()
    assert not data_dir.exists()


@pytest.mark.parametrize("command", ["corpus", "build", "tokenizer", "encode", "prepare"])
def test_cli_persistent_transform_commands_deny_before_creating_data(tmp_path, command):
    with patch("guru.__main__.DATA", str(tmp_path / "data")):
        with pytest.raises(SystemExit, match="disabled by I7.*ephemeral only"):
            main([command])
    assert not (tmp_path / "data").exists()


def test_cli_code_data_and_code_eval_deny_before_reading_or_writing(tmp_path):
    tasks = tmp_path / "missing-tasks.jsonl"
    predictions = tmp_path / "missing-predictions.jsonl"
    sft_output = tmp_path / "persistent-sft.jsonl"
    report_output = tmp_path / "persistent-eval-report.json"

    with pytest.raises(SystemExit, match="code-data is disabled by I7.*persistent storage"):
        main(["code-data", "--tasks", str(tasks), "--sft-out", str(sft_output)])
    with pytest.raises(SystemExit, match="code-eval is disabled by I7.*qualified local evaluator"):
        main(["code-eval", "--tasks", str(tasks), "--predictions", str(predictions), "--out", str(report_output)])

    assert not tasks.exists()
    assert not predictions.exists()
    assert not sft_output.exists()
    assert not report_output.exists()


def test_direct_tokenizer_training_denies_before_reading_or_creating_outputs(tmp_path):
    corpus = tmp_path / "missing-corpus.txt"
    dhatus = tmp_path / "missing-dhatus.txt"
    output_prefix = tmp_path / "tokenizer" / "guru"

    with patch.object(tokenizer, "load_dhatus") as load_dhatus, \
            patch.object(tokenizer.spm.SentencePieceTrainer, "train") as sentencepiece_train, \
            pytest.raises(PermissionError, match="persistent tokenizer training is disabled by I7"):
        tokenizer.train(str(corpus), str(output_prefix), vocab_size=32, dhatus_path=str(dhatus))

    load_dhatus.assert_not_called()
    sentencepiece_train.assert_not_called()
    assert not corpus.exists()
    assert not dhatus.exists()
    assert not output_prefix.parent.exists()


@pytest.mark.parametrize("entrypoint", [train, _train_impl])
def test_base_training_entrypoints_deny_persistent_token_files_before_reads_or_output(tmp_path, entrypoint):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "train.bin").write_bytes(b"persistent transformed training tokens")
    (data_dir / "val.bin").write_bytes(b"persistent transformed validation tokens")
    output = tmp_path / "out"

    with patch("guru.train.torch.load") as load_checkpoint, \
            patch("guru.train.TokenStream") as token_stream, \
            pytest.raises(ValueError, match="persistent train.bin/val.bin.*disabled by I7"):
        entrypoint(size="nano", data_dir=str(data_dir), out_dir=str(output),
                   tokenizer_path=str(tmp_path / "missing-tokenizer.model"), device="cpu")

    load_checkpoint.assert_not_called()
    token_stream.assert_not_called()
    assert not output.exists()


def test_cli_base_training_denies_but_synthetic_benchmark_remains_available(tmp_path):
    with patch("guru.__main__.DATA", str(tmp_path / "data")), \
            patch("guru.__main__.OUT", str(tmp_path / "out")):
        with pytest.raises(SystemExit, match="persistent train.bin/val.bin.*disabled by I7"):
            main(["train"])
        assert not (tmp_path / "out").exists()

        with patch("guru.train.train", return_value={"synthetic_data": True}) as run_training:
            main(["train", "--benchmark-steps", "1"])
        assert run_training.call_args.kwargs["benchmark_steps"] == 1
