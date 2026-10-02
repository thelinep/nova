'use strict';

// Sutra neurons: Neuron Factory presets that each learn one vowel-sandhi sutra of the
// Ashtadhyayi. The training examples are generated from the sutra's own definition
// (its pratyaharas and Panini's places of articulation), so the neuron can be checked
// against the rule exactly: every one of the 13 × 13 vowel pairs.
//
// Each neuron learns its own sutra in isolation. Which rule wins when several apply
// (for example 6.1.101 over 6.1.77 for इ + इ) is decided by the Ashtadhyayi's order of
// exceptions, not by the neuron; the card says so.

const panini = require('./panini');

// Places of articulation (sthana), as in Paniniya Shiksha and 1.1.9.
const STHANA = ['कण्ठ', 'तालु', 'मूर्धा', 'दन्त', 'ओष्ठ', 'कण्ठतालु', 'कण्ठोष्ठ'];
// [sthana, flag]: flag = long (dirgha) for simple vowels; for e/o vs ai/au it marks the vriddhi vowel.
const VOWELS = {
  'अ': [0, 0], 'आ': [0, 1], 'इ': [1, 0], 'ई': [1, 1], 'उ': [4, 0], 'ऊ': [4, 1], 'ऋ': [2, 0], 'ॠ': [2, 1],
  'ऌ': [3, 0], 'ए': [5, 0], 'ऐ': [5, 1], 'ओ': [6, 0], 'औ': [6, 1],
};
const LIST = Object.keys(VOWELS);
const IK = ['इ', 'ई', 'उ', 'ऊ', 'ऋ', 'ॠ', 'ऌ'];
const EC = ['ए', 'ऐ', 'ओ', 'औ'];
const AK = ['अ', 'आ', 'इ', 'ई', 'उ', 'ऊ', 'ऋ', 'ॠ', 'ऌ'];
const AT = ['अ', 'आ'];
const NONE = '—';
const BY_STHANA = (map, vowel) => map[VOWELS[vowel][0]];

const PRESETS = {
  'sandhi-yan': {
    sutra: '6.1.77', name: 'यण् sandhi neuron (6.1.77)',
    purpose: 'Learn sutra 6.1.77 इको यणचि: before a vowel, इ ई उ ऊ ऋ ॠ ऌ become य व र ल.',
    learns: 'Before any vowel, इक् (इ उ ऋ ऌ, short or long) is replaced by the यण् of the same place: य व र ल.',
    outputs: ['य्', 'व्', 'र्', 'ल्', NONE],
    rule: (l) => (IK.includes(l) ? BY_STHANA({ 1: 'य्', 4: 'व्', 2: 'र्', 3: 'ल्' }, l) : NONE),
    config: { hiddenSize: 12, epochs: 300, learningRate: 0.1, seed: 7 },
  },
  'sandhi-ayadi': {
    sutra: '6.1.78', name: 'अयादि sandhi neuron (6.1.78)',
    purpose: 'Learn sutra 6.1.78 एचोऽयवायावः: before a vowel, ए ओ ऐ औ become अय् अव् आय् आव्.',
    learns: 'Before any vowel, एच् (ए ओ ऐ औ) is replaced by अय् अव् आय् आव्.',
    outputs: ['अय्', 'अव्', 'आय्', 'आव्', NONE],
    rule: (l) => ({ 'ए': 'अय्', 'ओ': 'अव्', 'ऐ': 'आय्', 'औ': 'आव्' }[l] || NONE),
    config: { hiddenSize: 12, epochs: 300, learningRate: 0.1, seed: 7 },
  },
  'sandhi-guna': {
    sutra: '6.1.87', name: 'गुण sandhi neuron (6.1.87)',
    purpose: 'Learn sutra 6.1.87 आद्गुणः as Panini states it: अ or आ followed by any vowel merge into the nearest guna vowel अ ए ओ अर् अल्.',
    learns: 'अ/आ followed by any vowel (अचि, inherited from 6.1.77) becomes the guna vowel nearest to the second vowel: अ ए ओ, or अर् अल् (1.1.2 अदेङ् गुणः, 1.1.50, 1.1.51 उरण् रपरः). In real sandhi 6.1.101 wins for अ + अ and 6.1.88 for अ + ए/ओ.',
    outputs: ['अ', 'ए', 'ओ', 'अर्', 'अल्', NONE],
    rule: (l, r) => (AT.includes(l) ? BY_STHANA({ 0: 'अ', 1: 'ए', 5: 'ए', 4: 'ओ', 6: 'ओ', 2: 'अर्', 3: 'अल्' }, r) : NONE),
    config: { hiddenSize: 12, epochs: 300, learningRate: 0.1, seed: 7 },
  },
  'sandhi-vrddhi': {
    sutra: '6.1.88', name: 'वृद्धि sandhi neuron (6.1.88)',
    purpose: 'Learn sutra 6.1.88 वृद्धिरेचि: अ or आ followed by ए ओ ऐ औ merge into the vriddhi vowel ऐ or औ.',
    learns: 'अ/आ followed by एच् becomes one vriddhi vowel: ऐ (for ए ऐ) or औ (for ओ औ) (1.1.1 वृद्धिरादैच्).',
    outputs: ['ऐ', 'औ', NONE],
    rule: (l, r) => (AT.includes(l) && EC.includes(r) ? (VOWELS[r][0] === 5 ? 'ऐ' : 'औ') : NONE),
    config: { hiddenSize: 12, epochs: 300, learningRate: 0.1, seed: 7 },
  },
  'sandhi-dirgha': {
    sutra: '6.1.101', name: 'दीर्घ sandhi neuron (6.1.101)',
    purpose: 'Learn sutra 6.1.101 अकः सवर्णे दीर्घः: two vowels of the same place (अ इ उ ऋ ऌ) merge into its long vowel.',
    learns: 'अक् followed by a vowel of the same place (सवर्ण, 1.1.9) becomes that place\'s long vowel: आ ई ऊ ॠ ॡ. This one compares two vowels, so it needs a higher learning rate.',
    outputs: ['आ', 'ई', 'ऊ', 'ॠ', 'ॡ', NONE],
    rule: (l, r) => (AK.includes(l) && AK.includes(r) && VOWELS[l][0] === VOWELS[r][0] ? BY_STHANA({ 0: 'आ', 1: 'ई', 4: 'ऊ', 2: 'ॠ', 3: 'ॡ' }, l) : NONE),
    config: { hiddenSize: 16, epochs: 300, learningRate: 0.5, seed: 7 },
  },
};

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function encode(vowel) {
  const [sthana, flag] = VOWELS[vowel];
  const x = Array(8).fill(0); x[sthana] = 1; x[7] = flag; return x;
}

function examples(preset) {
  const out = [];
  for (const l of LIST) for (const r of LIST) {
    const answer = preset.rule(l, r);
    out.push({ input: [...encode(l), ...encode(r)], target: preset.outputs.map(o => (o === answer ? 1 : 0)) });
  }
  return out;
}

function list() {
  return Object.entries(PRESETS).map(([id, p]) => {
    const s = panini.get(p.sutra);
    return { id, sutra: p.sutra, sutraText: s?.devanagari || '', name: p.name, purpose: p.purpose, learns: p.learns, outputs: p.outputs,
      examples: LIST.length ** 2, applies: examples(p).filter(e => e.target[e.target.length - 1] === 0).length, config: p.config };
  });
}

// Input for neuronFactory.createBlueprint.
function blueprintInput(id) {
  const p = PRESETS[id];
  if (!p) throw error('Unknown sutra neuron.', 404);
  const s = panini.get(p.sutra);
  return {
    name: p.name, purpose: p.purpose, kind: 'tensor', scale: 'micro',
    config: { inputSize: 16, outputSize: p.outputs.length, ...p.config },
    examples: examples(p),
    sutra: { preset: id, id: p.sutra, text: s?.devanagari || '', outputs: p.outputs,
      encoding: 'Each vowel is 8 numbers: its place of articulation (कण्ठ, तालु, मूर्धा, दन्त, ओष्ठ, कण्ठतालु, कण्ठोष्ठ) and whether it is long (for ए/ओ vs ऐ/औ: whether it is the vriddhi vowel). Input = first vowel, then second vowel.' },
  };
}

function forward(tensors, input) {
  const { inputHidden: w1, hiddenBias: b1, hiddenOutput: w2, outputBias: b2 } = tensors;
  const hidden = b1.map((bias, j) => Math.tanh(bias + input.reduce((sum, v, i) => sum + v * w1[i][j], 0)));
  return b2.map((bias, k) => bias + hidden.reduce((sum, v, j) => sum + v * w2[j][k], 0));
}

// How often the trained neuron gives the sutra's answer, over all 169 vowel pairs.
function agreement(artifact, sutraMeta) {
  const p = PRESETS[sutraMeta?.preset];
  if (!p || !artifact?.tensors) return null;
  let correct = 0; const wrong = [];
  for (const l of LIST) for (const r of LIST) {
    const out = forward(artifact.tensors, [...encode(l), ...encode(r)]);
    const got = p.outputs[out.indexOf(Math.max(...out))], want = p.rule(l, r);
    if (got === want) correct += 1; else if (wrong.length < 12) wrong.push({ first: l, second: r, neuron: got, sutra: want });
  }
  return { correct, total: LIST.length ** 2, wrong };
}

function tryPair(artifact, sutraMeta, first, second) {
  const p = PRESETS[sutraMeta?.preset];
  if (!p) throw error('This neuron was not made from a sutra.', 409);
  if (!VOWELS[first] || !VOWELS[second]) throw error(`Choose two vowels from: ${LIST.join(' ')}.`);
  const out = forward(artifact.tensors, [...encode(first), ...encode(second)]);
  const neuron = p.outputs[out.indexOf(Math.max(...out))], sutra = p.rule(first, second);
  return { first, second, neuron, sutra, agrees: neuron === sutra, sutraId: p.sutra, scores: Object.fromEntries(p.outputs.map((o, i) => [o, Math.round(out[i] * 1000) / 1000])) };
}

module.exports = { PRESETS, VOWELS: LIST, STHANA, list, blueprintInput, examples, agreement, tryPair, NONE };
