from unittest.mock import patch

import pytest

from guru.config import preset
from guru.export import to_ollama


@pytest.mark.parametrize(
    ("configured_host", "expected_host"),
    [
        (None, "http://127.0.0.1:11434"),
        ("localhost:11434", "http://localhost:11434"),
        ("http://localhost", "http://localhost:80"),
        ("http://127.0.0.1:11434", "http://127.0.0.1:11434"),
        ("http://[::1]:11434", "http://[::1]:11434"),
    ],
)
def test_to_ollama_allows_default_and_explicit_loopback(tmp_path, monkeypatch,
                                                        configured_host, expected_host):
    if configured_host is None:
        monkeypatch.delenv("OLLAMA_HOST", raising=False)
    else:
        monkeypatch.setenv("OLLAMA_HOST", configured_host)
    gguf = tmp_path / "guru.gguf"
    gguf.touch()

    with patch("guru.export.subprocess.run") as run:
        assert to_ollama(str(gguf), "guru-local", preset("nano")) == "guru-local"

    run.assert_called_once()
    assert run.call_args.kwargs["env"]["OLLAMA_HOST"] == expected_host
    assert (tmp_path / "Modelfile").is_file()


@pytest.mark.parametrize(
    "configured_host",
    [
        "http://ollama.example:11434",
        "192.168.1.20:11434",
        "0.0.0.0:11434",
        "tcp://127.0.0.1:11434",
        "http://localhost.example:11434",
    ],
)
def test_to_ollama_rejects_remote_destination_before_modelfile_or_process(
    tmp_path, monkeypatch, configured_host,
):
    monkeypatch.setenv("OLLAMA_HOST", configured_host)
    gguf = tmp_path / "guru.gguf"
    gguf.touch()

    with patch("guru.export.subprocess.run") as run:
        with pytest.raises(ValueError, match="Ollama destination|remote Ollama"):
            to_ollama(str(gguf), "guru-remote", preset("nano"))

    run.assert_not_called()
    assert not (tmp_path / "Modelfile").exists()


def test_to_ollama_rejects_remote_host_without_changing_existing_modelfile(tmp_path, monkeypatch):
    monkeypatch.setenv("OLLAMA_HOST", "ollama.example:11434")
    gguf = tmp_path / "guru.gguf"
    gguf.touch()
    modelfile = tmp_path / "Modelfile"
    modelfile.write_text("existing local model config\n", encoding="utf-8")

    with patch("guru.export.subprocess.run") as run:
        with pytest.raises(ValueError, match="Ollama destination"):
            to_ollama(str(gguf), "guru-remote", preset("nano"))

    run.assert_not_called()
    assert modelfile.read_text(encoding="utf-8") == "existing local model config\n"
