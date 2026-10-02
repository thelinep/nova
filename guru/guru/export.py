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
Code: Apache-2.0. Weights: chosen by the owner. The training text includes CC BY-SA 4.0 material, so keep the attribution above;
whether share-alike terms reach trained weights is not settled law, so check before publishing the weights.

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


def to_ollama(gguf_file, name, cfg: GuruConfig, ollama="ollama"):
    folder = os.path.dirname(os.path.abspath(gguf_file))
    mf = os.path.join(folder, "Modelfile")
    with open(mf, "w", encoding="utf-8") as f:
        f.write(modelfile(os.path.basename(gguf_file), cfg))
    subprocess.run([ollama, "create", name, "-f", mf], check=True, cwd=folder)
    return name
