"""Guru-Panini v0: a rule checker for Devanagari text.

This is the first, small piece of the rule engine: it checks that Devanagari
is well formed (orthography), not yet grammar. It is used twice:
  - to filter the training corpus (lines with broken script are dropped), and
  - to score what Guru writes (verify()), so bad output is visible.

Rules in v0
  P1  a vowel sign (matra), virama, anusvara, chandrabindu, visarga or nukta
      must follow a consonant or vowel it can attach to, never start a word
  P2  no two vowel signs in a row, no two viramas in a row
  P3  a nukta only follows a consonant
  P4  a word does not mix Devanagari and Latin letters
  P5  no invisible or control characters (other than ZWJ/ZWNJ inside words)

Text in Brahmi, Kharoshthi or Siddham is checked through Devanagari (Guru-Lipi).
Grammar rules (sandhi, vibhakti agreement, dhatu forms from the Ashtadhyayi)
come later as separate rule sets with the same verify() interface.
"""
import re
import unicodedata

from . import lipi

VOWELS = set(chr(c) for c in range(0x0904, 0x0915)) | {"ॠ", "ॡ", "ॲ", "ॳ", "ॴ", "ॵ", "ॶ", "ॷ"}
CONSONANTS = set(chr(c) for c in range(0x0915, 0x093A)) | set(chr(c) for c in range(0x0958, 0x0960)) | {"ॸ", "ॹ", "ॺ", "ॻ", "ॼ", "ॽ", "ॾ", "ॿ"}
MATRAS = set(chr(c) for c in range(0x093A, 0x094D)) - {"़", "ऽ"} | {"ॎ", "ॏ", "ॕ", "ॖ", "ॗ", "ॢ", "ॣ"}
VIRAMA, NUKTA, AVAGRAHA = "्", "़", "ऽ"
MODIFIERS = {"ऀ", "ँ", "ं", "ः"}  # inverted candrabindu, candrabindu, anusvara, visarga
ZW = {"‌", "‍"}
DEV = re.compile(r"[ऀ-ॿ꣠-ꣿ]")
LATIN = re.compile(r"[A-Za-z]")


def is_devanagari(text: str, share: float = 0.3) -> bool:
    letters = [ch for ch in text if ch.isalpha() or DEV.match(ch)]
    if not letters:
        return False
    return sum(1 for ch in letters if DEV.match(ch)) / len(letters) >= share


def verify(text: str):
    """Returns {"ok": bool, "score": 0..1, "words": n, "issues": [{"rule", "word", "at"}]}."""
    text = unicodedata.normalize("NFC", lipi.to_deva(text))  # Brahmi, Kharoshthi and Siddham are checked through Devanagari
    issues = []
    words = re.findall(r"\S+", text)
    for wi, w in enumerate(words):
        if not DEV.search(w):
            continue
        if LATIN.search(w):
            issues.append({"rule": "P4", "word": w, "at": wi})
        prev = None
        for ch in w:
            if ch in MATRAS or ch == VIRAMA or ch in MODIFIERS:
                if (ch in MATRAS and prev in MATRAS) or (ch == VIRAMA and prev == VIRAMA):
                    issues.append({"rule": "P2", "word": w, "at": wi}); break
                if prev is None or not (prev in CONSONANTS or prev == NUKTA or (ch in MODIFIERS and (prev in VOWELS or prev in MATRAS or prev in MODIFIERS))):
                    issues.append({"rule": "P1", "word": w, "at": wi}); break
            elif ch == NUKTA and prev not in CONSONANTS:
                issues.append({"rule": "P3", "word": w, "at": wi}); break
            elif unicodedata.category(ch) in ("Cc", "Cf") and ch not in ZW:
                issues.append({"rule": "P5", "word": w, "at": wi}); break
            prev = ch
    dev_words = sum(1 for w in words if DEV.search(w)) or 1
    bad_words = len({i["at"] for i in issues})
    score = 1.0 - bad_words / dev_words
    return {"ok": not issues, "score": round(score, 4), "words": len(words), "issues": issues[:50]}


def keep_line(line: str, min_score: float = 0.9) -> bool:
    """Corpus filter: keeps non-Devanagari lines, and Devanagari lines that are well formed."""
    line = lipi.to_deva(line)
    if not DEV.search(line):
        return True
    return verify(line)["score"] >= min_score
