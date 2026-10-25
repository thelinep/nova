---
id: lipi-os
title: Lipi OS
section: Chat and knowledge
order: 12.7
summary: A language layer for Maataa. A Hindi welcome in twelve historic scripts, a letters board with sound and grammar for all 108 characters, a converter for twenty-five scripts, the 69-record script registry, courses and catalogues, a reading desk, workshop plans, a multi-script newsroom, the Ashokan text atlas and a sourced chronology.
keywords: lipi os halant virama conjunct samyuktakshar font letters board varnamala alphabet akshara swar vyanjan matra sound pronunciation sthana pratyahara maheshvara script registry brahmi kharoshthi bhaiksuki sharada siddham grantha nandinagari newa tirhuta mithilakshar takri modi kaithi dogra khudawadi dives akuru kawi tulu tigalari transliteration hindi schwa newsroom vaigyaaniq times workshop futurism course reading desk atlas ashoka girnar dhauli jaugada kalsi chronology timeline
views: lipios
---
**Lipi OS** (AAI group) is a language layer for Maataa. It began as the owner's Rakhigarhi / Lipi OS prototype and now runs inside Maataa, on this computer. A script is a writing system, not a language: Lipi OS keeps the two apart everywhere.

## Welcome

The modern Hindi greeting **आपका स्वागत है** written in twelve historic scripts: Brahmi, Kharoshthi, Bhaiksuki, Sharada, Siddham, Grantha, Nandinagari, Newa, Tirhuta, Takri, Modi and Kaithi. Click a card to focus it. Your choice and your study language are remembered in this browser.

The phrase is written **as it is pronounced** (आप्का स्वागत है), because historic scripts spell Sanskrit-style. These are draft renderings, not inscriptions or translations.

## Letters

The **Letters** board shows every character Lipi OS converts, 108 in all, on 14 boards: vowels (स्वर), vowel signs (मात्रा), the five vargas, semivowels (अन्तःस्थ), sibilants and h (ऊष्म), signs (anusvara, visarga, virama, nukta, avagraha), nukta letters, regional letters (ळ, ऴ, ऱ, the Sindhi implosives), digits, and punctuation and symbols.

- **Preview script** writes every tile in one of 23 scripts. Faded tiles have no form in that script.
- **Click a letter** to see it large, hear it (**Play**, or turn on *Play when selected*), and read its type and grammar: place of articulation (स्थान) with a small diagram, effort (प्रयत्न), voicing, breath, length, and the pratyaharas it belongs to.
- **Region** shows the letter in every script that writes it, with where that script is used, and lists the scripts that cannot write it. The *Region* filter keeps the letters written by scripts of one region.
- **Resources** links the Unicode record and chart, opens the Ashtadhyayi at the sutra behind the grammar (1.1.9 for place and effort, 1.1.71 for pratyaharas), and sends the letter to Convert.

Grammar follows the places and efforts stated in the Siddhanta Kaumudi under Ashtadhyayi 1.1.9; pratyaharas are computed from the 14 Maheshvara sutras. Sounds were recorded once, offline, with Kokoro's Hindi voice from the IPA shown, so they use Hindi pronunciation. Letters marked *approximate* (such as ळ, the vocalic ऋ, aspirated voiced stops and the Sindhi implosives) are the nearest sound the voice can make. Avagraha, the dandas and the abbreviation sign have no sound.

## Convert

Type Devanagari, any listed script, or SLP1 in Latin letters, and read it in up to twenty-five scripts at once.

| Choice | What it does |
| --- | --- |
| **Hindi: spell as pronounced** | Drops the inherent vowels Hindi does not say (आपका → आप्का), using a simple rule. Turn it off for Sanskrit. |
| **Script chips** | Pick which scripts to show. A percentage shows how many of the letters Sanskrit and Hindi need that script has. |

The conversion tables come from the Unicode character names, so a letter is converted only when Unicode gives the same letter in the other script. A letter a script lacks stays in Devanagari and is listed in amber, never guessed. Kharoshthi follows Guru's convention (ai and au as e and o with the length mark) and runs right to left.

Maataa ships the free Noto fonts for the historic scripts, so they show without installing anything.

### Halant and conjuncts

A halant (virama, ्) between two consonants joins them into a conjunct (संयुक्ताक्षर). Lipi OS writes the halant the Unicode way and lets the font draw the conjunct. Turn on **Show halant instead of conjuncts** to see each letter with its halant instead; Lipi OS then puts a zero-width non-joiner after the halant, which is how Unicode asks for a visible one.

The Noto fonts do not draw conjuncts for every script, so Maataa ships its own builds for three of them: **Maataa Lipi Brahmi**, **Maataa Lipi Sharada** and **Maataa Lipi Dives Akuru**. They are Noto fonts with stacked conjuncts added (the second letter written smaller, below the first), renamed as the SIL Open Font License requires. Takri and Khudawadi are normally written with a visible halant, Noto Serif Dogra forms no conjuncts, and Noto Sans Kharoshthi forms only some; Convert says so under those scripts.

## Scripts

The 69-record registry from the prototype, with its tiers (Flagship, Pilot, Research, Exhibition only). Search or filter by tier, and click a record to see its alphabet written out. Seventeen of the records can be written by the converter; the rest are historical styles without their own Unicode block. The Indus / Harappan signs stay **exhibition only**: no decipherment is claimed.

## Learn

- **Courses**: six provider listings (Sanskrit, Pali, Prakrit, Classical Tamil, Classical Tibetan). Maataa links to them; it does not run them.
- **Source catalogues**: GRETIL, the Digital South Asia Library, BDRC and the Tamil Digital Library.
- **My reading desk**: save a book or text with its author, language, script, link and notes, and mark it to read, reading or done. Saved in Maataa.

## Workshops

Eleven Lipi OS workshop manuals, each with a timed itinerary and QA checkpoints, and nine Futurism workshops. Each Futurism price is recomputed from its stated basis (a cohort of 12, lecturer and researcher days, production, venue, materials and an 8% platform charge) and marked when it matches. All are draft proposals: nothing is booked or certified.

## Newsroom

Compose a multi-language, multi-script edition, such as *Vaigyaaniq Times*.

1. Press **New edition**, give it a masthead and a theme, and type a source headline and text (or pick a sample story).
2. Each **lane** has its own language and script. Type into it, or press **Write from source** to write the source text in that lane's script. That button only works for Indic source text, and the lane is then marked as machine transliteration.
3. Switch views: **Debugged** (code points, grapheme clusters, normalisation and Unicode blocks), **Glue** (source and lane segments side by side), **3D vector** (a turnable page layout) and **Print preview**.

Nothing is translated automatically.

## Text atlas and chronology

- **Text atlas**: the four Ashokan Major Rock Edict sites (Girnar, Dhauli, Jaugada, Kalsi) as points on an offline map, with their sources. The photographs load only when network access is on in Settings.
- **Chronology**: 23 sourced records from 10,000 BCE to today. Filter by continent, category and years (negative years are BCE). Undated records are always listed and marked.

> **Note** Everything here keeps the prototype's caveats: draft renderings, demo copy and proposals are labelled as such and need specialist review before use.
