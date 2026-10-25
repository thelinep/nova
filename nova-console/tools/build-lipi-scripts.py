#!/usr/bin/env python3
"""Build lib/lipi-scripts.json: Devanagari -> other Brahmic scripts, by Unicode character name.

Every Brahmic block in Unicode names its characters the way Devanagari does
("DEVANAGARI LETTER KA" / "SHARADA LETTER KA"), so the table is derived from the
Unicode Character Database rather than typed by hand. A Devanagari character
with no same-named counterpart is left out of that script's table and listed
under "missing"; the converter then keeps the Devanagari character and reports
it, instead of guessing.

Run:  python3 tools/build-lipi-scripts.py      (uses the unicodedata2 package
      when installed, for Unicode 16+ scripts such as Tulu-Tigalari)
"""
import json, os, sys

try:
    import unicodedata2 as ud
except ImportError:  # the standard library knows fewer scripts
    import unicodedata as ud

# code, Unicode name prefix, English label, Hindi label, note
SCRIPTS = [
    ('Brah', 'BRAHMI', 'Brahmi', 'ब्राह्मी', 'Early historic South Asia; the parent of most scripts below.'),
    ('Bhks', 'BHAIKSUKI', 'Bhaiksuki', 'भैक्षुकी', 'Buddhist manuscripts of eastern India, 11th–12th century.'),
    ('Shrd', 'SHARADA', 'Sharada', 'शारदा', 'Kashmir and the western Himalaya.'),
    ('Sidd', 'SIDDHAM', 'Siddham', 'सिद्धम्', 'Buddhist texts in India and East Asia.'),
    ('Gran', 'GRANTHA', 'Grantha', 'ग्रन्थ', 'Sanskrit in South India.'),
    ('Nand', 'NANDINAGARI', 'Nandinagari', 'नन्दिनागरी', 'Sanskrit manuscripts and inscriptions of the Deccan and south.'),
    ('Newa', 'NEWA', 'Newa', 'नेवा', 'Nepal Bhasa and Sanskrit in the Kathmandu valley.'),
    ('Tirh', 'TIRHUTA', 'Tirhuta / Mithilakshar', 'तिरहुता / मिथिलाक्षर', 'Maithili and Sanskrit in Mithila.'),
    ('Takr', 'TAKRI', 'Takri', 'टाकरी', 'Western Himalayan languages.'),
    ('Modi', 'MODI', 'Modi', 'मोडी', 'Marathi administration, 17th–20th century.'),
    ('Kthi', 'KAITHI', 'Kaithi', 'कैथी', 'Hindustani and Bhojpuri records of north India.'),
    ('Dogr', 'DOGRA', 'Dogra', 'डोगरा', 'Dogri in Jammu.'),
    ('Sind', 'KHUDAWADI', 'Khudawadi', 'खुदावादी', 'Sindhi trade script.'),
    ('Diak', 'DIVES AKURU', 'Dives Akuru', 'दिवेस अकुरु', 'Historic Maldivian.'),
    ('Kawi', 'KAWI', 'Kawi', 'कवि', 'Old Javanese and maritime Southeast Asia.'),
    ('Tutg', 'TULU-TIGALARI', 'Tulu-Tigalari', 'तुळु-तिगळारि', 'Sanskrit and Tulu in coastal Karnataka.'),
    ('Beng', 'BENGALI', 'Bengali–Assamese', 'बांग्ला', 'Modern script; va is written with ba.'),
    ('Guru', 'GURMUKHI', 'Gurmukhi', 'गुरमुखी', 'Modern script; several Sanskrit letters have no form.'),
    ('Gujr', 'GUJARATI', 'Gujarati', 'गुजराती', 'Modern script.'),
    ('Orya', 'ORIYA', 'Odia', 'ओड़िआ', 'Modern script.'),
    ('Telu', 'TELUGU', 'Telugu', 'तेलुगु', 'Modern script.'),
    ('Knda', 'KANNADA', 'Kannada', 'कन्नड़', 'Modern script.'),
    ('Mlym', 'MALAYALAM', 'Malayalam', 'मलयालम', 'Modern script.'),
]

# Letters a Sanskrit or Hindi text needs; coverage is reported against these.
CORE = [chr(c) for c in list(range(0x0901, 0x0904)) + list(range(0x0905, 0x090D)) + [0x090F, 0x0910, 0x0913, 0x0914]
        + list(range(0x0915, 0x0929)) + list(range(0x092A, 0x0931)) + [0x0932, 0x0933] + list(range(0x0935, 0x093A))
        + [0x093D] + list(range(0x093E, 0x0945)) + [0x0947, 0x0948, 0x094B, 0x094C, 0x094D] + list(range(0x0966, 0x0970))]

# Writing conventions that are not a same-name match (code points, so the file stays readable).
OVERRIDES = {
    'Beng': {0x0935: [0x09AC]},                       # va -> ba
    'Guru': {0x0901: [0x0A01], 0x0902: [0x0A02]},     # candrabindu -> adak bindi, anusvara -> bindi
    # Kawi writes o as e + aa, and its virama is the "killer" (the converter turns it into the
    # conjoiner when a consonant follows, so clusters stack).
    'Kawi': {0x094B: [0x11F3E, 0x11F34], 0x094D: [0x11F41]},
}

# Scripts that distinguish short e/o from long ee/oo: Sanskrit and Hindi e/o are the long ones.
LONG_EO = [('LETTER E', 'LETTER EE'), ('LETTER O', 'LETTER OO'), ('VOWEL SIGN E', 'VOWEL SIGN EE'), ('VOWEL SIGN O', 'VOWEL SIGN OO')]
SHORT_EO = {0x090E: 'LETTER E', 0x0912: 'LETTER O', 0x0946: 'VOWEL SIGN E', 0x094A: 'VOWEL SIGN O'}


def name(ch):
    try:
        return ud.name(ch)
    except ValueError:
        return None


def lookup(n):
    try:
        return ud.lookup(n)
    except KeyError:
        return None


def candidates(dev_name, prefix):
    base = dev_name.replace('DEVANAGARI ', prefix + ' ', 1)
    out = [base]
    if ' SIGN ' in base:
        out.append(base.replace(' SIGN ', ' ', 1))
    else:
        out.append(base.replace(prefix + ' ', prefix + ' SIGN ', 1))
    return out


def build():
    scripts = {}
    for order, (code, prefix, label, hi, note) in enumerate(SCRIPTS):
        table, missing = {}, []
        for cp in range(0x0900, 0x0980):
            ch = chr(cp)
            dn = name(ch)
            if not dn or not dn.startswith('DEVANAGARI '):
                continue
            hit = None
            for cand in candidates(dn, prefix):
                hit = lookup(cand)
                if hit:
                    break
            if lookup(prefix + ' LETTER EE'):
                for short, long in LONG_EO:
                    if dn == 'DEVANAGARI ' + short:
                        hit = lookup(prefix + ' ' + long) or hit
                if cp in SHORT_EO:
                    hit = lookup(prefix + ' ' + SHORT_EO[cp]) or hit
            if not hit and dn == 'DEVANAGARI LETTER VA':
                hit = lookup(prefix + ' LETTER WA')
            if cp in OVERRIDES.get(code, {}):
                hit = ''.join(chr(c) for c in OVERRIDES[code][cp])
            if hit:
                table[ch] = hit
            elif ch in CORE:
                missing.append(ch)
        if not table:
            print(f'skip {code}: this Unicode database does not know {prefix}', file=sys.stderr)
            continue
        covered = sum(1 for c in CORE if c in table)
        scripts[code] = {
            'code': code, 'order': order, 'label': label, 'hi': hi, 'unicodeName': prefix.title(), 'direction': 'ltr', 'note': note,
            'coverage': round(covered / len(CORE), 3), 'missing': missing, 'map': table,
        }
    return {
        'format': 'maataa.lipi-scripts.v1',
        'source': f'Unicode Character Database {ud.unidata_version}, matched by character name',
        'core': ''.join(CORE),
        'scripts': scripts,
    }


if __name__ == '__main__':
    out = build()
    path = os.path.join(os.path.dirname(__file__), '..', 'lib', 'lipi-scripts.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
        f.write('\n')
    for s in out['scripts'].values():
        print(f"{s['code']:5} {s['coverage']*100:5.1f}%  missing: {''.join(s['missing'])}")
