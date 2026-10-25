"""Builds lib/lipi-indus.json and public/lipi-indus/ for the Lipi OS Indus signs board.

Inputs (collected through the Wikimedia Commons API in the browser, 26 Oct 2026): a JSON file with file metadata and
images. Usage: python3 tools/build-lipi-indus.py commons-download.json

The Indus script is undeciphered and has no Unicode encoding. Full sign lists (Mahadevan 1977: 417 signs; Parpola
1994: 386; Wells 2015: 694) are published works, so this board shows only openly licensed material: reference signs
uploaded to Commons with their list numbers, and signs cut from openly licensed photographs and drawings of seals.
Sign boxes were drawn by hand on each picture; the visual groups are an informal sorting, not a sign list.
"""
import base64, io, json, os, re, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = json.load(open(sys.argv[1]))
META, IMAGES = src['meta'], src['images']
slug = lambda t: re.sub(r'[^a-z0-9]+', '-', t.lower().rsplit('.', 1)[0]).strip('-')[:50]
BY_SLUG = {slug(t): t for t in META}

# objects: (slug, id, title, site, find/collection, date, kind, note)
OBJECTS = [
 ('banner-at-the-north-gate-of-dholavira', 'dholavira-banner', 'Dholavira “signboard” (drawing)', 'Dholavira, Kutch, Gujarat, India', 'c. 2600–1900 BCE (find)', 'Drawing of an inlaid inscription', 'Ten large signs, once inlaid in wood, found near the north gate of the citadel; each up to about 37 cm high.'),
 ('the-ten-indus-scripts-discovered-near-the-northern', 'dholavira-photo', 'Dholavira “signboard” (photograph of a copy)', 'Dholavira, Kutch, Gujarat, India', 'c. 2600–1900 BCE (find)', 'Inlaid inscription', 'The same ten signs, one of the longest Indus texts written in large letters.'),
 ('indus-script-recovered-from-khirsara-indus-valley-', 'khirsara', 'Khirsara inscribed bar seal', 'Khirsara, Kutch, Gujarat, India', 'Mature Harappan', 'Inscribed bar seal', 'A bar seal with a line of signs and no animal, from the Khirsara excavations.'),
 ('clevelandart-1964-104', 'cleveland-1964', 'Stamp seal with a bull (Cleveland 1964.104)', 'Indus valley (now Cleveland Museum of Art)', 'c. 2500–2000 BCE', 'Stamp seal', 'Signs along the top over an animal, the usual Indus seal layout.'),
 ('clevelandart-1973-160', 'cleveland-1973-160', 'Stamp seal with a zebu (Cleveland 1973.160)', 'Indus valley (now Cleveland Museum of Art)', 'c. 2500–2000 BCE', 'Stamp seal', 'Ladder-like and human-like signs above a humped bull.'),
 ('clevelandart-1973-161', 'cleveland-1973-161', 'Stamp seal with a bull (Cleveland 1973.161)', 'Indus valley (now Cleveland Museum of Art)', 'c. 2500–2000 BCE', 'Stamp seal', 'Nine signs, among them strokes, arcs and a rayed sign.'),
 ('met-1984-482-237872', 'met-1984', 'Stamp seal (Met 1984.482)', 'Pakistan (now Metropolitan Museum of Art)', 'c. 2600–1900 BCE', 'Stamp seal', 'Stroke signs stacked in two rows inside the line of text.'),
 ('stamp-seal-buffalo-with-incense-burner-met-ss49-40', 'met-buffalo', 'Stamp seal: buffalo and “incense burner”', 'Indus valley (now Metropolitan Museum of Art)', 'c. 2600–1900 BCE', 'Stamp seal', 'Jar-like and cross-like signs above the animal.'),
 ('stamp-seal-and-modern-impression-unicorn-and-incen', 'met-unicorn', 'Stamp seal and modern impression: “unicorn”', 'Indus valley (now Metropolitan Museum of Art)', 'c. 2600–1900 BCE', 'Stamp seal with impression', 'Diamond and triangle signs; the impression shows the text the right way round.'),
 ('bar-shaped-rectangular-plaque-seal-met-ss49-40-4', 'met-bar', 'Bar-shaped plaque seal (Met)', 'Indus valley (now Metropolitan Museum of Art)', 'c. 2600–1900 BCE', 'Plaque seal', 'Four signs and no animal.'),
 ('steatite-stamp-seal-indus-script-bm-1912-0629-1', 'bm-1912', 'Steatite seal with impression (BM 1912,0629.1)', 'North-western Pakistan (now British Museum)', 'c. 2600–1900 BCE', 'Seal and impression', 'A text-only seal shown beside its impression.'),
 ('indus-seal-impression', 'bm-impression', 'Seal impression with five signs (British Museum)', 'Indus valley (now British Museum)', 'c. 2600–1900 BCE', 'Seal impression', 'A clear five-sign text, often used to illustrate the script.'),
 ('unicorn-mold-of-seal-indus-valley-civilization', 'mumbai-unicorn', '“Unicorn” seal cast', 'Indus valley (cast at Chhatrapati Shivaji Maharaj Vastu Sangrahalaya, Mumbai)', 'c. 2500–1500 BCE (as labelled)', 'Cast of a seal', 'Nine signs in a row over a “unicorn” and a standard.'),
 ('elephant-mold-of-seal-indus-valley-civilization', 'bhopal-elephant', 'Elephant seal cast', 'Indus valley (cast at State Museum, Bhopal)', 'c. 2500–1500 BCE (as labelled)', 'Cast of a seal', 'Four signs over an elephant.'),
 ('sceau-indus-taureau-guimet', 'guimet-bull', 'Bull seal with impression (Musée Guimet)', 'Mohenjo-daro, Pakistan (now Musée Guimet, Paris)', 'c. 2600–1900 BCE', 'Seal and impression', 'Seal (top) and modern impression (bottom) of the same text.'),
 ('sceau-indus-unicorne-guimet', 'guimet-unicorn', '“Unicorn” seal with impression (Musée Guimet)', 'Mohenjo-daro, Pakistan (now Musée Guimet, Paris)', 'c. 2600–1900 BCE', 'Seal and impression', 'Seal and modern impression.'),
 ('longest-indus-script-inscription-2600-2000-bce', 'longest', 'A long Indus inscription (copper plate)', 'Indus valley', 'c. 2600–2000 BCE', 'Inscribed plate', 'Several rows of signs; published as the longest Indus text by Shinde and Willis.'),
 ('longest-indus-script-inscription-colour', 'longest-colour', 'The same long inscription, in colour', 'Indus valley', 'c. 2600–2000 BCE', 'Inscribed plate', 'Colour photograph of the same object.'),
 ('copper-plates-with-indus-script', 'copper-plates', 'Copper plates with Indus script', 'Indus valley', 'c. 2600–2000 BCE', 'Inscribed copper plates', 'Small copper plates with short texts.'),
 ('shiva-pashupati', 'pashupati', '“Pashupati” seal', 'Mohenjo-daro, Pakistan', 'c. 2350–2000 BCE', 'Stamp seal', 'A seated horned figure among animals, with signs along the top.'),
 ('yogi-seal-mohenjodaro-eamd13', 'prism-sealing', 'Triangular prism sealing', 'Mohenjo-daro, Pakistan', 'c. 2600–1900 BCE', 'Prism sealing', 'A seated figure with animals; one face of a three-sided sealing.'),
 ('kalibangan-cylinder-seal-impression', 'kalibangan-cylinder', 'Kalibangan cylinder seal (impression)', 'Kalibangan, Rajasthan, India', 'c. 2600–1900 BCE', 'Cylinder seal impression', 'A rare Indus cylinder seal: figures, animals and a few signs.'),
 ('mohenjo-daro-seals', 'mohenjodaro-two', 'Two seals from Mohenjo-daro', 'Mohenjo-daro, Pakistan', 'c. 2600–1900 BCE', 'Stamp seals (old photograph)', 'Two seal impressions from the early excavations.'),
 ('indus-seal-impression-from-susa-excavations', 'susa-scheil', 'Indus seal impression from Susa (drawing)', 'Susa, Iran', 'c. 2600–1700 BCE', 'Cylinder-seal impression (drawing)', 'Indus signs on a seal found in Elam: evidence of trade with Mesopotamia and Iran.'),
 ('susa-seal-with-indus-signs', 'susa-louvre', 'Susa cylinder seal with Indus signs', 'Susa, Iran (now Louvre)', 'c. 2600–1700 BCE', 'Cylinder seal impression', 'The uploader drew the signs above the impression with list numbers.'),
 ('indus-seal-impression-discovered-in-djokha-umma-ne', 'umma', 'Indus seal impression from Umma (drawing)', 'Djokha (Umma), Iraq', 'c. 2500–2000 BCE', 'Seal impression (drawing)', 'An Indus-type seal from southern Mesopotamia.'),
 ('indus-seal-found-in-kish-by-langdon-1931', 'kish', 'Indus seal found at Kish', 'Kish, Iraq', 'c. 2500–2000 BCE', 'Stamp seal (1931 photograph)', 'Published by Langdon in 1931; another sign of contact between the Indus and Mesopotamia.'),
 ('cunningham-seal-bm', 'cunningham', '“Cunningham” seal', 'Harappa, Pakistan (now British Museum)', 'c. 2600–1900 BCE', 'Stamp seal with impression', 'The first Indus seal to be published, by Alexander Cunningham in 1875.'),
 ('harappa-seals-nm-india-04', 'nmi-04', 'Seal in the National Museum, New Delhi', 'Harappan site (now National Museum, New Delhi)', 'c. 2600–1900 BCE', 'Stamp seal', 'Diamond, oval and stroke signs over a “unicorn”.'),
]
REFS = [('indus-sign-7', '7'), ('indus-sign-13', '13'), ('indus-sign-46', '46'), ('indus-sign-60', '60'), ('indus-sign-87', '87'), ('indus-sign-88', '88'),
        ('indus-sign-91', '91'), ('indus-sign-187', '187'), ('indus-sign-193', '193'), ('indus-sign-202', '202'), ('indus-sign-296', '296'), ('indus-sign-311', '311'),
        ('indus-sign-368', '368'), ('indus-sign-376', '376'), ('indus-script-sign-045', '45'), ('indus-script-sign-2', '2'), ('indus-script-sign-3', '3'), ('indus-script-sign-4', '4')]
GROUPS = {
 'wheel': ('Spoked circle', 'चक्र जैसा', [0, 3, 7, 8, 73, 78], ['368']),
 'oval': ('Diamond and oval', 'हीरा और अंडाकार', [4, 33, 75, 92, 95], ['376']),
 'cross': ('X and cross', 'क्रॉस', [5, 26, 47, 102], []),
 'stroke': ('Single stroke', 'एक रेखा', [6, 41, 105], []),
 'strokes': ('Groups of strokes', 'रेखाओं के समूह', [32, 53, 66, 103, 111], []),
 'spear': ('T and spear', 'भाला / T', [1, 64, 70, 100], []),
 'jar': ('U-shape (“jar”)', 'U आकार (“घड़ा”)', [31, 56, 71, 72, 99], ['296', '311']),
 'comb': ('Comb and rake', 'कंघी', [12, 45, 46, 52, 81, 82, 108], []),
 'ladder': ('Ladder and grid', 'सीढ़ी और जाली', [17, 18, 24, 35, 38, 48, 80, 104, 112], []),
 'human': ('Human figure', 'मानव आकृति', [13, 23, 36, 109], ['2', '3', '4', '7', '13']),
 'arc': ('Arc, bracket and S', 'चाप, कोष्ठ और S', [19, 37, 39, 40, 42, 43, 44, 106], []),
 'triangle': ('Triangle and arrowhead', 'त्रिकोण', [54, 55, 76, 85, 86], ['193']),
 'fshape': ('F-shape', 'F आकार', [62, 63, 69, 97, 101], []),
 'loops': ('Crossed loops', 'लिपटे फंदे', [2, 9], []),
 'other': ('Not grouped', 'असमूहित', [11, 20, 21, 22, 25, 27, 28, 30, 51, 57, 58, 59, 65, 67, 68, 74, 79, 83, 94], []),
}
crops = json.load(open(sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "tools", "lipi-indus-signs.json")))   # hand-drawn boxes: [{img, box}] in the order the boxes were drawn
used = {}
signs = []
for g, (en, hi, idx, refs) in GROUPS.items():
    for i in idx:
        c = crops[i]
        signs.append({'id': f's{i}', 'group': g, 'object': c['img'], 'box': c['box']})
obj_ids = {o[0]: o[1] for o in OBJECTS}
for s in signs: s['object'] = obj_ids[s['object']]
out_objects = []
os.makedirs(os.path.join(ROOT, 'public', 'lipi-indus'), exist_ok=True)
def save(sl, oid, maxw=900):
    t = BY_SLUG[sl]; im = Image.open(io.BytesIO(base64.b64decode(IMAGES[t].split(',', 1)[1]))).convert('RGB')
    if im.width > maxw: im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
    im.save(os.path.join(ROOT, 'public', 'lipi-indus', oid + '.jpg'), 'JPEG', quality=82, optimize=True, progressive=True)
    m = META[t]
    author = m['artist'] or 'Unknown'
    if 'Shabir Kumbhar' in author: author = 'Font by Shabir Kumbhar; mapping by Amar Fayaz Buriro'
    return im, {'author': author, 'licence': m['license'], 'licenceUrl': m.get('licenseUrl'), 'source': m['page'], 'file': t, 'via': 'Wikimedia Commons', 'commonsCredit': m['credit']}
for sl, oid, title, place, date, kind, note in OBJECTS:
    im, cr = save(sl, oid)
    out_objects.append({'id': oid, 'title': title, 'place': place, 'date': date, 'kind': kind, 'note': note, 'image': f'/lipi-indus/{oid}.jpg', 'w': im.width, 'h': im.height, 'credit': cr,
                        'signs': [s['id'] for s in signs if s['object'] == oid]})
refs = []
for sl, num in REFS:
    im, cr = save(sl, 'ref-' + num, 700)
    refs.append({'id': 'ref-' + num, 'number': num, 'image': f'/lipi-indus/ref-{num}.jpg', 'w': im.width, 'h': im.height, 'credit': cr,
                 'groups': [g for g, v in GROUPS.items() if num in v[3]]})
data = {
 'about': 'Indus (Harappan) script signs from openly licensed pictures. The script is undeciphered and not in Unicode. Sign boxes were drawn by hand; groups are an informal visual sorting, not a sign list.',
 'signLists': [
   {'who': 'Iravatham Mahadevan', 'year': 1977, 'signs': 417, 'note': 'The Indus Script: Texts, Concordance and Tables (Archaeological Survey of India). 2,906 texts; later counts 419 signs and 2,911 texts. Read online at the Roja Muthiah Research Library.', 'url': 'https://www.rmrl.in/en/dl/research-papers/mahadevan'},
   {'who': 'Asko Parpola', 'year': 1994, 'signs': 386, 'note': 'Deciphering the Indus Script (Cambridge University Press); also the Corpus of Indus Seals and Inscriptions.'},
   {'who': 'Bryan K. Wells', 'year': 2015, 'signs': 694, 'note': 'The Archaeology and Epigraphy of Indus Writing (Archaeopress).'},
 ],
 'facts': [
   'More than 4,700 inscribed objects are known: stamp seals, sealings, copper plates, small tablets, pottery and ivory rods.',
   'Most texts are short: about five signs on average; the longest has a few dozen.',
   'Texts on seals usually run from right to left; impressions show them reversed.',
   'There is no bilingual text, and the script has not been deciphered. Claims of decipherment, including links to Brahmi, are debated.',
 ],
 'resources': [
   {'title': 'Mahadevan, The Indus Script: Texts, Concordance and Tables (online, RMRL)', 'url': 'https://www.rmrl.in/en/dl/research-papers/mahadevan'},
   {'title': 'Harappa.com: Indus concordance now online', 'url': 'https://www.harappa.com/blog/indus-concordance-and-tamil-potsherds-now-online'},
   {'title': 'Yadav (2018), The Indus Script and Economics (arXiv)', 'url': 'https://arxiv.org/abs/1812.00049'},
   {'title': 'Wikimedia Commons: Category Indus script', 'url': 'https://commons.wikimedia.org/wiki/Category:Indus_script'},
 ],
 'groups': {g: {'en': v[0], 'hi': v[1], 'refs': v[3]} for g, v in GROUPS.items()},
 'objects': out_objects, 'signs': signs, 'refs': refs,
}
json.dump(data, open(os.path.join(ROOT, 'lib', 'lipi-indus.json'), 'w'), ensure_ascii=False, indent=1)
lines = ['# Indus signs board: image credits', '', 'Reduced copies of files on Wikimedia Commons, collected 26 October 2026. Each keeps its original licence.', '', '| Image | Author | Licence | Source |', '| --- | --- | --- | --- |']
for o in out_objects + refs:
    c = o['credit']; lic = f"[{c['licence']}]({c['licenceUrl']})" if c.get('licenceUrl') else c['licence']
    lines.append(f"| {o['id']}.jpg | {c['author'].replace('|', '/')} | {lic} | [{c['file'].replace('|', '/')}]({c['source']}) |")
open(os.path.join(ROOT, 'public', 'lipi-indus', 'CREDITS.md'), 'w').write('\n'.join(lines) + '\n')
print(len(out_objects), 'objects,', len(signs), 'signs,', len(refs), 'reference signs')
