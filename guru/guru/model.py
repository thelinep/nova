"""GuruForCausalLM: a decoder-only transformer written from scratch.

RMSNorm, rotary position embeddings (RoPE), grouped-query causal attention and
a SwiGLU feed-forward block. Parameter names follow the Llama layout
(model.layers.N.self_attn.q_proj, mlp.gate_proj, ...), so a trained Guru exports
as a LlamaForCausalLM checkpoint and converts to GGUF for llama.cpp and Ollama
without any custom code. The architecture is ours; the file layout is shared.
"""
import math
import torch
import torch.nn as nn
import torch.nn.functional as F

from .config import GuruConfig


class RMSNorm(nn.Module):
    def __init__(self, dim: int, eps: float = 1e-5):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))

    def forward(self, x):
        dtype = x.dtype
        x = x.float()
        x = x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps)
        return self.weight * x.to(dtype)


def rope_tables(head_dim: int, seq_len: int, theta: float, device=None):
    inv_freq = 1.0 / (theta ** (torch.arange(0, head_dim, 2, device=device).float() / head_dim))
    t = torch.arange(seq_len, device=device).float()
    freqs = torch.outer(t, inv_freq)
    emb = torch.cat((freqs, freqs), dim=-1)
    return emb.cos(), emb.sin()


def rotate_half(x):
    x1, x2 = x[..., : x.shape[-1] // 2], x[..., x.shape[-1] // 2:]
    return torch.cat((-x2, x1), dim=-1)


def apply_rope(x, cos, sin):
    # x: (B, H, T, D); cos/sin: (T, D)
    return (x * cos) + (rotate_half(x) * sin)


class Attention(nn.Module):
    def __init__(self, c: GuruConfig):
        super().__init__()
        self.n_head, self.n_kv, self.hd = c.n_head, c.n_kv_head, c.head_dim
        self.q_proj = nn.Linear(c.d_model, c.n_head * self.hd, bias=False)
        self.k_proj = nn.Linear(c.d_model, c.n_kv_head * self.hd, bias=False)
        self.v_proj = nn.Linear(c.d_model, c.n_kv_head * self.hd, bias=False)
        self.o_proj = nn.Linear(c.n_head * self.hd, c.d_model, bias=False)
        self.dropout = c.dropout

    def forward(self, x, cos, sin):
        B, T, _ = x.shape
        q = self.q_proj(x).view(B, T, self.n_head, self.hd).transpose(1, 2)
        k = self.k_proj(x).view(B, T, self.n_kv, self.hd).transpose(1, 2)
        v = self.v_proj(x).view(B, T, self.n_kv, self.hd).transpose(1, 2)
        q, k = apply_rope(q, cos, sin), apply_rope(k, cos, sin)
        if self.n_kv != self.n_head:  # each key/value head serves a group of query heads
            rep = self.n_head // self.n_kv
            k = k.repeat_interleave(rep, dim=1)
            v = v.repeat_interleave(rep, dim=1)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True, dropout_p=self.dropout if self.training else 0.0)
        return self.o_proj(y.transpose(1, 2).reshape(B, T, self.n_head * self.hd))


class MLP(nn.Module):
    def __init__(self, c: GuruConfig):
        super().__init__()
        self.gate_proj = nn.Linear(c.d_model, c.ffn_dim, bias=False)
        self.up_proj = nn.Linear(c.d_model, c.ffn_dim, bias=False)
        self.down_proj = nn.Linear(c.ffn_dim, c.d_model, bias=False)

    def forward(self, x):
        return self.down_proj(F.silu(self.gate_proj(x)) * self.up_proj(x))


class Block(nn.Module):
    def __init__(self, c: GuruConfig):
        super().__init__()
        self.input_layernorm = RMSNorm(c.d_model, c.norm_eps)
        self.self_attn = Attention(c)
        self.post_attention_layernorm = RMSNorm(c.d_model, c.norm_eps)
        self.mlp = MLP(c)

    def forward(self, x, cos, sin):
        x = x + self.self_attn(self.input_layernorm(x), cos, sin)
        return x + self.mlp(self.post_attention_layernorm(x))


class GuruModel(nn.Module):
    def __init__(self, c: GuruConfig):
        super().__init__()
        self.embed_tokens = nn.Embedding(c.vocab_size, c.d_model)
        self.layers = nn.ModuleList([Block(c) for _ in range(c.n_layer)])
        self.norm = RMSNorm(c.d_model, c.norm_eps)


class GuruForCausalLM(nn.Module):
    def __init__(self, config: GuruConfig):
        super().__init__()
        self.config = config.validate()
        self.model = GuruModel(config)
        self.lm_head = nn.Linear(config.d_model, config.vocab_size, bias=False)
        if config.tie_embeddings:
            self.lm_head.weight = self.model.embed_tokens.weight
        cos, sin = rope_tables(config.head_dim, config.max_seq_len, config.rope_theta)
        self.register_buffer("rope_cos", cos, persistent=False)
        self.register_buffer("rope_sin", sin, persistent=False)
        self.apply(self._init)
        # GPT-2 style: scale the residual projections down with depth.
        for n, p in self.named_parameters():
            if n.endswith("o_proj.weight") or n.endswith("down_proj.weight"):
                nn.init.normal_(p, mean=0.0, std=0.02 / math.sqrt(2 * config.n_layer))

    @staticmethod
    def _init(m):
        if isinstance(m, nn.Linear):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)
        elif isinstance(m, nn.Embedding):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)

    def num_parameters(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def forward(self, input_ids, targets=None, loss_mask=None):
        B, T = input_ids.shape
        if T > self.config.max_seq_len:
            raise ValueError(f"Sequence of {T} tokens is longer than this model's {self.config.max_seq_len}.")
        x = self.model.embed_tokens(input_ids)
        cos, sin = self.rope_cos[:T].to(x.dtype), self.rope_sin[:T].to(x.dtype)
        for layer in self.model.layers:
            x = layer(x, cos, sin)
        logits = self.lm_head(self.model.norm(x))
        loss = None
        if targets is not None:
            per_tok = F.cross_entropy(logits.float().view(-1, logits.size(-1)), targets.view(-1), reduction="none", ignore_index=-100)
            if loss_mask is not None:  # instruction tuning: learn only the answer tokens
                m = loss_mask.view(-1).float()
                loss = (per_tok * m).sum() / m.sum().clamp(min=1)
            else:
                valid = (targets.view(-1) != -100).float()
                loss = (per_tok * valid).sum() / valid.sum().clamp(min=1)
        return logits, loss

    @torch.no_grad()
    def generate(self, idx, max_new_tokens=128, temperature=0.8, top_k=50, top_p=0.95, eos_id=None, repetition_penalty=1.1):
        self.eval()
        for _ in range(max_new_tokens):
            idx_cond = idx[:, -self.config.max_seq_len:]
            logits, _ = self(idx_cond)
            logits = logits[:, -1, :].float()
            if repetition_penalty and repetition_penalty != 1.0:
                seen = idx_cond[0].unique()
                logits[0, seen] = torch.where(logits[0, seen] > 0, logits[0, seen] / repetition_penalty, logits[0, seen] * repetition_penalty)
            if temperature <= 0:
                next_id = logits.argmax(-1, keepdim=True)
            else:
                logits = logits / temperature
                if top_k:
                    v, _ = torch.topk(logits, min(top_k, logits.size(-1)))
                    logits[logits < v[:, [-1]]] = float("-inf")
                probs = F.softmax(logits, dim=-1)
                if top_p and top_p < 1.0:
                    sp, si = torch.sort(probs, descending=True)
                    cut = sp.cumsum(-1) - sp > top_p
                    sp[cut] = 0
                    probs = torch.zeros_like(probs).scatter(-1, si, sp)
                    probs = probs / probs.sum(-1, keepdim=True)
                next_id = torch.multinomial(probs, 1)
            idx = torch.cat([idx, next_id], dim=1)
            if eos_id is not None and int(next_id[0, 0]) == eos_id:
                break
        return idx
