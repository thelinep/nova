# Guru

**Guru** is MAATAA's own language model family, built and trained from scratch: our architecture code, our tokenizer, our corpus and our training run. No pretrained weights are used.

*Guru* (गुरु) is traditionally explained as "dispeller of darkness" (*gu*, darkness; *ru*, remover), from the Advaya Tāraka Upaniṣad. Linguistically the word means "weighty". Both fit.

```
Guru = Guru-LLM + Guru-Dhatu + Guru-Panini + Guru-Lipi (+ Guru-Veda / Guru-Shastra / Guru-Purana, later)
```

| Module | What it is today (v0.1) | Next |
| --- | --- | --- |
| **Guru-LLM** (`guru/model.py`) | `GuruForCausalLM`: a decoder-only transformer with RMSNorm, RoPE, grouped-query causal attention and SwiGLU, written from scratch. The tensor layout matches Llama, so it exports to GGUF and runs in Ollama. | Larger sizes on rented GPUs |
| **Guru-Dhatu** (`guru/tokenizer.py`) | A SentencePiece BPE tokenizer trained on our corpus, with byte fallback and NFC normalisation. Roots listed in `data/dhatus.txt` are kept as whole pieces. | A real root + affix segmenter before BPE |
| **Guru-Panini** (`guru/panini.py`, `guru/sutra.py`) | A rule checker for Devanagari orthography (rules P1–P5), plus the real texts: all 3,983 Ashtadhyayi sutras, the Dhatupatha (2,229 roots) and the Unadi, Linganushasana and Phit sutras (MIT licence, see below). It filters the training corpus, scores everything Guru writes, and checks sutra citations in it. | Sandhi and grammar rule sets, using the same `verify()` interface |
| **Guru-Lipi** (`guru/lipi.py`) | Brahmi, Kharoshthi and Siddham ⇄ Devanagari. Guru learns and checks in Devanagari, reads the other three through it at the same token cost, and can answer in any of them. Round trips are exact, except Kharoshthi ai/au and digits, which are reported. | Sharada, Grantha, Tamil-Brahmi, IAST |
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
6. **Guru 6 - Look up a sutra.command**: look up Ashtadhyayi sutras by number or words, or a root in the Dhatupatha. It works before setup.

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

### Experimental Guru-Code path

`CODING.md` documents an experimental task-data contract and offline evaluator.
The checked-in fixtures are original, hand-authored examples; held-out eval
rows have no target answers and are excluded from `code-data` SFT export.

```bash
python -m guru code-data
python -m guru code-eval --predictions out/guru-code-predictions.jsonl
```

This is pipeline scaffolding, **not evidence that a current Guru checkpoint is
a capable coding model**. The evaluator checks strict proposal JSON, basic
relative paths, Python syntax and shallow fixture rubrics; it does not execute
generated code. Guru-Code needs a dedicated provenance-reviewed code corpus,
model/context work and substantially broader held-out evaluation before any
capability claim. See [`CODING.md`](CODING.md) for the record format, report
limits and prediction format, and [`CODING_RELEASE.md`](CODING_RELEASE.md) for
the provenance intake, execution benchmark and end-to-end release evidence
requirements.

`code-data` only exports the train split; it does not train a model. `teach`
requires a previously trained Guru base checkpoint and the matching prepared
tokenizer. The default nano preset has only 512 tokens of context, while
Maataa's current Coding Studio requires at least 4096. The documented 7b
preset reaches 4096 tokens but requires GPU-cluster training resources; no
eligible Guru base checkpoint or coding corpus is currently provided. See
[`CODING.md`](CODING.md) for the gated SFT sequence.

Training on NVIDIA GPUs: `torchrun --nproc_per_node 8 -m guru train --size base-1b --compile`. It uses bf16 and fused AdamW.

## How it is checked

`python -m unittest discover -s tests` checks the following:

- The parameter counts match the configs.
- Attention is causal: changing a later token never changes an earlier output.
- A tiny model learns a pattern, and greedy generation reproduces it.
- An exported Guru loads as a standard Hugging Face `LlamaForCausalLM` and gives the same logits (within 1e-4).
- The tokenizer round-trips Devanagari, nukta forms, English and unseen scripts; listed dhatus stay whole.
- Guru-Panini flags broken Devanagari and passes well-formed text.
- The Ashtadhyayi has all 3,983 sutras, in order in 32 padas with no gaps. Known sutras (1.1.1, 6.1.77, 8.4.68 and others) read correctly, there is no placeholder text, citations are checked, and the SLP1 conversion is right.
- Guru-Lipi round-trips Brahmi, Kharoshthi and Siddham exactly (except the reported Kharoshthi cases), each costs the same tokens as Devanagari, and broken Brahmi is caught by Guru-Panini.

The whole pipeline was also run end to end: corpus, tokenizer, training, export, GGUF, then generation with llama.cpp.

## Panini texts: Ashtadhyayi and Dhatupatha

`data/panini` holds the real texts:

- all 3,983 sutras of the Ashtadhyayi (1.1.1 to 8.4.68);
- the Dhatupatha (2,229 roots with meaning and gana);
- the Unadi sutras, the Linganushasana, the Phit sutras and the Dhatupatha's gana sutras.

They come from [Vidyut](https://github.com/ambuda-org/vidyut) (ambuda.org) under the MIT licence; most of it was shared by the author of ashtadhyayi.com. Provenance, the commit and file hashes are in `data/panini/SOURCES.md`. Only the sutra text is included, not meanings or commentary, because modern translations have their own copyright.

- **Derivations (Maataa AAI):** with `vidyut` installed (it is in `requirements.txt`), `teach --panini` also adds about 11,000 verified pairs from Vidyut's prakriya engine: present, imperative, imperfect and future forms of every root, and full step-by-step derivations, each step citing its sutra, for the first 300 roots.
- **Training:** the texts are always part of the corpus, three times over (`--panini-weight`, 0 leaves them out). `teach --panini` adds about 18,000 question/answer pairs built only from the text: a sutra by number, the number of a sutra, the next sutra, and a root's meaning and gana.
- **Checking:** `check` and `ask` look for citations such as `6.1.77`, `१.१.१` or `वृद्धिरादैच् (1.1.1)`. They report numbers that do not exist (for example 1.1.101, since the first pada ends at 1.1.75) and quotes that belong to a different sutra.
- **Looking up:**

```bash
python -m guru sutra 1.1.1                  # 1.1.1  वृद्धिरादैच्
python -m guru sutra 8.4.66-8.4.68 --script iast
python -m guru sutra इको यण                 # find by words, in any script or SLP1
python -m guru dhatu भू                     # 01.0001 भू सत्तायाम् (भ्वादिगण) …
python -m guru check "6.1.87 इको यणचि"      # mismatch: that is 6.1.77; 6.1.87 is आद्गुणः
```

Maataa Workstation's **Ashtadhyayi** view and its sutra neurons in Neuron Factory read `nova-console/lib/panini-data.json`. Regenerate that file with `python -m guru panini-json` if the data in `data/panini` changes.

## Scripts: Brahmi, Kharoshthi, Siddham

Guru-Lipi lets Guru work with three historic scripts without training on them separately. Digital text in these scripts is scarce, but their letters map almost one to one onto Devanagari.

- **Input:** text in any of the four scripts is converted to Devanagari before the tokenizer and Guru-Panini see it. A Siddham line costs exactly the tokens of the same line in Devanagari; without the conversion it would cost about 2.8 times as many, because each of these letters is 4 bytes. Guru-Panini checks Brahmi, Kharoshthi and Siddham too. Texts in these scripts placed in `data/my_texts` train as Devanagari.
- **Output:** `python -m guru ask "…" --script siddham`, or the script choice in **Guru 4 - Talk to Guru**.
- **Conversion:** `python -m guru lipi "गुरुः शिष्यं ज्ञानं ददाति।" --to kharoshthi` (any script to any script).

| Script | Matched by Unicode name | Handled specially | Not exact |
| --- | --- | --- | --- |
| Brahmi | 76 of 115 | virama, jihvamuliya ᳵ, upadhmaniya ᳶ | additive numbers and ornaments are kept; nukta is dropped |
| Kharoshthi (right to left) | 44 of 68 | vowels as A + sign, the length mark for ā ī ū ṝ, virama, dandas | ai/au are written as e/o + length mark (Guru convention); digits stay in Devanagari because Kharoshthi numbers are additive; Gandhari letters KKA, TTTA, TTTHA and VHA are kept |
| Siddham | 65 of 92 | separators become a danda, alternate i/u forms become the normal ones | ornaments, repetition marks and the end-of-text sign are kept; no digits |

Fonts: if letters show as boxes, install Noto Sans Brahmi, Noto Sans Kharoshthi and Noto Sans Siddham (Google Fonts, free).

## Data and licences

- **Code:** Apache-2.0.
- **Wikipedia text:** CC BY-SA 4.0, with attribution recorded in `data/SOURCES.md` and in each exported model card. Whether share-alike terms reach trained weights is not settled law; check before publishing weights.
- **Your own texts:** these remain yours.
- **Panini texts (`data/panini`):** MIT, © ambuda.org (Vidyut), data originally shared by ashtadhyayi.com. Keep `LICENSE-vidyut.md` and the attribution in `data/panini/SOURCES.md`.

The name "Guru" is common. Before publishing, search trademarks and the Hugging Face hub; `guru-maataa-*` is the distinctive form.
