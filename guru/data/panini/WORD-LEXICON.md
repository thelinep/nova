# Ashtadhyayi surface-token index

`ashtadhyayi-surface-lexicon.v1.json` is a frequency and reference index over
the repository's pinned 3,983-sutra Ashtadhyayi text.

Each entry preserves one whitespace-separated SLP1 token and includes its
Devanagari and IAST rendering, occurrence count, and the sutra numbers where
it appears. The file is generated from `sutrapatha.tsv` with:

```sh
python -m guru.panini_words
```

This is a surface-token inventory. The source text is compact and often
contains sandhi, compounds, inflected forms, and grammatical markers. The
index does not split those forms, infer lemmas, attach meanings, or include a
commentary. Do not treat frequency as importance or a token as a standalone
dictionary headword.

The source and attribution are recorded inside the JSON and in
[`SOURCES.md`](SOURCES.md). The source files were copied from Vidyut by
ambuda.org under MIT; the attribution in `SOURCES.md` must remain with derived
redistributions. This extraction adds no modern translation or commentary.
