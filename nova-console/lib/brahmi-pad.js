/* ===========================================================================
 * Brahmi Notepad core: Roman or Devanagari in, Brahmi out.
 *
 * One file for the Workstation (Node) and the web notepad (browser global
 * BrahmiPad). Code points follow the Workstation's Lipi table
 * (lib/panini-data.json), which is checked on all 3,983 sutras.
 *
 * Roman input accepts three common schemes at once, longest match first:
 *   ITRANS  aa ii uu RRi RRI LLi ~N ~n ch chh Th Dh sh Sh .m .N .h
 *   Harvard-Kyoto  A I U R RR lR G J T D N z S M H
 *   IAST  ā ī ū ṛ ṝ ḷ ḹ ṅ ñ ṭ ḍ ṇ ś ṣ ṃ ḥ
 * so "dharma" and "dharmaḥ" both work. Capitals are letters (A = ā, T = ṭ),
 * so type names in lower case. "ch" is the one clash: च in ITRANS ("chakra"),
 * छ in IAST. In 'auto' mode, text with any IAST diacritic is read as IAST
 * (ch = छ, sh = स्ह); otherwise ch = च, sh = श, and छ is "chh" or "Ch". "ch" is च (as in chakra); छ is "chh" or "Ch".
 * Devanagari is converted letter by letter; Brahmi characters pass through,
 * so an on-screen keyboard can insert them into the same text.
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BrahmiPad = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const C = cp => String.fromCodePoint(cp);
  // Sound ids are SLP1 letters (one letter per sound).
  const VOWEL = { a: 0x11005, A: 0x11006, i: 0x11007, I: 0x11008, u: 0x11009, U: 0x1100A, f: 0x1100B, F: 0x1100C, x: 0x1100D, X: 0x1100E, e: 0x1100F, E: 0x11010, o: 0x11011, O: 0x11012 };
  const SIGN = { A: 0x11038, i: 0x1103A, I: 0x1103B, u: 0x1103C, U: 0x1103D, f: 0x1103E, F: 0x1103F, x: 0x11040, X: 0x11041, e: 0x11042, E: 0x11043, o: 0x11044, O: 0x11045 };
  const CONS = { k: 0x11013, K: 0x11014, g: 0x11015, G: 0x11016, N: 0x11017, c: 0x11018, C: 0x11019, j: 0x1101A, J: 0x1101B, Y: 0x1101C, w: 0x1101D, W: 0x1101E, q: 0x1101F, Q: 0x11020, R: 0x11021, t: 0x11022, T: 0x11023, d: 0x11024, D: 0x11025, n: 0x11026, p: 0x11027, P: 0x11028, b: 0x11029, B: 0x1102A, m: 0x1102B, y: 0x1102C, r: 0x1102D, l: 0x1102E, v: 0x1102F, S: 0x11030, z: 0x11031, s: 0x11032, h: 0x11033, L: 0x11034 };
  const MARK = { M: 0x11001, H: 0x11002, '~': 0x11000 };
  const VIRAMA = 0x11046, DANDA = 0x11047, DDANDA = 0x11048, DIGIT0 = 0x11066;

  // Roman spellings -> [kind, sound id]. kind: v vowel, c consonant(s), m mark, x virama, p punctuation.
  const R = {};
  const add = (kind, id, ...keys) => { for (const k of keys) R[k] = [kind, id]; };
  add('v', 'a', 'a'); add('v', 'A', 'aa', 'A', 'ā'); add('v', 'i', 'i'); add('v', 'I', 'ii', 'I', 'ī');
  add('v', 'u', 'u'); add('v', 'U', 'uu', 'U', 'ū');
  add('v', 'f', 'R', 'RRi', 'R^i', 'ṛ', 'r̥'); add('v', 'F', 'RR', 'RRI', 'R^I', 'ṝ', 'r̥̄');
  add('v', 'x', 'lR', 'LLi', 'L^i', 'ḷ', 'l̥'); add('v', 'X', 'lRR', 'LLI', 'L^I', 'ḹ', 'l̥̄');
  add('v', 'e', 'e', 'E', 'ē'); add('v', 'E', 'ai'); add('v', 'o', 'o', 'O', 'ō'); add('v', 'O', 'au');
  const c = (id, ...keys) => add('c', id, ...keys);
  c('k', 'k'); c('K', 'kh'); c('g', 'g'); c('G', 'gh'); c('N', 'G', '~N', 'N^', 'ṅ');
  c('c', 'c', 'ch'); c('C', 'chh', 'Ch', 'C'); c('j', 'j'); c('J', 'jh'); c('Y', 'J', '~n', 'JN', 'ñ');
  c('w', 'T', 'ṭ'); c('W', 'Th', 'ṭh'); c('q', 'D', 'ḍ'); c('Q', 'Dh', 'ḍh'); c('R', 'N', 'ṇ');
  c('t', 't'); c('T', 'th'); c('d', 'd'); c('D', 'dh'); c('n', 'n');
  c('p', 'p'); c('P', 'ph', 'f'); c('b', 'b'); c('B', 'bh'); c('m', 'm');
  c('y', 'y'); c('r', 'r'); c('l', 'l'); c('v', 'v', 'w');
  c('S', 'sh', 'z', 'ś'); c('z', 'Sh', 'S', 'shh', 'ṣ'); c('s', 's'); c('h', 'h'); c('L', 'L', 'ḻ');
  c('kz', 'x', 'kSh', 'kṣ'); c('jY', 'GY', 'dny', 'jñ');
  add('m', 'M', 'M', '.m', 'ṃ', 'ṁ'); add('m', 'H', 'H', 'ḥ'); add('m', '~', '.N', 'm̐');
  add('x', '', '.h'); add('p', 'DD', '||'); add('p', 'D', '|');
  const KEYS = Object.keys(R).sort((a, b) => b.length - a.length);
  const MAXLEN = KEYS[0].length;

  // Devanagari -> Brahmi, letter by letter.
  const DEVA = {};
  const DV = { 'अ': 'a', 'आ': 'A', 'इ': 'i', 'ई': 'I', 'उ': 'u', 'ऊ': 'U', 'ऋ': 'f', 'ॠ': 'F', 'ऌ': 'x', 'ॡ': 'X', 'ए': 'e', 'ऐ': 'E', 'ओ': 'o', 'औ': 'O' };
  const DS = { 'ा': 'A', 'ि': 'i', 'ी': 'I', 'ु': 'u', 'ू': 'U', 'ृ': 'f', 'ॄ': 'F', 'ॢ': 'x', 'ॣ': 'X', 'े': 'e', 'ै': 'E', 'ो': 'o', 'ौ': 'O' };
  const DC = 'कखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसहळ', DCK = 'kKgGNcCjJYwWqQRtTdDnpPbBmyrlvSzshL';
  for (const [d, s] of Object.entries(DV)) DEVA[d] = C(VOWEL[s]);
  for (const [d, s] of Object.entries(DS)) DEVA[d] = C(SIGN[s]);
  [...DC].forEach((d, i) => { DEVA[d] = C(CONS[DCK[i]]); });
  Object.assign(DEVA, { 'ँ': C(0x11000), 'ं': C(0x11001), 'ः': C(0x11002), 'ᳵ': C(0x11003), 'ᳶ': C(0x11004), '्': C(VIRAMA), '।': C(DANDA), '॥': C(DDANDA) });
  for (let i = 0; i < 10; i++) DEVA[String.fromCharCode(0x0966 + i)] = C(DIGIT0 + i);

  const isBrahmi = ch => { const cp = ch.codePointAt(0); return cp >= 0x11000 && cp <= 0x1107F; };
  const isDeva = ch => { const cp = ch.codePointAt(0); return (cp >= 0x0900 && cp <= 0x097F) || cp === 0x1CF5 || cp === 0x1CF6; };
  const BSIGNS = new Set([...Object.values(SIGN), VIRAMA, 0x11000, 0x11001, 0x11002].map(C));

  /** Roman, Devanagari or Brahmi (mixed) -> Brahmi. Other characters (spaces, punctuation, Latin we can't read) pass through. */
  const IAST_MARKS = /[āīūṛṝḷḹṅñṭḍṇśṣṃṁḥēō]/;
  // In IAST, ch is छ and sh is स्ह (IAST writes ś for श).
  const IAST_PAIRS = { ch: ['c', 'C'], sh: ['c', 'sh'] };
  /** Which reading of "ch" applies: 'iast' (ch = छ) or 'itrans' (ch = च). */
  function scheme(text, mode = 'auto') { return mode === 'iast' || mode === 'itrans' ? mode : (IAST_MARKS.test(String(text || '').normalize('NFC')) ? 'iast' : 'itrans'); }
  function toBrahmi(input, opts = {}) {
    const text = String(input || '').normalize('NFC');
    const iast = scheme(text, opts.scheme) === 'iast';
    const chars = [...text], out = [];
    let pendingConsonant = false; // a consonant waits for its vowel
    const close = (nextIsSign) => { if (pendingConsonant && !nextIsSign) out.push(C(VIRAMA)); pendingConsonant = false; };
    let i = 0;
    while (i < chars.length) {
      const ch = chars[i];
      if (isBrahmi(ch)) { close(BSIGNS.has(ch)); out.push(ch); i++; continue; }
      if (isDeva(ch)) { close(false); out.push(DEVA[ch] || (ch === '़' ? '' : ch)); i++; continue; }
      if (/[0-9]/.test(ch) && opts.digits !== false) { close(false); out.push(C(DIGIT0 + Number(ch))); i++; continue; }
      let hit = null;
      for (let n = Math.min(MAXLEN, chars.length - i); n > 0; n--) { const k = chars.slice(i, i + n).join(''); if (R[k]) { hit = [k, iast && IAST_PAIRS[k] ? IAST_PAIRS[k] : R[k]]; break; } }
      if (!hit) { close(false); out.push(ch); i++; continue; }
      const [key, [kind, id]] = hit; i += [...key].length;
      if (kind === 'v') {
        if (pendingConsonant) { if (id !== 'a') out.push(C(SIGN[id])); pendingConsonant = false; }
        else out.push(C(VOWEL[id]));
      } else if (kind === 'c') {
        close(false);
        const ids = id.length === 2 && CONS[id[0]] && CONS[id[1]] && !CONS[id] ? [...id] : [id];
        ids.forEach((s, k) => { out.push(C(CONS[s])); if (k < ids.length - 1) out.push(C(VIRAMA)); });
        pendingConsonant = true;
      } else if (kind === 'm') { close(true); out.push(C(MARK[id])); }
      else if (kind === 'x') { if (pendingConsonant) out.push(C(VIRAMA)); pendingConsonant = false; }
      else if (kind === 'p') { close(false); out.push(C(id === 'DD' ? DDANDA : DANDA)); }
    }
    close(false);
    return out.join('');
  }

  // Brahmi -> IAST, for the reading line under the Brahmi text.
  const IAST = { a: 'a', A: 'ā', i: 'i', I: 'ī', u: 'u', U: 'ū', f: 'ṛ', F: 'ṝ', x: 'ḷ', X: 'ḹ', e: 'e', E: 'ai', o: 'o', O: 'au',
    k: 'k', K: 'kh', g: 'g', G: 'gh', N: 'ṅ', c: 'c', C: 'ch', j: 'j', J: 'jh', Y: 'ñ', w: 'ṭ', W: 'ṭh', q: 'ḍ', Q: 'ḍh', R: 'ṇ', t: 't', T: 'th', d: 'd', D: 'dh', n: 'n', p: 'p', P: 'ph', b: 'b', B: 'bh', m: 'm', y: 'y', r: 'r', l: 'l', v: 'v', S: 'ś', z: 'ṣ', s: 's', h: 'h', L: 'ḷ' };
  const BV = {}, BS = {}, BC = {};
  for (const [s, cp] of Object.entries(VOWEL)) BV[C(cp)] = s;
  for (const [s, cp] of Object.entries(SIGN)) BS[C(cp)] = s;
  for (const [s, cp] of Object.entries(CONS)) BC[C(cp)] = s;
  function toIast(brahmi) {
    const chars = [...String(brahmi || '')], out = [];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i], next = chars[i + 1] || '';
      if (BC[ch]) { out.push(IAST[BC[ch]]); if (BS[next]) { out.push(IAST[BS[next]]); i++; } else if (next === C(VIRAMA)) i++; else out.push('a'); continue; }
      if (BV[ch]) { out.push(IAST[BV[ch]]); continue; }
      const cp = ch.codePointAt(0);
      if (cp === 0x11001) out.push('ṃ'); else if (cp === 0x11002) out.push('ḥ'); else if (cp === 0x11000) out.push('m̐');
      else if (cp === DANDA) out.push('|'); else if (cp === DDANDA) out.push('||');
      else if (cp >= DIGIT0 && cp <= DIGIT0 + 9) out.push(String(cp - DIGIT0));
      else out.push(ch);
    }
    return out.join('').normalize('NFC');
  }

  /** The on-screen keyboard, in the order of the varṇamālā. Each key: [Brahmi, IAST label]. */
  const KEYBOARD = {
    vowels: Object.keys(VOWEL).map(s => [C(VOWEL[s]), IAST[s]]),
    signs: Object.keys(SIGN).map(s => [C(SIGN[s]), '◌' + IAST[s]]),
    consonants: Object.keys(CONS).map(s => [C(CONS[s]), IAST[s] + 'a']),
    marks: [[C(VIRAMA), 'virāma'], [C(0x11001), 'ṃ'], [C(0x11002), 'ḥ'], [C(0x11000), 'm̐'], [C(DANDA), '|'], [C(DDANDA), '||']],
    digits: Array.from({ length: 10 }, (_, d) => [C(DIGIT0 + d), String(d)]),
  };

  /** Spelling help for the cheat sheet: sound -> what to type. */
  const CHEATSHEET = [
    ['ā ī ū', 'aa ii uu  ·  A I U  ·  ā ī ū'], ['ṛ ṝ', 'R RR  ·  RRi RRI  ·  ṛ ṝ'], ['e ai o au', 'e ai o au'],
    ['ṅ ñ', '~N ~n  ·  G J  ·  ṅ ñ'], ['c ch', 'ch (or c), chh  ·  in IAST: c, ch'], ['ṭ ṭh ḍ ḍh ṇ', 'T Th D Dh N  ·  ṭ ṭh ḍ ḍh ṇ'],
    ['ś ṣ', 'sh Sh  ·  z S  ·  ś ṣ'], ['kṣ jñ', 'x or kSh  ·  GY or jñ'], ['ṃ ḥ m̐', 'M H .N  ·  .m  ·  ṃ ḥ'],
    ['virāma', '.h  (a final consonant gets one by itself)'], ['। ॥', '|  ||'],
  ];

  return { toBrahmi, toIast, scheme, KEYBOARD, CHEATSHEET, isBrahmi, VIRAMA: C(VIRAMA) };
}));
