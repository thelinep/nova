'use strict';
/* Brahmi Notepad core: Roman (ITRANS / Harvard-Kyoto / IAST) and Devanagari to Brahmi. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pad = require('../lib/brahmi-pad');
const panini = require('../lib/panini');
const data = require('../lib/panini-data.json');

const plain = (deva, iast) => !/[≍ᳵᳶ॒॑'’ऽ]/.test(deva + iast);

test('Devanagari gives the same Brahmi as the Lipi table, on every sutra', () => {
  let n = 0;
  for (const [id, deva] of data.sutras) {
    if (/[≍ᳵᳶ॒॑]/.test(deva)) continue;
    assert.equal(pad.toBrahmi(deva), panini.fromDeva(deva, 'brahmi'), id); n++;
  }
  assert.ok(n > 3900);
});

test('IAST gives the same Brahmi as the Devanagari, and reads back unchanged', () => {
  for (const [id, deva, iast] of data.sutras) {
    if (!plain(deva, iast)) continue;
    const b = pad.toBrahmi(iast, { scheme: 'iast' });
    assert.equal(b, panini.fromDeva(deva, 'brahmi'), id);
    assert.equal(pad.toIast(b), iast.normalize('NFC'), id);
  }
});

test('ITRANS, Harvard-Kyoto and IAST spellings of a word agree', () => {
  const same = (words, expect) => { for (const w of words) assert.equal(pad.toBrahmi(w), pad.toBrahmi(expect), w); };
  same(['dharmaH', 'dharmaḥ'], 'धर्मः');
  same(['ashoka', 'azoka', 'aśoka'], 'अशोक');
  same(['kShatriya', 'kSatriya', 'kṣatriya', 'xatriya'], 'क्षत्रिय');
  same(['jñAna', 'GYAna', 'jJAna'], 'ज्ञान');
  same(['R^iShi', 'RRiShi', 'RSi', 'ṛṣi'], 'ऋषि');
  same(['gaN^gA', 'gaGgA', 'gaṅgā', 'ga~NgA'], 'गङ्गा');
  same(['buddhaM sharaNaM gachChAmi'], 'बुद्धं शरणं गच्छामि');
  assert.equal(pad.toBrahmi('dharma'), '𑀥𑀭𑁆𑀫');
});

test('"ch" is च in ITRANS and छ in IAST; auto mode decides by diacritics', () => {
  assert.equal(pad.scheme('chakra'), 'itrans');
  assert.equal(pad.scheme('chandaḥ'), 'iast');
  assert.equal(pad.toBrahmi('chakra'), pad.toBrahmi('चक्र'));
  assert.equal(pad.toBrahmi('chandaḥ'), pad.toBrahmi('छन्दः'));
  assert.equal(pad.toBrahmi('chandas', { scheme: 'iast' }), pad.toBrahmi('छन्दस्'));
  assert.equal(pad.toBrahmi('chhAyA'), pad.toBrahmi('छाया'));
  assert.equal(pad.toBrahmi('māsha'), pad.toBrahmi('मास्ह'), 'in IAST, sh is s + h');
  assert.equal(pad.toBrahmi('mAsha'), pad.toBrahmi('माश'), 'in ITRANS, sh is ś');
});

test('a final consonant takes a virama; Brahmi from the keyboard passes through and joins', () => {
  assert.equal(pad.toBrahmi('vAk'), pad.toBrahmi('वाक्'));
  const [ki] = pad.KEYBOARD.signs.find(([, l]) => l === '◌i');
  assert.equal(pad.toBrahmi('k' + ki), pad.toBrahmi('कि'), 'a typed consonant takes a keyboard vowel sign');
  assert.equal(pad.toBrahmi('𑀥𑀫𑁆𑀫 dhamma'), '𑀥𑀫𑁆𑀫 𑀥𑀫𑁆𑀫');
  assert.equal(pad.toBrahmi('2025 | ||'), '𑁨𑁦𑁨𑁫 𑁇 𑁈');
  assert.equal(pad.toBrahmi('Hello, world'.toLowerCase()), pad.toBrahmi('हेल्लो, वोर्ल्द्'));
});

test('the keyboard covers the varnamala in order', () => {
  assert.equal(pad.KEYBOARD.vowels.length, 14);
  assert.equal(pad.KEYBOARD.consonants.length, 34);
  assert.equal(pad.KEYBOARD.consonants[0][1], 'ka');
  assert.equal(pad.KEYBOARD.signs.length, 13);
  assert.ok(pad.KEYBOARD.marks.some(([ch]) => ch === pad.VIRAMA));
});

test('Workstation notes keep the typed text and derive the Brahmi', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { openDb, Store } = require('../lib/db');
  const notes = require('../lib/brahmi-notes');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-bp-'));
  const { db } = openDb(dir); const store = new Store(db);
  try {
    const a = notes.create(store, { src: 'dharma' });
    assert.equal(a.brahmi, '𑀥𑀭𑁆𑀫');
    assert.equal(a.reading, 'dharma');
    const b = notes.update(store, a.id, { src: 'chandas', scheme: 'iast' });
    assert.equal(b.brahmi, pad.toBrahmi('छन्दस्'));
    assert.equal(b.readAs, 'iast');
    assert.equal(notes.list(store).length, 1);
    assert.equal(notes.exportText(store, a.id), b.brahmi + '\n');
    assert.match(notes.exportText(store, a.id, 'both'), /chandas/);
    assert.deepEqual(notes.convert({ text: 'dhamma' }).brahmi, '𑀥𑀫𑁆𑀫');
    assert.throws(() => notes.create(store, { src: 'x'.repeat(100001) }), /at most/);
    notes.remove(store, a.id);
    assert.throws(() => notes.get(store, a.id), /Unknown note/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
