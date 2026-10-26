# Guru offline coding dictionary

`coding-terms.v0.1.json` is a small, local-only glossary of 32 programming
concepts in Sanskrit, Hindi, English, Urdu, Russian, and Simplified Chinese.
It is a coding glossary, not a general-purpose dictionary or a translation
engine. Search is exact after Unicode compatibility normalization and case
folding; it does not transliterate, stem, or resolve context-sensitive senses.

Search it from the `guru/` project root:

```sh
python -m guru.offline_dictionary algorithm
python -m guru.offline_dictionary एल्गोरिदम --language hi
python -m guru.offline_dictionary --list-languages
```

## Review and rights status

Every entry is marked `draft`. The non-English terms are proposed equivalents
and aliases; they have not been approved by fluent technical reviewers. The
short English definitions are original editorial summaries. This file does
not include downloaded dictionary records, and its terms are **not approved
for model training, corpus admission, or publication**. Obtain language review
and a separate use-rights decision before assigning those uses.

The source URLs in the JSON are research pointers, not blanket permission to
copy their databases. In particular, the Center for Language Engineering
states that part of its Urdu glossary is based on National Language Authority
material under separate copyright, while its team-added entries have a
different license. No CLE or NLA data was imported here.

## Reference authorities

- Sanskrit and Hindi: [CSTT English-Hindi-Sanskrit IT glossary](https://shabd.education.gov.in/lexicon.jsp?lexicon=cstt_fund_IT_EngHinSan_glossary), marked in progress.
- Urdu: [Center for Language Engineering terminology glossary and rights note](https://cle.org.pk/software/localization/OSS/ossGlossary.html).
- Russian: [Russian terminology index for IT and AI concepts](https://docs.cntd.ru/document/566348046/titles/8OU0LO); treat it as a project/draft reference.
- Chinese: [Computer Science and Technology Terms, Second Edition](https://www.cnterm.cn/sd/xxjs/zwh/jsj/sdml/202311/t20231128_761281.html).
- English concepts: [NIST CSRC Glossary](https://csrc.nist.gov/glossary).
