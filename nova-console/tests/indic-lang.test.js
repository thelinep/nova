'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detect, scriptOf } = require('../lib/indic-lang');

test('one-language scripts are identified with high confidence', () => {
  const cases = { ta: 'வானத்தின் நிறம் என்ன?', te: 'ఆకాశం రంగు ఏమిటి?', kn: 'ಆಕಾಶದ ಬಣ್ಣ ಯಾವುದು?', ml: 'ആകാശത്തിന്റെ നിറം എന്താണ്?', gu: 'આકાશનો રંગ કયો છે?', pa: 'ਅਸਮਾਨ ਦਾ ਰੰਗ ਕੀ ਹੈ?', or: 'ଆକାଶର ରଙ୍ଗ' };
  for (const [lang, text] of Object.entries(cases)) { const d = detect(text); assert.equal(d.lang, lang, text); assert.ok(d.confidence >= 0.9, `${lang} ${d.confidence}`); assert.deepEqual(d.candidates, [lang]); }
});

test('shared scripts give a first guess and say what else it could be', () => {
  const hi = detect('आसमान का रंग क्या है?');
  assert.equal(hi.lang, 'hi'); assert.ok(hi.candidates.includes('mr') && hi.candidates.includes('sa')); assert.ok(hi.confidence < 0.9);
  assert.equal(detect('आकाशाचा रंग कोणता आहे?').lang, 'mr');
  assert.equal(detect('धर्मक्षेत्रे कुरुक्षेत्रे समवेता युयुत्सवः ॥').lang, 'sa');
  assert.equal(detect('আকাশের রং কী?').lang, 'bn');
  assert.equal(detect('আকাশৰ ৰং কি?').lang, 'as');
  const ur = detect('آسمان کا رنگ کیا ہے؟'); assert.equal(ur.lang, 'ur'); assert.deepEqual(ur.candidates, ['ur', 'ks', 'sd']);
});

test('Hindi in English letters is Hindi, romanized; plain English stays English', () => {
  const h = detect('india ki sari languages ko samajhkar model ka istemaal karo');
  assert.equal(h.lang, 'hi'); assert.equal(h.romanized, true); assert.equal(h.script, 'Latin');
  assert.equal(detect('Asha watches the sea as the city lights come on.').lang, 'en');
  assert.equal(detect('list all services and monetization path').lang, 'en');
  assert.equal(detect('12345 !!').confidence, 0);
});

test('mixed text follows the dominant Indian script, and scriptOf maps a language to its script', () => {
  assert.equal(detect('Maataa में shot list बनाओ और PDF निकालो').lang, 'hi');
  assert.equal(scriptOf('mr'), 'Devanagari'); assert.equal(scriptOf('as'), 'Bengali'); assert.equal(scriptOf('ta'), 'Tamil'); assert.equal(scriptOf('en'), 'Latin');
});
