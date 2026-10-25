'use strict';
/**
 * Brahmi report: what the OCR readings contain, and where in each picture.
 *
 * Categories: akshar (letters), sanyukta (conjuncts), dhatu (verb forms and their roots), sangya (nouns),
 * sarvanaam (pronouns), sankhya (numbers), jyamiti (geometry and measures), antariksh (sky), anya (other topics).
 * Words come from lib/lipi-brahmi-lexicon.json (built by tools/lipi-ocr/build-lexicon.js) and are found in the
 * readings akshara by akshara. Every find carries the polygon of its letters in the picture (fractions of
 * width and height), so the app can draw the detected areas.
 *
 * A find is "sure" only when the spelling matches exactly, the line was read with high confidence and the
 * script variant is one the model reads well; otherwise it is "possible". OCR mistakes make false finds,
 * so a possible find is a lead to check, not a reading.
 */
const fs = require('node:fs');
const path = require('node:path');
const scripts = require('./lipi-scripts');

const VIRAMA = '\u{11046}';
const isMark = ch => { const c = ch.codePointAt(0); return (c >= 0x11000 && c <= 0x11002) || (c >= 0x11038 && c <= 0x11046); };
const isVowel = ch => { const c = ch.codePointAt(0); return c >= 0x11005 && c <= 0x11012; };
const isCons = ch => { const c = ch.codePointAt(0); return c >= 0x11013 && c <= 0x11037; };
const TRUSTED = new Set(['early', 'ashokan', 'post', 'bhattiprolu', 'tamil', 'lanka']);
const SURE_CONF = 0.8;

function splitAksharas(text) {
  const out = [];
  for (const ch of text) {
    if (out.length && (isMark(ch) || out[out.length - 1].endsWith(VIRAMA))) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

let lex = null;
function lexicon() {
  if (lex) return lex;
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'lipi-brahmi-lexicon.json'), 'utf8'));
  const forms = [];
  for (const e of raw.entries) for (const f of e.forms) {
    const ak = splitAksharas(f.brahmi);
    if (ak.length >= 2) forms.push({ entry: e, deva: f.deva, ak });
  }
  forms.sort((a, b) => b.ak.length - a.ak.length);
  lex = { ...raw, forms };
  return lex;
}

// A point along the line polygon [TL, TR, BR, BL] at fraction t; returns the strip between t0 and t1.
function strip(poly, t0, t1) {
  const [tl, tr, br, bl] = poly;
  const at = (p, q, t) => [+(p[0] + (q[0] - p[0]) * t).toFixed(4), +(p[1] + (q[1] - p[1]) * t).toFixed(4)];
  return [at(tl, tr, t0), at(tl, tr, t1), at(bl, br, t1), at(bl, br, t0)];
}

/** Analyses one reading ({lines:[{text, conf, poly, aksharas:[[t,a,b]]}]}). variant: gallery variant key, if any. */
function analyse(reading, variant) {
  const L = lexicon();
  const trusted = variant ? TRUSTED.has(variant) : true;
  const letters = { total: 0, consonants: {}, vowels: {}, signs: {}, anusvara: 0, visarga: 0 };
  const finds = [];
  (reading.lines || []).forEach((line, li) => {
    const aks = line.aksharas && line.aksharas.length ? line.aksharas : splitAksharas(line.text).map((t, i, all) => [t, i / all.length, (i + 1) / all.length]);
    const texts = aks.map(a => a[0]);
    const poly = line.poly || null;
    const area = (i, j) => poly ? strip(poly, aks[i][1], aks[j][2]) : null;
    const lineSure = line.conf >= SURE_CONF && trusted;
    // letters and conjuncts
    aks.forEach(([t], i) => {
      letters.total++;
      for (const ch of t) {
        if (isCons(ch)) letters.consonants[ch] = (letters.consonants[ch] || 0) + 1;
        else if (isVowel(ch)) letters.vowels[ch] = (letters.vowels[ch] || 0) + 1;
        else if (ch === '\u{11001}') letters.anusvara++;
        else if (ch === '\u{11002}') letters.visarga++;
        else if (isMark(ch) && ch !== VIRAMA) letters.signs[ch] = (letters.signs[ch] || 0) + 1;
      }
      const chars = [...t];
      const vi = chars.indexOf(VIRAMA);
      if (vi >= 0) {
        // a real conjunct is consonant + virama + consonant; anything else is an OCR slip
        const valid = vi > 0 && isCons(chars[vi - 1]) && chars[vi + 1] !== undefined && isCons(chars[vi + 1]);
        finds.push({ cat: 'sanyukta', text: t, deva: scripts.toDeva(t, 'Brah'), line: li, from: i, to: i, conf: line.conf, sure: valid && lineSure, valid, area: area(i, i) });
      }
    });
    // words, longest first
    const taken = [];
    for (const wantExact of [true, false]) for (const f of L.forms) {   // exact spellings first, then near ones
      const n = f.ak.length;
      for (let i = 0; i + n <= texts.length; i++) {
        let diff = 0;
        for (let k = 0; k < n && diff < 2; k++) if (texts[i + k] !== f.ak[k]) diff++;
        const exact = diff === 0;
        if (exact !== wantExact) continue;
        if (!(exact || (diff === 1 && n >= 4))) continue;
        if (n === 2 && !(exact && line.conf >= SURE_CONF)) continue;   // two-akshara words only when clear
        const cat = f.entry.cat;
        // overlapping finds: never twice in one category; a verb inside a longer word is kept, other short words are not
        const clash = taken.find(m => m.from <= i + n - 1 && i <= m.to && (m.cat === cat || (cat !== 'dhatu' && n < 3)));
        if (clash) continue;
        const m = { cat, head: f.entry.head, form: f.deva, read: scripts.toDeva(texts.slice(i, i + n).join(''), 'Brah'), hi: f.entry.hi, en: f.entry.en,
          line: li, from: i, to: i + n - 1, exact, conf: line.conf, sure: exact && lineSure, area: area(i, i + n - 1) };
        if (f.entry.dhatu) m.dhatu = f.entry.dhatu;
        if (f.entry.topic) m.topic = f.entry.topic;
        taken.push(m); finds.push(m);
      }
    }
  });
  const counts = {};
  for (const f of finds) { const c = counts[f.cat] || (counts[f.cat] = { sure: 0, possible: 0 }); c[f.sure ? 'sure' : 'possible']++; }
  counts.akshar = { sure: 0, possible: letters.total };
  const deva = o => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => [scripts.toDeva(k, 'Brah'), v]));
  return {
    letters: { total: letters.total, consonants: deva(letters.consonants), vowels: deva(letters.vowels), signs: Object.fromEntries(Object.entries(letters.signs).map(([k, v]) => ['◌' + scripts.toDeva('\u{11013}' + k, 'Brah').slice(1), v])), anusvara: letters.anusvara, visarga: letters.visarga },
    finds, counts, trusted,
  };
}

let reportCache = null;
/** The whole report over the gallery readings: per picture and per category. */
function report(readings, gallery) {
  if (reportCache && reportCache.src === readings) return reportCache.value;
  const L = lexicon();
  const items = {};
  const byCat = {};
  const totals = { letters: 0, consonants: {} };
  for (const it of gallery.items) {
    const r = readings[it.id];
    if (!r) continue;
    const a = analyse(r, it.variant);
    items[it.id] = { title: it.title, variant: it.variant, legible: !!r.legible, ...a };
    totals.letters += a.letters.total;
    for (const [k, v] of Object.entries(a.letters.consonants)) totals.consonants[k] = (totals.consonants[k] || 0) + v;
    for (const f of a.finds) {
      const key = f.cat === 'sanyukta' ? f.deva : f.head;
      const c = byCat[f.cat] || (byCat[f.cat] = {});
      const e = c[key] || (c[key] = { key, hi: f.hi || '', en: f.en || '', dhatu: f.dhatu || null, topic: f.topic || null, valid: f.valid, sure: 0, possible: 0, images: {} });
      e[f.sure ? 'sure' : 'possible']++;
      e.images[it.id] = (e.images[it.id] || 0) + 1;
    }
  }
  const categories = Object.fromEntries(Object.entries(byCat).map(([cat, m]) => [cat,
    Object.values(m).map(e => ({ ...e, images: Object.entries(e.images).map(([id, n]) => ({ id, n })) }))
      .sort((a, b) => b.sure - a.sure || b.possible - a.possible)]));
  totals.consonants = Object.fromEntries(Object.entries(totals.consonants).sort((a, b) => b[1] - a[1]));
  const value = { labels: L.categories, topics: L.topics, sureConfidence: SURE_CONF, totals, categories, items };
  reportCache = { src: readings, value };
  return value;
}

module.exports = { analyse, report, splitAksharas, strip, _reset: () => { lex = null; reportCache = null; } };
