"""Training: pretraining on train.bin, or instruction tuning on a JSONL of questions and answers.

Runs on Apple silicon (MPS), NVIDIA (CUDA, several GPUs with torchrun) or CPU.
Stops cleanly at a token budget or a time budget, keeps the best checkpoint by
validation loss, and can resume. Every evaluation writes a line to log.jsonl
with the loss, speed and a short sample, and Guru-Panini's score of the sample.
"""
import json
import math
import os
import time
from contextlib import nullcontext

import numpy as np
import torch
import torch.distributed as dist

from .config import GuruConfig, preset
from .model import GuruForCausalLM
from .tokenizer import Tokenizer, BOS, EOS
from . import panini

PROMPT_TEMPLATE = "### प्रश्न / Question:\n{prompt}\n\n### उत्तर / Answer:\n"
SAMPLE_PROMPTS = ["भारत", "संस्कृतम्", "The film begins"]


def pick_device(want=None):
    if want:
        return want
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class TokenStream:
    """Random windows from a uint16 token file (memory-mapped, so the corpus need not fit in RAM)."""
    def __init__(self, path, seq_len, seed=0):
        self.data = np.memmap(path, dtype=np.uint16, mode="r")
        if len(self.data) <= seq_len + 1:
            raise SystemExit(f"{os.path.basename(path)} has only {len(self.data)} tokens; the model needs more than {seq_len + 1}. Add text or use a smaller size.")
        self.seq_len, self.rng = seq_len, np.random.default_rng(seed)

    def batch(self, bs, device):
        ix = self.rng.integers(0, len(self.data) - self.seq_len - 1, size=bs)
        x = np.stack([self.data[i:i + self.seq_len].astype(np.int64) for i in ix])
        y = np.stack([self.data[i + 1:i + 1 + self.seq_len].astype(np.int64) for i in ix])
        return torch.from_numpy(x).to(device), torch.from_numpy(y).to(device)


class SFTStream:
    """Question/answer pairs in the Guru template; the loss counts only the answer tokens."""
    def __init__(self, path, tok: Tokenizer, seq_len, seed=0):
        self.items = []
        with open(path, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                p = tok.encode(PROMPT_TEMPLATE.format(prompt=r["prompt"].strip()), bos=True)
                a = tok.encode(r["answer"].strip(), eos=True)
                ids = (p + a)[: seq_len + 1]
                mask = ([0] * len(p) + [1] * len(a))[: seq_len + 1]
                if sum(mask[1:]) > 0:
                    self.items.append((ids, mask))
        if not self.items:
            raise SystemExit("No usable question/answer pairs found.")
        self.seq_len, self.rng = seq_len, np.random.default_rng(seed)

    def batch(self, bs, device):
        pick = self.rng.integers(0, len(self.items), size=bs)
        T = min(self.seq_len, max(len(self.items[i][0]) for i in pick) - 1)
        x = torch.full((bs, T), EOS, dtype=torch.long); y = torch.full((bs, T), -100, dtype=torch.long); m = torch.zeros((bs, T))
        for r, i in enumerate(pick):
            ids, mask = self.items[i]
            n = min(len(ids) - 1, T)
            x[r, :n] = torch.tensor(ids[:n]); y[r, :n] = torch.tensor(ids[1:n + 1]); m[r, :n] = torch.tensor(mask[1:n + 1], dtype=torch.float)
        return x.to(device), y.to(device), m.to(device)


def lr_at(step, total, peak, warmup):
    if step < warmup:
        return peak * (step + 1) / warmup
    progress = min(1.0, (step - warmup) / max(1, total - warmup))
    return peak * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * progress)))


def sample(model, tok, prompt, device, n=48):
    ids = torch.tensor([tok.encode(prompt, bos=True)], device=device)
    out = model.generate(ids, max_new_tokens=n, temperature=0.8, top_k=40, eos_id=EOS)
    return tok.decode(out[0].tolist())


def train(size="nano", data_dir="data", out_dir="out", tokenizer_path=None, minutes=None, tokens=None, micro_bs=None,
          resume=False, device=None, sft=None, init_from=None, eval_every=200, seed=1337, compile_model=False, overrides=None):
    ddp = int(os.environ.get("WORLD_SIZE", "1")) > 1
    rank = 0
    if ddp:
        dist.init_process_group("nccl"); rank = dist.get_rank()
        torch.cuda.set_device(int(os.environ["LOCAL_RANK"])); device = f"cuda:{int(os.environ['LOCAL_RANK'])}"
    device = pick_device(device)
    master = rank == 0
    torch.manual_seed(seed + rank)
    tokenizer_path = tokenizer_path or os.path.join(data_dir, "guru-dhatu.model")
    tok = Tokenizer(tokenizer_path)

    ckpt = None
    if init_from or resume:
        src = init_from or os.path.join(out_dir, "last.pt")
        ckpt = torch.load(src, map_location="cpu", weights_only=False)
        cfg = GuruConfig.from_dict(ckpt["config"])
    else:
        cfg = preset(size, vocab_size=tok.vocab_size, **(overrides or {}))
    if cfg.vocab_size != tok.vocab_size:
        raise SystemExit(f"The tokenizer has {tok.vocab_size} pieces but the model expects {cfg.vocab_size}.")
    if sft:
        cfg.name = cfg.name.replace("-instruct", "") + "-instruct"

    model = GuruForCausalLM(cfg).to(device)
    if ckpt:
        model.load_state_dict(ckpt["model"])
    raw_model = model
    if compile_model and device.startswith("cuda"):
        model = torch.compile(model)
    if ddp:
        model = torch.nn.parallel.DistributedDataParallel(model, device_ids=[int(os.environ["LOCAL_RANK"])])

    seq = cfg.max_seq_len
    micro_bs = micro_bs or {"nano": 16, "mini": 8, "small": 4}.get(size, 2)
    world = dist.get_world_size() if ddp else 1
    accum = max(1, cfg.batch_tokens // (seq * micro_bs * world))
    budget = int(tokens or cfg.train_tokens)
    total_steps = max(1, budget // (seq * micro_bs * accum * world))
    if sft:
        stream = SFTStream(sft, tok, seq, seed + rank)
        val_stream = None
        total_steps = min(total_steps, int(tokens or 0) // (seq * micro_bs * accum) or 600)
        peak = cfg.lr * 0.1
    else:
        stream = TokenStream(os.path.join(data_dir, "train.bin"), seq, seed + rank)
        val_stream = TokenStream(os.path.join(data_dir, "val.bin"), seq, 999)
        peak = cfg.lr
    warmup = min(500, max(20, total_steps // 20))

    decay = [p for n, p in raw_model.named_parameters() if p.dim() >= 2]
    nodecay = [p for n, p in raw_model.named_parameters() if p.dim() < 2]
    opt = torch.optim.AdamW([{"params": decay, "weight_decay": 0.1}, {"params": nodecay, "weight_decay": 0.0}],
                            lr=peak, betas=(0.9, 0.95), eps=1e-8, fused=device.startswith("cuda"))
    step, best = 0, float("inf")
    if resume and ckpt and not init_from:
        opt.load_state_dict(ckpt["optimizer"]); step = ckpt["step"]; best = ckpt.get("best_val", best)

    amp = torch.autocast("cuda", dtype=torch.bfloat16) if device.startswith("cuda") else nullcontext()
    os.makedirs(out_dir, exist_ok=True)
    if master:
        with open(os.path.join(out_dir, "config.json"), "w") as f:
            f.write(cfg.to_json())
        print(f"{cfg.name}: {raw_model.num_parameters()/1e6:.1f}M parameters on {device} · context {seq} · "
              f"batch {micro_bs}×{accum}×{world} sequences ({seq*micro_bs*accum*world:,} tokens) · {total_steps:,} steps "
              f"({total_steps*seq*micro_bs*accum*world/1e6:,.0f}M tokens){' · stops after ' + str(minutes) + ' min' if minutes else ''}")
    log = open(os.path.join(out_dir, "log.jsonl"), "a") if master else None
    t_start, t_last, tok_count = time.time(), time.time(), 0

    def evaluate():
        raw_model.eval(); losses = []
        with torch.no_grad():
            for _ in range(20 if val_stream else 0):
                x, y = val_stream.batch(micro_bs, device)
                with amp:
                    _, l = raw_model(x, y)
                losses.append(l.item())
        raw_model.train()
        return float(np.mean(losses)) if losses else None

    def save(name, val):
        # best.pt holds only the weights (small); last.pt also keeps the optimizer so training can resume.
        state = {"model": raw_model.state_dict(), "config": json.loads(cfg.to_json()),
                 "step": step, "best_val": best, "val_loss": val, "tokenizer": os.path.abspath(tokenizer_path)}
        if name == "last.pt":
            state["optimizer"] = opt.state_dict()
        tmp = os.path.join(out_dir, name + ".tmp")
        torch.save(state, tmp); os.replace(tmp, os.path.join(out_dir, name))

    model.train()
    stop_reason = "token budget"
    while step < total_steps:
        lr = lr_at(step, total_steps, peak, warmup)
        for g in opt.param_groups:
            g["lr"] = lr
        loss_sum = 0.0
        for micro in range(accum):
            if sft:
                x, y, m = stream.batch(micro_bs, device)
            else:
                (x, y), m = stream.batch(micro_bs, device), None
            if ddp:
                model.require_backward_grad_sync = micro == accum - 1
            with amp:
                _, loss = model(x, y, m)
            (loss / accum).backward()
            loss_sum += loss.item() / accum
            tok_count += x.numel() * world
        torch.nn.utils.clip_grad_norm_(raw_model.parameters(), 1.0)
        opt.step(); opt.zero_grad(set_to_none=True)
        step += 1
        if not math.isfinite(loss_sum):
            raise SystemExit(f"The loss became {loss_sum} at step {step}. Lower the learning rate (try --lr {peak/3:.1e}) and resume.")
        timeout = minutes and (time.time() - t_start) / 60 >= minutes
        if master and (step % eval_every == 0 or step == total_steps or timeout or step == 1):
            val = evaluate()
            dt = time.time() - t_last; t_last = time.time()
            rate = tok_count / max(dt, 1e-6); tok_count = 0
            text = sample(raw_model, tok, SAMPLE_PROMPTS[(step // max(1, eval_every)) % len(SAMPLE_PROMPTS)], device)
            check = panini.verify(text)
            rec = {"step": step, "of": total_steps, "loss": round(loss_sum, 4), "val": None if val is None else round(val, 4), "lr": lr,
                   "tok_per_s": round(rate), "minutes": round((time.time() - t_start) / 60, 1), "sample": text[:300], "panini_score": check["score"]}
            log.write(json.dumps(rec, ensure_ascii=False) + "\n"); log.flush()
            print(f"step {step:>6}/{total_steps} · loss {loss_sum:.3f}" + (f" · val {val:.3f}" if val is not None else "") +
                  f" · {rate/1000:,.1f}k tok/s · {rec['minutes']} min\n    “{text[:140].strip()}”  (Panini {check['score']:.2f})")
            if val is not None and val < best:
                best = val; save("best.pt", val)
            save("last.pt", val)
        if timeout:
            stop_reason = f"{minutes} minute limit"
            break
    if master:
        val = evaluate()
        if val is not None and val < best:
            best = val; save("best.pt", val)
        if sft or val is None:
            save("best.pt", val)
        save("last.pt", val)
        summary = {"model": cfg.name, "params": raw_model.num_parameters(), "steps": step, "stopped": stop_reason, "best_val": None if best == float("inf") else best,
                   "minutes": round((time.time() - t_start) / 60, 1), "device": device}
        with open(os.path.join(out_dir, "summary.json"), "w") as f:
            json.dump(summary, f, indent=2)
        print(f"Done ({stop_reason}). Best validation loss {summary['best_val']}. Checkpoint: {os.path.join(out_dir, 'best.pt')}")
    if ddp:
        dist.destroy_process_group()
    return out_dir
