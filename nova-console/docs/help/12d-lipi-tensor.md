---
id: lipi-tensor
title: Lipi Tensor (HKDM)
section: Chat and knowledge
order: 12.5
summary: The HKDM script tensor T(α, β, γ, δ) puts writing systems on four axes (epoch, substrate, information architecture, direction). Each cell opens to its sourced records.
keywords: hkdm tensor lipi script epigraphy brahmi kharoshthi siddham cuneiform hieroglyphs indus phoenician aramaic greek chinese hangul grantha sharada devanagari substrate direction abugida abjad lineage export csv json
views: hkdm
---
**Lipi Tensor** (AAI group) is the HKDM script tensor **T(α, β, γ, δ)**. It places writing systems on four axes:

| Axis | What it is | Values |
| --- | --- | --- |
| **α Epoch** | When | 500-year bins from 3500 BCE to 2000 CE (100, 250 or 1,000 also possible) |
| **β Substrate** | What it was written on | clay, stone, metal, bone and shell, wood and bamboo, birch bark, palm leaf, papyrus, leather, silk, paper |
| **γ Information architecture** | How the signs encode language | logographic (mixed), abjad, alphabet, abugida, featural, undeciphered |
| **δ Direction** | Which way it runs | left to right, right to left, top to bottom in columns, boustrophedon |

A cell counts the scripts that **records** place there. Nothing is inferred: an empty cell means there is no record yet, not that it never happened.

## Records

Each record is one attestation: a script, a span of years, a substrate, an architecture, a direction and a note. Every record carries two labels:

| Label | Meaning |
| --- | --- |
| **established** or **debated** | Whether scholars agree. Debated claims, such as the early Anuradhapura potsherds for Brahmi or Hangul as a "featural" script, are kept and marked. |
| **from the source page** or **general knowledge, unchecked** | Whether the fact was found on the script's reference page, or is general knowledge not yet checked against a page. |

> **Note** The seed data (16 scripts, 54 records) is a **draft**. Each record still needs review by an epigraphist before it is cited.

## Use it

1. Choose the **rows** and **columns** (any two axes). The other two axes are summed, or fixed with their filters.
2. Use **Confidence: established only** or **Basis: from a source page only** to see what holds without debated or unchecked records.
3. Choose a cell to see the records behind it, with links to their sources.
4. **Lineage** lists which script descends from which, with the years between their first established records. Both hypotheses for the origin of Brahmi (Aramaic, Indus) are shown, both marked debated.
5. **Download tensor (JSON)** gives the dense count tensor (shape 11 × 11 × 6 × 4) and the sparse cells with their scripts and record ids. **Download records (CSV)** gives every record with its reference.
