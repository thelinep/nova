/* ===========================================================================
 * Lipi OS script engine: Devanagari <-> 20+ Brahmic scripts
 *
 * The tables (lib/lipi-scripts.json) are generated from Unicode character
 * names by tools/build-lipi-scripts.py, so a letter maps only where Unicode
 * itself gives the same letter in the other script. Anything without a
 * counterpart stays in Devanagari and is reported, never guessed.
 *
 * Kharoshthi keeps Guru's convention from lib/panini.js (ai/au as e/o plus
 * the length mark). Hindi text can optionally be respelled the way it is
 * pronounced (dropped inherent vowels marked with a virama) before it is
 * written in a historical script; this is a heuristic and is labelled so.
 * ========================================================================= */
const fs = require('node:fs');
const path = require('node:path');
const panini = require('./panini');
const slp1 = require('./slp1');

let data = null, reverse = null;
function load() {
  if (!data) data = JSON.parse(fs.readFileSync(path.join(__dirname, 'lipi-scripts.json'), 'utf8'));
  return data;
}

const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const DEVA = /[\u{0900}-\u{097f}]/u;
const isDevaConsonant = ch => /[\u{0915}-\u{0939}\u{0958}-\u{095f}\u{0978}-\u{097f}]/u.test(ch);
const isDevaVowelSign = ch => /[\u{093e}-\u{094c}\u{0962}\u{0963}]/u.test(ch);
const isDevaModifier = ch => /[\u{0900}-\u{0903}]/u.test(ch);
const isDevaIndependentVowel = ch => /[\u{0904}-\u{0914}]/u.test(ch);
const VIRAMA = '\u{094d}', NUKTA = '\u{093c}';
const KAWI_CONJOINER = '\u{11F42}';
const ZWNJ = '\u{200C}';

/**
 * How each script's halant (virama) shows with the fonts Maataa ships. "stacked": a virama
 * between consonants forms a conjunct; "partial": the font forms only some conjuncts and shows
 * a visible halant elsewhere; "visible": the halant is drawn (by script convention, or because
 * no font forms conjuncts yet). Measured with HarfBuzz on the shipped fonts (tools/build-lipi-conjunct-fonts.py).
 */
const HALANT = {
  Brah: ['visible', 'Noto Sans Brahmi draws every virama as a bar. Brahmi+ shows the same text with stacked conjuncts.'],
  'Brah+': ['stacked', 'Maataa Lipi Brahmi: the same Brahmi text, with the stacked conjuncts Noto Sans Brahmi lacks.'],
  Shrd: ['stacked', 'Maataa Lipi Sharada stacks the conjuncts Noto Sans Sharada leaves open.'],
  Diak: ['stacked', 'Maataa Lipi Dives Akuru stacks the conjuncts Noto Serif Dives Akuru leaves open.'],
  Khar: ['stacked', 'Maataa Lipi Kharoshthi keeps the clusters Noto Sans Kharoshthi draws and stacks the rest (F9).'],
  Takr: ['visible', 'Takri is usually written with a visible halant.'],
  Dogr: ['visible', 'Noto Serif Dogra forms no conjuncts; the halant is shown.'],
  Sind: ['visible', 'Khudawadi does not form conjuncts; the halant is shown.'],
};
const halantOf = code => (HALANT[code] || ['stacked', ''])[0];
/** The virama a script writes, from its table. */
const viramaOf = code => code === 'Brah+' ? viramaOf('Brah') : code === 'Khar' ? '\u{10A3F}' : code === 'Deva' ? VIRAMA : (load().scripts[code] || { map: {} }).map[VIRAMA];

/** Kharoshthi has no generated table: measure it against the same core letters as the other scripts. */
let kharCov = null;
function kharCoverage() {
  if (kharCov) return kharCov;
  const core = [...load().core], missing = core.filter(ch => fromDevaJoined(ch, 'Khar').missing.length);
  return (kharCov = { coverage: Math.round((core.length - missing.length) / core.length * 1000) / 1000, missing });
}

/** Every script Lipi can write, in display order. */
function list() {
  const d = load();
  const out = [{ code: 'Deva', label: 'Devanagari', hi: 'देवनागरी', direction: 'ltr', coverage: 1, missing: [], note: 'The source script for conversion.', halant: 'stacked', halantNote: '' }];
  const kh = kharCoverage();
  out.push({ code: 'Khar', label: 'Kharoshthi', hi: 'खरोष्ठी', direction: 'rtl', coverage: kh.coverage, missing: kh.missing, note: 'Right to left. ai and au are written as e and o with the length mark (Guru convention).', halant: halantOf('Khar'), halantNote: HALANT.Khar[1] });
  for (const s of Object.values(d.scripts).sort((a, b) => a.order - b.order)) {
    out.push({ code: s.code, label: s.label, hi: s.hi, direction: s.direction, coverage: s.coverage, missing: s.missing, note: s.note, halant: halantOf(s.code), halantNote: (HALANT[s.code] || [])[1] || '' });
    // Brahmi+ is a second view of the same Brahmi text: identical characters, drawn with stacked conjuncts.
    if (s.code === 'Brah') out.push({ code: 'Brah+', label: 'Brahmi+', hi: 'ब्राह्मी+', direction: s.direction, coverage: s.coverage, missing: s.missing, note: 'Same Brahmi text as Brahmi, drawn with stacked conjuncts (Maataa Lipi Brahmi).', halant: halantOf('Brah+'), halantNote: HALANT['Brah+'][1], sameAs: 'Brah' });
  }
  return out;
}

const known = code => code === 'Deva' || code === 'Khar' || code === 'Brah+' || !!load().scripts[code];

/**
 * Shows the halant instead of a conjunct: a zero-width non-joiner after every virama that is
 * followed by a letter (the Unicode way to ask for an explicit virama).
 */
function visibleHalant(text, code) {
  const v = viramaOf(code);
  if (!v) return text;
  const chars = [...text], out = [];
  for (let i = 0; i < chars.length; i++) {
    out.push(chars[i]);
    const next = chars[i + 1] || '';
    if (chars[i] === v && next && next !== ZWNJ && !/[\s\p{P}]/u.test(next)) out.push(ZWNJ);
  }
  return out.join('');
}

/**
 * Devanagari text -> one script. Returns { text, missing: [chars kept in Devanagari] }.
 * opts.halant: 'joined' (default; conjuncts where the script forms them) or 'visible'.
 */
function fromDeva(text, code, opts = {}) {
  const r = fromDevaJoined(text, code);
  if (opts.halant !== 'visible') return r;
  return { ...r, text: visibleHalant(code === 'Kawi' ? r.text.split(KAWI_CONJOINER).join(viramaOf('Kawi')) : r.text, code) };
}

function fromDevaJoined(text, code) {
  if (code === 'Brah+') code = 'Brah'; // same characters; only the font differs
  const src = String(text).normalize('NFD');
  if (code === 'Deva') return { text: src.normalize('NFC'), missing: [] };
  if (code === 'Khar') {
    // Guru's Kharoshthi writer keeps any letter it has no form for in Devanagari; report those (F7).
    const text = panini.fromDeva(src, 'kharoshthi');
    return { text, missing: [...new Set([...text].filter(ch => DEVA.test(ch) && ch !== NUKTA))] };
  }
  const s = load().scripts[code];
  if (!s) throw error(`Lipi does not know the script ${code}.`);
  const chars = [...src], out = [], missing = new Set();
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!DEVA.test(ch)) { out.push(ch); continue; }
    let m = s.map[ch];
    if (code === 'Kawi' && ch === VIRAMA && isDevaConsonant(chars[i + 1] || '')) m = KAWI_CONJOINER;
    if (m === undefined) {
      if (ch === NUKTA) continue; // no nukta in this script: the base letter stands
      missing.add(ch); out.push(ch); continue;
    }
    out.push(m);
  }
  return { text: out.join('').normalize('NFC'), missing: [...missing] };
}

function reverseTable() {
  if (reverse) return reverse;
  reverse = new Map(); // target sequence -> Devanagari; the lowest Devanagari letter wins a shared form
  for (const s of Object.values(load().scripts)) {
    for (const [dev, tgt] of Object.entries(s.map).sort((a, b) => a[0].codePointAt(0) - b[0].codePointAt(0))) {
      if (!reverse.has(tgt)) reverse.set(tgt, dev);
    }
  }
  reverse.set(KAWI_CONJOINER, VIRAMA);
  return reverse;
}

/** Any supported script (or SLP1 in Latin letters) -> Devanagari. */
function toDeva(text) {
  const t = String(text);
  if (!t.trim()) return '';
  if (/[a-zA-Z]/.test(t) && /^[\x00-\x7f]*$/.test(t)) return slp1.toDevanagari(t);
  if (/[\u{10A00}-\u{10A5F}]/u.test(t)) throw error('Kharoshthi can be written here but not read back yet. Type Devanagari or another Brahmic script.');
  const rev = reverseTable(), chars = [...t.normalize('NFC')], out = [];
  for (let i = 0; i < chars.length; i++) {
    const two = chars[i] + (chars[i + 1] || '');
    if (chars[i + 1] && rev.has(two)) { out.push(rev.get(two)); i++; continue; }
    out.push(rev.has(chars[i]) ? rev.get(chars[i]) : chars[i]);
  }
  return out.join('').normalize('NFC');
}

/**
 * Hindi pronunciation spelling: marks inherent vowels that Hindi drops.
 * Rule (Ohala's, simplified): the word-final inherent vowel is silent; a
 * medial one is dropped in V C _ C V when the following vowel is itself
 * sounded. Applied right to left so two neighbours are never both dropped.
 * Example: आपका -> आप्का, स्वागत stays (its final a is the silent one).
 */
function hindiSpelling(text) {
  return String(text).normalize('NFC').split(/(\s+)/).map(word => {
    if (!DEVA.test(word)) return word;
    const ch = [...word], syl = [];
    for (let i = 0; i < ch.length;) {
      const start = i;
      if (isDevaConsonant(ch[i])) {
        let j = i, cluster = 1;
        while (ch[j + 1] === NUKTA) j++;
        while (ch[j + 1] === VIRAMA && isDevaConsonant(ch[j + 2] || '')) { j += 2; cluster++; while (ch[j + 1] === NUKTA) j++; }
        if (ch[j + 1] === VIRAMA) { syl.push({ start, end: j + 2, vowel: 'none', cluster }); i = j + 2; continue; }
        let vowel = 'inherent', k = j + 1;
        if (isDevaVowelSign(ch[k] || '')) { vowel = 'sign'; k++; }
        while (isDevaModifier(ch[k] || '')) { if (vowel === 'inherent') vowel = 'nasal'; k++; }
        syl.push({ start, end: k, vowel, cluster, consonantEnd: j });
        i = k;
      } else {
        let k = i + 1; while (isDevaModifier(ch[k] || '')) k++;
        syl.push({ start, end: k, vowel: isDevaIndependentVowel(ch[i]) ? 'independent' : 'other', cluster: 0 }); i = k;
      }
    }
    if (syl.length < 3) return word;
    const sounded = syl.map(s => s.vowel !== 'none' && s.vowel !== 'other');
    if (syl[syl.length - 1].vowel === 'inherent') sounded[syl.length - 1] = false;
    const drop = new Set();
    for (let i = syl.length - 2; i >= 1; i--) {
      const s = syl[i];
      if (s.vowel !== 'inherent' || s.cluster !== 1) continue;
      if (!sounded[i - 1] || !sounded[i + 1] || syl[i + 1].cluster !== 1) continue;
      drop.add(i); sounded[i] = false;
    }
    if (!drop.size) return word;
    return syl.map((s, i) => drop.has(i) ? ch.slice(s.start, s.consonantEnd + 1).join('') + VIRAMA + ch.slice(s.consonantEnd + 1, s.end).join('') : ch.slice(s.start, s.end).join('')).join('');
  }).join('');
}

/** Convert text into many scripts at once. opts: { scripts: [codes], hindi: bool, halant: 'joined' | 'visible' } */
function convert(text, opts = {}) {
  const raw = String(text || '');
  if (!raw.trim()) throw error('Type some text.');
  if (raw.length > 5000) throw error('Convert at most 5,000 characters at a time.');
  const codes = Array.isArray(opts.scripts) && opts.scripts.length ? opts.scripts : list().map(s => s.code);
  const bad = codes.filter(c => !known(c));
  if (bad.length) throw error(`Lipi does not know: ${bad.join(', ')}.`);
  const devanagari = toDeva(raw);
  const spelled = opts.hindi ? hindiSpelling(devanagari) : devanagari;
  const meta = Object.fromEntries(list().map(s => [s.code, s]));
  let iast = '';
  try { iast = slp1.toIast(slp1.fromDevanagari(spelled)); } catch (_) { iast = ''; }
  return {
    input: raw, devanagari, spelling: opts.hindi ? 'hindi-pronunciation' : 'as-written', spelled, iast, halant: opts.halant === 'visible' ? 'visible' : 'joined',
    results: codes.map(code => ({ code, label: meta[code].label, hi: meta[code].hi, direction: meta[code].direction, halantStyle: meta[code].halant || 'stacked', ...fromDeva(spelled, code, { halant: opts.halant }) })),
  };
}

const WELCOME = { hindi: 'आपका स्वागत है', roman: 'Aapkaa swaagata hai', english: 'You are welcome' };
const WELCOME_SCRIPTS = ['Brah', 'Khar', 'Bhks', 'Shrd', 'Sidd', 'Gran', 'Nand', 'Newa', 'Tirh', 'Takr', 'Modi', 'Kthi'];

/** The modern Hindi welcome carried across the twelve historic scripts. */
function welcome(scripts = WELCOME_SCRIPTS) {
  const r = convert(WELCOME.hindi, { scripts, hindi: true });
  return { ...WELCOME, spelled: r.spelled, note: 'Heritage rendering draft: the modern Hindi phrase written in each script as it is pronounced. It is not an ancient inscription or a translation, and script-specific spelling still needs scholarly review.', results: r.results };
}

module.exports = { HALANT, viramaOf, visibleHalant, list, known, fromDeva, toDeva, hindiSpelling, convert, welcome, WELCOME, WELCOME_SCRIPTS, _reset: () => { data = null; reverse = null; } };
