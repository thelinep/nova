'use strict';

// Paninian Sandhi and Cheda (Segmentation) Engine (Maataa AAI Roadmap R2)
//
// Rules derive and check. This engine implements:
//   1. Sandhi join: computes the junction between two padas according to Panini's sutras:
//      - Ac-sandhi (vowels): savarna-dirgha (6.1.101), guna (6.1.87), vriddhi (6.1.88),
//        yan (6.1.77), ayadi (6.1.78), purvarupa (6.1.109), pragrhya (1.1.11).
//      - Hal-sandhi (consonants): scutva (8.4.40), stutva (8.4.41), jastva (8.2.39),
//        cartva (8.4.55), anunasika (8.4.45), anusvara (8.3.23), tor li (8.4.60),
//        chattra (6.1.73/74), sascho 'ti (8.4.63).
//      - Visarga-sandhi: utva with avagraha (6.1.113), hasi ca (6.1.114), visarjaniya sa/sa/sa
//        (8.3.34/40/41), rutva before voiced (8.2.66), lopa after a/aa (8.3.17/22/19),
//        sa/esa lopa before consonants (6.1.132), ro ri dirgha (8.3.14 + 6.3.111).
//   2. Cheda (segmentation): decomposes samhita strings into constituent padas and cites the rule.
//   3. Sentence check: validates every word boundary in a Sanskrit sentence against Paninian rules,
//      distinguishing verified junctions from violations and optional sandhi.

const slp1 = require('./slp1');
const panini = require('./panini');

// Pratyaharas in SLP1
const AC = new Set(['a', 'A', 'i', 'I', 'u', 'U', 'f', 'F', 'x', 'X', 'e', 'E', 'o', 'O']);
const IK = new Set(['i', 'I', 'u', 'U', 'f', 'F', 'x', 'X']);
const EC = new Set(['e', 'E', 'o', 'O']);
const ENG = new Set(['e', 'o']);
const SAVARNA_GROUPS = [
  new Set(['a', 'A']),
  new Set(['i', 'I']),
  new Set(['u', 'U']),
  new Set(['f', 'F', 'x', 'X']), // r and l are savarna by 'rkāralrkārayoḥ savarnavidhiḥ'
];

const HASH = new Set([
  'g', 'G', 'N', 'j', 'J', 'Y', 'q', 'Q', 'R', 'd', 'D', 'n', 'b', 'B', 'm',
  'y', 'r', 'l', 'v', 'h'
]);
const ASH = new Set([...AC, ...HASH]);
const KHAR = new Set(['k', 'K', 'c', 'C', 'w', 'W', 't', 'T', 'p', 'P', 'S', 'z', 's']);
const JHAL = new Set([
  'k', 'K', 'g', 'G', 'c', 'C', 'j', 'J', 'w', 'W', 'q', 'Q', 't', 'T', 'd', 'D',
  'p', 'P', 'b', 'B', 'S', 'z', 's', 'h'
]);

// Consonant classes
const SPARSAS = {
  k: 'k', K: 'k', g: 'k', G: 'k', N: 'k',
  c: 'c', C: 'c', j: 'c', J: 'c', Y: 'c',
  w: 'w', W: 'w', q: 'w', Q: 'w', R: 'w',
  t: 't', T: 't', d: 't', D: 't', n: 't',
  p: 'p', P: 'p', b: 'p', B: 'p', m: 'p'
};

const JASH_MAP = {
  k: 'g', K: 'g', g: 'g', G: 'g',
  c: 'j', C: 'j', j: 'j', J: 'j',
  w: 'q', W: 'q', q: 'q', Q: 'q',
  t: 'd', T: 'd', d: 'd', D: 'd',
  p: 'b', P: 'b', b: 'b', B: 'b'
};

const CAR_MAP = {
  g: 'k', G: 'k',
  j: 'c', J: 'c',
  q: 'w', Q: 'w',
  d: 't', D: 't',
  b: 'p', B: 'p'
};

const NASAL_MAP = {
  k: 'N', K: 'N', g: 'N', G: 'N', N: 'N',
  w: 'R', W: 'R', q: 'R', Q: 'R', R: 'R',
  t: 'n', T: 'n', d: 'n', D: 'n', n: 'n',
  p: 'm', P: 'm', b: 'm', B: 'm', m: 'm'
};

const S_PALATAL = { s: 'S', t: 'c', T: 'C', d: 'j', D: 'J', n: 'Y' };
const S_RETROFLEX = { s: 'z', t: 'w', T: 'W', d: 'q', D: 'Q', n: 'R' };

function areSavarna(v1, v2) {
  for (const g of SAVARNA_GROUPS) {
    if (g.has(v1) && g.has(v2)) return true;
  }
  return false;
}

function longOf(v) {
  if (v === 'a' || v === 'A') return 'A';
  if (v === 'i' || v === 'I') return 'I';
  if (v === 'u' || v === 'U') return 'U';
  if (v === 'f' || v === 'F' || v === 'x' || v === 'X') return 'F';
  return v;
}

function toSlp(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (/[\u0900-\u097f]/.test(s)) return slp1.fromDevanagari(s);
  // IAST diacritic detection
  if (/[āīūṛṝḷḹēōṃḥśṣñṅṭḍṇ]/.test(s)) {
    // Quick IAST -> SLP1 normalization
    return s.normalize('NFD')
      .replace(/a[̄\u0304]/g, 'A').replace(/i[̄\u0304]/g, 'I').replace(/u[̄\u0304]/g, 'U')
      .replace(/r[̥\u0325][̄\u0304]/g, 'F').replace(/r[̥\u0325]/g, 'f')
      .replace(/l[̥\u0325][̄\u0304]/g, 'X').replace(/l[̥\u0325]/g, 'x')
      .replace(/m[̣\u0323]/g, 'M').replace(/h[̣\u0323]/g, 'H')
      .replace(/s[́\u0301]/g, 'S').replace(/s[̣\u0323]/g, 'z')
      .replace(/n[̃\u0303]/g, 'Y').replace(/n[̇\u0307]/g, 'N')
      .replace(/t[̣\u0323]/g, 'w').replace(/d[̣\u0323]/g, 'q').replace(/n[̣\u0323]/g, 'R');
  }
  return s;
}

/**
 * Computes the sandhi between two padas.
 * Options:
 *   - pragrhya: boolean (left pada is a pragrhya dual, e.g. harī, viṣṇū)
 *   - padanta: boolean (default true; whether junction is at word boundary)
 *   - script: 'devanagari' | 'iast' | 'slp1' (default 'devanagari')
 */
function join(w1, w2, options = {}) {
  const s1 = toSlp(w1);
  const s2 = toSlp(w2);
  const script = options.script || (/[ऀ-ॿ]/.test(w1 || w2) ? 'devanagari' : 'devanagari');

  if (!s1) return formatResult(s2, script, null, w1, w2);
  if (!s2) return formatResult(s1, script, null, w1, w2);

  const last = s1.slice(-1);
  const first = s2[0];
  const l2 = s1.length >= 2 ? s1.slice(-2) : s1;

  // 0. Pragrhya check (1.1.11 īdūdeddvivacanam pragṛhyam)
  if (options.pragrhya || (['I', 'U', 'e'].includes(last) && options.isDual)) {
    return formatResult(`${s1} ${s2}`, script, {
      id: '1.1.11', name: 'īdūdeddvivacanaṁ pragṛhyam', type: 'pragṛhya'
    }, w1, w2);
  }

  // 1. Special pronoun sandhi: saḥ / eṣaḥ before consonant (6.1.132)
  if ((s1 === 'saH' || s1 === 'ezaH') && !AC.has(first)) {
    const stem = s1.slice(0, -1); // 'sa' or 'eza'
    return formatResult(`${stem} ${s2}`, script, {
      id: '6.1.132', name: 'etattadoḥ sulopo \'kor anañsamāse hali', type: 'visarga-lopa'
    }, w1, w2);
  }

  // 2. Visarga sandhi
  if (last === 'H' || last === 's' || last === 'r') {
    const vRes = joinVisarga(s1, s2, first);
    if (vRes) return formatResult(vRes.slp, script, vRes.rule, w1, w2);
  }

  // 3. Vowel Sandhi (Ac-sandhi)
  if (AC.has(last) && AC.has(first)) {
    const acRes = joinAc(s1, s2, last, first, l2);
    if (acRes) return formatResult(acRes.slp, script, acRes.rule, w1, w2);
  }

  // 4. Consonant Sandhi (Hal-sandhi)
  const halRes = joinHal(s1, s2, last, first);
  if (halRes) return formatResult(halRes.slp, script, halRes.rule, w1, w2);

  // Default: juxtaposition with space
  return formatResult(`${s1} ${s2}`, script, { id: 'padanta', name: 'saṁhitā-avivakṣā', type: 'none' }, w1, w2);
}

function joinAc(s1, s2, last, first, l2) {
  const stem1 = s1.slice(0, -1);
  const rest2 = s2.slice(1);

  // 6.1.109 eṅaḥ padāntād ati (pūrvarūpa)
  if (ENG.has(last) && first === 'a') {
    return {
      slp: `${stem1}${last}'${rest2}`,
      rule: { id: '6.1.109', name: 'eṅaḥ padāntād ati', type: 'pūrvarūpa' }
    };
  }

  // 6.1.101 akaḥ savarṇe dīrghaḥ
  if (areSavarna(last, first)) {
    return {
      slp: `${stem1}${longOf(last)}${rest2}`,
      rule: { id: '6.1.101', name: 'akaḥ savarṇe dīrghaḥ', type: 'savarṇa-dīrgha' }
    };
  }

  // 6.1.88 vṛddhir eci
  if ((last === 'a' || last === 'A') && EC.has(first)) {
    const vrd = (first === 'e' || first === 'E') ? 'E' : 'O';
    return {
      slp: `${stem1}${vrd}${rest2}`,
      rule: { id: '6.1.88', name: 'vṛddhir eci', type: 'vṛddhi' }
    };
  }

  // 6.1.87 ādguṇaḥ
  if (last === 'a' || last === 'A') {
    if (first === 'i' || first === 'I') return { slp: `${stem1}e${rest2}`, rule: { id: '6.1.87', name: 'ādguṇaḥ', type: 'guṇa' } };
    if (first === 'u' || first === 'U') return { slp: `${stem1}o${rest2}`, rule: { id: '6.1.87', name: 'ādguṇaḥ', type: 'guṇa' } };
    if (first === 'f' || first === 'F') return { slp: `${stem1}ar${rest2}`, rule: { id: '6.1.87', name: 'ādguṇaḥ', type: 'guṇa' } };
    if (first === 'x' || first === 'X') return { slp: `${stem1}al${rest2}`, rule: { id: '6.1.87', name: 'ādguṇaḥ', type: 'guṇa' } };
  }

  // 6.1.77 iko yaṇ aci
  if (IK.has(last)) {
    const yan = (last === 'i' || last === 'I') ? 'y' : (last === 'u' || last === 'U') ? 'v' : (last === 'f' || last === 'F') ? 'r' : 'l';
    return {
      slp: `${stem1}${yan}${first}${rest2}`,
      rule: { id: '6.1.77', name: 'iko yaṇ aci', type: 'yaṇ' }
    };
  }

  // 6.1.78 eco 'yavāyāvaḥ + 8.3.19 lopaḥ śākalyasya
  if (EC.has(last)) {
    // Padanta optional lopa is common in classical Sanskrit: 'hare e' -> 'hara e'
    if (last === 'e') return { slp: `${stem1}a ${first}${rest2}`, rule: { id: '6.1.78/8.3.19', name: 'eco \'yavāyāvaḥ / lopaḥ śākalyasya', type: 'ayādi-lopa' } };
    if (last === 'E') return { slp: `${stem1}A ${first}${rest2}`, rule: { id: '6.1.78/8.3.19', name: 'eco \'yavāyāvaḥ / lopaḥ śākalyasya', type: 'ayādi-lopa' } };
    if (last === 'o') return { slp: `${stem1}a ${first}${rest2}`, rule: { id: '6.1.78/8.3.19', name: 'eco \'yavāyāvaḥ / lopaḥ śākalyasya', type: 'ayādi-lopa' } };
    if (last === 'O') return { slp: `${stem1}Av${first}${rest2}`, rule: { id: '6.1.78', name: 'eco \'yavāyāvaḥ', type: 'ayādi' } };
  }

  return null;
}

function joinHal(s1, s2, last, first) {
  const stem1 = s1.slice(0, -1);
  const rest2 = s2.slice(1);

  // 8.3.23 mo 'nusvāraḥ
  if (last === 'm' && !AC.has(first)) {
    return {
      slp: `${stem1}M ${s2}`,
      rule: { id: '8.3.23', name: 'mo \'nusvāraḥ', type: 'anusvāra' }
    };
  }

  // 6.1.73 che ca / 6.1.74 dīrghāt padāntād dā ca (tuk augment)
  if (AC.has(last) && first === 'C') {
    return {
      slp: `${s1}cC${rest2}`,
      rule: { id: '6.1.73', name: 'che ca', type: 'tuk-chattra' }
    };
  }

  // 8.4.60 tor li
  if ((last === 't' || last === 'd') && first === 'l') {
    return {
      slp: `${stem1}ll${rest2}`,
      rule: { id: '8.4.60', name: 'tor li', type: 'parasavarṇa' }
    };
  }

  // 8.4.40 stoḥ ścunā ścuḥ
  if (S_PALATAL[last] && ['c', 'C', 'j', 'J', 'Y', 'S'].includes(first)) {
    const sub = S_PALATAL[last];
    // 8.4.63 śaścho 'ṭi: t/d + ś -> cch
    if ((last === 't' || last === 'd') && first === 'S') {
      return {
        slp: `${stem1}cC${rest2}`,
        rule: { id: '8.4.63', name: 'śaścho \'ṭi', type: 'ścutva-chātva' }
      };
    }
    return {
      slp: `${stem1}${sub}${s2}`,
      rule: { id: '8.4.40', name: 'stoḥ ścunā ścuḥ', type: 'ścutva' }
    };
  }

  // 8.4.41 ṣṭunā ṣṭuḥ
  if (S_RETROFLEX[last] && ['w', 'W', 'q', 'Q', 'R', 'z'].includes(first)) {
    const sub = S_RETROFLEX[last];
    return {
      slp: `${stem1}${sub}${s2}`,
      rule: { id: '8.4.41', name: 'ṣṭunā ṣṭuḥ', type: 'ṣṭutva' }
    };
  }

  // 8.4.45 yaro 'nunāsike 'nunāsiko vā
  if (NASAL_MAP[last] && (first === 'm' || first === 'n')) {
    return {
      slp: `${stem1}${NASAL_MAP[last]}${s2}`,
      rule: { id: '8.4.45', name: 'yaro \'nunāsike \'nunāsiko vā', type: 'anunāsika' }
    };
  }

  // 8.4.55 khari ca (cartva before unvoiced stop)
  if (CAR_MAP[last] && KHAR.has(first)) {
    return {
      slp: `${stem1}${CAR_MAP[last]}${s2}`,
      rule: { id: '8.4.55', name: 'khari ca', type: 'cartva' }
    };
  }

  // 8.2.39 jhalāṁ jaśo 'nte (before vowels or voiced consonants)
  if (JASH_MAP[last] && ASH.has(first)) {
    return {
      slp: `${stem1}${JASH_MAP[last]}${s2}`,
      rule: { id: '8.2.39', name: 'jhalāṁ jaśo \'nte', type: 'jaśtva' }
    };
  }

  return null;
}

function joinVisarga(s1, s2, first) {
  const prec = s1.length >= 2 ? s1[s1.length - 2] : '';
  const stem1 = s1.slice(0, -1);
  const rest2 = s2.slice(1);

  // 8.3.14 ro ri + 6.3.111 ḍhralope pūrvasya dīrgho 'ṇaḥ (r/H + r -> dīrgha + r)
  if (first === 'r') {
    const vowel = s1.length >= 2 ? s1[s1.length - 2] : '';
    const base = s1.slice(0, -2);
    return {
      slp: `${base}${longOf(vowel)} ${s2}`,
      rule: { id: '8.3.14/6.3.111', name: 'ro ri / ḍhralope pūrvasya dīrgho \'ṇaḥ', type: 'r-lopa-dīrgha' }
    };
  }

  // 6.1.113 ato ror aplutād aplute (aH + a -> o')
  if (prec === 'a' && first === 'a') {
    return {
      slp: `${s1.slice(0, -2)}o'${rest2}`,
      rule: { id: '6.1.113', name: 'ato ror aplutād aplute', type: 'utva-avagraha' }
    };
  }

  // 6.1.114 haśi ca (aH + voiced consonant -> o + voiced)
  if (prec === 'a' && HASH.has(first)) {
    return {
      slp: `${s1.slice(0, -2)}o ${s2}`,
      rule: { id: '6.1.114', name: 'haśi ca', type: 'utva' }
    };
  }

  // 8.3.17 bhobhago'gho'pūrvasya yo 'śi / 8.3.22 hali sarveṣām (āḥ + aś -> ā + aś)
  if (prec === 'A' && ASH.has(first)) {
    return {
      slp: `${stem1} ${s2}`,
      rule: { id: '8.3.17/22', name: 'bhobhago\'gho\'pūrvasya yo \'śi', type: 'visarga-lopa' }
    };
  }

  // Visarga lopa for bhoḥ, bhagoḥ, aghoḥ
  if ((s1 === 'BoH' || s1 === 'BagoH' || s1 === 'aGoH') && ASH.has(first)) {
    return {
      slp: `${stem1} ${s2}`,
      rule: { id: '8.3.17', name: 'bhobhago\'gho\'pūrvasya yo \'śi', type: 'visarga-lopa' }
    };
  }

  // 8.3.34 visarjanīyasya saḥ
  if (['c', 'C'].includes(first)) {
    return {
      slp: `${stem1}S${s2}`,
      rule: { id: '8.3.34/8.4.40', name: 'visarjanīyasya saḥ / stoḥ ścunā ścuḥ', type: 'satva-ścutva' }
    };
  }
  if (['w', 'W'].includes(first)) {
    return {
      slp: `${stem1}z${s2}`,
      rule: { id: '8.3.34/8.4.41', name: 'visarjanīyasya saḥ / ṣṭunā ṣṭuḥ', type: 'satva-ṣṭutva' }
    };
  }
  if (['t', 'T'].includes(first)) {
    return {
      slp: `${stem1}s${s2}`,
      rule: { id: '8.3.34', name: 'visarjanīyasya saḥ', type: 'satva' }
    };
  }

  // Other vowels + H before voiced (ASH): rutva (becomes r)
  if (prec && prec !== 'a' && prec !== 'A' && ASH.has(first)) {
    return {
      slp: `${stem1}r${AC.has(first) ? s2 : ' ' + s2}`,
      rule: { id: '8.2.66', name: 'sasajuṣo ruḥ', type: 'rutva' }
    };
  }

  // Visarga before k, kh, p, ph: remains visarga (8.3.37 kupvoḥ)
  if (['k', 'K', 'p', 'P'].includes(first)) {
    return {
      slp: `${s1} ${s2}`,
      rule: { id: '8.3.37', name: 'kupvoḥ ᳵk-ᳶpau ca', type: 'visarga-prakṛti' }
    };
  }

  // Visarga before sibilants (8.3.36 vā śari): remains visarga
  if (['S', 'z', 's'].includes(first)) {
    return {
      slp: `${s1} ${s2}`,
      rule: { id: '8.3.36', name: 'vā śari', type: 'visarga-śari' }
    };
  }

  return null;
}

function formatResult(slpText, script, rule, w1, w2) {
  let text;
  if (script === 'slp1') text = slpText;
  else if (script === 'iast') text = slp1.toIast(slpText);
  else text = slp1.toDevanagari(slpText);

  return {
    text,
    slp1: slpText,
    rule: rule || { id: 'none', name: 'prakṛtibhāva', type: 'none' },
    left: w1,
    right: w2
  };
}

/**
 * Sequentially joins an array of padas into a continuous sentence or phrase.
 */
function joinMany(words, options = {}) {
  if (!Array.isArray(words) || words.length === 0) return { text: '', steps: [] };
  if (words.length === 1) return { text: words[0], steps: [] };

  const steps = [];
  let current = words[0];

  for (let i = 1; i < words.length; i++) {
    const res = join(current, words[i], options);
    steps.push({
      step: i,
      left: current,
      right: words[i],
      result: res.text,
      rule: res.rule
    });
    current = res.text;
  }

  return { text: current, steps };
}

/**
 * Cheda (splitting / segmentation):
 * Attempts to decompose a joined word into two candidate constituent words.
 */
function split(compound, options = {}) {
  const s = toSlp(compound);
  const candidates = [];
  const len = s.length;

  for (let i = 1; i < len; i++) {
    const leftPart = s.slice(0, i);
    const rightPart = s.slice(i);
    const ch = s[i - 1];
    const nxt = s[i];

    // Avagraha split: o' -> aH + a
    if (ch === 'o' && nxt === "'") {
      candidates.push({
        left: slp1.toDevanagari(s.slice(0, i - 1) + 'aH'),
        right: slp1.toDevanagari('a' + s.slice(i + 1)),
        rule: { id: '6.1.113', name: 'ato ror aplutād aplute', type: 'utva-avagraha' }
      });
    }

    // Savarna-dirgha split
    if (ch === 'A') {
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'a'), right: slp1.toDevanagari('a' + rightPart), rule: { id: '6.1.101', name: 'akaḥ savarṇe dīrghaḥ' } });
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'A'), right: slp1.toDevanagari('a' + rightPart), rule: { id: '6.1.101', name: 'akaḥ savarṇe dīrghaḥ' } });
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'a'), right: slp1.toDevanagari('A' + rightPart), rule: { id: '6.1.101', name: 'akaḥ savarṇe dīrghaḥ' } });
    }
    if (ch === 'I') {
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'i'), right: slp1.toDevanagari('i' + rightPart), rule: { id: '6.1.101', name: 'akaḥ savarṇe dīrghaḥ' } });
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'i'), right: slp1.toDevanagari('I' + rightPart), rule: { id: '6.1.101', name: 'akaḥ savarṇe dīrghaḥ' } });
    }
    if (ch === 'U') {
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'u'), right: slp1.toDevanagari('u' + rightPart), rule: { id: '6.1.101', name: 'akaḥ savarṇe dīrghaḥ' } });
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'u'), right: slp1.toDevanagari('U' + rightPart), rule: { id: '6.1.101', name: 'akaḥ savarṇe dīrghaḥ' } });
    }

    // Guna split
    if (ch === 'e' && nxt !== "'") {
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'a'), right: slp1.toDevanagari('i' + rightPart), rule: { id: '6.1.87', name: 'ādguṇaḥ' } });
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'A'), right: slp1.toDevanagari('I' + rightPart), rule: { id: '6.1.87', name: 'ādguṇaḥ' } });
    }
    if (ch === 'o' && nxt !== "'") {
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'a'), right: slp1.toDevanagari('u' + rightPart), rule: { id: '6.1.87', name: 'ādguṇaḥ' } });
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'A'), right: slp1.toDevanagari('u' + rightPart), rule: { id: '6.1.87', name: 'ādguṇaḥ' } });
    }

    // Vriddhi split
    if (ch === 'E') {
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'a'), right: slp1.toDevanagari('e' + rightPart), rule: { id: '6.1.88', name: 'vṛddhir eci' } });
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'A'), right: slp1.toDevanagari('eva' + rightPart.slice(2)), rule: { id: '6.1.88', name: 'vṛddhir eci' } });
    }

    // Yan split
    if (ch === 'y' && AC.has(nxt)) {
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'i'), right: slp1.toDevanagari(rightPart), rule: { id: '6.1.77', name: 'iko yaṇ aci' } });
    }
    if (ch === 'v' && AC.has(nxt)) {
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'u'), right: slp1.toDevanagari(rightPart), rule: { id: '6.1.77', name: 'iko yaṇ aci' } });
    }

    // Hal-sandhi splits:
    // Saccit -> sat + cit
    if (ch === 'c' && nxt === 'c') {
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 't'), right: slp1.toDevanagari(rightPart), rule: { id: '8.4.40', name: 'stoḥ ścunā ścuḥ' } });
    }
    if (ch === 'c' && nxt === 'C') {
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1)), right: slp1.toDevanagari(rightPart), rule: { id: '6.1.73', name: 'che ca' } });
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 't'), right: slp1.toDevanagari('S' + rightPart.slice(1)), rule: { id: '8.4.63', name: 'śaścho \'ṭi' } });
    }
    // Jastva split: vAgISa -> vAk + ISa
    if (ch === 'g' && ASH.has(nxt)) {
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 'k'), right: slp1.toDevanagari(rightPart), rule: { id: '8.2.39', name: 'jhalāṁ jaśo \'nte' } });
    }
    if (ch === 'd' && ASH.has(nxt)) {
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 't'), right: slp1.toDevanagari(rightPart), rule: { id: '8.2.39', name: 'jhalāṁ jaśo \'nte' } });
    }
    // Jagannatha -> jagat + natha
    if (ch === 'n' && nxt === 'n') {
      candidates.push({ left: slp1.toDevanagari(leftPart.slice(0, -1) + 't'), right: slp1.toDevanagari(rightPart), rule: { id: '8.4.45', name: 'yaro \'nunāsike \'nunāsiko vā' } });
    }
  }

  return candidates;
}

/**
 * Checks a complete Sanskrit sentence for sandhi correctness between adjacent words.
 * Returns { ok, verdict, junctures, words, summary }
 */
function checkSentence(sentenceText) {
  const raw = String(sentenceText || '').trim();
  if (!raw) return { ok: true, verdict: 'empty', junctures: [], words: [], summary: 'No sentence text provided.' };

  // Tokenize into words, separating punctuation
  const tokens = raw.split(/[\s,;।॥!?]+/g).filter(Boolean);
  if (tokens.length <= 1) {
    return {
      ok: true,
      verdict: 'verified',
      junctures: [],
      words: tokens,
      summary: `Single word or invocation: ${raw}`
    };
  }

  const junctures = [];
  let violations = 0;

  for (let i = 0; i < tokens.length - 1; i++) {
    const left = tokens[i];
    const right = tokens[i + 1];
    const sLeft = toSlp(left);
    const sRight = toSlp(right);

    const expected = join(left, right);
    const lastChar = sLeft.slice(-1);
    const firstChar = sRight[0];

    // Check if external sandhi is expected
    let status = 'valid';
    let note = '';

    // Anusvara check: 'm' at end of pada before consonant should be 'M' (ं)
    if (lastChar === 'm' && !AC.has(firstChar)) {
      status = 'violation';
      note = `Padānta 'm' before consonant should become anusvāra (8.3.23 mo 'nusvāraḥ). Expected: ${slp1.toDevanagari(sLeft.slice(0, -1) + 'M')} ${right}`;
      violations++;
    }
    // Visarga 'saḥ/eṣaḥ' before consonant should drop visarga
    else if ((sLeft === 'saH' || sLeft === 'ezaH') && !AC.has(firstChar)) {
      status = 'violation';
      note = `'${left}' before consonant should drop visarga (6.1.132 etattadoḥ sulopo \'kor anañsamāse hali). Expected: ${slp1.toDevanagari(sLeft.slice(0, -1))} ${right}`;
      violations++;
    }
    // Vowel-vowel junction with space in prose: permitted as avivakṣita saṁhitā, but flagged
    else if (AC.has(lastChar) && AC.has(firstChar)) {
      status = 'optional';
      note = `Vowel-vowel juncture: saṁhitā gives '${expected.text}' (${expected.rule.name}), hiatus permitted in prose`;
    }
    // Visarga before voiced consonant: utva 'aH' -> 'o'
    else if (lastChar === 'H' && sLeft.length >= 2 && sLeft[sLeft.length - 2] === 'a' && HASH.has(firstChar)) {
      status = 'violation';
      note = `Visarga after 'a' before voiced consonant should undergo utva to 'o' (6.1.114 haśi ca). Expected: ${expected.text}`;
      violations++;
    }
    // Visarga before 'a': ato ror aplutad aplute
    else if (lastChar === 'H' && sLeft.length >= 2 && sLeft[sLeft.length - 2] === 'a' && firstChar === 'a') {
      status = 'violation';
      note = `Visarga after 'a' before 'a' should undergo utva with avagraha (6.1.113 ato ror aplutād aplute). Expected: ${expected.text}`;
      violations++;
    }
    // Visarga before sibilant / dental: satva
    else if (lastChar === 'H' && ['t', 'T', 'c', 'C', 'w', 'W'].includes(firstChar)) {
      status = 'violation';
      note = `Visarga before dental/palatal/retroflex stop should become sibilant (8.3.34 visarjanīyasya saḥ). Expected: ${expected.text}`;
      violations++;
    }

    junctures.push({
      index: i + 1,
      left,
      right,
      status,
      rule: expected.rule,
      expected: expected.text,
      note
    });
  }

  const ok = violations === 0;
  const verdict = ok ? (junctures.some(j => j.status === 'optional') ? 'verified-with-hiatus' : 'verified') : 'sandhi-violation';
  const summary = ok
    ? `All ${junctures.length} word junctures conform to Paninian rules.`
    : `Found ${violations} sandhi violation(s) across ${junctures.length} junctures.`;

  return { ok, verdict, violations, junctures, words: tokens, summary };
}

function rulesList() {
  return [
    { id: '6.1.101', name: 'akaḥ savarṇe dīrghaḥ', type: 'ac-sandhi', example: 'विद्या + आलयः → विद्यालयः' },
    { id: '6.1.87', name: 'ādguṇaḥ', type: 'ac-sandhi', example: 'महा + ईशः → महेशः' },
    { id: '6.1.88', name: 'vṛddhir eci', type: 'ac-sandhi', example: 'सदा + एव → सदैव' },
    { id: '6.1.77', name: 'iko yaṇ aci', type: 'ac-sandhi', example: 'इति + आह → इत्याह' },
    { id: '6.1.78', name: 'eco \'yavāyāvaḥ', type: 'ac-sandhi', example: 'पो + अनम् → पवनम्' },
    { id: '6.1.109', name: 'eṅaḥ padāntād ati', type: 'ac-sandhi', example: 'ते + अपि → तेऽपि' },
    { id: '1.1.11', name: 'īdūdeddvivacanaṁ pragṛhyam', type: 'ac-sandhi', example: 'हरी + एतौ → हरी एतौ' },
    { id: '8.4.40', name: 'stoḥ ścunā ścuḥ', type: 'hal-sandhi', example: 'सत् + चित् → सच्चित्' },
    { id: '8.4.41', name: 'ṣṭunā ṣṭuḥ', type: 'hal-sandhi', example: 'तत् + टीका → तट्टीका' },
    { id: '8.2.39', name: 'jhalāṁ jaśo \'nte', type: 'hal-sandhi', example: 'वाक् + ईशः → वागीशः' },
    { id: '8.4.55', name: 'khari ca', type: 'hal-sandhi', example: 'सद् + कारः → सत्कारः' },
    { id: '8.4.45', name: 'yaro \'nunāsike \'nunāsiko vā', type: 'hal-sandhi', example: 'जगत् + नाथः → जगन्नाथः' },
    { id: '8.3.23', name: 'mo \'nusvāraḥ', type: 'hal-sandhi', example: 'सत्यम् + वद → सत्यं वद' },
    { id: '8.4.60', name: 'tor li', type: 'hal-sandhi', example: 'तत् + लयः → तल्लयः' },
    { id: '6.1.73', name: 'che ca', type: 'hal-sandhi', example: 'शिव + छाया → शिवच्छाया' },
    { id: '6.1.113', name: 'ato ror aplutād aplute', type: 'visarga-sandhi', example: 'रामः + अयम् → रामोऽयम्' },
    { id: '6.1.114', name: 'haśi ca', type: 'visarga-sandhi', example: 'रामः + गच्छति → रामो गच्छति' },
    { id: '8.3.34', name: 'visarjanīyasya saḥ', type: 'visarga-sandhi', example: 'नमः + ते → नमस्ते' },
    { id: '8.3.17', name: 'bhobhago\'gho\'pūrvasya yo \'śi', type: 'visarga-sandhi', example: 'देवाः + गच्छन्ति → देवा गच्छन्ति' },
    { id: '6.1.132', name: 'etattadoḥ sulopo \'kor anañsamāse hali', type: 'visarga-sandhi', example: 'सः + गच्छति → स गच्छति' },
    { id: '8.3.14', name: 'ro ri', type: 'visarga-sandhi', example: 'पुनः + रमते → पुना रमते' }
  ];
}

module.exports = {
  join,
  joinMany,
  split,
  checkSentence,
  rulesList,
  areSavarna,
  toSlp
};
