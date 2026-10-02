"""Guru-Panini's source texts: the Ashtadhyayi and its companion texts.

The data in data/panini comes from Vidyut (ambuda.org), MIT licence; most of
it was shared by the author of ashtadhyayi.com under that licence. See
data/panini/SOURCES.md. The files are SLP1; this module serves Devanagari,
IAST or any Guru-Lipi script.

  get("1.1.1")               one sutra
  find("गुण")                sutras whose text contains a string (any script or SLP1)
  dhatu("भू")                Dhatupatha entries for a root
  check_citations(text)      finds "1.1.1"-style citations in text and checks
                             that the number exists and the quoted words match
  corpus_docs()              the texts as training documents (one per pada / gana)
  teach_pairs()              question/answer pairs for `guru teach`
  export_json(path)          one compact JSON file for Maataa Workstation

Only the sutra text is included, not commentary or meanings: Guru learns the
exact wording and numbering, and check_citations() catches a wrong quote.
"""
import os
import re
import unicodedata
from functools import lru_cache

from . import slp1

HERE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "panini")
FILES = {
    "ashtadhyayi": "sutrapatha.tsv", "dhatupatha": "dhatupatha.tsv", "unadipatha": "unadipatha.tsv",
    "linganushasanam": "linganushasanam.tsv", "phit": "phit-sutras.tsv", "ganasutras": "dhatupatha-ganasutras.tsv",
    "varttikas": "varttikas.tsv",
}
TITLES = {
    "ashtadhyayi": "अष्टाध्यायी", "dhatupatha": "धातुपाठ", "unadipatha": "उणादिसूत्र", "linganushasanam": "लिङ्गानुशासन",
    "phit": "फिट्सूत्र", "ganasutras": "धातुपाठ गणसूत्र", "varttikas": "वार्त्तिक",
}
GANAS = {1: "भ्वादि", 2: "अदादि", 3: "जुहोत्यादि", 4: "दिवादि", 5: "स्वादि", 6: "तुदादि", 7: "रुधादि", 8: "तनादि", 9: "क्र्यादि", 10: "चुरादि"}
TOTAL_SUTRAS = 3983
ID = re.compile(r"^[1-8]\.[1-4]\.\d{1,3}$")


def _rows(name):
    with open(os.path.join(HERE, FILES[name]), encoding="utf-8") as f:
        lines = f.read().splitlines()
    for line in lines[1:]:
        if line.strip():
            yield line.split("\t")


@lru_cache(maxsize=None)
def sutras():
    """All 3,983 Ashtadhyayi sutras in order: dicts with id, adhyaya, pada, number, slp1, deva, iast."""
    out = []
    for code, text in _rows("ashtadhyayi"):
        a, p, n = (int(x) for x in code.split("."))
        out.append({"id": code, "adhyaya": a, "pada": p, "number": n, "slp1": text, "deva": slp1.to_devanagari(text), "iast": slp1.to_iast(text)})
    return tuple(out)


@lru_cache(maxsize=None)
def _index():
    return {s["id"]: i for i, s in enumerate(sutras())}


def get(sutra_id, script="devanagari"):
    """One sutra by number ("1.1.1"), or None. Adds `text` in the chosen script."""
    i = _index().get(str(sutra_id).strip())
    if i is None:
        return None
    s = dict(sutras()[i])
    s["text"] = slp1.convert(s["slp1"], script)
    s["previous"] = sutras()[i - 1]["id"] if i else None
    s["next"] = sutras()[i + 1]["id"] if i + 1 < len(sutras()) else None
    return s


def _key(text):
    """Compares wording, ignoring spaces, accents, punctuation and script."""
    from . import lipi
    text = unicodedata.normalize("NFC", lipi.to_deva(text))
    if re.search(r"[a-zA-Z]", text) and not re.search(r"[ऀ-ॿ]", text):
        text = slp1.to_devanagari(text) if not re.search(r"[āīūṛṣśṇṭḍñṅḥṃ]", text) else _iast_to_deva(text)
    return re.sub(r"[\s॒॑।॥.,;:!?'\"()\-–—]", "", text)


def _iast_to_deva(text):
    rev = sorted(((v[2], k) for k, v in slp1.VOWELS.items()), key=lambda x: -len(x[0])) + \
          sorted(((v[1], k) for k, v in slp1.CONSONANTS.items()), key=lambda x: -len(x[0])) + [("ṃ", "M"), ("ḥ", "H"), ("m̐", "~")]
    rev.sort(key=lambda x: -len(x[0]))
    s, out, i = unicodedata.normalize("NFC", text.lower()), [], 0
    while i < len(s):
        for a, b in rev:
            if s.startswith(a, i):
                out.append(b); i += len(a); break
        else:
            out.append(s[i]); i += 1
    return slp1.to_devanagari("".join(out))


def find(query, limit=20):
    q = _key(query)
    if not q:
        return []
    return [s for s in sutras() if q in _key(s["deva"])][:limit]


@lru_cache(maxsize=None)
def dhatus():
    out = []
    for code, dhatu, artha in _rows("dhatupatha"):
        if dhatu.strip() in ("", "-"):  # 30 rows hold the places of the gana sutras, not roots
            continue
        gana = int(code.split(".")[0])
        out.append({"code": code, "gana": gana, "gana_name": GANAS.get(gana, ""), "slp1": dhatu,
                    "deva": slp1.to_devanagari(dhatu), "artha": slp1.to_devanagari(artha), "artha_slp1": artha})
    return tuple(out)


def _root_forms(deva):
    """The forms a Dhatupatha entry can be looked up by: as written, and without its marker letters (anubandhas)."""
    k = _key(deva).replace("ँ", "")
    forms = {k}
    for pre in ("ञि", "टु", "डु"):
        if k.startswith(pre) and len(k) > len(pre) + 1:
            k = k[len(pre):]; forms.add(k)
    for end in ("ञ्", "ङ्", "ष्"):  # final markers (डुपचँ॑ष्, डुकृ॒ञ्, शीङ्)
        if k.endswith(end):
            k = k[:-len(end)]; forms.add(k)
    last = k[-1:]
    if "\u093E" <= last <= "\u094C" or last in "\u0962\u0963":  # final marker vowel sign: गमॢ → गम्
        forms.add(k[:-1] + "्")
    elif "\u0915" <= last <= "\u0939":  # final marker a: एध → एध्
        forms.add(k + "्")
    return forms


def dhatu(root, limit=20):
    """Dhatupatha entries for a root, written with or without its markers (भू, गम्, एध्, कृ, इन्ध् …)."""
    q = _key(root).replace("ँ", "")
    exact = [d for d in dhatus() if q in _root_forms(d["deva"]) or (q + "्") in _root_forms(d["deva"])]
    return exact[:limit] or [d for d in dhatus() if _key(d["deva"]).replace("ँ", "").startswith(q)][:limit]


def other(name):
    """Unadipatha, Linganushasanam, Phit sutras, Dhatupatha ganasutras or the few varttikas: (code, devanagari) pairs."""
    return [(code, slp1.to_devanagari(text)) for code, text in _rows(name)]


# --- checking citations -------------------------------------------------------
CITE = re.compile(r"(?<![\d.])([1-8])\s*[./।]\s*([1-4])\s*[./।]\s*(\d{1,3})(?![\d.]\d)")
DEVA_RUN = re.compile(r"^[\s:–—\-(\"'“‘]*([ऀ-ॿ᳐-᳿][ऀ-ॿ᳐-᳿\s]*)")
DEVA_BEFORE = re.compile(r"([ऀ-ॿ᳐-᳿][ऀ-ॿ᳐-᳿\s]*?)[\s\"'”’]*[(\[]\s*$")
_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")


def check_citations(text):
    """Finds Ashtadhyayi citations (1.1.1, 1/1/1, १.१.१) and checks them.

    Returns a list of {"cite", "id", "status", "quoted", "expected", "looks_like"}; status is
      ok        the number exists and the words quoted with it are its text
      number    the number exists; no sutra text is quoted with it
      unknown   no such sutra (for example 1.1.101: the first pada has 75)
      mismatch  the words quoted with the number are a different sutra
                (looks_like names it)
    Words are "quoted with" a number when they directly follow it
    ("6.1.77 इको यणचि") or directly precede it in brackets ("इको यणचि (6.1.77)").
    """
    text = unicodedata.normalize("NFC", text).translate(_DIGITS)
    out = []
    for m in CITE.finditer(text):
        sid = f"{m.group(1)}.{m.group(2)}.{int(m.group(3))}"
        s = get(sid)
        row = {"cite": m.group(0), "id": sid, "status": "unknown", "quoted": "", "expected": s["deva"] if s else None, "looks_like": None}
        out.append(row)
        if not s:
            continue
        bracketed = re.search(r"[(\[]\s*$", text[max(0, m.start() - 3):m.start()])
        if bracketed:
            run = DEVA_BEFORE.search(text[max(0, m.start() - 160):m.start()])
            quoted = run.group(1).strip().split("\n")[-1] if run else ""
            k, hit = _key(quoted), lambda key: k.endswith(key)
        else:
            run = DEVA_RUN.match(text[m.end():])
            quoted = run.group(1).strip().split("\n")[0] if run else ""
            k, hit = _key(quoted), lambda key: k.startswith(key)
        row["quoted"] = quoted
        if k and hit(_key(s["deva"])):
            row["status"] = "ok"; continue
        other_ = max((t for t in sutras() if len(_keys()[t["id"]]) >= 4 and hit(_keys()[t["id"]])), key=lambda t: len(_keys()[t["id"]]), default=None) if k else None
        if other_:
            row["status"], row["looks_like"] = "mismatch", f"{other_['id']} {other_['deva']}"
        else:
            row["status"] = "number"
    return out


@lru_cache(maxsize=None)
def _keys():
    return {t["id"]: _key(t["deva"]) for t in sutras()}


# --- training data --------------------------------------------------------------
def corpus_docs():
    """(source, document) pairs: the Ashtadhyayi one document per pada, the Dhatupatha one per gana, the rest whole."""
    docs = []
    by_pada = {}
    for s in sutras():
        by_pada.setdefault((s["adhyaya"], s["pada"]), []).append(s)
    for (a, p), rows in by_pada.items():
        docs.append(("ashtadhyayi", f"{TITLES['ashtadhyayi']} — अध्याय {a}, पाद {p}\n\n" + "\n".join(f"{s['id']} {s['deva']}" for s in rows)))
    by_gana = {}
    for d in dhatus():
        by_gana.setdefault(d["gana"], []).append(d)
    for g, rows in by_gana.items():
        docs.append(("dhatupatha", f"{TITLES['dhatupatha']} — {GANAS.get(g, g)}गण\n\n" + "\n".join(f"{d['deva']} {d['artha']}" for d in rows)))
    for name in ("unadipatha", "linganushasanam", "phit", "ganasutras"):
        docs.append((name, f"{TITLES[name]}\n\n" + "\n".join(f"{c} {t}" for c, t in other(name))))
    return docs


def teach_pairs(dhatupatha=True):
    """Question/answer pairs built only from the source text (no invented explanations)."""
    pairs = []
    rows = sutras()
    for i, s in enumerate(rows):
        loc = f"अध्याय {s['adhyaya']}, पाद {s['pada']}, सूत्र {s['number']}"
        pairs.append({"prompt": f"अष्टाध्यायी का सूत्र {s['id']} क्या है?", "answer": f"{s['id']} {s['deva']}"})
        pairs.append({"prompt": f"\"{s['deva']}\" अष्टाध्यायी का कौन सा सूत्र है?", "answer": f"यह अष्टाध्यायी का सूत्र {s['id']} है ({loc})।"})
        pairs.append({"prompt": f"What is Ashtadhyayi sutra {s['id']}?", "answer": f"{s['id']} {s['deva']} ({s['iast']})"})
        if i + 1 < len(rows):
            n = rows[i + 1]
            pairs.append({"prompt": f"अष्टाध्यायी में सूत्र {s['id']} के बाद कौन सा सूत्र आता है?", "answer": f"{n['id']} {n['deva']}"})
    if dhatupatha:
        for d in dhatus():
            pairs.append({"prompt": f"धातुपाठ में \"{d['deva']}\" धातु का अर्थ और गण क्या है?",
                          "answer": f"{d['deva']} — {d['artha']} ({d['gana_name']}गण, {d['code']})"})
    return pairs


def export_json(path):
    """Writes the Ashtadhyayi, the Dhatupatha and the Guru-Lipi tables as one compact JSON file
    (used by Maataa Workstation's Ashtadhyayi view and sutra neurons)."""
    import hashlib
    import json
    from . import lipi
    raw = open(os.path.join(HERE, FILES["ashtadhyayi"]), "rb").read()
    data = {
        "source": {
            "name": "Vidyut (ambuda.org)", "url": "https://github.com/ambuda-org/vidyut",
            "commit": "8da2f90bee3ce1c07505fa432fc3729e3f7e02ea", "license": "MIT",
            "attribution": "Ashtadhyayi and Dhatupatha from Vidyut (https://github.com/ambuda-org/vidyut), (c) ambuda.org, MIT licence; data originally shared by ashtadhyayi.com.",
            "sutrapatha_sha256": hashlib.sha256(raw).hexdigest(),
            "generated_by": "python -m guru panini-json",
        },
        "fields": {"sutras": ["id", "devanagari", "iast", "slp1"], "dhatus": ["code", "root", "meaning"]},
        "ganas": GANAS,
        "sutras": [[t["id"], t["deva"], t["iast"], t["slp1"]] for t in sutras()],
        "dhatus": [[d["code"], d["deva"], d["artha"]] for d in dhatus()],
        "lipi": {
            "from_deva": {k: v for k, v in lipi.FROM_DEVA.items()},
            "kharoshthi": {"a": lipi.K_A, "length": lipi.K_LEN, "signs": lipi.K_SIGN,
                           "independent": {k: list(v) for k, v in lipi._K_INDEP.items()},
                           "dependent": {k: list(v) for k, v in lipi._K_LONG_SIGN.items()}},
        },
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    return path
