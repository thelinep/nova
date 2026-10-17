// ===========================================================================
// Character Studio lip-sync: phonemes → visemes → mouth shapes over time.
//   phonemes come from Kokoro's own phonemizer (the same sounds the voice says)
//   or, without Kokoro, from simple English / Devanagari spelling rules.
//   align() spreads them over the voiced parts of the actual audio, so the
//   mouth closes in pauses and moves with each syllable.
// Plain JavaScript (no three.js): used by the 2D puppet and the 3D model.
// ===========================================================================

// Mouth shape for each viseme: open (jaw), wide (stretch), round (pucker), bite (lip on teeth).
export const VISEMES = {
  sil: { open: 0,    wide: 0,    round: 0,   bite: 0 },
  PP:  { open: 0,    wide: -0.1, round: 0,   bite: 0 },   // p b m: lips pressed
  FF:  { open: 0.1,  wide: 0.1,  round: 0,   bite: 1 },   // f v: lower lip on teeth
  TH:  { open: 0.18, wide: 0.2,  round: 0,   bite: 0.5 },
  DD:  { open: 0.25, wide: 0.15, round: 0,   bite: 0 },   // t d n l
  kk:  { open: 0.32, wide: 0.1,  round: 0,   bite: 0 },   // k g ŋ
  CH:  { open: 0.22, wide: -0.1, round: 0.55, bite: 0 },  // ch j sh
  SS:  { open: 0.1,  wide: 0.6,  round: 0,   bite: 0 },   // s z
  RR:  { open: 0.25, wide: -0.1, round: 0.4, bite: 0 },
  aa:  { open: 0.85, wide: 0.15, round: 0,   bite: 0 },
  E:   { open: 0.5,  wide: 0.55, round: 0,   bite: 0 },
  I:   { open: 0.28, wide: 0.85, round: 0,   bite: 0 },
  O:   { open: 0.6,  wide: -0.2, round: 0.8, bite: 0 },
  U:   { open: 0.28, wide: -0.3, round: 1,   bite: 0 },
};
const VOWELS = new Set(['aa', 'E', 'I', 'O', 'U']);

/* ------------------------------- IPA → visemes ------------------------------- */
const IPA = [
  ['tʃ', 'CH'], ['dʒ', 'CH'], ['oʊ', 'O'], ['aɪ', 'aa'], ['aʊ', 'aa'], ['eɪ', 'E'], ['ɔɪ', 'O'],
  ['p', 'PP'], ['b', 'PP'], ['m', 'PP'], ['ɱ', 'PP'], ['f', 'FF'], ['v', 'FF'], ['ʋ', 'FF'], ['θ', 'TH'], ['ð', 'TH'],
  ['t', 'DD'], ['d', 'DD'], ['n', 'DD'], ['l', 'DD'], ['ɾ', 'DD'], ['ʈ', 'DD'], ['ɖ', 'DD'], ['ɳ', 'DD'], ['ɭ', 'DD'], ['ɽ', 'DD'],
  ['k', 'kk'], ['g', 'kk'], ['ɡ', 'kk'], ['ŋ', 'kk'], ['x', 'kk'], ['ɣ', 'kk'], ['q', 'kk'], ['ʔ', 'sil'],
  ['ʃ', 'CH'], ['ʒ', 'CH'], ['ɕ', 'CH'], ['ʑ', 'CH'], ['c', 'CH'], ['ɟ', 'CH'], ['ʂ', 'CH'],
  ['s', 'SS'], ['z', 'SS'], ['ɹ', 'RR'], ['r', 'RR'], ['ɻ', 'RR'], ['ɚ', 'RR'], ['ɝ', 'RR'],
  ['a', 'aa'], ['ɑ', 'aa'], ['æ', 'aa'], ['ʌ', 'aa'], ['ɐ', 'aa'], ['ə', 'aa'], ['h', 'aa'], ['ɦ', 'aa'],
  ['e', 'E'], ['ɛ', 'E'], ['ɜ', 'E'], ['i', 'I'], ['ɪ', 'I'], ['y', 'I'], ['j', 'I'], ['ɨ', 'I'],
  ['o', 'O'], ['ɔ', 'O'], ['ɒ', 'O'], ['u', 'U'], ['ʊ', 'U'], ['w', 'U'], ['ʉ', 'U'],
];
/** Visemes from an IPA string (what Kokoro's phonemizer returns). Words are split by '|'. */
export function fromIPA(ipa) {
  const out = []; const s = String(ipa || '').normalize('NFD');
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (/[\s]/.test(ch)) { if (out.length && out[out.length - 1] !== '|') out.push('|'); i++; continue; }
    if (/[,.;:!?—–-]/.test(ch)) { out.push(ch === ',' || ch === ';' ? ',' : '.'); i++; continue; }
    let hit = null; for (const [k, v] of IPA) if (s.startsWith(k, i)) { hit = [k, v]; break; }
    if (hit) { if (hit[1] !== 'sil' || out[out.length - 1] !== 'sil') out.push(hit[1]); i += hit[0].length; } else i++; // stress marks, length, nasal tilde
  }
  return out;
}

/* --------------------------- spelling → visemes (fallback) --------------------------- */
const DEV = {
  'प': 'PP', 'फ': 'PP', 'ब': 'PP', 'भ': 'PP', 'म': 'PP', 'फ़': 'FF', 'व': 'U',
  'त': 'DD', 'थ': 'DD', 'द': 'DD', 'ध': 'DD', 'न': 'DD', 'ट': 'DD', 'ठ': 'DD', 'ड': 'DD', 'ढ': 'DD', 'ण': 'DD', 'ल': 'DD', 'ड़': 'DD', 'ढ़': 'DD',
  'क': 'kk', 'ख': 'kk', 'ग': 'kk', 'घ': 'kk', 'ङ': 'kk', 'क़': 'kk', 'ख़': 'kk', 'ग़': 'kk',
  'च': 'CH', 'छ': 'CH', 'ज': 'CH', 'झ': 'CH', 'ञ': 'CH', 'श': 'CH', 'ष': 'CH', 'स': 'SS', 'ज़': 'SS', 'र': 'RR', 'य': 'I', 'ह': 'aa',
  'अ': 'aa', 'आ': 'aa', 'इ': 'I', 'ई': 'I', 'उ': 'U', 'ऊ': 'U', 'ऋ': 'RR', 'ए': 'E', 'ऐ': 'E', 'ओ': 'O', 'औ': 'O',
  'ा': 'aa', 'ि': 'I', 'ी': 'I', 'ु': 'U', 'ू': 'U', 'ृ': 'RR', 'े': 'E', 'ै': 'E', 'ो': 'O', 'ौ': 'O',
};
const MATRA = new Set(['ा', 'ि', 'ी', 'ु', 'ू', 'ृ', 'े', 'ै', 'ो', 'ौ', '्']);
const EN = [['th', 'TH'], ['sh', 'CH'], ['ch', 'CH'], ['ph', 'FF'], ['ee', 'I'], ['oo', 'U'], ['ou', 'aa'], ['ow', 'O'], ['ai', 'E'], ['ay', 'E'], ['ng', 'kk'],
  ['b', 'PP'], ['m', 'PP'], ['p', 'PP'], ['f', 'FF'], ['v', 'FF'], ['t', 'DD'], ['d', 'DD'], ['n', 'DD'], ['l', 'DD'], ['k', 'kk'], ['c', 'kk'], ['g', 'kk'], ['q', 'kk'], ['x', 'kk'],
  ['j', 'CH'], ['s', 'SS'], ['z', 'SS'], ['r', 'RR'], ['a', 'aa'], ['e', 'E'], ['i', 'I'], ['y', 'I'], ['o', 'O'], ['u', 'U'], ['w', 'U'], ['h', 'aa']];
/** Visemes from plain text when no phonemizer is available. Devanagari is close to phonetic. */
export function fromText(text) {
  const out = []; const s = String(text || '').toLowerCase().normalize('NFC');
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i];
    if (chars[i + 1] === '़') { ch += '़'; i++; }            // nukta
    if (/\s/.test(ch)) { if (out.length && out[out.length - 1] !== '|') out.push('|'); continue; }
    if (/[,.;:!?।—–-]/.test(ch)) { out.push(/[,;]/.test(ch) ? ',' : '.'); continue; }
    if (DEV[ch]) {
      out.push(DEV[ch]);
      const next = chars[i + 1];
      const isConsonant = /[क-हक़-य़]/.test(ch[0]);
      if (isConsonant && !(next && (MATRA.has(next) || next === '़')) && next && /[ऀ-ॿ]/.test(next)) out.push('aa'); // inherent a
      continue;
    }
    if (/[ंँ]/.test(ch)) { out.push('DD'); continue; }
    if (/[a-z]/.test(ch)) { const rest = s.slice([...s].slice(0, i).join('').length); let hit = EN.find(([k]) => rest.startsWith(k)); if (hit) { out.push(hit[1]); i += [...hit[0]].length - 1; } }
  }
  return out;
}

/* ------------------------------- align to audio ------------------------------- */
/** Voiced stretches of an AudioBuffer (or Float32Array + rate): [[start, end], …] in seconds. */
export function voiced(samples, rate) {
  const hop = Math.round(rate * 0.01), n = Math.floor(samples.length / hop), env = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * hop; j < (i + 1) * hop; j++) s += samples[j] * samples[j]; env[i] = Math.sqrt(s / hop); if (env[i] > peak) peak = env[i]; }
  const th = Math.max(0.008, peak * 0.08), parts = [];
  let start = -1;
  for (let i = 0; i <= n; i++) { const on = i < n && env[i] > th; if (on && start < 0) start = i; if (!on && start >= 0) { parts.push([start * 0.01, i * 0.01]); start = -1; } }
  const merged = []; for (const p of parts) { const last = merged[merged.length - 1]; if (last && p[0] - last[1] < 0.07) last[1] = p[1]; else merged.push([...p]); }
  return { parts: merged.filter(p => p[1] - p[0] > 0.03), env, hop: 0.01, peak };
}
/**
 * A viseme track: [{ t0, t1, v }] covering the audio. Phonemes are spread over
 * the voiced stretches in proportion to their weight (vowels last longer).
 */
export function align(visemes, samples, rate) {
  const dur = samples.length / rate;
  const { parts, env, peak } = voiced(samples, rate);
  const seq = visemes.filter(v => VISEMES[v]);
  if (!seq.length || !parts.length) return { events: [], env, peak, dur };
  const weight = v => VOWELS.has(v) ? 1.7 : v === 'PP' || v === 'FF' ? 1.1 : 0.9;
  const total = seq.reduce((a, v) => a + weight(v), 0), voicedTime = parts.reduce((a, p) => a + p[1] - p[0], 0);
  const events = []; let pi = 0, used = 0;
  for (const v of seq) {
    let len = weight(v) / total * voicedTime;
    while (len > 1e-6 && pi < parts.length) {
      const [a, b] = parts[pi], t0 = a + used, room = b - t0, take = Math.min(room, len);
      events.push({ t0, t1: t0 + take, v }); len -= take; used += take;
      if (used >= b - a - 1e-6) { pi++; used = 0; }
    }
  }
  return { events, env, peak, dur };
}
/** Mouth shape at time t (seconds) with short cross-fades, scaled by loudness. */
export function sample(track, t) {
  const out = { open: 0, wide: 0, round: 0, bite: 0 };
  if (!track || !track.events.length || t < 0 || t > track.dur) return out;
  const ev = track.events; let i = 0; while (i < ev.length - 1 && ev[i].t1 < t) i++;
  const e = ev[i]; if (t < e.t0 - 0.06 || t > e.t1 + 0.06) return out;
  const fade = 0.045, mix = (a, b, k) => { for (const key of Object.keys(out)) out[key] = a[key] + (b[key] - a[key]) * k; };
  const cur = VISEMES[e.v];
  if (t < e.t0) mix(VISEMES.sil, cur, Math.max(0, 1 - (e.t0 - t) / 0.06));
  else if (t > e.t1) mix(cur, VISEMES.sil, Math.min(1, (t - e.t1) / 0.06));
  else { const next = ev[i + 1] && ev[i + 1].t0 - e.t1 < 0.02 ? VISEMES[ev[i + 1].v] : null; const k = next && e.t1 - t < fade ? 1 - (e.t1 - t) / fade : 0; mix(cur, next || cur, k * 0.5); }
  const idx = Math.min(track.env.length - 1, Math.floor(t / 0.01)), loud = track.peak ? Math.min(1, track.env[idx] / track.peak * 2.2) : 1;
  out.open *= 0.55 + 0.45 * loud;
  return out;
}
