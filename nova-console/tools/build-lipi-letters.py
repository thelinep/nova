#!/usr/bin/env python3
"""Build lib/lipi-letters.json: the Lipi OS letters board.

One record per Devanagari character that Lipi OS converts (the keys of
lib/lipi-scripts.json), with:
  board     the board it sits on (vowels, vowel signs, the five vargas, ...)
  type      vowel / vowel sign / consonant / nasal sign / sign / digit / punctuation / symbol
  grammar   place and manner of articulation as the Paninian tradition states them
            (Siddhanta Kaumudi on Ashtadhyayi 1.1.9), voicing, aspiration, length,
            and the pratyaharas (Maheshvara sutra groups) the sound belongs to
  sound     the IPA the audio was rendered from (Hindi pronunciation) and whether it
            is an approximation
  scripts   which Lipi OS scripts write it (from lipi-scripts.json)
  used      where the letter is used, in a few words
  resources links for further reading

Run:  python3 tools/build-lipi-letters.py
Audio: python3 tools/render-lipi-letter-sounds.py (needs Kokoro; writes public/lipi-sounds/)
"""
import json, os, unicodedata

ROOT = os.path.join(os.path.dirname(__file__), '..')
SCRIPTS = json.load(open(os.path.join(ROOT, 'lib', 'lipi-scripts.json'), encoding='utf-8'))

REGION = {  # where each Lipi OS script is (or was) written
    'Brah': 'Pan-Indian (ancient)', 'Bhks': 'Eastern India', 'Shrd': 'Kashmir', 'Sidd': 'India and East Asia', 'Gran': 'Tamil Nadu',
    'Nand': 'Deccan and Karnataka', 'Newa': 'Nepal', 'Tirh': 'Mithila (Bihar, Nepal)', 'Takr': 'Western Himalaya', 'Modi': 'Maharashtra',
    'Kthi': 'North India', 'Dogr': 'Jammu', 'Sind': 'Sindh', 'Diak': 'Maldives', 'Kawi': 'Java and maritime Southeast Asia',
    'Tutg': 'Coastal Karnataka', 'Beng': 'Bengal and Assam', 'Guru': 'Punjab', 'Gujr': 'Gujarat', 'Orya': 'Odisha',
    'Telu': 'Andhra Pradesh and Telangana', 'Knda': 'Karnataka', 'Mlym': 'Kerala',
}

# --- Maheshvara sutras and pratyaharas ------------------------------------------------------------
SHIVA = [('अइउ', 'ण'), ('ऋऌ', 'क'), ('एओ', 'ङ'), ('ऐऔ', 'च'), ('हयवर', 'ट'), ('ल', 'ण'), ('ञमङणन', 'म'), ('झभ', 'ञ'),
         ('घढध', 'ष'), ('जबगडद', 'श'), ('खफछठथचटतव', 'व'), ('कप', 'य'), ('शषस', 'र'), ('ह', 'ल')]
SAVARNA = {'आ': 'अ', 'ई': 'इ', 'ऊ': 'उ', 'ॠ': 'ऋ', 'ॡ': 'ऌ'}
PRATYAHARAS = ['अच्', 'हल्', 'अक्', 'इक्', 'एङ्', 'एच्', 'यण्', 'ञम्', 'झष्', 'जश्', 'हश्', 'खय्', 'खर्', 'चर्', 'शर्', 'शल्', 'झल्']


def pratyahara_members(name):
    first, it = name[0], name[1]
    seq, started = [], False
    for letters, end in SHIVA:
        for ch in letters:
            if ch == first:
                started = True
            if started:
                seq.append(ch)
        if started and end == it and len(seq) > 0:
            return set(seq)
    return set(seq)


PMEM = {p: pratyahara_members(p) for p in PRATYAHARAS}


def pratyaharas_of(ch):
    base = SAVARNA.get(ch, ch)
    return [p for p in PRATYAHARAS if base in PMEM[p]]


# --- places of articulation (Siddhanta Kaumudi on 1.1.9) --------------------------------------------
STHANA = {
    'कण्ठ': 'अआकखगघङह', 'तालु': 'इईचछजझञयश', 'मूर्धा': 'ऋॠटठडढणरष', 'दन्त': 'ऌॡतथदधनलस', 'ओष्ठ': 'उऊपफबभम',
    'कण्ठतालु': 'एऐ', 'कण्ठोष्ठ': 'ओऔ', 'दन्तोष्ठ': 'व',
}
STHANA_EN = {'कण्ठ': 'throat (velar/glottal)', 'तालु': 'palate', 'मूर्धा': 'roof (retroflex)', 'दन्त': 'teeth (dental)', 'ओष्ठ': 'lips (labial)',
             'कण्ठतालु': 'throat + palate', 'कण्ठोष्ठ': 'throat + lips', 'दन्तोष्ठ': 'teeth + lips', 'नासिका': 'nose'}
NASALS = 'ङञणनम'


def sthana_of(ch):
    for k, v in STHANA.items():
        if ch in v:
            return k
    return None


# --- the letters ------------------------------------------------------------------------------------
# char: (board, type, english name, hindi name, iast, ipa-for-audio, used-in, note, approx)
V, VS, C, NS, SG, D, P, SY = 'vowel', 'vowel sign', 'consonant', 'nasal sign', 'sign', 'digit', 'punctuation', 'symbol'
L = {}
def add(ch, board, typ, en, hi, iast, ipa, used='Sanskrit, Hindi and most Devanagari languages', note='', approx=False):
    L[ch] = dict(board=board, type=typ, name=en, hi=hi, iast=iast, ipa=ipa, used=used, note=note, approx=approx)

B_V, B_VS, B_SG = 'स्वर · Vowels', 'मात्रा · Vowel signs', 'अयोगवाह और चिह्न · Signs'
B_K, B_C, B_T, B_TA, B_P = 'कवर्ग · Velars', 'चवर्ग · Palatals', 'टवर्ग · Retroflexes', 'तवर्ग · Dentals', 'पवर्ग · Labials'
B_A, B_U, B_N, B_R, B_D, B_PU = 'अन्तःस्थ · Semivowels', 'ऊष्म · Sibilants and h', 'नुक्ता वर्ण · Nukta letters', 'क्षेत्रीय वर्ण · Regional letters', 'अंक · Digits', 'विराम और प्रतीक · Punctuation and symbols'

for ch, en, iast, ipa in [('अ', 'a', 'a', 'ə'), ('आ', 'aa', 'ā', 'aː'), ('इ', 'i', 'i', 'ɪ'), ('ई', 'ii', 'ī', 'iː'), ('उ', 'u', 'u', 'ʊ'), ('ऊ', 'uu', 'ū', 'uː'),
                          ('ए', 'e', 'e', 'eː'), ('ऐ', 'ai', 'ai', 'ɛː'), ('ओ', 'o', 'o', 'oː'), ('औ', 'au', 'au', 'ɔː')]:
    add(ch, B_V, V, f'Letter {en}', ch, iast, ipa)
add('ऋ', B_V, V, 'Vocalic r', 'ऋ', 'ṛ', 'ɾɪ', note='Sanskrit has a syllabic r; Hindi says "ri". The audio uses the Hindi sound.', approx=True)
add('ॠ', B_V, V, 'Vocalic rr (long)', 'ॠ', 'ṝ', 'ɾiː', used='Sanskrit', note='Long syllabic r, Sanskrit only; audio uses the Hindi-style "rii".', approx=True)
add('ऌ', B_V, V, 'Vocalic l', 'ऌ', 'ḷ', 'lɾɪ', used='Sanskrit (one root, कॢप्)', note='Syllabic l; recited "lri" in Hindi schools.', approx=True)
add('ॡ', B_V, V, 'Vocalic ll (long)', 'ॡ', 'ḹ', 'lɾiː', used='Sanskrit grammar only', note='Listed by grammarians; it occurs in no word.', approx=True)
add('ऎ', B_V, V, 'Short e', 'ऎ', 'ĕ', 'e', used='Transliterating Dravidian languages and Kashmiri', note='Short e, distinct from long ए in Dravidian languages.')
add('ऒ', B_V, V, 'Short o', 'ऒ', 'ŏ', 'o', used='Transliterating Dravidian languages', note='Short o, distinct from long ओ in Dravidian languages.')

for ch, base, en, iast, ipa in [('ा', 'आ', 'aa', 'ā', 'kaː'), ('ि', 'इ', 'i', 'i', 'kɪ'), ('ी', 'ई', 'ii', 'ī', 'kiː'), ('ु', 'उ', 'u', 'u', 'kʊ'), ('ू', 'ऊ', 'uu', 'ū', 'kuː'),
                                ('े', 'ए', 'e', 'e', 'keː'), ('ै', 'ऐ', 'ai', 'ai', 'kɛː'), ('ो', 'ओ', 'o', 'o', 'koː'), ('ौ', 'औ', 'au', 'au', 'kɔː')]:
    add(ch, B_VS, VS, f'Vowel sign {en}', f'{base} की मात्रा', iast, ipa, note=f'Shown on क; the sound is क + {base}.')
add('ृ', B_VS, VS, 'Vowel sign vocalic r', 'ऋ की मात्रा', 'ṛ', 'kɾɪ', note='Shown on क (कृ).', approx=True)
add('ॄ', B_VS, VS, 'Vowel sign vocalic rr', 'ॠ की मात्रा', 'ṝ', 'kɾiː', used='Sanskrit', note='Shown on क (कॄ).', approx=True)
add('ॢ', B_VS, VS, 'Vowel sign vocalic l', 'ऌ की मात्रा', 'ḷ', 'klɾɪ', used='Sanskrit (कॢप्)', note='Shown on क (कॢ).', approx=True)
add('ॣ', B_VS, VS, 'Vowel sign vocalic ll', 'ॡ की मात्रा', 'ḹ', 'klɾiː', used='Sanskrit grammar only', approx=True)
add('ॆ', B_VS, VS, 'Vowel sign short e', 'ऎ की मात्रा', 'ĕ', 'ke', used='Dravidian transliteration')
add('ॊ', B_VS, VS, 'Vowel sign short o', 'ऒ की मात्रा', 'ŏ', 'ko', used='Dravidian transliteration')
add('ॅ', B_VS, VS, 'Vowel sign candra e', 'चन्द्र ए', 'ê', 'kæ', used='English loanwords in Hindi and Marathi (बॅट)')
add('ॉ', B_VS, VS, 'Vowel sign candra o', 'चन्द्र ओ', 'ô', 'kɒ', used='English loanwords in Hindi and Marathi (डॉक्टर)')
add('ॎ', B_VS, VS, 'Prishthamatra e', 'पृष्ठमात्रा', 'e', 'keː', used='Old Devanagari manuscripts (e written before the consonant)')
add('ऺ', B_VS, VS, 'Vowel sign oe', 'ओए की मात्रा', 'ŏe', 'kɨ', used='Kashmiri', approx=True)
add('ऻ', B_VS, VS, 'Vowel sign ooe', 'दीर्घ ओए की मात्रा', 'ōe', 'kɨː', used='Kashmiri', approx=True)
add('ॖ', B_VS, VS, 'Vowel sign ue', 'उए की मात्रा', 'üe', 'kɨ', used='Kashmiri', approx=True)
add('ॗ', B_VS, VS, 'Vowel sign uue', 'दीर्घ उए की मात्रा', 'ǖe', 'kɨː', used='Kashmiri', approx=True)

add('ं', B_SG, NS, 'Anusvara', 'अनुस्वार', 'ṃ', 'əŋ', note='A nasal after a vowel, assimilated to the next consonant. Shown on अ (अं).')
add('ँ', B_SG, NS, 'Candrabindu', 'चन्द्रबिन्दु', 'm̐', 'ə̃', note='Nasalises the vowel. Shown on अ (अँ).')
add('ऀ', B_SG, NS, 'Inverted candrabindu', 'उल्टा चन्द्रबिन्दु', 'm̐', 'ə̃', used='Vedic manuscripts', note='Shown on अ.', approx=True)
add('ः', B_SG, SG, 'Visarga', 'विसर्ग', 'ḥ', 'əh', note='A breath after the vowel, echoing it in recitation. Shown on अ (अः).')
add('्', B_SG, SG, 'Virama (halant)', 'हलन्त', '—', 'k', note='Removes the inherent a. Shown on क (क्).')
add('़', B_SG, SG, 'Nukta', 'नुक्ता', '—', 'qə', used='Hindi and Urdu loan sounds; Punjabi; Sindhi', note='A dot that changes a consonant’s sound (क → क़). Heard here as क़.')
add('ऽ', B_SG, SG, 'Avagraha', 'अवग्रह', "'", '', note='Marks an elided a in Sanskrit sandhi (सोऽहम्). It has no sound of its own.')

VARGAS = [(B_K, 'कखगघङ', ['k', 'kʰ', 'ɡ', 'ɡʱ', 'ŋ'], ['ka', 'kha', 'ga', 'gha', 'ṅa']),
          (B_C, 'चछजझञ', ['ʧ', 'ʧʰ', 'ʤ', 'ʤʱ', 'ɲ'], ['ca', 'cha', 'ja', 'jha', 'ña']),
          (B_T, 'टठडढण', ['ʈ', 'ʈʰ', 'ɖ', 'ɖʱ', 'ɳ'], ['ṭa', 'ṭha', 'ḍa', 'ḍha', 'ṇa']),
          (B_TA, 'तथदधन', ['t', 'tʰ', 'd', 'dʱ', 'n'], ['ta', 'tha', 'da', 'dha', 'na']),
          (B_P, 'पफबभम', ['p', 'pʰ', 'b', 'bʱ', 'm'], ['pa', 'pha', 'ba', 'bha', 'ma'])]
for board, chars, ipas, iasts in VARGAS:
    for ch, ipa, iast in zip(chars, ipas, iasts):
        k_ipa = ipa.replace('ʱ', 'ʰ')  # Kokoro has no breathy-voice mark; ʰ is the closest
        add(ch, board, C, f'Letter {iast}', ch, iast, k_ipa + 'ə', approx=('ʱ' in ipa))
for ch, iast, ipa in [('य', 'ya', 'jə'), ('र', 'ra', 'ɾə'), ('ल', 'la', 'lə'), ('व', 'va', 'ʋə')]:
    add(ch, B_A, C, f'Letter {iast}', ch, iast, ipa)
for ch, iast, ipa in [('श', 'śa', 'ʃə'), ('ष', 'ṣa', 'ʂə'), ('स', 'sa', 'sə'), ('ह', 'ha', 'hə')]:
    add(ch, B_U, C, f'Letter {iast}', ch, iast, ipa, approx=False)
L['ष']['note'] = 'Sanskrit retroflex sibilant; most Hindi speakers say it like श.'

for ch, iast, ipa, used in [(chr(0x959), 'xa', 'xə', 'Hindi and Urdu loans from Persian and Arabic (ख़बर)'), (chr(0x95A), 'ġa', 'ɣə', 'Hindi and Urdu loans (ग़ज़ल)'),
                            (chr(0x95B), 'za', 'zə', 'Hindi and Urdu loans (ज़मीन); English loans'), (chr(0x95C), 'ṛa', 'ɽə', 'Hindi, Punjabi (सड़क)'),
                            (chr(0x95D), 'ṛha', 'ɽʰə', 'Hindi, Punjabi (पढ़ना)'), (chr(0x95E), 'fa', 'fə', 'Hindi and Urdu loans (फ़िल्म)'), (chr(0x95F), 'ẏa', 'jə', 'Bengali and Odia transliteration')]:
    add(ch, B_N, C, f'Letter {iast}', ch, iast, ipa, used=used, approx=(ch == chr(0x95F)))
for ch, en, iast, ipa, used, approx in [('ळ', 'lla', 'ḷa', 'ɭə', 'Vedic Sanskrit, Marathi, Konkani, Rajasthani; Dravidian languages', True),
                                        ('ऴ', 'llla', 'ḻa', 'ɻə', 'Transliterating Tamil and Malayalam ழ', False),
                                        ('ऱ', 'rra', 'ṟa', 'rə', 'Marathi (eyelash ra), Dravidian transliteration', False),
                                        ('ऩ', 'nnna', 'ṉa', 'nə', 'Transliterating Tamil ன', True),
                                        ('ॹ', 'zha', 'zha', 'ʒə', 'Transliterating Avestan and other languages', False),
                                        ('ॻ', 'gga', 'ɠa', 'ɡə', 'Sindhi (implosive g)', True), ('ॼ', 'jja', 'ʄa', 'ɟə', 'Sindhi (implosive j)', True),
                                        ('ॾ', 'ddda', 'ɗa', 'ɖə', 'Sindhi (implosive d)', True), ('ॿ', 'bba', 'ɓa', 'bə', 'Sindhi (implosive b)', True)]:
    add(ch, B_R, C, f'Letter {en}', ch, iast, ipa, used=used, approx=approx)
L['ळ']['ipa'] = 'ɽə'
L['ळ']['note'] = 'Retroflex lateral. The audio voice has no exact sound for it and uses ड़ instead.'

for i, (ch, word, ipa) in enumerate(zip('०१२३४५६७८९', ['शून्य', 'एक', 'दो', 'तीन', 'चार', 'पाँच', 'छह', 'सात', 'आठ', 'नौ'],
                                       ['ʃuːnjə', 'eːk', 'doː', 'tiːn', 'ʧaːɾ', 'pa\u0303ːʧ', 'ʧʰeː', 'saːt', 'aːʈʰ', 'nɔː'])):
    add(ch, B_D, D, f'Digit {i}', word, str(i), ipa, note=f'Read in Hindi as {word}.')
add('।', B_PU, P, 'Danda', 'पूर्ण विराम', '|', '', note='Full stop. No sound.')
add('॥', B_PU, P, 'Double danda', 'दोहरा दण्ड', '||', '', note='Ends a verse or section. No sound.')
add('॰', B_PU, P, 'Abbreviation sign', 'लाघव चिह्न', '°', '', note='Marks an abbreviation (डॉ॰). No sound.')
add('ॐ', B_PU, SY, 'Om', 'ओम्', 'oṃ', 'oːm', used='Sacred syllable in Hindu, Buddhist and Jain traditions')

BOARDS = [B_V, B_VS, B_K, B_C, B_T, B_TA, B_P, B_A, B_U, B_SG, B_N, B_R, B_D, B_PU]
SAMPLE_BASE = {VS: 'क', NS: 'अ'}


def sample(ch, rec):
    if rec['type'] in SAMPLE_BASE:
        return SAMPLE_BASE[rec['type']] + ch
    if ch == 'ः':
        return 'अः'
    if ch in ('्', '़'):
        return 'क' + ch
    return ch


def grammar(ch, rec):
    g = {}
    if rec['type'] in (V, VS):
        vowel = ch if rec['type'] == V else {'ा': 'आ', 'ि': 'इ', 'ी': 'ई', 'ु': 'उ', 'ू': 'ऊ', 'ृ': 'ऋ', 'ॄ': 'ॠ', 'ॢ': 'ऌ', 'ॣ': 'ॡ', 'े': 'ए', 'ै': 'ऐ', 'ो': 'ओ', 'ौ': 'औ'}.get(ch)
        if vowel:
            s = sthana_of(vowel)
            if s: g['sthana'] = s
            g['length'] = 'दीर्घ · long' if vowel in 'आईऊॠॡएऐओऔ' else 'ह्रस्व · short'
            if vowel in 'एऐओऔ': g['length'] = 'दीर्घ · long (diphthong in Sanskrit: ऐ औ)' if vowel in 'ऐऔ' else 'दीर्घ · long (always long in Sanskrit)'
            g['prayatna'] = 'विवृत · open'
            g['voicing'] = 'घोष · voiced'
            g['pratyahara'] = pratyaharas_of(vowel)
    elif rec['type'] == C and ch in ''.join(c for _, c, _, _ in VARGAS) + 'यरलवशषसह':
        s = sthana_of(ch)
        if s: g['sthana'] = s + (' + नासिका' if ch in NASALS else '')
        if ch in 'यरलव': g['prayatna'] = 'ईषत्स्पृष्ट · slight contact'
        elif ch in 'शषसह': g['prayatna'] = 'विवृत · open (friction)'
        else: g['prayatna'] = 'स्पृष्ट · full contact (stop)'
        pr = pratyaharas_of(ch)
        g['voicing'] = 'घोष · voiced' if 'हश्' in pr else 'अघोष · voiceless'
        g['aspiration'] = 'महाप्राण · aspirated' if (ch in 'खघछझठढथधफभ' or ch in 'शषसह') else 'अल्पप्राण · unaspirated'
        if ch in NASALS: g['nasal'] = 'अनुनासिक · nasal'
        g['pratyahara'] = pr
    elif ch == 'ं':
        g['sthana'] = 'नासिका'
    elif ch == 'ः':
        g['sthana'] = 'कण्ठ'
    return g


def build():
    out = []
    order = {b: i for i, b in enumerate(BOARDS)}
    pos = {c: i for i, c in enumerate(L)}  # traditional order, as the records are written above
    for i, c in enumerate('अआइईउऊऋॠऌॡएऐओऔऎऒ' + 'ािीुूृॄॢॣेैोौॆॊॅॉॎऺऻॖॗ'):
        pos[c] = i - 100  # varnamala order for vowels and their signs
    keys = sorted({k for s in SCRIPTS['scripts'].values() for k in s['map']}, key=lambda c: (order.get(L.get(c, {}).get('board'), 99), pos.get(c, 999)))
    missing = [k for k in keys if k not in L]
    if missing:
        raise SystemExit('No letter record for: ' + ' '.join(f'{k} U+{ord(k):04X}' for k in missing))
    for ch in keys:
        rec = dict(L[ch])
        cp = ' '.join(f'U+{ord(c):04X}' for c in ch)
        writes = [c for c, s in SCRIPTS['scripts'].items() if ch in s['map']]
        lacks = [c for c in SCRIPTS['scripts'] if c not in writes]
        g = grammar(ch, rec)
        if 'sthana' in g:
            base = g['sthana'].split(' + ')[0]
            g['sthanaEn'] = STHANA_EN.get(base, '') + (' + nose' if ' + नासिका' in g['sthana'] else '')
        sound = None if not rec['ipa'] else f'/lipi-sounds/u{ord(ch):04x}.mp3'
        out.append({
            'char': ch, 'codepoint': cp, 'sample': sample(ch, rec), 'board': rec['board'], 'type': rec['type'],
            'name': rec['name'], 'hi': rec['hi'], 'iast': rec['iast'], 'unicodeName': unicodedata.name(ch).title(),
            'grammar': g, 'sound': {'file': sound, 'ipa': rec['ipa'] or None, 'approx': bool(rec['approx']) if rec['ipa'] else False},
            'used': rec['used'], 'note': rec['note'],
            'scripts': {'writes': writes, 'lacks': lacks},
            'resources': [
                {'label': f'{cp} on Compart', 'url': f'https://www.compart.com/en/unicode/{cp.split()[0]}'},
                {'label': 'Unicode Devanagari chart (PDF)', 'url': 'https://www.unicode.org/charts/PDF/U0900.pdf'},
            ] + ([{'label': 'Ashtadhyayi 1.1.9 तुल्यास्यप्रयत्नं सवर्णम् (place and effort)', 'sutra': '1.1.9'}] if 'sthana' in g else [])
              + ([{'label': 'Maheshvara sutras (pratyaharas)', 'sutra': '1.1.71'}] if g.get('pratyahara') else []),
        })
    return {
        'format': 'maataa.lipi-letters.v1',
        'boards': BOARDS,
        'regions': REGION,
        'sources': {
            'grammar': 'Places and efforts as Siddhanta Kaumudi states them under Ashtadhyayi 1.1.9 (अकुहविसर्जनीयानां कण्ठः …); pratyaharas computed from the 14 Maheshvara sutras.',
            'sound': 'Rendered offline with Kokoro-82M (Apache-2.0), Hindi voice hf_alpha, from the IPA shown. Hindi pronunciation; marked approximate where the voice lacks the exact sound.',
            'scripts': 'Lipi OS tables, ' + SCRIPTS['source'],
        },
        'letters': out,
    }


if __name__ == '__main__':
    data = build()
    path = os.path.join(ROOT, 'lib', 'lipi-letters.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')
    n = len(data['letters'])
    print(f'{n} letters on {len(data["boards"])} boards; {sum(1 for l in data["letters"] if l["sound"]["file"])} with sound')
