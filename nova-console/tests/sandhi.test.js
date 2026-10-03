'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sandhi = require('../lib/sandhi');
const slp1 = require('../lib/slp1');

test('Ac-sandhi: savarna-dirgha (6.1.101)', () => {
  const r1 = sandhi.join('विद्या', 'आलयः');
  assert.equal(r1.text, 'विद्यालयः');
  assert.equal(r1.rule.id, '6.1.101');

  const r2 = sandhi.join('दैत्य', 'अरिः');
  assert.equal(r2.text, 'दैत्यारिः');

  const r3 = sandhi.join('गिरि', 'इन्द्रः');
  assert.equal(r3.text, 'गिरीन्द्रः');

  const r4 = sandhi.join('भानु', 'उदयः');
  assert.equal(r4.text, 'भानूदयः');
});

test('Ac-sandhi: guna (6.1.87)', () => {
  const r1 = sandhi.join('महा', 'ईशः');
  assert.equal(r1.text, 'महेशः');
  assert.equal(r1.rule.id, '6.1.87');

  const r2 = sandhi.join('देव', 'इन्द्रः');
  assert.equal(r2.text, 'देवेन्द्रः');

  const r3 = sandhi.join('सूर्य', 'उदयः');
  assert.equal(r3.text, 'सूर्योदयः');

  const r4 = sandhi.join('महा', 'ऋषिः');
  assert.equal(r4.text, 'महर्षिः');
});

test('Ac-sandhi: vriddhi (6.1.88)', () => {
  const r1 = sandhi.join('सदा', 'एव');
  assert.equal(r1.text, 'सदैव');
  assert.equal(r1.rule.id, '6.1.88');

  const r2 = sandhi.join('महा', 'औषधम्');
  assert.equal(r2.text, 'महौषधम्');
});

test('Ac-sandhi: yan (6.1.77)', () => {
  const r1 = sandhi.join('इति', 'आह');
  assert.equal(r1.text, 'इत्याह');
  assert.equal(r1.rule.id, '6.1.77');

  const r2 = sandhi.join('यदि', 'अपि');
  assert.equal(r2.text, 'यद्यपि');

  const r3 = sandhi.join('मधु', 'अरिः');
  assert.equal(r3.text, 'मध्वरिः');
});

test('Ac-sandhi: purvarupa (6.1.109)', () => {
  const r1 = sandhi.join('ते', 'अपि');
  assert.equal(r1.text, 'तेऽपि');
  assert.equal(r1.rule.id, '6.1.109');

  const r2 = sandhi.join('प्रभो', 'अत्र');
  assert.equal(r2.text, 'प्रभोऽत्र');
});

test('Ac-sandhi: pragrhya (1.1.11)', () => {
  const r = sandhi.join('हरी', 'एतौ', { pragrhya: true });
  assert.equal(r.text, 'हरी एतौ');
  assert.equal(r.rule.id, '1.1.11');
});

test('Hal-sandhi: scutva (8.4.40) and stutva (8.4.41)', () => {
  const r1 = sandhi.join('सत्', 'चित्');
  assert.equal(r1.text, 'सच्चित्');
  assert.equal(r1.rule.id, '8.4.40');

  const r2 = sandhi.join('तत्', 'टीका');
  assert.equal(r2.text, 'तट्टीका');
  assert.equal(r2.rule.id, '8.4.41');
});

test('Hal-sandhi: jastva (8.2.39) and anunasika (8.4.45)', () => {
  const r1 = sandhi.join('वाक्', 'ईशः');
  assert.equal(r1.text, 'वागीशः');
  assert.equal(r1.rule.id, '8.2.39');

  const r2 = sandhi.join('जगत्', 'नाथः');
  assert.equal(r2.text, 'जगन्नाथः');
  assert.equal(r2.rule.id, '8.4.45');
});

test('Hal-sandhi: anusvara (8.3.23), tor li (8.4.60), che ca (6.1.73)', () => {
  const r1 = sandhi.join('सत्यम्', 'वद');
  assert.equal(r1.text, 'सत्यं वद');
  assert.equal(r1.rule.id, '8.3.23');

  const r2 = sandhi.join('तत्', 'लयः');
  assert.equal(r2.text, 'तल्लयः');
  assert.equal(r2.rule.id, '8.4.60');

  const r3 = sandhi.join('शिव', 'छाया');
  assert.equal(r3.text, 'शिवच्छाया');
  assert.equal(r3.rule.id, '6.1.73');
});

test('Visarga-sandhi: utva with avagraha (6.1.113) and hasi ca (6.1.114)', () => {
  const r1 = sandhi.join('रामः', 'अयम्');
  assert.equal(r1.text, 'रामोऽयम्');
  assert.equal(r1.rule.id, '6.1.113');

  const r2 = sandhi.join('रामः', 'गच्छति');
  assert.equal(r2.text, 'रामो गच्छति');
  assert.equal(r2.rule.id, '6.1.114');
});

test('Visarga-sandhi: visarjaniya sa (8.3.34) and sa/esa lopa (6.1.132)', () => {
  const r1 = sandhi.join('नमः', 'ते');
  assert.equal(r1.text, 'नमस्ते');
  assert.equal(r1.rule.id, '8.3.34');

  const r2 = sandhi.join('सः', 'गच्छति');
  assert.equal(r2.text, 'स गच्छति');
  assert.equal(r2.rule.id, '6.1.132');

  const r3 = sandhi.join('एषः', 'वदति');
  assert.equal(r3.text, 'एष वदति');
  assert.equal(r3.rule.id, '6.1.132');
});

test('Visarga-sandhi: lopa after aa (8.3.17) and ro ri (8.3.14)', () => {
  const r1 = sandhi.join('देवाः', 'गच्छन्ति');
  assert.equal(r1.text, 'देवा गच्छन्ति');
  assert.equal(r1.rule.id, '8.3.17/22');

  const r2 = sandhi.join('पुनः', 'रमते');
  assert.equal(r2.text, 'पुना रमते');
  assert.equal(r2.rule.id, '8.3.14/6.3.111');
});

test('joinMany: sequential sandhi across multiple words', () => {
  const r = sandhi.joinMany(['सत्यम्', 'वद']);
  assert.equal(r.text, 'सत्यं वद');
  assert.equal(r.steps.length, 1);
});

test('Cheda (segmentation): decomposes compound and cites rule', () => {
  const s1 = sandhi.split('महेशः');
  assert.ok(s1.some(c => (c.left === 'महा' || c.left === 'मह') && (c.right === 'ईशः' || c.right === 'इशः') && c.rule.id === '6.1.87'));

  const s2 = sandhi.split('रामोऽयम्');
  assert.ok(s2.some(c => c.left === 'रामः' && c.right === 'अयम्' && c.rule.id === '6.1.113'));

  const s3 = sandhi.split('सच्चित्');
  assert.ok(s3.some(c => c.left === 'सत्' && c.right === 'चित्' && c.rule.id === '8.4.40'));
});

test('Sentence checking: verifies valid and catches violations', () => {
  // Correct sentence with anusvara rule applied: सत्यं वद
  const c1 = sandhi.checkSentence('सत्यं वद');
  assert.equal(c1.ok, true);
  assert.equal(c1.verdict, 'verified');

  // Violation: satyam vada written with final 'm' before consonant
  const c2 = sandhi.checkSentence('सत्यम् वद');
  assert.equal(c2.ok, false);
  assert.equal(c2.verdict, 'sandhi-violation');
  assert.equal(c2.violations, 1);
  assert.match(c2.junctures[0].note, /8.3.23/);

  // Correct: sa gacchati (visarga dropped before consonant)
  const c3 = sandhi.checkSentence('स गच्छति');
  assert.equal(c3.ok, true);

  // Violation: saḥ gacchati (retaining visarga)
  const c4 = sandhi.checkSentence('सः गच्छति');
  assert.equal(c4.ok, false);
  assert.match(c4.junctures[0].note, /6.1.132/);
});
