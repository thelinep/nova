"""Reproducible, synthetic-only CPU SFT smoke path for the native Guru model.

This module deliberately uses a temporary byte tokenizer and two inline authored
examples. It is for checking the trainer plumbing only; it cannot qualify a
coding model or admit a corpus.
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path

import torch

from .config import GuruConfig
from .model import GuruForCausalLM
from .train import train


MANIFEST_VERSION = "guru-synthetic-sft-smoke-manifest-v4"


class ByteTokenizer:
    """Small deterministic UTF-8 byte tokenizer used only by this smoke path."""

    vocab_size = 258
    bos_id = 256
    eos_id = 257

    def encode(self, text: str, bos: bool = False, eos: bool = False) -> list[int]:
        raw = list(text.encode("utf-8"))
        return ([self.bos_id] if bos else []) + raw + ([self.eos_id] if eos else [])

    def decode(self, ids, script="devanagari") -> str:
        raw = bytes(int(token) for token in ids if 0 <= int(token) <= 255)
        return raw.decode("utf-8", errors="replace")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _canonical_json(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _model_state_digest(state: dict[str, torch.Tensor]) -> str:
    digest = hashlib.sha256()
    for name, tensor in sorted(state.items()):
        value = tensor.detach().cpu().contiguous()
        digest.update(name.encode("utf-8") + b"\0")
        digest.update(str(value.dtype).encode("ascii") + b"\0")
        digest.update(_canonical_json(list(value.shape)))
        digest.update(value.numpy().tobytes())
    return digest.hexdigest()


def _source_digests() -> dict[str, str]:
    package = Path(__file__).resolve().parent
    paths = (package / "sft_smoke.py", package / "train.py", package / "config.py", package / "model.py")
    return {path.name: _sha256_bytes(path.read_bytes()) for path in paths}


def run_synthetic_sft_smoke(out_dir: str | os.PathLike[str], *, total_steps: int = 2, seed: int = 20261012) -> dict:
    """Train a tiny native Guru model on inline synthetic data, writing only below the system temp dir.

    The first process segment saves one step. A second trainer invocation resumes
    from that checkpoint to ``total_steps``, exercising optimizer restoration and
    total-step accounting. The output directory must be a new child of the system
    temporary directory so this smoke cannot write into the repository's ``out``.
    """
    if type(total_steps) is not int or total_steps < 2:
        raise ValueError("total_steps must be an integer of at least 2 to exercise resume")
    if type(seed) is not int or seed < 0:
        raise ValueError("seed must be a non-negative integer")

    temp_root = Path(tempfile.gettempdir()).resolve()
    target = Path(out_dir).expanduser().resolve()
    if target == temp_root or temp_root not in target.parents:
        raise ValueError("synthetic SFT output must be a child of the system temporary directory")
    target.mkdir(parents=True, exist_ok=False)

    rows = [
        {"prompt": "Write add(a, b).", "answer": "def add(a, b):\n    return a + b"},
        {"prompt": "Write a zero function.", "answer": "def zero():\n    return 0"},
    ]
    fixture_bytes = b"".join(_canonical_json(row) for row in rows)
    fixture_path = target / "synthetic-sft.jsonl"
    fixture_path.write_bytes(fixture_bytes)

    tokenizer_metadata = {
        "type": "utf8-byte",
        "vocab_size": ByteTokenizer.vocab_size,
        "bos_id": ByteTokenizer.bos_id,
        "eos_id": ByteTokenizer.eos_id,
        "synthetic_only": True,
    }
    tokenizer_bytes = _canonical_json(tokenizer_metadata)
    tokenizer_path = target / "synthetic-byte-tokenizer.json"
    tokenizer_path.write_bytes(tokenizer_bytes)

    seq_len = 192
    config = GuruConfig(
        vocab_size=ByteTokenizer.vocab_size,
        d_model=32,
        n_layer=1,
        n_head=4,
        n_kv_head=2,
        ffn_dim=64,
        max_seq_len=seq_len,
        train_tokens=seq_len * total_steps,
        batch_tokens=seq_len,
        lr=2e-3,
    ).validate()
    # ``train(sft=...)`` appends this conventional suffix before saving.
    config.name = "guru-maataa-nano-instruct"
    config_bytes = _canonical_json(json.loads(config.to_json()))
    torch.manual_seed(seed)
    initial_model = GuruForCausalLM(config)
    initial_weights_sha256 = _model_state_digest(initial_model.state_dict())
    del initial_model

    prior_threads = torch.get_num_threads()
    try:
        torch.set_num_threads(1)
        train(
            size="nano", data_dir=str(target), out_dir=str(target),
            tokenizer_path=str(tokenizer_path), tokens=seq_len * total_steps, micro_bs=1,
            sft=str(fixture_path), eval_every=1, seed=seed, device="cpu",
            overrides={key: value for key, value in json.loads(config.to_json()).items() if key != "name"},
            tokenizer_override=ByteTokenizer(), stop_at_step=1,
        )
        train(
            size="nano", data_dir=str(target), out_dir=str(target),
            tokenizer_path=str(tokenizer_path), tokens=seq_len * total_steps, micro_bs=1,
            sft=str(fixture_path), eval_every=1, seed=seed, device="cpu", resume=True,
            tokenizer_override=ByteTokenizer(),
        )
    finally:
        torch.set_num_threads(prior_threads)

    checkpoint_path = target / "best.pt"
    last_path = target / "last.pt"
    if not checkpoint_path.is_file() or not last_path.is_file():
        raise RuntimeError("synthetic SFT did not write both best.pt and last.pt")
    best_state = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    last_state = torch.load(last_path, map_location="cpu", weights_only=True)
    if last_state.get("step") != total_steps:
        raise RuntimeError(f"resumed SFT ended at step {last_state.get('step')}; expected {total_steps}")
    if not isinstance(last_state.get("optimizer"), dict):
        raise RuntimeError("last.pt does not contain optimizer state for resume")
    model = GuruForCausalLM(GuruConfig.from_dict(best_state["config"]))
    model.load_state_dict(best_state["model"])
    finite = all(
        torch.isfinite(tensor).all().item()
        for tensor in best_state["model"].values()
        if torch.is_floating_point(tensor)
    )
    if not finite:
        raise RuntimeError("synthetic SFT checkpoint contains non-finite weights")
    final_weights_sha256 = _model_state_digest(best_state["model"])

    code_files = _source_digests()
    manifest = {
        "schema_version": MANIFEST_VERSION,
        "synthetic": True,
        "qualification": False,
        "capability_claim": False,
        "base_checkpoint_sha256": None,
        "training": {
            "method": "native Guru full-parameter SFT from random initialization",
            "device": "cpu",
            "seed": seed,
            "steps": last_state["step"],
            "context_positions": seq_len,
            "parameter_count": model.num_parameters(),
            "loss_is_answer_only": True,
            "resume_verified": True,
            "sampler_state_resume_verified": "sft_stream_state" in last_state,
            "weights_finite": True,
            "weights_changed": final_weights_sha256 != initial_weights_sha256,
        },
        "digests": {
            "code_files_sha256": code_files,
            "config_sha256": _sha256_bytes(config_bytes),
            "fixture_sha256": _sha256_bytes(fixture_bytes),
            "tokenizer_sha256": _sha256_bytes(tokenizer_bytes),
            "checkpoint_sha256": _sha256_bytes(checkpoint_path.read_bytes()),
            "sft_training_identity_sha256": _sha256_bytes(_canonical_json(last_state["sft_training_identity"])),
            "initial_weights_sha256": initial_weights_sha256,
            "trained_weights_sha256": final_weights_sha256,
        },
        "limitations": [
            "The examples are tiny, hand-authored synthetic smoke data, not an approved or representative corpus.",
            "The byte tokenizer is a temporary test tokenizer, not Guru-Dhatu or a selected student tokenizer.",
            "The model was initialized from random weights; no student base was selected or used.",
            "The short context and loss check do not establish code correctness, coding capability, or Maataa qualification.",
            "This run is CPU plumbing evidence only and provides no training-capacity or release claim.",
        ],
    }
    (target / "run-manifest.json").write_bytes(_canonical_json(manifest))
    return manifest


def main(argv=None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", required=True, help="new child directory under the system temporary directory")
    parser.add_argument("--steps", type=int, default=2, help="total optimizer steps; at least 2 to exercise resume")
    parser.add_argument("--seed", type=int, default=20261012)
    args = parser.parse_args(argv)
    result = run_synthetic_sft_smoke(args.out_dir, total_steps=args.steps, seed=args.seed)
    print("SYNTHETIC_SFT_SMOKE " + json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
