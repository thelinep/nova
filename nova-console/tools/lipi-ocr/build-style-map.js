'use strict';
/**
 * Maps every Brahmi character the OCR reads to the same letter in later scripts of the Brahmi family
 * (Siddham, Bhaiksuki, Sharada, Nandinagari, Grantha, Kawi, Tirhuta), so synthetic lines can be drawn in
 * those letter shapes while the label stays in Brahmi. That teaches the model Gupta-period, Pallava and
 * Southeast Asian (Kawi) forms. Writes tools/lipi-ocr/style-map.json.
 *   node tools/lipi-ocr/build-style-map.js
 */
const fs = require('node:fs');
const path = require('node:path');
const scripts = require('../../lib/lipi-scripts');

const CHARSET = JSON.parse(process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : fs.readFileSync(path.join(__dirname, 'charset.json'), 'utf8'));
const TARGETS = ['Sidd', 'Bhks', 'Shrd', 'Nand', 'Gran', 'Kawi', 'Tirh'];
const KA = '\u{11013}';
const isSign = ch => { const c = ch.codePointAt(0); return (c >= 0x11000 && c <= 0x11002) || (c >= 0x11038 && c <= 0x11046); };

const out = {};
for (const code of TARGETS) {
  const m = {};
  const kaT = scripts.fromDeva('क', code).text;
  for (const ch of CHARSET) {
    // signs are converted on a ka and the ka is taken off again
    const src = isSign(ch) ? KA + ch : ch;
    const deva = scripts.toDeva(src, 'Brah');
    const r = scripts.fromDeva(deva, code);
    if (r.missing.length) { m[ch] = null; continue; }
    let t = r.text;
    if (isSign(ch)) { if (!t.startsWith(kaT)) { m[ch] = null; continue; } t = t.slice(kaT.length); }
    m[ch] = t || null;
  }
  out[code] = m;
}
fs.writeFileSync(path.join(__dirname, 'style-map.json'), JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) console.log(k, Object.values(v).filter(Boolean).length + '/' + CHARSET.length);
