"""Verified teaching pairs from Paninian derivations (Maataa AAI).

Uses Vidyut's prakriya engine (`pip install vidyut`, MIT licence) on the Dhatupatha in
data/panini. Every answer is a form the rules derive, and the derivation answers list the
sutra used at each step, so Guru learns from checked output rather than invented text.

  available()          True when the engine is installed
  teach_pairs(...)     question/answer pairs (used by `guru teach --panini`)
"""
import os
import shutil
import tempfile

from . import slp1
from .sutra import HERE, GANAS, get

LAKARAS = {"Lat": "लट्", "Lot": "लोट्", "Lan": "लङ्", "Lrt": "लृट्"}


def available():
    try:
        import vidyut.prakriya  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def _entries():
    import vidyut.prakriya as P
    folder = tempfile.mkdtemp(prefix="guru-prakriya-")
    shutil.copyfile(os.path.join(HERE, "dhatupatha.tsv"), os.path.join(folder, "dhatupatha.tsv"))
    try:
        return P.Data(folder).load_dhatu_entries()
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def teach_pairs(lakaras=("Lat", "Lot", "Lan", "Lrt"), with_steps=300):
    """Form questions for every root (3rd person singular, active) and full derivations for the first `with_steps` roots."""
    import vidyut.prakriya as P
    v = P.Vyakarana()
    pairs = []
    for i, e in enumerate(_entries()):
        root, artha = slp1.to_devanagari(e.dhatu.aupadeshika), slp1.to_devanagari(e.artha)
        gana = GANAS.get(int(e.code.split(".")[0]), "")
        for lak in lakaras:
            try:
                forms = v.derive(P.Pada.Tinanta(e.dhatu, P.Prayoga.Kartari, getattr(P.Lakara, lak), P.Purusha.Prathama, P.Vacana.Eka))
            except Exception:  # noqa: BLE001
                continue
            if not forms:
                continue
            words = " / ".join(slp1.to_devanagari(f.text) for f in forms)
            pairs.append({"prompt": f"\"{root}\" धातु ({gana}गण, {artha}) का {LAKARAS[lak]} लकार, प्रथम पुरुष एकवचन (कर्तरि) रूप क्या है?", "answer": words})
            if lak == "Lat":
                pairs.append({"prompt": f"\"{slp1.to_devanagari(forms[0].text)}\" किस धातु का कौन सा रूप है?", "answer": f"{root} धातु ({gana}गण, {e.code}), लट् लकार, प्रथम पुरुष एकवचन।"})
                if i < with_steps:
                    steps = []
                    for s in forms[0].history:
                        sutra = get(s.code) if s.source.name == "Ashtadhyayi" else None
                        steps.append(f"{s.code}{' ' + sutra['deva'] if sutra else ''} → {slp1.to_devanagari(' + '.join(s.result))}")
                    pairs.append({"prompt": f"\"{slp1.to_devanagari(forms[0].text)}\" की पाणिनीय प्रक्रिया बताइए।", "answer": "\n".join(steps)})
    return pairs
