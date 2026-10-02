"""Model sizes. Parameter counts are with tied input/output embeddings."""
from dataclasses import dataclass, asdict, field
import json


@dataclass
class GuruConfig:
    name: str = "guru-maataa-nano"
    vocab_size: int = 24000
    d_model: int = 384
    n_layer: int = 6
    n_head: int = 6
    n_kv_head: int = 2          # grouped-query attention: fewer key/value heads than query heads
    ffn_dim: int = 1024         # SwiGLU hidden size
    max_seq_len: int = 512
    rope_theta: float = 10000.0
    norm_eps: float = 1e-5
    tie_embeddings: bool = True
    dropout: float = 0.0
    bos_id: int = 1
    eos_id: int = 2
    # Training defaults for this size (tokens to see, batch in tokens, peak learning rate)
    train_tokens: int = 200_000_000
    batch_tokens: int = 32_768
    lr: float = 1e-3
    extra: dict = field(default_factory=dict)

    @property
    def head_dim(self) -> int:
        return self.d_model // self.n_head

    def validate(self):
        assert self.d_model % self.n_head == 0, "d_model must divide by n_head"
        assert self.n_head % self.n_kv_head == 0, "n_head must divide by n_kv_head"
        assert self.head_dim % 2 == 0, "RoPE needs an even head size"
        return self

    def n_params(self) -> int:
        d, f, l, hd = self.d_model, self.ffn_dim, self.n_layer, self.head_dim
        attn = d * d * 2 + d * self.n_kv_head * hd * 2
        mlp = 3 * d * f
        per_layer = attn + mlp + 2 * d
        emb = self.vocab_size * d
        return emb * (1 if self.tie_embeddings else 2) + l * per_layer + d

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)

    @classmethod
    def from_dict(cls, d: dict) -> "GuruConfig":
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**known).validate()


# Trainable on a Mac with Apple silicon (MPS). The three local sizes share one 24,000-piece
# tokenizer, so one prepared corpus serves all of them. The cloud sizes use 32,000 pieces (run prepare again).
# Cloud sizes follow the usual ~20 tokens per parameter for a compute-efficient run.
PRESETS = {
    "nano":    dict(name="guru-maataa-nano",  vocab_size=24000, d_model=384,  n_layer=6,  n_head=6,  n_kv_head=2, ffn_dim=1024,  max_seq_len=512,  train_tokens=200_000_000,   batch_tokens=32_768,  lr=1e-3),
    "mini":    dict(name="guru-maataa-mini",  vocab_size=24000, d_model=512,  n_layer=8,  n_head=8,  n_kv_head=4, ffn_dim=1408,  max_seq_len=1024, train_tokens=500_000_000,   batch_tokens=65_536,  lr=8e-4),
    "small":   dict(name="guru-maataa-small", vocab_size=24000, d_model=768,  n_layer=12, n_head=12, n_kv_head=4, ffn_dim=2048,  max_seq_len=1024, train_tokens=1_000_000_000, batch_tokens=131_072, lr=6e-4),
    "base-1b": dict(name="guru-maataa-1b",    vocab_size=32000, d_model=2048, n_layer=22, n_head=32, n_kv_head=4, ffn_dim=5632,  max_seq_len=2048, train_tokens=22_000_000_000,  batch_tokens=1_048_576, lr=4e-4),
    "7b":      dict(name="guru-maataa-7b",    vocab_size=32000, d_model=4096, n_layer=32, n_head=32, n_kv_head=8, ffn_dim=14336, max_seq_len=4096, train_tokens=140_000_000_000, batch_tokens=4_194_304, lr=3e-4),
}
LOCAL_SIZES = ("nano", "mini", "small")


def preset(name: str, **overrides) -> GuruConfig:
    if name not in PRESETS:
        raise ValueError(f"Unknown size {name!r}. Choose one of: {', '.join(PRESETS)}")
    return GuruConfig(**{**PRESETS[name], **overrides}).validate()
