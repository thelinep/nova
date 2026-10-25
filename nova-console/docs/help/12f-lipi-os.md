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

The Noto fonts do not draw conjuncts for every script, so Maataa ships its own builds for three of them: **Maataa Lipi Brahmi**, **Maataa Lipi Sharada** and **Maataa Lipi Dives Akuru**. In these fonts the lower letter is three-quarters size and touches the foot of the upper one, as in inscriptions. Placement is magnetic, by the stroke ends (edges) at the foot of the upper letter: with no edge the lower letter hangs from the middle, with one edge from that edge, and with two or more from the right-most edge. The lower letter is hung by the edge at its own top, chosen the same way, and a third letter hangs from the second by the same rule. A wide pair gets extra space so it does not run into its neighbours, and u and uu move under the lower letter. Brahmi is offered both ways: **Brahmi** uses Noto Sans Brahmi, which draws every halant as a bar, and **Brahmi+** shows exactly the same text with stacked conjuncts. Copying either gives the same characters. They are Noto fonts with stacked conjuncts added (the second letter written smaller, below the first), renamed as the SIL Open Font License requires. Takri and Khudawadi are normally written with a visible halant, Noto Serif Dogra forms no conjuncts, and Noto Sans Kharoshthi forms only some; Convert says so under those scripts.

### Conjunct editor

Open **Conjunct editor** to change how a pair is drawn in Brahmi+, Sharada or Dives Akuru.

1. Pick the script, the **upper letter** and the **lower letter**. The pair is drawn large, with the edges and the middle of the upper letter marked.
2. Drag the lower letter, or use the arrow keys (10 units; hold Shift for 50) or the nudge buttons. It sticks to an edge, the middle or the starting height when it comes near. **Stick to** jumps to a mark, and **Back to the rule** undoes the move for this pair.
3. **Size** changes the lower letter wherever it is written under any letter in that script.
4. Press **Save edits**, then **Rebuild fonts**. Maataa writes the edited fonts into its data folder and uses them everywhere at once; the shipped fonts are not changed. **Use shipped fonts** goes back to them and keeps your edits for later.

Rebuilding needs the font tools once: double-click **Lipi - Install font tools.command** in the `launchers` folder (about 10 MB). The editor says so if they are missing.

## Brahmi gallery

Photographs, rubbings and drawings of original Brahmi writing, from the earliest finds to the scripts that grew out of it: Ashokan edicts, post-Mauryan cave and stupa records, Bhattiprolu, Tamil-Brahmi, Sri Lankan Brahmi, Kushan and Kshatrapa, Gupta and Central Asian manuscripts, and the charts used to decipher it.

- Filter by variant, search by place, language or ruler, and sort oldest first or by place.
- Click a picture for its date, place, language and a short note, with the photographer or author, the licence and a link to the original file.
- The pictures are stored in Maataa and work offline. Every one comes from Wikimedia Commons under a public domain, CC0, Creative Commons or Government Open Data licence. Keep the credit line when you reuse one. The full list is in `public/lipi-brahmi/CREDITS.md`.
- Dates are approximate, and a few (such as Sohgaura and Piprahwa) are debated.

### Reading Brahmi (OCR)

Each gallery picture has a **machine reading**: the lines the Lipi OCR model found, in Brahmi and in Devanagari, with how sure it is of each line. Lines below 80% confidence are faded, and a picture with no confident line is marked **Not legible to the model**. For Kushan, Gupta and Central Asian Brahmi the reading is always marked unreliable, because their letter shapes differ from the ones the model learned.

- The model was trained only on synthetic lines: Brahmi text drawn with fonts and aged to look like printed plates, rubbings and carved stone. No real photograph was used for training, so treat every reading as a guess to check against a published one.
- It does best on plates, rubbings and clear photographs. Weathered stone photographed in flat light is usually beyond it.
- **Read again** reads a gallery picture with the model on this computer. **Read Brahmi in your own image** reads a PNG, JPEG or WebP you choose. Both need the OCR tools once: double-click **Lipi - Install OCR.command** in the `launchers` folder (about 80 MB).
- **Lipi - Train OCR.command** retrains the model on this Mac from new synthetic lines (several hours, and it installs PyTorch the first time). Maataa then uses your model instead of the one it ships with.
- Nothing is uploaded: reading and training both run locally.

### Brahmi report and detected areas

Press **Brahmi report** above the gallery for what the readings contain, picture by picture and over the whole gallery:

- **अक्षर** (letters): how many aksharas were read and the most frequent consonants.
- **संयुक्त अक्षर** (conjuncts): consonant + halant + consonant. Halant marks that join nothing are counted separately as OCR slips.
- **धातु** (verb roots): verb forms such as *jāte*, *kālāpita*, *āha*, each traced to its root in Panini’s Dhatupatha with its number and meaning.
- **संज्ञा, सर्वनाम, संख्या** (nouns, pronouns, numbers), **ज्यामिति और माप** (geometry and measures), **अंतरिक्ष** (sun, moon, nakshatras, heavenly signs) and **अन्य विषय** (dhamma, administration, animals, medicine, plants, buildings, people, places).

In a picture, the detected areas are drawn on the image in the category’s colour. Turn categories on and off with the chips under the picture, and click a word to light up every place it was found. **अक्षर** shows the box of every akshara the model read.

A find is **sure** (solid outline) when the spelling matches exactly, the line was read with at least 80% confidence, and the script variant is one the model reads well. Everything else is **possible** (dashed): a lead to check against a published reading. The words come from a list of Ashokan Prakrit vocabulary, so OCR mistakes can produce false finds and words outside the list are not reported.

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
