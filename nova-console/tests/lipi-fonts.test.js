'use strict';
// Halant display: Maataa's conjunct fonts are shipped and served, and "show halant" inserts
// a zero-width non-joiner after a virama that would otherwise join two letters.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lipi = require('../lib/lipi-scripts');

const ZWNJ = '‌';

test('the Maataa conjunct fonts are present, WOFF2 and renamed', () => {
  for (const slug of ['brahmi', 'sharada', 'dives-akuru', 'kharoshthi']) {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'public', 'fonts', 'lipi', `maataa-lipi-${slug}.woff2`));
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2', slug + ' is WOFF2');
    assert.ok(buf.length > 10000 && buf.length < 400000, slug + ' size');
  }
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'fonts', 'lipi', 'OFL-LICENSE.txt')), 'the OFL travels with the fonts');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'tools', 'build-lipi-conjunct-fonts.py')), 'the fonts can be rebuilt');
});

test('joined by default: a Brahmi conjunct is virama + consonant with nothing between', () => {
  const t = lipi.fromDeva('धर्म', 'Brah').text;
  assert.equal(t, '\u{11025}\u{1102D}\u{11046}\u{1102B}');
  assert.ok(!t.includes(ZWNJ));
});

test('visible halant: ZWNJ after a virama before a letter, not at the end of a word', () => {
  const t = lipi.fromDeva('धर्म त्', 'Brah', { halant: 'visible' }).text;
  assert.equal(t, '\u{11025}\u{1102D}\u{11046}' + ZWNJ + '\u{1102B} \u{11022}\u{11046}');
  const kawi = lipi.fromDeva('धर्म', 'Kawi', { halant: 'visible' }).text;
  assert.ok(!kawi.includes('\u{11F42}') && kawi.includes('\u{11F41}' + ZWNJ), 'Kawi uses its killer, not the conjoiner');
  const conv = lipi.convert('क्त', { scripts: ['Shrd', 'Khar'], halant: 'visible' });
  assert.equal(conv.halant, 'visible');
  for (const r of conv.results) assert.ok(r.text.includes(ZWNJ), r.code + ' shows its halant');
});

test('Brahmi and Brahmi+ hold the same text and differ only in font', () => {
  assert.equal(lipi.fromDeva('धर्म', 'Brah+').text, lipi.fromDeva('धर्म', 'Brah').text);
  const r = lipi.convert('धर्म', { scripts: ['Brah', 'Brah+'] }).results;
  assert.equal(r[0].text, r[1].text); assert.equal(r[1].label, 'Brahmi+');
  assert.equal(lipi.fromDeva('क्त', 'Brah+', { halant: 'visible' }).text, '\u{11013}\u{11046}\u200C\u{11022}');
});

test('every script reports how its halant shows', () => {
  const list = lipi.list();
  for (const s of list) assert.ok(['stacked', 'partial', 'visible'].includes(s.halant), s.code);
  const by = Object.fromEntries(list.map(s => [s.code, s.halant]));
  assert.equal(by.Brah, 'visible'); assert.equal(by['Brah+'], 'stacked'); assert.equal(by.Takr, 'visible'); assert.equal(by.Khar, 'stacked');
  assert.equal(lipi.viramaOf('Brah'), '\u{11046}');
});
