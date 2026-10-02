# Guru

**Guru** is MAATAA's own language model family, built and trained from scratch: our architecture code, our tokenizer, our corpus and our training run. No pretrained weights are used.

*Guru* (गुरु) is traditionally explained as "dispeller of darkness" (*gu*, darkness; *ru*, remover), from the Advaya Tāraka Upaniṣad. Linguistically the word means "weighty". Both fit.

```
Guru = Guru-LLM + Guru-Dhatu + Guru-Panini (+ Guru-Veda / Guru-Shastra / Guru-Purana, later)
```

| Module | What it is today (v0.1) | Next |
| --- | --- | --- |
| **Guru-LLM** (`guru/model.py`) | `GuruForCausalLM`: a decoder-only transformer with RMSNorm, RoPE, grouped-query causal attention and SwiGLU, written from scratch. The tensor layout matches Llama, so it exports to GGUF and runs in Ollama. | Larger sizes on rented GPUs |
| **Guru-Dhatu** (`guru/tokenizer.py`) | A SentencePiece BPE tokenizer trained on our corpus, with byte fallback and NFC normalisation. Roots listed in `data/dhatus.txt` are kept as whole pieces. | A real root + affix segmenter before BPE |
| **Guru-Panini** (`guru/panini.py`) | A rule checker for Devanagari orthography (rules P1–P5). It filters the training corpus and scores everything Guru writes. | Sandhi and grammar rule sets, using the same `verify()` interface |
| Guru-Veda / Shastra / Purana | Not built yet. | Grounding knowledge bases (retrieval), not weights |

## Sizes

| Size | Name | Parameters | Context | Token budget | Where |
| --- | --- | --- | --- | --- | --- |
| nano | guru-maataa-nano | 18.7M | 512 | 0.2B | Mac, about 1–2 hours |
| mini | guru-maataa-mini | 35.9M | 1024 | 0.5B | Mac, about 5–8 hours |
| small | guru-maataa-small | 93.9M | 1024 | 1.0B | Mac, a day or more |
| base-1b | guru-maataa-1b | 1.03B | 2048 | 22B | Rented GPUs (for example 8×A100 for several days) |
| 7b | guru-maataa-7b | 7.1B | 4096 | 140B | A GPU cluster; needs a much larger corpus than Wikipedia |

Mac times are rough estimates for Apple silicon; measured speed is printed while training. The local sizes share one 24,000-piece tokenizer. The cloud sizes use 32,000 pieces: run `prepare --size base-1b` before training them.

> **Important** What to expect: a nano or mini Guru writes fluent-looking Hindi, Sanskrit and English, but it knows little and invents facts. That is normal for models of this size. The value is that every part is ours and the pipeline is proven, so it can grow. For a strong assistant today, use an existing open model. Guru is the long-term path to our own.

## Use it (double-click, in the brahmini folder)

1. **Guru 1 - Set up.command**: makes `guru/.venv` with PyTorch (about 1 GB) and runs the tests.
2. **Guru 2 - Get corpus.command**: downloads Wikipedia in Sanskrit, Hindi and English (about 600 MB of text kept; the downloads are deleted after extraction), adds your texts from `guru/data/my_texts`, filters them with Guru-Panini, then trains Guru-Dhatu and writes the token files. You can choose only your own texts instead.
3. **Guru 3 - Train.command**: choose a size and a time limit. The Mac stays awake while it trains, progress is saved, and the next run can continue where this one stopped.
4. **Guru 4 - Talk to Guru.command**: give it the start of a text and it continues.
5. **Guru 5 - Add Guru to Ollama.command**: exports to GGUF and adds `guru-maataa-<size>` to Ollama. It can also make it *the* `guru-maataa`; the current Llama-based model is kept as `llama-guru-maataa`.

Your texts count three times as much as Wikipedia. Screenplays, notes and books in `data/my_texts` shape Guru's voice.

## Command line

```bash
cd guru && source .venv/bin/activate
python -m guru sizes
python -m guru corpus --langs sa,hi,en --cap-mb sa=80,hi=250,en=250   # download and build
python -m guru prepare --size nano                                      # build + tokenizer + token files
python -m guru train --size nano --minutes 90                           # or --tokens 2e8, --resume
python -m guru ask "संस्कृतं" --size nano
python -m guru check "गुरुः शिष्यं ज्ञानं ददाति।"                         # Guru-Panini
python -m guru teach --size nano --pairs data/teach.jsonl               # {"prompt": "...", "answer": "..."} per line
python -m guru export --size nano --ollama guru-maataa-nano
```

Training on NVIDIA GPUs: `torchrun --nproc_per_node 8 -m guru train --size base-1b --compile`. It uses bf16 and fused AdamW.

## How it is checked

`python -m unittest discover -s tests` checks the following:

- The parameter counts match the configs.
- Attention is causal: changing a later token never changes an earlier output.
- A tiny model learns a pattern, and greedy generation reproduces it.
- An exported Guru loads as a standard Hugging Face `LlamaForCausalLM` and gives the same logits (within 1e-4).
- The tokenizer round-trips Devanagari, nukta forms, English and unseen scripts; listed dhatus stay whole.
- Guru-Panini flags broken Devanagari and passes well-formed text.

The whole pipeline was also run end to end: corpus, tokenizer, training, export, GGUF, then generation with llama.cpp.

## Data and licences

- **Code:** Apache-2.0.
- **Wikipedia text:** CC BY-SA 4.0, with attribution recorded in `data/SOURCES.md` and in each exported model card. Whether share-alike terms reach trained weights is not settled law; check before publishing weights.
- **Your own texts:** these remain yours.

The name "Guru" is common. Before publishing, search trademarks and the Hugging Face hub; `guru-maataa-*` is the distinctive form.
