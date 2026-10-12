"""Export: Guru checkpoint → Hugging Face folder → GGUF → Ollama.

Guru's tensors already use the Llama names, so the Hugging Face folder is a
standard LlamaForCausalLM checkpoint (config.json, model.safetensors,
tokenizer.model). llama.cpp's converter turns it into GGUF, and Ollama runs it.
"""
import json
import os
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

import torch

from .config import GuruConfig
from .train import PROMPT_TEMPLATE

LLAMA_CPP = "https://github.com/ggml-org/llama.cpp"
LLAMA_CPP_TESTED = "4ebdf2c74acce30883d8e34b7c70b3eb8146f2fe"  # converter version Guru was tested with


def to_hf(ckpt_path, out_dir, tokenizer_path=None, dtype=torch.float16):
    from safetensors.torch import save_file
    ck = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    cfg = GuruConfig.from_dict(ck["config"])
    tok = tokenizer_path or ck.get("tokenizer")
    os.makedirs(out_dir, exist_ok=True)
    sd = {}
    for k, v in ck["model"].items():
        if cfg.tie_embeddings and k == "lm_head.weight":
            continue  # tied to model.embed_tokens.weight
        sd[k] = v.to(dtype).contiguous()
    save_file(sd, os.path.join(out_dir, "model.safetensors"), metadata={"format": "pt"})
    config = {
        "architectures": ["LlamaForCausalLM"], "model_type": "llama",
        "hidden_size": cfg.d_model, "intermediate_size": cfg.ffn_dim, "num_hidden_layers": cfg.n_layer,
        "num_attention_heads": cfg.n_head, "num_key_value_heads": cfg.n_kv_head, "head_dim": cfg.head_dim,
        "max_position_embeddings": cfg.max_seq_len, "rms_norm_eps": cfg.norm_eps, "rope_theta": cfg.rope_theta,
        "vocab_size": cfg.vocab_size, "tie_word_embeddings": cfg.tie_embeddings, "hidden_act": "silu",
        "attention_bias": False, "mlp_bias": False, "bos_token_id": cfg.bos_id, "eos_token_id": cfg.eos_id,
        "torch_dtype": "float16" if dtype == torch.float16 else "float32", "initializer_range": 0.02,
        "guru": {"name": cfg.name, "architecture": "GuruForCausalLM", "trained_from_scratch": True, "val_loss": ck.get("val_loss"), "steps": ck.get("step")},
    }
    with open(os.path.join(out_dir, "config.json"), "w") as f:
        json.dump(config, f, indent=2)
    with open(os.path.join(out_dir, "generation_config.json"), "w") as f:
        json.dump({"bos_token_id": cfg.bos_id, "eos_token_id": cfg.eos_id, "do_sample": True, "temperature": 0.8, "top_p": 0.95}, f, indent=2)
    shutil.copy(tok, os.path.join(out_dir, "tokenizer.model"))
    with open(os.path.join(out_dir, "tokenizer_config.json"), "w") as f:
        json.dump({"tokenizer_class": "LlamaTokenizer", "add_bos_token": True, "add_eos_token": False, "legacy": False,
                   "bos_token": "<s>", "eos_token": "</s>", "unk_token": "<unk>", "model_max_length": cfg.max_seq_len,
                   "clean_up_tokenization_spaces": False}, f, indent=2)
    with open(os.path.join(out_dir, "special_tokens_map.json"), "w") as f:
        json.dump({"bos_token": "<s>", "eos_token": "</s>", "unk_token": "<unk>"}, f, indent=2)
    write_model_card(out_dir, cfg, ck)
    return out_dir


def write_model_card(out_dir, cfg: GuruConfig, ck):
    sources = ""
    src = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "SOURCES.md")
    if os.path.exists(src):
        sources = open(src, encoding="utf-8").read().replace("# Guru training sources", "").strip()
    n = sum(v.numel() for k, v in ck["model"].items() if not (cfg.tie_embeddings and k == "lm_head.weight"))
    card = f"""# {cfg.name}

Part of **Guru**, MAATAA's own language model family, trained from scratch (no pretrained weights).

| | |
| --- | --- |
| Architecture | GuruForCausalLM: decoder-only transformer, RMSNorm, RoPE (θ={cfg.rope_theta:g}), grouped-query attention, SwiGLU (Llama-compatible tensor layout) |
| Parameters | {n/1e6:.1f}M |
| Layers / width / heads | {cfg.n_layer} / {cfg.d_model} / {cfg.n_head} query, {cfg.n_kv_head} key-value |
| Context | {cfg.max_seq_len} tokens |
| Tokenizer | Guru-Dhatu v0: SentencePiece BPE, {cfg.vocab_size} pieces, byte fallback, NFC |
| Training | {ck.get('step')} steps; validation loss {ck.get('val_loss')} |
| Prompt format | {'`' + PROMPT_TEMPLATE.replace(chr(10), '⏎') + '`' if 'instruct' in cfg.name else 'base model: continues text'} |

## Training data
{sources or 'See data/SOURCES.md.'}

## Licence
Code: Apache-2.0. Guru-Code checkpoints and exports are private local artifacts;
distribution is disabled by the owner-selected I7 use-scope policy. A local format
conversion does not grant permission to share the resulting weights.

## Limits
A small model trained on a modest corpus: it writes fluent-looking text but knows little and makes things up. Do not rely on its facts.
Guru-Panini v0 checks Devanagari orthography only, not grammar or truth.
"""
    with open(os.path.join(out_dir, "README.md"), "w", encoding="utf-8") as f:
        f.write(card)


def ensure_llama_cpp(tools_dir):
    path = os.path.join(tools_dir, "llama.cpp")
    if not os.path.exists(os.path.join(path, "convert_hf_to_gguf.py")):
        os.makedirs(tools_dir, exist_ok=True)
        print("Getting llama.cpp's converter (one time)…")
        subprocess.run(["git", "clone", "--depth", "1", LLAMA_CPP, path], check=True)
        # Use the converter version Guru was tested with when it is still available.
        if subprocess.run(["git", "-C", path, "fetch", "--depth", "1", "origin", LLAMA_CPP_TESTED], capture_output=True).returncode == 0:
            subprocess.run(["git", "-C", path, "checkout", "-q", LLAMA_CPP_TESTED], check=False)
    return path


def to_gguf(hf_dir, out_file, tools_dir, outtype="f16"):
    lc = ensure_llama_cpp(tools_dir)
    subprocess.run([sys.executable, os.path.join(lc, "convert_hf_to_gguf.py"), hf_dir, "--outfile", out_file, "--outtype", outtype], check=True)
    return out_file


def modelfile(gguf_name, cfg: GuruConfig):
    lines = [f"FROM ./{gguf_name}", "PARAMETER temperature 0.8", "PARAMETER top_p 0.95", "PARAMETER repeat_penalty 1.1",
             f"PARAMETER num_ctx {cfg.max_seq_len}", 'PARAMETER stop "</s>"']
    if "instruct" in cfg.name:
        lines += ['TEMPLATE """### प्रश्न / Question:\n{{ .Prompt }}\n\n### उत्तर / Answer:\n"""', 'PARAMETER stop "### प्रश्न"']
    else:
        lines += ['TEMPLATE """{{ .Prompt }}"""']
    return "\n".join(lines) + "\n"


def _local_ollama_host(configured_host: str | None) -> str:
    """Return a normalized loopback Ollama URL or reject a remote destination.

    Ollama defaults OLLAMA_HOST to 127.0.0.1:11434. It also accepts host:port
    without a scheme, so parse that form using the same local default. Only
    localhost names and literal loopback IP addresses are allowed here.
    """
    import ipaddress

    raw = (configured_host or "").strip()
    if not raw:
        return "http://127.0.0.1:11434"

    has_scheme = "://" in raw
    parsed = urlsplit(raw if has_scheme else "//" + raw)
    scheme = parsed.scheme.lower() if has_scheme else "http"
    if scheme not in {"http", "https"}:
        raise ValueError("Ollama destination must use a local HTTP endpoint")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Ollama destination must not include credentials")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("Ollama destination must be a local server origin without a path")
    try:
        host = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Ollama destination has an invalid host or port") from exc
    if not host:
        raise ValueError("Ollama destination must name a local host")

    normalized_host = host.rstrip(".").lower()
    if normalized_host != "localhost":
        try:
            address = ipaddress.ip_address(normalized_host)
        except ValueError as exc:
            raise ValueError("Ollama destination must be localhost or a loopback IP address") from exc
        if not address.is_loopback:
            raise ValueError("remote Ollama destinations are disabled by the I7 private-local policy")
        normalized_host = f"[{address.compressed}]" if address.version == 6 else address.compressed

    if port is None:
        if has_scheme:
            port = 80 if scheme == "http" else 443
        else:
            port = 11434
    if not 1 <= port <= 65535:
        raise ValueError("Ollama destination port must be between 1 and 65535")
    return f"{scheme}://{normalized_host}:{port}"


def to_ollama(gguf_file, name, cfg: GuruConfig, ollama="ollama"):
    # Validate before creating or changing the Modelfile. Pass an explicit,
    # normalized loopback target so the child process cannot inherit a remote
    # OLLAMA_HOST configuration.
    local_host = _local_ollama_host(os.environ.get("OLLAMA_HOST"))
    child_env = os.environ.copy()
    child_env["OLLAMA_HOST"] = local_host
    folder = os.path.dirname(os.path.abspath(gguf_file))
    mf = os.path.join(folder, "Modelfile")
    with open(mf, "w", encoding="utf-8") as f:
        f.write(modelfile(os.path.basename(gguf_file), cfg))
    subprocess.run([ollama, "create", name, "-f", mf], check=True, cwd=folder, env=child_env)
    return name
