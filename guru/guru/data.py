"""Guru's corpus: open Wikipedia (Sanskrit, Hindi, English) plus your own texts.

  fetch_wikipedia()  downloads cleaned article text (the Wikimedia "wikipedia"
                     dataset on Hugging Face, Parquet) up to a size cap per language
  build_corpus()     NFC, light cleaning, Guru-Panini filter for Devanagari,
                     exact-duplicate removal, your texts weighted higher
  encode_corpus()    tokenises into train.bin / val.bin (uint16 token ids)

Wikipedia text is CC BY-SA 4.0: attribution is recorded in data/SOURCES.md and
the model card, and a model trained on it should keep that notice.
"""
import hashlib
import json
import os
import random
import re
import shutil
import sys
import time
import unicodedata
import urllib.request

import numpy as np

from . import panini
from .tokenizer import Tokenizer, EOS

DATASET = "wikimedia/wikipedia"
SNAPSHOT = "20231101"
DEFAULT_CAPS_MB = {"sa": 80, "hi": 250, "en": 250}  # text megabytes kept per language


def _get(url, dest=None, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "guru-maataa/0.1 (local training)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if dest is None:
            return r.read()
        tmp = dest + ".part"
        with open(tmp, "wb") as f:
            done, total, t0 = 0, int(r.headers.get("Content-Length") or 0), time.time()
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk); done += len(chunk)
                if total:
                    sys.stdout.write(f"\r    {done/1e6:,.0f} / {total/1e6:,.0f} MB"); sys.stdout.flush()
        os.replace(tmp, dest)
        if total:
            print()
        return dest


def free_gb(path):
    return shutil.disk_usage(path).free / 1e9


def fetch_wikipedia(data_dir, langs=("sa", "hi", "en"), caps_mb=None, snapshot=SNAPSHOT):
    """Downloads Parquet shards per language until the text cap is reached; writes raw/wiki-<lang>.txt."""
    import pyarrow.parquet as pq
    caps = {**DEFAULT_CAPS_MB, **(caps_mb or {})}
    raw = os.path.join(data_dir, "raw"); os.makedirs(raw, exist_ok=True)
    report = {}
    for lang in langs:
        out = os.path.join(raw, f"wiki-{lang}.txt")
        cap = caps.get(lang, 100) * 1_000_000
        if os.path.exists(out) and os.path.getsize(out) >= cap * 0.95:
            print(f"  {lang}: already have {os.path.getsize(out)/1e6:,.0f} MB"); report[lang] = os.path.getsize(out); continue
        need = cap * 3 / 1e9 + 1
        if free_gb(data_dir) < need:
            raise SystemExit(f"Not enough free disk space for {lang} ({free_gb(data_dir):.1f} GB free, about {need:.1f} GB needed). Lower the cap or free space.")
        listing = json.loads(_get(f"https://huggingface.co/api/datasets/{DATASET}/tree/main/{snapshot}.{lang}"))
        shards = sorted(x["path"] for x in listing if x.get("path", "").endswith(".parquet"))
        if not shards:
            raise SystemExit(f"No Wikipedia files found for {lang}.")
        written = 0
        with open(out, "w", encoding="utf-8") as fo:
            for shard in shards:
                if written >= cap:
                    break
                local = os.path.join(raw, os.path.basename(shard).replace(".parquet", f".{lang}.parquet"))
                if not os.path.exists(local):
                    print(f"  {lang}: downloading {shard}")
                    _get(f"https://huggingface.co/datasets/{DATASET}/resolve/main/{shard}", local, timeout=600)
                table = pq.ParquetFile(local)
                for batch in table.iter_batches(columns=["title", "text"], batch_size=2000):
                    for title, text in zip(batch.column("title").to_pylist(), batch.column("text").to_pylist()):
                        if not text or len(text) < 200:
                            continue
                        doc = f"{title}\n\n{text.strip()}\n\x1e\n"
                        fo.write(doc); written += len(doc.encode("utf-8"))
                        if written >= cap:
                            break
                    if written >= cap:
                        break
                os.remove(local)  # keep the disk small: only the extracted text is kept
        print(f"  {lang}: {written/1e6:,.0f} MB of text")
        report[lang] = written
    with open(os.path.join(data_dir, "SOURCES.md"), "w", encoding="utf-8") as f:
        f.write("# Guru training sources\n\n")
        for lang, n in report.items():
            f.write(f"- Wikipedia ({lang}), snapshot {snapshot}, via the Wikimedia `{DATASET}` dataset: {n/1e6:,.0f} MB of text. "
                    "Licence: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). Contributors: https://{lang}.wikipedia.org.\n".replace("{lang}", lang))
        f.write("- Your own texts in data/my_texts (your rights).\n")
    return report


_WS = re.compile(r"[ \t ]+")


def clean(text: str) -> str:
    from . import lipi
    text = unicodedata.normalize("NFC", lipi.to_deva(text))  # Brahmi / Kharoshthi / Siddham texts train as Devanagari.replace("\r\n", "\n").replace("\r", "\n")
    lines = []
    for line in text.split("\n"):
        line = _WS.sub(" ", line).strip()
        if not line:
            lines.append(""); continue
        if not panini.keep_line(line):
            continue
        lines.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _docs_from_file(path):
    """Raw Wikipedia files keep one article per record, separated by a line holding only \\x1e."""
    yield from iter_corpus_docs(path)


def own_texts(data_dir):
    root = os.path.join(data_dir, "my_texts")
    for dp, _, files in os.walk(root):
        for fn in sorted(files):
            if fn.lower().endswith((".txt", ".md", ".fountain")) and fn != "README.txt":
                p = os.path.join(dp, fn)
                with open(p, encoding="utf-8", errors="replace") as f:
                    yield fn, f.read()


def build_corpus(data_dir, own_weight=3, seed=7):
    """Writes data/corpus.txt (documents separated by a blank line plus \\x1e) and data/corpus.json (stats)."""
    random.seed(seed)
    raw = os.path.join(data_dir, "raw")
    docs, seen, stats = [], set(), {}
    def add(source, text, times=1):
        t = clean(text)
        if len(t) < 50:
            return
        h = hashlib.blake2b(t.encode("utf-8"), digest_size=12).digest()
        if h in seen:
            stats.setdefault(source, {"docs": 0, "chars": 0, "dupes": 0})["dupes"] += 1; return
        seen.add(h)
        s = stats.setdefault(source, {"docs": 0, "chars": 0, "dupes": 0})
        s["docs"] += 1; s["chars"] += len(t) * times
        docs.extend([t] * times)
    if os.path.isdir(raw):
        for fn in sorted(os.listdir(raw)):
            if fn.endswith(".txt"):
                for d in _docs_from_file(os.path.join(raw, fn)):
                    add(fn[:-4], d)
    for fn, text in own_texts(data_dir):
        for part in re.split(r"\n{3,}", text):
            add("my_texts", part, own_weight)
    if not docs:
        raise SystemExit("The corpus is empty. Run Get corpus, or put .txt/.md files into guru/data/my_texts.")
    random.shuffle(docs)
    out = os.path.join(data_dir, "corpus.txt")
    with open(out, "w", encoding="utf-8") as f:
        for d in docs:
            f.write(d.replace("\x1e", " ") + "\n\x1e\n")
    total = sum(len(d) for d in docs)
    summary = {"documents": len(docs), "characters": total, "sources": stats, "own_weight": own_weight}
    with open(os.path.join(data_dir, "corpus.json"), "w") as f:
        json.dump(summary, f, indent=2)
    return summary


def iter_corpus_docs(path):
    with open(path, encoding="utf-8") as f:
        buf = []
        for line in f:
            if line.rstrip("\n") == "\x1e":
                yield "".join(buf).rstrip("\n"); buf = []
            else:
                buf.append(line)
        if buf:
            yield "".join(buf).rstrip("\n")


def write_tokenizer_input(corpus_path, out_path, max_chars=400_000_000):
    """Plain text for SentencePiece: one paragraph per line, capped."""
    n = 0
    with open(out_path, "w", encoding="utf-8") as fo:
        for d in iter_corpus_docs(corpus_path):
            for para in d.split("\n"):
                if para.strip():
                    fo.write(para + "\n"); n += len(para)
            if n >= max_chars:
                break
    return out_path


def encode_corpus(data_dir, tokenizer_path, val_share=0.005, batch=512):
    tok = Tokenizer(tokenizer_path)
    if tok.vocab_size > 65535:
        raise SystemExit("Vocabulary too large for uint16 token files.")
    corpus = os.path.join(data_dir, "corpus.txt")
    train_f, val_f = open(os.path.join(data_dir, "train.bin"), "wb"), open(os.path.join(data_dir, "val.bin"), "wb")
    counts = {"train": 0, "val": 0}
    rng = random.Random(11)
    pending = []
    def flush():
        for ids in tok.encode_batch(pending):
            arr = np.array(ids + [EOS], dtype=np.uint16)
            if rng.random() < val_share:
                arr.tofile(val_f); counts["val"] += len(arr)
            else:
                arr.tofile(train_f); counts["train"] += len(arr)
        pending.clear()
    for d in iter_corpus_docs(corpus):
        pending.append(d)
        if len(pending) >= batch:
            flush()
            sys.stdout.write(f"\r  {counts['train']/1e6:,.1f}M tokens"); sys.stdout.flush()
    if pending:
        flush()
    train_f.close(); val_f.close()
    print(f"\r  {counts['train']/1e6:,.1f}M training tokens, {counts['val']/1e6:,.2f}M validation tokens")
    if counts["val"] < 2048:  # tiny corpora: carve validation from the end of train
        tr = np.fromfile(os.path.join(data_dir, "train.bin"), dtype=np.uint16)
        cut = max(len(tr) - max(len(tr) // 20, 1024), len(tr) // 2)
        tr[cut:].tofile(os.path.join(data_dir, "val.bin")); tr[:cut].tofile(os.path.join(data_dir, "train.bin"))
        counts = {"train": int(cut), "val": int(len(tr) - cut)}
    with open(os.path.join(data_dir, "tokens.json"), "w") as f:
        json.dump({**counts, "tokenizer": os.path.basename(tokenizer_path), "vocab_size": tok.vocab_size}, f, indent=2)
    return counts
