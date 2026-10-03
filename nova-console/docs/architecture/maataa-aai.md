# Maataa AAI: Advanced Ancient Intelligence

*Status: v0.2, built into Maataa Workstation. Codename AAI. October 2026. v0.2 adds signed evidence records (R1).*

## 1. What it is

Maataa AAI is MAATAA's intelligence built on the rule systems of the Indian knowledge tradition. It starts with Panini's grammar, the Aṣṭādhyāyī: about 4,000 rules that generate correct Sanskrit. AAI uses those rules as rules. They derive words step by step and check claims. Neural models are allowed to propose but not to decide.

> **Principle:** Rules derive and check. Models propose. Nothing is called correct unless the rules confirm it.

This follows from MAATAA's own line, "governed intelligence" and "Intelligence for a Higher Good". Its execution contracts already require evidence before an action is accepted. AAI requires the same before a statement is called correct.

## 2. Naming

- **Public name:** *Maataa AAI*, always with "Maataa". In India, "AAI" on its own is widely read as the Airports Authority of India.
- **Long form:** "Advanced Ancient Intelligence". Use it for the tagline, not as the name.
- **Before public launch:** do a trademark search for "Maataa AAI" in classes 9 and 42, plus a domain and social-handle check.
- **Inside the product:** the Workstation rail group is "AAI · Ancient Intelligence", with five screens: Maataa AAI, Ashtadhyayi, Derivation, Lipi and Lipi Tensor.

## 3. Pillars

| Pillar | What it is | Where it lives today |
| --- | --- | --- |
| **Texts** | The Ashtadhyayi (3,983 sutras), Dhatupatha (2,229 roots), Unadi, Linganushasana and Phit sutras | `guru/data/panini` (Vidyut, MIT); Workstation `lib/panini-data.json`; allb `data/ashtadhyayi.json` |
| **Rules engine** | Paninian derivation (prakriya): root + affix → word. Every step names its sutra. | Workstation `lib/aai.js` + `lib/aai_prakriya.py`, using Vidyut's prakriya engine |
| **Verification** | Sutra citations (does the number exist, is the quote right?), "is this form derivable?", Devanagari orthography | `panini.checkCitations`; `aai.checkForm`; Guru-Panini (P1–P5) |
| **Learned parts** | Small neurons that learn one rule and must agree with it on every case; the Guru model family | Neuron Factory sutra neurons; `guru/` |
| **Scripts** | Devanagari, IAST, SLP1, Brahmi, Kharoshthi, Siddham | Guru-Lipi (`guru/lipi.py`); Workstation Lipi |
| **Script tensor** | Writing systems on four axes (epoch, substrate, architecture, direction), every cell backed by sourced records | Workstation Lipi Tensor (`lib/hkdm-tensor.js`) |
| **Grounding (later)** | Veda, Shastra and Purana as retrieval sources with licensed editions, not as model weights | Not built |

## 4. How a question flows

```
question ─► grounding: exact text of the sutras it mentions
         ─► model proposes an answer (Guru or any Ollama model)
         ─► AAI checks every cited sutra (number exists? quoted words are this sutra's?)
         ─► verdict: citations verified | not verified | contradicted
         ─► sealed as an evidence record (signed, chained, exportable)
```

For word forms there is no model in the loop. The rules derive the forms, and AAI shows each step with its sutra. "Check a form" answers whether the rules derive a claimed form.

## 5. Honesty rules (binding)

1. A form is shown as **derived** only if the rule engine derived it. If the rules give no form, the screen shows a dash, never a guess.
2. A model's answer is labelled with the model's name. It is marked **verified** only for the parts the rules checked, which today are its sutra citations, and the label says exactly that.
3. A sutra neuron is approved only if it agrees with its sutra on every case (169 of 169 vowel pairs). It learns its sutra on its own. Which rule wins when several apply is decided by the Ashtadhyayi's order of exceptions, not by the neuron.
4. Only text with a licence that allows it is included. Meanings and commentaries stay out until a licensed edition is chosen.
5. Placeholder data is refused by the build, as allb's `build.rs` now does.
6. Every derivation, form check and Ask answer is sealed as an evidence record, including answers whose citations fail. A failed check is kept as evidence, never dropped.

## 6. Where AAI sits in the Maataa ecosystem

- **MAATAA (the governed intelligence layer):** AAI is its rules-first reasoning branch.
- **Maataa Workstation:** the AAI group of screens and the `/api/aai/*` API.
- **Guru:** MAATAA's own model family. It is trained on AAI-verified pairs (about 11,000 derivation pairs, plus about 18,000 sutra and Dhatupatha pairs), and AAI checks what Guru writes.
- **Lipi System:** AAI reads and writes the historic scripts through Guru-Lipi.
- **allb (MAATAA × Siddham runtime):** uses the same real sutra dataset. Next step: derivations at the edge (R4).
- **Replay + Proof System:** AAI verdicts are evidence records (R1, done): execution contracts with the capability `knowledge.verify`, sealed and signed by the workstation's Ed25519 key.

## 7. What exists today (v0.1)

- **Ashtadhyayi screen:** find sutras by number, range, pada or words, in any of six scripts, and look up roots in the Dhatupatha.
- **Derivation screen:** verbs across 11 lakaras, 2 voices and 22 prefixes; nouns in 3 genders; tables of all forms; step-by-step derivations that cite a sutra at each step; "Check a form".
- **Lipi screen:** six scripts at once. The conversion is checked against all 3,983 sutras.
- **Maataa AAI screen:** install the engine in one click (or with `AAI - Set up.command`), Ask AAI with checked citations, and a citation checker for any pasted text.
- **Sutra neurons:** five presets in Neuron Factory: 6.1.77, 6.1.78, 6.1.87, 6.1.88 and 6.1.101.
- **Guru:** `teach --panini` adds the verified derivation pairs when `vidyut` is installed.
- **Hardware (allb, Siddham):** a Paninian datapath (`hardware/rtl/sivasutra_rom.v`, `sandhi_engine.v`, `panini_datapath.v`). It has a Shiva Sutra ROM, parallel sutra match blocks with an exception-override matrix, a Saptādhyāyī loop and a Tripādī stage (8.3.19). It is verified on 338 reference cases and 143 Vidyut cases, and takes 208 LUT4s on iCE40.
  - It also has a consonant and visarga sandhi pipeline: 8.2, 8.3 and 8.4 as registered stages, a bypass for 6.1.113, 6.1.114 and 6.3.111, and lanes for optional rules. All 11,844 junctures agree with the reference, and 1,305 of 1,314 Vidyut entries agree; the 9 differences are explained in the report. It takes 1,550 LUT4s. See allb `docs/PANINI_DATAPATH.md`.
  - It also has a **prakriyā core** that derives words from the root as taught. It covers the present active 3rd singular of 981 of the 1,156 first-class roots. Competing operations are decided by antaraṅga, by nitya (tested by speculative evaluation in hardware) and by para. All 1,042 forms agree with Vidyut's derivations, and all 21,707 steps agree between the RTL and the reference. It takes 6,176 LUT4s.
- **Evidence records (R1):** every derivation, form check and Ask answer is an execution contract (`lib/aai-evidence.js`). The contract holds the request, the engine version, the edition of the texts (commit and SHA-256), the result's SHA-256 and the rule checks. It is approved by the read-only policy rule `aai.read-only`, chained to the previous contract and signed with the workstation's Ed25519 key. The full result is kept beside it in the `aaiEvidence` store.
  - **Replay:** derivations and form checks are run again and must give the same result hash. For Ask, the model isn't run again; its citations are checked again by rule.
  - **Export:** one JSON file (`maataa-aai-evidence/1`) with the contract, the result and the device's public key. Anyone can check it offline: the result hash, the record hash, the key fingerprint, the signature, and the citation or step checks redone from the sutra text. Its position in the chain can only be checked on the sealing workstation.
  - **API:** `GET /api/aai/evidence`, `GET /api/aai/evidence/:id`, `GET /api/aai/evidence/:id/bundle`, `POST /api/aai/evidence/:id/replay`, `POST /api/aai/evidence/verify`; the chain is checked by `GET /api/contracts/verify`. Pass `"evidence": false` to skip sealing for one request.
- **Lipi Tensor (HKDM):** the script tensor T(α, β, γ, δ), epoch × substrate × information architecture × direction (`lib/hkdm-tensor.js`, data in `lib/hkdm-scripts.json`). The seed data holds 20 scripts and 65 records (57 from a source page, 8 general knowledge), each marked established or debated, and from a source page or general knowledge, and is cross-checked against Omniglot on 18 topics (agree, partly, differ). It is a draft for an epigraphist to review. The screen shows any two axes as a heatmap and opens each cell to its records. It also shows lineage with the gaps between first attestations, and exports the dense tensor (JSON, 11 × 11 × 6 × 5; δ includes 'unfixed') and the records (CSV). API: `GET /api/hkdm`, `/api/hkdm/projection`, `/api/hkdm/cell`, `/api/hkdm/export/tensor`, `/api/hkdm/export/records.csv`.
- **Tests:** unit tests for the engine, conversions, citations and the Ask verdicts; evidence tests (sealing, failed citations, tamper detection in exported files, chain breaks, replay of verb, noun and form-check results); and a browser test that derives भवति, checks a wrong form, replays the sealed record, verifies the chain and verifies an exported file.

## 8. Roadmap

| # | Step | Why |
| --- | --- | --- |
| R1 | **Done (v0.2).** Each Ask, derivation and form check is a signed evidence record (execution contracts), with replay and offline-verifiable export | Replay and proof; shareable verdicts |
| R2 | Sandhi and segmentation (Vidyut's sandhi and cheda modules) to check whole sentences a model writes | Verify more than citations |
| R3 | Anuvṛtti view: what each sutra inherits from earlier sutras | Read sutras as Panini meant them |
| R4 | Derivations in allb: Vidyut's engine is Rust (MIT) and can compile into allb's WASM, giving `/api/z0/derive` at the edge | One engine across the Workstation, the edge and Siddham devices |
| R5 | A Guru training loop where AAI checks generated answers and only verified ones are kept | A model that improves only on rule-checked data |
| R6 | Meanings and commentary from a licensed edition | Explanations, not just text |
| R7 | Reading Kharoshthi, plus Sharada and Grantha | Full Lipi coverage |
| R8 | More sutra neurons (savarna 1.1.9, consonant sandhi in 8.4) and a precedence demo | Show how rules interact |

## 9. Licences

- Sutra text, Dhatupatha and derivation engine: Vidyut by ambuda.org, MIT licence (data originally shared by ashtadhyayi.com).
- Guru training text: Wikipedia, CC BY-SA 4.0, attributed in each model card.
- AAI code: part of the brahmini monorepo.
