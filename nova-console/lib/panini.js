'use strict';

// The Ashtadhyayi (all 3,983 sutras) and the Dhatupatha for Maataa Workstation.
// Data: lib/panini-data.json, written by `python -m guru panini-json` from guru/data/panini
// (Vidyut by ambuda.org, MIT licence; data shared by ashtadhyayi.com).

const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, 'panini-data.json');
const SCRIPTS = ['devanagari', 'iast', 'slp1', 'brahmi', 'kharoshthi', 'siddham'];
const ID = /^([1-8])\.([1-4])\.(\d{1,3})$/;
const RANGE = /^([1-8]\.[1-4]\.\d{1,3})\s*[-–]\s*([1-8]\.[1-4]\.\d{1,3})$/;
let cache = null;

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function load() {
  if (cache) return cache;
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const sutras = raw.sutras.map(([id, deva, iast, slp1], index) => {
    const [adhyaya, pada, number] = id.split('.').map(Number);
    return { id, adhyaya, pada, number, deva, iast, slp1, index };
  });
  const byId = new Map(sutras.map(s => [s.id, s]));
  const padas = [];
  for (const s of sutras) {
    const last = padas[padas.length - 1];
    if (last && last.adhyaya === s.adhyaya && last.pada === s.pada) last.count += 1;
    else padas.push({ adhyaya: s.adhyaya, pada: s.pada, first: s.id, count: 1 });
  }
  const dhatus = raw.dhatus.map(([code, root, meaning]) => {
    const gana = Number(code.split('.')[0]);
    return { code, root, meaning, gana, ganaName: raw.ganas[String(gana)] || '' };
  });
  const toDeva = {};
  for (const script of ['brahmi', 'siddham']) {
    toDeva[script] = {};
    for (const [deva, ch] of Object.entries(raw.lipi.from_deva[script])) toDeva[script][ch] = deva;
  }
  cache = { source: raw.source, sutras, byId, padas, dhatus, lipi: raw.lipi, toDeva, keys: null };
  cache.keys = sutras.map(s => key(s.deva));
  return cache;
}

// --- scripts ---------------------------------------------------------------------
function fromDeva(text, script) {
  const { lipi } = load();
  const map = lipi.from_deva[script];
  if (!map) throw error(`Unknown script ${script}.`);
  const out = [];
  const K = lipi.kharoshthi;
  for (const ch of String(text).normalize('NFD')) {
    const cp = ch.codePointAt(0);
    if (cp < 0x0900 || cp > 0x097f) { out.push(ch); continue; }
    if (script === 'kharoshthi') {
      if (cp >= 0x0966 && cp <= 0x096f) { out.push(ch); continue; } // Kharoshthi numbers are additive
      if (K.independent[ch]) { const [sign, long] = K.independent[ch]; out.push(K.a + (sign ? K.signs[sign] : '') + (long ? K.length : '')); continue; }
      if (K.dependent[ch]) { const [sign, long] = K.dependent[ch]; out.push((sign ? K.signs[sign] : '') + (long ? K.length : '')); continue; }
    }
    if (ch === '़') continue; // nukta: no equivalent
    out.push(map[ch] || ch);
  }
  return out.join('');
}

function show(sutra, script = 'devanagari') {
  if (script === 'devanagari') return sutra.deva;
  if (script === 'iast') return sutra.iast;
  if (script === 'slp1') return sutra.slp1;
  return fromDeva(sutra.deva, script);
}

function toDevaText(text) {
  const { toDeva } = load();
  let out = '';
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x11000 && cp <= 0x1107f) out += toDeva.brahmi[ch] ?? ch;
    else if (cp >= 0x11580 && cp <= 0x115ff) out += toDeva.siddham[ch] ?? ch;
    else out += ch;
  }
  return out.normalize('NFC');
}

// Compares wording, ignoring spaces, accents and punctuation.
function key(text) {
  return toDevaText(text).replace(/[\s॒॑।॥.,;:!?'"()\-–—]/gu, '');
}
function latinKey(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

// --- lookups -----------------------------------------------------------------------
function view(s, script) {
  const { sutras } = load();
  return { id: s.id, adhyaya: s.adhyaya, pada: s.pada, number: s.number, text: show(s, script), devanagari: s.deva, iast: s.iast,
    previous: s.index ? sutras[s.index - 1].id : null, next: s.index + 1 < sutras.length ? sutras[s.index + 1].id : null };
}

function info() {
  const { source, sutras, padas, dhatus } = load();
  return { source, total: sutras.length, padas, dhatus: dhatus.length, scripts: SCRIPTS };
}

function get(id, script = 'devanagari') {
  const s = load().byId.get(String(id).trim());
  return s ? view(s, script) : null;
}

function search(query, { script = 'devanagari', limit = 60 } = {}) {
  if (!SCRIPTS.includes(script)) throw error(`Script must be one of ${SCRIPTS.join(', ')}.`);
  const q = String(query || '').trim();
  const { sutras, byId, keys, padas } = load();
  if (!q) return { kind: 'empty', results: [] };
  const range = q.match(RANGE);
  if (range) {
    const a = byId.get(range[1]), b = byId.get(range[2]);
    if (!a || !b) throw error('No such sutra number in that range.', 404);
    const [lo, hi] = a.index <= b.index ? [a, b] : [b, a];
    if (hi.index - lo.index >= 400) throw error('Ask for at most 400 sutras at a time.');
    return { kind: 'range', results: sutras.slice(lo.index, hi.index + 1).map(s => view(s, script)) };
  }
  const id = q.match(ID);
  if (id) {
    const s = byId.get(q);
    if (!s) {
      const pada = padas.find(p => p.adhyaya === Number(id[1]) && p.pada === Number(id[2]));
      return { kind: 'missing', results: [], message: `There is no sutra ${q}. Pada ${id[1]}.${id[2]} has ${pada.count} sutras.` };
    }
    return { kind: 'number', results: [view(s, script)] };
  }
  const pada = q.match(/^([1-8])\.([1-4])$/);
  if (pada) {
    return { kind: 'pada', results: sutras.filter(s => s.adhyaya === Number(pada[1]) && s.pada === Number(pada[2])).map(s => view(s, script)) };
  }
  let hits;
  if (/[a-zA-Z]/.test(q) && !/[ऀ-ॿ]/.test(q)) {
    const lk = latinKey(q), raw = q.replace(/\s/g, '');
    hits = sutras.filter(s => latinKey(s.iast).includes(lk) || s.slp1.replace(/\s/g, '').includes(raw));
  } else {
    const k = key(q);
    hits = k ? sutras.filter((_, i) => keys[i].includes(k)) : [];
  }
  return { kind: 'words', total: hits.length, results: hits.slice(0, limit).map(s => view(s, script)) };
}

function rootForms(deva) {
  let k = key(deva).replace(/ँ/g, '');
  const forms = new Set([k]);
  for (const pre of ['ञि', 'टु', 'डु']) if (k.startsWith(pre) && k.length > pre.length + 1) { k = k.slice(pre.length); forms.add(k); }
  for (const end of ['ञ्', 'ङ्', 'ष्']) if (k.endsWith(end)) { k = k.slice(0, -end.length); forms.add(k); }
  const last = k.slice(-1);
  if ((last >= 'ा' && last <= 'ौ') || last === 'ॢ' || last === 'ॣ') forms.add(k.slice(0, -1) + '्');
  else if (last >= 'क' && last <= 'ह') forms.add(k + '्');
  return forms;
}

function dhatu(root, limit = 40) {
  const q = key(root).replace(/ँ/g, '');
  if (!q) return [];
  const { dhatus } = load();
  const exact = dhatus.filter(d => { const f = rootForms(d.root); return f.has(q) || f.has(q + '्'); });
  return (exact.length ? exact : dhatus.filter(d => key(d.root).replace(/ँ/g, '').startsWith(q))).slice(0, limit);
}

// --- citations -----------------------------------------------------------------------
// Same rules as guru/guru/sutra.py check_citations(): finds 1.1.1 / 1/1/1 / १.१.१ and checks
// that the sutra exists and that words quoted with it (right after it, or right before it
// in brackets) are its text and not another sutra's.
const CITE = /(?<![\d.])([1-8])\s*[./।]\s*([1-4])\s*[./।]\s*(\d{1,3})(?![\d.]\d)/g;
const DEVA_RUN = /^[\s:–—\-("'“‘]*([\u0900-\u097f\u1cd0-\u1cff][\u0900-\u097f\u1cd0-\u1cff\s]*)/u;
const DEVA_BEFORE = /([\u0900-\u097f\u1cd0-\u1cff][\u0900-\u097f\u1cd0-\u1cff\s]*?)[\s"'”’]*[(\[]\s*$/u;
const DIGITS = { '०':'0', '१':'1', '२':'2', '३':'3', '४':'4', '५':'5', '६':'6', '७':'7', '८':'8', '९':'9' };

function checkCitations(text) {
  const { sutras, keys } = load();
  const src = String(text || '').normalize('NFC').replace(/[०-९]/g, d => DIGITS[d]);
  const out = [];
  for (const m of src.matchAll(CITE)) {
    const id = `${m[1]}.${m[2]}.${Number(m[3])}`, s = load().byId.get(id);
    const row = { cite: m[0], id, status: 'unknown', quoted: '', expected: s ? s.deva : null, looksLike: null };
    out.push(row);
    if (!s) continue;
    const start = m.index, end = m.index + m[0].length;
    const bracketed = /[(\[]\s*$/.test(src.slice(Math.max(0, start - 3), start));
    let quoted, hit;
    if (bracketed) {
      const run = src.slice(Math.max(0, start - 160), start).match(DEVA_BEFORE);
      quoted = run ? run[1].trim().split('\n').pop() : '';
      const k = key(quoted); hit = kk => !!k && k.endsWith(kk);
    } else {
      const run = src.slice(end).match(DEVA_RUN);
      quoted = run ? run[1].trim().split('\n')[0] : '';
      const k = key(quoted); hit = kk => !!k && k.startsWith(kk);
    }
    row.quoted = quoted;
    if (quoted && hit(keys[s.index])) { row.status = 'ok'; continue; }
    let best = null;
    if (quoted) sutras.forEach((t, i) => { if (keys[i].length >= 4 && hit(keys[i]) && (!best || keys[i].length > keys[best.index].length)) best = t; });
    if (best) { row.status = 'mismatch'; row.looksLike = `${best.id} ${best.deva}`; } else row.status = 'number';
  }
  return out;
}

function dhatuByCode(code) { return load().dhatus.find(d => d.code === String(code)) || null; }

module.exports = { SCRIPTS, info, get, search, dhatu, dhatuByCode, fromDeva, toDevaText, show, key, checkCitations, _reset: () => { cache = null; } };
