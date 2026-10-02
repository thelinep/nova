"""Guru-Dhatu v0: the tokenizer.

A SentencePiece BPE vocabulary trained on Guru's own corpus (Sanskrit, Hindi,
English and your texts), with byte fallback so no character is ever unknown.
Text is NFC-normalised first, so the same akshara always has one spelling, and
Brahmi, Kharoshthi and Siddham are read through Devanagari (Guru-Lipi), so they cost the same tokens.

Dhatu awareness, honestly: v0 learns pieces from data. If data/dhatus.txt
exists (one root or affix per line, for example "गम्", "कृ", "ति"), those
entries are kept as whole pieces in the vocabulary. A real morphological
segmenter (splitting words into root + affixes before BPE) is the next step;
the hook for it is segment() below.
"""
import os
import unicodedata

import sentencepiece as spm

from . import lipi

UNK, BOS, EOS = 0, 1, 2


def normalise(text: str) -> str:
    """Brahmi, Kharoshthi and Siddham become Devanagari (Guru-Lipi); then NFC."""
    return unicodedata.normalize("NFC", lipi.to_deva(text))


def segment(text: str) -> str:
    """Hook for a dhatu segmenter (root + affix boundaries). v0 returns the text unchanged."""
    return text


def load_dhatus(path: str):
    if not path or not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            w = normalise(line.strip())
            if w and not w.startswith("#") and " " not in w:
                out.append(w)
    return sorted(set(out))[:4000]


def train(corpus_path: str, out_prefix: str, vocab_size: int, dhatus_path: str = None, max_sentences: int = 4_000_000, threads: int = None):
    """Trains <out_prefix>.model / .vocab. Returns the list of dhatu pieces that were kept."""
    dhatus = load_dhatus(dhatus_path)
    os.makedirs(os.path.dirname(out_prefix) or ".", exist_ok=True)
    spm.SentencePieceTrainer.train(
        input=corpus_path,
        model_prefix=out_prefix,
        model_type="bpe",
        vocab_size=vocab_size,
        character_coverage=0.9995,   # Devanagari, Latin, digits and punctuation; rare characters fall back to bytes
        byte_fallback=True,
        split_digits=True,
        normalization_rule_name="identity",  # we NFC-normalise ourselves; keeps llama.cpp and Python identical
        remove_extra_whitespaces=False,
        allow_whitespace_only_pieces=True,
        unk_id=UNK, bos_id=BOS, eos_id=EOS, pad_id=-1,
        user_defined_symbols=dhatus,
        input_sentence_size=max_sentences,
        shuffle_input_sentence=True,
        max_sentence_length=8192,
        num_threads=threads or max(1, (os.cpu_count() or 2) - 1),
        train_extremely_large_corpus=False,
        minloglevel=2,
    )
    return dhatus


class Tokenizer:
    def __init__(self, model_path: str):
        self.sp = spm.SentencePieceProcessor(model_file=model_path)
        self.path = model_path

    @property
    def vocab_size(self) -> int:
        return self.sp.get_piece_size()

    def encode(self, text: str, bos: bool = False, eos: bool = False):
        ids = self.sp.encode(segment(normalise(text)))
        return ([BOS] if bos else []) + ids + ([EOS] if eos else [])

    def encode_batch(self, texts):
        return self.sp.encode([segment(normalise(t)) for t in texts])

    def decode(self, ids, script: str = "devanagari"):
        text = self.sp.decode([i for i in ids if i not in (BOS, EOS)])
        return lipi.from_deva(text, script)[0] if script != "devanagari" else text
