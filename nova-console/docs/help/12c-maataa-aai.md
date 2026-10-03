---
id: maataa-aai
title: Maataa AAI
section: Chat and knowledge
order: 12.4
summary: Advanced Ancient Intelligence. Panini's rules derive Sanskrit words step by step, models answer questions, and only what the rules confirm is marked verified. Includes Derivation and Lipi.
keywords: aai advanced ancient intelligence maataa panini prakriya derivation verb noun dhatu lakara tinanta subanta paradigm conjugation declension lipi script brahmi kharoshthi siddham iast slp1 citations verify vidyut guru evidence record sealed signed replay export proof chain
views: aai,derivation,lipi
---
**Maataa AAI** (the AAI group) works on one principle: **rules derive and check, models propose, and nothing is called correct unless the rules confirm it.**

The group has six screens:

| Screen | What it does |
| --- | --- |
| **Maataa AAI** | Install the derivation engine, ask questions, and check sutra citations in any text |
| [Ashtadhyayi](help:ashtadhyayi) | All 3,983 sutras and the Dhatupatha |
| **Derivation** | Panini's rules derive a word step by step |
| **Lipi** | Convert text between six scripts |
| [Brahmi Notepad](help:brahmi-notepad) | Write in Roman or Devanagari and read it in Brahmi |
| [Lipi Tensor](help:lipi-tensor) | Writing systems on four axes: epoch, substrate, architecture, direction |

## Install the derivation engine (once)

Derivation uses Vidyut's prakriya engine (MIT licence, about 3 MB). On **Maataa AAI**, press **Install derivation engine**. It goes into Maataa's own folder, and nothing else on your Mac changes. You can also double-click **AAI - Set up.command** in the brahmini folder. Python 3 must be installed; if it isn't, run `xcode-select --install`.

## Derivation

**Verbs (तिङन्त)**

1. Type a root, for example भू, कृ or गम्, and choose the Dhatupatha entry.
2. Optionally choose a prefix (उपसर्ग).
3. Choose the tense or mood (लकार), the voice (प्रयोग), and optionally the pada.
4. Press **Show all forms**. You get the nine forms: three persons by three numbers.

**Nouns (सुबन्त)**: type a stem (राम, मति) in Devanagari or SLP1, choose the gender, and press **Show all forms**. You get eight cases by three numbers.

**Choose any form** in the table to see its derivation. Each step shows the word so far, the sutra number (which opens in the Ashtadhyayi) and the sutra's text. For example, भवति takes 20 steps, ending with 6.1.78 एचोऽयवायावः, which turns भो into भव्.

**Check a form**: type a form, for example one another AI gave you. AAI says whether the rules derive it for your choice, and where it sits in the table.

> **Note** Forms come only from the rules. If the rules derive no form for a choice, the table shows a dash rather than a guess.

## Ask AAI

Choose an Ollama model (a `guru-maataa` model is picked first if you have one) and ask a question.

1. AAI finds the sutras your question mentions and gives the model their exact text.
2. It checks every sutra the answer cites.
3. The answer gets one of three labels:

| Label | Meaning |
| --- | --- |
| **Citations verified** | Every cited sutra exists and is quoted correctly. The explanation is still the model's own. |
| **Not verified** | No sutra citation could be checked. |
| **Contradicted by the sutras** | A citation is wrong: the number doesn't exist, or the quoted words belong to another sutra. |

**Check sutra citations in any text** does the same check on text you paste, for example from another AI.

## Evidence records

Every derivation you open, every form you check and every Ask answer is **sealed as an evidence record**. The result shows a **Sealed as evidence #N** badge and an **Export** button.

A record keeps:

- what was asked, which engine (with its version) and which edition of the texts;
- the result, as its SHA-256 hash;
- the rule checks: every step names a real sutra, and every cited sutra exists and is quoted correctly;
- a link to the record before it, and a signature made with this computer's own key.

On **Maataa AAI**, under **Evidence records**:

| Button | What it does |
| --- | --- |
| **Replay** | Runs a derivation or form check again and compares it with the sealed result. For an Ask answer, the model isn't run again (its answers vary), but its citations are checked again by rule. |
| **Export** | Saves the record as a JSON file that anyone can check without this computer. |
| **Verify an exported file** | Checks a file: the result matches its hash, the record is unchanged, and the signature is valid. Any edit is caught. |
| **Verify the chain** | Checks every sealed record on this computer, so a changed, removed or reordered record is found. |

An answer whose citations are wrong is sealed too, as **failed**. The failed check is itself the evidence. Recording never changes anything outside Maataa: these are read-only actions under the capability **knowledge.verify**.

## Lipi

Type Devanagari, Brahmi or Siddham, or Latin letters (read as SLP1). Lipi shows the text in Devanagari, IAST, SLP1, Brahmi, Kharoshthi and Siddham, each with a **Copy** button. It's the same conversion Guru uses, checked on all 3,983 sutras. Kharoshthi can be written but not yet read.

## Sources

- Sutra text and Dhatupatha: Vidyut (ambuda.org), MIT licence, data shared by ashtadhyayi.com.
- Derivations: Vidyut's prakriya engine, MIT licence.

The same derivations also give Guru verified teaching pairs.
