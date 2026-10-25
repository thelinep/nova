'use strict';
/**
 * Lipi OS letters board: every Devanagari character Lipi OS converts, grouped on boards
 * (vowels, vowel signs, the five vargas, semivowels, sibilants, signs, nukta and regional
 * letters, digits, punctuation), with its grammar, a recorded sound, the scripts that write
 * it and further reading. Data: lib/lipi-letters.json (tools/build-lipi-letters.py);
 * sounds: public/lipi-sounds/ (tools/render-lipi-letter-sounds.py).
 */
const fs = require('node:fs');
const path = require('node:path');
const lipiScripts = require('./lipi-scripts');

let cache = null;
function load() {
  if (cache) return cache;
  cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'lipi-letters.json'), 'utf8'));
  return cache;
}

/** The whole board, each letter with its sample written in every script that can write it. */
function board() {
  const d = load();
  const scripts = lipiScripts.list().filter(s => s.code !== 'Deva' && s.code !== 'Khar');
  const letters = d.letters.map(l => {
    const renders = { Deva: l.sample };
    const writes = l.scripts.writes.includes('Brah') ? [...l.scripts.writes, 'Brah+'] : l.scripts.writes;
    for (const code of writes) {
      const r = lipiScripts.fromDeva(l.sample, code);
      renders[code] = r.missing.length ? null : r.text;
    }
    return { ...l, scripts: { writes, lacks: l.scripts.lacks.includes('Brah') ? [...l.scripts.lacks, 'Brah+'] : l.scripts.lacks }, renders };
  });
  return {
    format: d.format, boards: d.boards, regions: d.regions, sources: d.sources,
    scripts: scripts.map(s => ({ code: s.code, label: s.label, hi: s.hi, region: d.regions[s.sameAs || s.code] || '' })),
    counts: { letters: letters.length, withSound: letters.filter(l => l.sound.file).length, boards: d.boards.length },
    letters,
  };
}

/** One letter by its character (or by U+XXXX code point). */
function letter(key) {
  const k = String(key || '');
  const cp = /^u\+?([0-9a-f]{4,5})$/i.exec(k);
  const ch = cp ? String.fromCodePoint(parseInt(cp[1], 16)) : k.normalize('NFC');
  const found = board().letters.find(l => l.char === ch || l.char === k);
  if (!found) throw Object.assign(new Error('Lipi OS has no letter ' + k + '.'), { statusCode: 404 });
  return found;
}

module.exports = { board, letter, _reset: () => { cache = null; } };
