# Panini texts: sources and licence

These files are copied unchanged from **Vidyut** by ambuda.org (`vidyut-prakriya/data`):

- Repository: https://github.com/ambuda-org/vidyut
- Commit: `8da2f90bee3ce1c07505fa432fc3729e3f7e02ea` (24 June 2026)
- Licence: MIT. See `LICENSE-vidyut.md`.
- Vidyut's data README says most of these files came from [ashtadhyayi.com](https://ashtadhyayi.com). The author of ashtadhyayi.com agreed to share them under the MIT licence. Vidyut also says its Dhatupatha combines five traditional sources, with svaras added.

| File | What it is | Entries | SHA-256 |
| --- | --- | --- | --- |
| `sutrapatha.tsv` | Ashtadhyayi, 1.1.1 to 8.4.68 | 3,983 | `f2ff7987…7e87c` |
| `dhatupatha.tsv` | Dhatupatha: code, root with markers and svaras, meaning | 2,229 roots (plus 30 rows marking where the gana sutras go) | `bb2013ea…ba380` |
| `unadipatha.tsv` | Unadi sutras | 748 | `ff2ededa…aa5c6` |
| `linganushasanam.tsv` | Linganushasanam | 189 | `04286806…8776f` |
| `phit-sutras.tsv` | Phit sutras | 87 | `1f0bf844…d3f98` |
| `dhatupatha-ganasutras.tsv` | Gana sutras inside the Dhatupatha | 19 | `3a6b295e…f8d8f` |
| `varttikas.tsv` | A small selection of varttikas, not the full set | 108 | `666820a8…45874` |

All the files are in SLP1. `guru/slp1.py` converts them to Devanagari or IAST. It was checked against Vidyut's own transliterator on all 9,652 strings. Where the two differ, Guru's output is the correct one, for two reasons:

- Guru keeps an independent vowel that follows another vowel, for example भोभगोअघोअपूर्वस्य (8.3.17) and टुओँस्फूर्जाँ.
- Guru writes the jihvamuliya and upadhmaniya in 8.3.37 as ᳵ and ᳶ, where the source has the symbol ≍.

The number of sutras follows this edition (3,983). Other printed editions count between about 3,959 and 3,996, depending on how they handle split or added sutras.

**Not included:** meanings, commentary (vritti) and pada-patha. The sutra wording is about 2,500 years old, but modern translations and commentaries have their own copyright. Add them only from a source whose licence allows it.

## Attribution to keep

> Ashtadhyayi, Dhatupatha and related texts from Vidyut (https://github.com/ambuda-org/vidyut), © ambuda.org, MIT licence; data originally shared by ashtadhyayi.com.
