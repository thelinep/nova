'use strict';

// SLP1 ⇄ Devanagari, matching guru/guru/slp1.py (Guru). SLP1 is the one-letter-per-sound
// scheme the Paninian engine works in; the Workstation shows Devanagari.

const VOWELS = { a:['अ',''], A:['आ','ा'], i:['इ','ि'], I:['ई','ी'], u:['उ','ु'], U:['ऊ','ू'], f:['ऋ','ृ'], F:['ॠ','ॄ'], x:['ऌ','ॢ'], X:['ॡ','ॣ'], e:['ए','े'], E:['ऐ','ै'], o:['ओ','ो'], O:['औ','ौ'] };
const CONSONANTS = { k:'क', K:'ख', g:'ग', G:'घ', N:'ङ', c:'च', C:'छ', j:'ज', J:'झ', Y:'ञ', w:'ट', W:'ठ', q:'ड', Q:'ढ', R:'ण', t:'त', T:'थ', d:'द', D:'ध', n:'न', p:'प', P:'फ', b:'ब', B:'भ', m:'म', y:'य', r:'र', l:'ल', v:'व', S:'श', z:'ष', s:'स', h:'ह' };
const MARKS = { M:'ं', H:'ः', '~':'ँ', '\\':'॒', '^':'॑', '3':'३' };
const VIRAMA = '्';

function toDevanagari(s) {
  s = String(s); const out = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], next = s[i + 1] || '';
    if (ch === '≍') { out.push('pP'.includes(next) ? 'ᳶ' : 'ᳵ'); continue; }
    if (CONSONANTS[ch]) {
      out.push(CONSONANTS[ch]);
      if (VOWELS[next]) { out.push(VOWELS[next][1]); i += 1; } else if (!MARKS[next]) out.push(VIRAMA);
      continue;
    }
    if (VOWELS[ch]) { out.push(VOWELS[ch][0]); continue; }
    if (MARKS[ch]) { out.push(MARKS[ch]); continue; }
    if (ch === "'") { out.push('ऽ'); continue; }
    if (ch === '.' && !/\d/.test(s[i - 1] || '')) { if (next === '.') { out.push('॥'); i += 1; } else out.push('।'); continue; }
    out.push(ch);
  }
  return out.join('');
}

const D_VOWEL = Object.fromEntries(Object.entries(VOWELS).map(([k, [v]]) => [v, k]));
const D_SIGN = Object.fromEntries(Object.entries(VOWELS).filter(([, [, s]]) => s).map(([k, [, s]]) => [s, k]));
const D_CONS = Object.fromEntries(Object.entries(CONSONANTS).map(([k, v]) => [v, k]));
const D_MARK = Object.fromEntries(Object.entries(MARKS).map(([k, v]) => [v, k]));

function fromDevanagari(s) {
  const chars = [...String(s).normalize('NFC')]; const out = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i], next = chars[i + 1] || '';
    if (D_CONS[ch]) {
      out.push(D_CONS[ch]);
      if (next === VIRAMA) i += 1;
      else if (D_SIGN[next]) { out.push(D_SIGN[next]); i += 1; }
      else out.push('a');
      continue;
    }
    if (D_VOWEL[ch]) { out.push(D_VOWEL[ch]); continue; }
    if (D_MARK[ch]) { out.push(D_MARK[ch]); continue; }
    if (ch === 'ऽ') { out.push("'"); continue; }
    if (ch === '।') { out.push('.'); continue; }
    if (ch === '॥') { out.push('..'); continue; }
    out.push(ch);
  }
  return out.join('');
}

const IAST_V = { a:'a', A:'ā', i:'i', I:'ī', u:'u', U:'ū', f:'ṛ', F:'ṝ', x:'ḷ', X:'ḹ', e:'e', E:'ai', o:'o', O:'au' };
const IAST_C = { k:'k', K:'kh', g:'g', G:'gh', N:'ṅ', c:'c', C:'ch', j:'j', J:'jh', Y:'ñ', w:'ṭ', W:'ṭh', q:'ḍ', Q:'ḍh', R:'ṇ', t:'t', T:'th', d:'d', D:'dh', n:'n', p:'p', P:'ph', b:'b', B:'bh', m:'m', y:'y', r:'r', l:'l', v:'v', S:'ś', z:'ṣ', s:'s', h:'h' };
const IAST_M = { M:'ṃ', H:'ḥ', '~':'m̐', '\\':'', '^':'', '3':'3' };
function toIast(s) {
  s = String(s); let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '≍') { out += 'pP'.includes(s[i + 1] || '') ? 'ḫ' : 'ẖ'; continue; }
    out += IAST_C[ch] ?? IAST_V[ch] ?? IAST_M[ch] ?? ch;
  }
  return out;
}

module.exports = { toDevanagari, fromDevanagari, toIast };
