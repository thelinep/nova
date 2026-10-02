#!/usr/bin/env python3
"""Maataa AAI: Paninian derivations with Vidyut's prakriya engine (ambuda.org, MIT licence).

Reads one JSON request on stdin and writes one JSON answer on stdout. Strings are SLP1;
the Workstation converts them to Devanagari. Every derivation step names the rule that
made it, so nothing here is a guess: if the engine cannot derive a form, it says so.

  {"op": "version"}
  {"op": "tinanta", "code": "01.0001", "lakara": "Lat", "prayoga": "Kartari",
   "purusha": "Prathama", "vacana": "Eka", "pada": null, "prefixes": []}
  {"op": "paradigm", "code": "01.0001", "lakara": "Lat", "prayoga": "Kartari", "pada": null, "prefixes": []}
  {"op": "subanta", "stem": "rAma", "linga": "Pum", "vibhakti": "Prathama", "vacana": "Eka"}
  {"op": "declension", "stem": "rAma", "linga": "Pum"}
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DHATUPATHA = os.environ.get("NOVA_AAI_DHATUPATHA") or os.path.join(HERE, "aai-dhatupatha.tsv")
PURUSHAS = ["Prathama", "Madhyama", "Uttama"]
VACANAS = ["Eka", "Dvi", "Bahu"]
VIBHAKTIS = ["Prathama", "Dvitiya", "Trtiya", "Caturthi", "Panchami", "Sasthi", "Saptami", "Sambodhana"]


def fail(message, code="error"):
    print(json.dumps({"ok": False, "code": code, "error": message}, ensure_ascii=False))
    sys.exit(0)


try:
    import vidyut
    import vidyut.prakriya as P
except Exception:  # noqa: BLE001
    fail("The derivation engine (the 'vidyut' Python package) is not installed.", "engine-missing")


def data_dir():
    """Vidyut's Data() reads dhatupatha.tsv from a folder; keep a copy keyed by content."""
    raw = open(DHATUPATHA, "rb").read()
    folder = os.path.join(tempfile.gettempdir(), "maataa-aai-" + hashlib.sha256(raw).hexdigest()[:12])
    target = os.path.join(folder, "dhatupatha.tsv")
    if not os.path.exists(target):
        os.makedirs(folder, exist_ok=True)
        tmp = target + ".part"
        shutil.copyfile(DHATUPATHA, tmp)
        os.replace(tmp, target)
    return folder


def entries():
    return {e.code: e for e in P.Data(data_dir()).load_dhatu_entries()}


def enum(cls, name, label):
    try:
        return getattr(cls, name)
    except (AttributeError, TypeError):
        fail(f"Unknown {label}: {name!r}.")


def steps(prakriya):
    return [{"source": s.source.name, "code": s.code, "result": list(s.result)} for s in prakriya.history]


def dhatu_for(req):
    e = entries().get(str(req.get("code", "")))
    if not e:
        fail(f"No Dhatupatha entry {req.get('code')!r}.", "not-found")
    d = e.dhatu
    prefixes = [p for p in (req.get("prefixes") or []) if p]
    if prefixes:
        d = d.with_prefixes(prefixes)
    return e, d


def tinanta(d, req, purusha, vacana):
    kwargs = {}
    if req.get("pada"):
        kwargs["dhatu_pada"] = enum(P.DhatuPada, req["pada"], "pada")
    pada = P.Pada.Tinanta(d, enum(P.Prayoga, req.get("prayoga", "Kartari"), "prayoga"), enum(P.Lakara, req.get("lakara", "Lat"), "lakara"),
                          enum(P.Purusha, purusha, "purusha"), enum(P.Vacana, vacana, "vacana"), **kwargs)
    return P.Vyakarana().derive(pada)


def subanta(req, vibhakti, vacana):
    stem = str(req.get("stem", "")).strip()
    if not stem:
        fail("Give a stem (pratipadika).")
    pada = P.Pada.Subanta(P.Pratipadika.basic(stem), enum(P.Linga, req.get("linga", "Pum"), "linga"), enum(P.Vibhakti, vibhakti, "vibhakti"), enum(P.Vacana, vacana, "vacana"))
    return P.Vyakarana().derive(pada)


def main():
    req = json.loads(sys.stdin.read() or "{}")
    op = req.get("op")
    if op == "version":
        print(json.dumps({"ok": True, "engine": "vidyut-prakriya", "version": getattr(vidyut, "__version__", None) or _pkg_version(), "dhatus": len(entries())}))
        return
    if op == "tinanta":
        e, d = dhatu_for(req)
        forms = tinanta(d, req, req.get("purusha", "Prathama"), req.get("vacana", "Eka"))
        out = {"ok": True, "dhatu": {"code": e.code, "aupadeshika": e.dhatu.aupadeshika, "artha": e.artha}, "forms": [{"text": f.text, "steps": steps(f)} for f in forms]}
    elif op == "paradigm":
        e, d = dhatu_for(req)
        grid = [[[f.text for f in tinanta(d, req, p, v)] for v in VACANAS] for p in PURUSHAS]
        out = {"ok": True, "dhatu": {"code": e.code, "aupadeshika": e.dhatu.aupadeshika, "artha": e.artha}, "rows": PURUSHAS, "columns": VACANAS, "grid": grid}
    elif op == "subanta":
        forms = subanta(req, req.get("vibhakti", "Prathama"), req.get("vacana", "Eka"))
        out = {"ok": True, "forms": [{"text": f.text, "steps": steps(f)} for f in forms]}
    elif op == "declension":
        grid = [[[f.text for f in subanta(req, vb, v)] for v in VACANAS] for vb in VIBHAKTIS]
        out = {"ok": True, "rows": VIBHAKTIS, "columns": VACANAS, "grid": grid}
    else:
        fail(f"Unknown operation {op!r}.")
    print(json.dumps(out, ensure_ascii=False))


def _pkg_version():
    try:
        from importlib.metadata import version
        return version("vidyut")
    except Exception:  # noqa: BLE001
        return None


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        fail(f"{type(exc).__name__}: {exc}")
