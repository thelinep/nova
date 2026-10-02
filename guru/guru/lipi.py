"""Guru-Lipi: Brahmi, Kharoshthi and Siddham ⇄ Devanagari.

Guru learns and checks in one pivot script, Devanagari. Text in Brahmi,
Kharoshthi or Siddham is converted to Devanagari before the tokenizer and
Guru-Panini see it, so it costs the same tokens and gets the same rules.
Guru's output can be shown in any of the four scripts.

Most letters correspond one to one and are matched by their Unicode names
(SIDDHAM LETTER KA ↔ DEVANAGARI LETTER KA). The rest are handled here:
  Kharoshthi  writes every vowel as A + vowel sign and marks length with a
              separate sign; it has no long vowel signs, no AI/AU and no nukta.
              Its extra Gandhari letters (KKA, TTTA, TTTHA, VHA) and marks are
              kept as they are.
  Brahmi      jihvamuliya and upadhmaniya have Devanagari equivalents (ᳵ ᳶ);
              its additive numbers and punctuation ornaments are kept.
  Siddham     separators become dandas, alternate vowel forms become the
              normal ones, ornaments and repetition marks are kept.
from_deva() reports what could not be written exactly in the target script.
"""
import unicodedata

SCRIPTS = {
    "devanagari": (0x0900, 0x097F),
    "brahmi": (0x11000, 0x1107F),
    "kharoshthi": (0x10A00, 0x10A5F),
    "siddham": (0x11580, 0x115FF),
}
LABELS = {"devanagari": "Devanagari", "brahmi": "Brahmi", "kharoshthi": "Kharoshthi", "siddham": "Siddham"}
FONTS = {"brahmi": "Noto Sans Brahmi", "kharoshthi": "Noto Sans Kharoshthi", "siddham": "Noto Sans Siddham", "devanagari": "Noto Sans Devanagari"}


def _u(name):
    try:
        return unicodedata.lookup(name)
    except KeyError:
        return None


def _name_map(script):
    """Characters of a script whose Unicode name has a Devanagari twin."""
    lo, hi = SCRIPTS[script]
    up = script.upper()
    out = {}
    for cp in range(lo, hi + 1):
        ch = chr(cp)
        n = unicodedata.name(ch, "")
        if not n:
            continue
        d = _u(n.replace(up, "DEVANAGARI", 1))
        if d is None and n.endswith(" VIRAMA"):
            d = "्"
        if d is None and n.endswith("PUNCTUATION DANDA"):
            d = "।"
        if d is None and n.endswith("PUNCTUATION DOUBLE DANDA"):
            d = "॥"
        if d:
            out[ch] = d
    return out


TO_DEVA = {s: _name_map(s) for s in SCRIPTS if s != "devanagari"}
# Extra one-way mappings into Devanagari.
TO_DEVA["brahmi"].update({_u("BRAHMI SIGN JIHVAMULIYA"): "ᳵ", _u("BRAHMI SIGN UPADHMANIYA"): "ᳶ"})
TO_DEVA["siddham"].update({
    _u("SIDDHAM SEPARATOR DOT"): "।", _u("SIDDHAM SEPARATOR BAR"): "।",
    _u("SIDDHAM LETTER THREE-CIRCLE ALTERNATE I"): "इ", _u("SIDDHAM LETTER TWO-CIRCLE ALTERNATE I"): "इ",
    _u("SIDDHAM LETTER TWO-CIRCLE ALTERNATE II"): "ई", _u("SIDDHAM LETTER ALTERNATE U"): "उ",
    _u("SIDDHAM VOWEL SIGN ALTERNATE U"): "ु", _u("SIDDHAM VOWEL SIGN ALTERNATE UU"): "ू",
})
for m in TO_DEVA.values():
    m.pop(None, None)
# The way back: one Devanagari character to one target character (first, standard form wins).
FROM_DEVA = {}
for s, m in TO_DEVA.items():
    rev = {}
    for k, v in sorted(m.items(), key=lambda kv: ord(kv[0])):
        if len(v) == 1 and v not in rev and "ALTERNATE" not in unicodedata.name(k, "") and "SEPARATOR" not in unicodedata.name(k, ""):
            rev[v] = k
    FROM_DEVA[s] = rev

# Kharoshthi vowels: A + sign, and a separate length mark.
K_A, K_LEN = _u("KHAROSHTHI LETTER A"), _u("KHAROSHTHI VOWEL LENGTH MARK")
K_SIGN = {n: _u("KHAROSHTHI VOWEL SIGN " + n) for n in ("I", "U", "VOCALIC R", "E", "O")}
DEVA_VOWEL_SIGN = {"I": "ि", "U": "ु", "VOCALIC R": "ृ", "E": "े", "O": "ो"}
DEVA_INDEP = {"": "अ", "I": "इ", "U": "उ", "VOCALIC R": "ऋ", "E": "ए", "O": "ओ"}
DEVA_LONG_INDEP = {"": "\u0906", "I": "\u0908", "U": "\u090A", "VOCALIC R": "\u0960", "E": "\u0910", "O": "\u0914"}
DEVA_LONG_SIGN = {"": "\u093E", "I": "\u0940", "U": "\u0942", "VOCALIC R": "\u0944", "E": "\u0948", "O": "\u094C"}  # e/o + length mark = ai/au (Guru convention)
SIGN_NAME = {v: k for k, v in K_SIGN.items()}


def script_of(ch):
    cp = ord(ch)
    for s, (lo, hi) in SCRIPTS.items():
        if lo <= cp <= hi:
            return s
    return None


def detect(text):
    """The scripts in a text with their share of letters, largest first."""
    counts = {}
    for ch in text:
        s = script_of(ch)
        if s:
            counts[s] = counts.get(s, 0) + 1
    total = sum(counts.values()) or 1
    return sorted(((s, round(n / total, 3)) for s, n in counts.items()), key=lambda x: -x[1])


def _kharoshthi_to_deva(text):
    m = TO_DEVA["kharoshthi"]
    out, i = [], 0
    while i < len(text):
        ch = text[i]
        if ch == K_A:  # independent vowel: A, A + sign, optionally + length mark
            j = i + 1
            sign = SIGN_NAME.get(text[j]) if j < len(text) else None
            if sign:
                j += 1
            long_ = j < len(text) and text[j] == K_LEN
            if long_:
                j += 1
            key = sign or ""
            out.append((DEVA_LONG_INDEP.get(key) if long_ else None) or DEVA_INDEP[key]); i = j; continue
        if ch in SIGN_NAME:  # dependent vowel sign, optionally long
            key = SIGN_NAME[ch]
            long_ = i + 1 < len(text) and text[i + 1] == K_LEN
            out.append((DEVA_LONG_SIGN.get(key) if long_ else None) or DEVA_VOWEL_SIGN[key]); i += 2 if long_ else 1; continue
        if ch == K_LEN:  # length mark on the inherent a
            out.append("ा"); i += 1; continue
        out.append(m.get(ch, ch)); i += 1
    return "".join(out)


def to_deva(text):
    """Any Brahmi, Kharoshthi or Siddham in the text becomes Devanagari; everything else is untouched."""
    if not text or not any(script_of(ch) in TO_DEVA for ch in text):
        return text
    if any(script_of(ch) == "kharoshthi" for ch in text):
        text = _kharoshthi_to_deva(text)
    return unicodedata.normalize("NFC", "".join(TO_DEVA.get(script_of(ch), {}).get(ch, ch) if script_of(ch) in TO_DEVA else ch for ch in text))


_K_LONG_SIGN = {"ा": ("", True), "ी": ("I", True), "ू": ("U", True), "ॄ": ("VOCALIC R", True),
                "ि": ("I", False), "ु": ("U", False), "ृ": ("VOCALIC R", False), "े": ("E", False), "ो": ("O", False),
                "ै": ("E", True), "ौ": ("O", True)}
_K_INDEP = {"अ": ("", False), "आ": ("", True), "इ": ("I", False), "ई": ("I", True), "उ": ("U", False), "ऊ": ("U", True),
            "ऋ": ("VOCALIC R", False), "ॠ": ("VOCALIC R", True), "ए": ("E", False), "ऐ": ("E", True), "ओ": ("O", False), "औ": ("O", True)}


def from_deva(text, script):
    """Devanagari → Brahmi / Kharoshthi / Siddham. Returns (text, notes) where notes lists what was approximated."""
    if script == "devanagari":
        return text, []
    if script not in FROM_DEVA:
        raise ValueError(f"Unknown script {script!r}. Choose one of: {', '.join(SCRIPTS)}")
    text = unicodedata.normalize("NFD", text)  # split nukta forms so the base letter can be written
    rev, out, notes = FROM_DEVA[script], [], set()
    for ch in text:
        if script_of(ch) != "devanagari":
            out.append(ch); continue
        if script == "kharoshthi":
            if "\u0966" <= ch <= "\u096F":  # Kharoshthi numbers are additive (1, 2, 3, 4, 10, 20, 100, 1000), not positional digits
                notes.add("digits kept in Devanagari (Kharoshthi numbers are additive)"); out.append(ch); continue
            if ch in _K_INDEP:
                key, long_ = _K_INDEP[ch]
                out.append(K_A + (K_SIGN[key] if key else "") + (K_LEN if long_ else ""))
                if ch in ("ऐ", "औ"):
                    notes.add("ai/au written as e/o + length mark (Guru convention; Kharoshthi has no ai/au)")
                continue
            if ch in _K_LONG_SIGN:
                key, long_ = _K_LONG_SIGN[ch]
                out.append((K_SIGN[key] if key else "") + (K_LEN if long_ else ""))
                if ch in ("ै", "ौ"):
                    notes.add("ai/au written as e/o + length mark (Guru convention; Kharoshthi has no ai/au)")
                continue
        if ch == "़":
            notes.add("nukta dropped (no equivalent)"); continue
        t = rev.get(ch)
        if t is None and "\u0966" <= ch <= "\u096F":
            notes.add(f"digits kept in Devanagari ({LABELS[script]} has no digit for them)"); out.append(ch); continue
        if t is None:
            notes.add(f"{unicodedata.name(ch, hex(ord(ch))).replace('DEVANAGARI ', '').lower()} kept in Devanagari")
            out.append(ch)
        else:
            out.append(t)
    return "".join(out), sorted(notes)


def convert(text, to="devanagari"):
    """Any supported script → any supported script, through Devanagari."""
    deva = to_deva(text)
    return from_deva(deva, to) if to != "devanagari" else (deva, [])
