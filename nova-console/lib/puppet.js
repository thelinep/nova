'use strict';
/* ===========================================================================
 * Character Studio: the rigged 2D puppet, its sounds and its actions
 *
 * A character (lib/characters.js) can carry
 *   puppet    how it looks: body, head, hair, eyes, mouth, colours, extras.
 *             The app draws and animates it (public/index.html, cs* code).
 *   sounds    named sounds from the library (a laugh, a beep, footsteps)
 *   actions   named performances: steps of a move, a spoken line and a sound
 *   portraits AI pictures of the same character, made with SDXL from the
 *             puppet's description and a fixed seed so they stay alike
 * saveClip() turns a performance the app recorded into an MP4 in the library.
 * ========================================================================= */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const media = require('./media');

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const HEX = /^#[0-9a-f]{6}$/i;
const hex = (v, d) => (HEX.test(String(v || '')) ? String(v).toLowerCase() : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.round(Math.min(hi, Math.max(lo, n)) * 100) / 100 : d; };

const PARTS = {
  body: ['round', 'tall', 'pear', 'block', 'robot'],
  head: ['round', 'oval', 'square', 'screen'],
  hairStyle: ['none', 'short', 'long', 'bun', 'curly', 'cap'],
  eyes: ['dots', 'round', 'happy', 'sleepy', 'glow'],
  mouth: ['smile', 'flat', 'grin'],
  limbs: ['soft', 'robot'],
  extras: ['glasses', 'antenna', 'leaf-badge', 'scarf', 'bindi', 'mustache', 'beard', 'notebook'],
};

/* Moves the app can animate. Each is a loop; a step plays it for its seconds. */
const MOVES = {
  idle:      'Stand and breathe',
  talk:      'Talk (lip-sync to the line)',
  wave:      'Wave',
  nod:       'Nod yes',
  shake:     'Shake head no',
  jump:      'Jump',
  walk:      'Walk',
  dance:     'Dance',
  think:     'Think',
  celebrate: 'Celebrate',
  point:     'Point',
  bow:       'Bow',
  sad:       'Feel sad',
  surprise:  'Surprised',
};

/* Starting looks. All original designs; "Inchi" follows the description in the author's own Inchi manuscript. */
const LOOKS = {
  explorer:  { label: 'Young explorer', puppet: { body: 'round', head: 'round', skin: '#c68863', outfit: '#e4572e', accent: '#2e86ab', hair: '#2b1d14', hairStyle: 'long', eyes: 'round', eyeColor: '#2b1d14', mouth: 'smile', limbs: 'soft', extras: [], height: 0.85, width: 1 } },
  thinker:   { label: 'Careful thinker', puppet: { body: 'tall', head: 'oval', skin: '#b5795a', outfit: '#3d5a80', accent: '#ee6c4d', hair: '#1b1b1b', hairStyle: 'short', eyes: 'round', eyeColor: '#1b1b1b', mouth: 'flat', limbs: 'soft', extras: ['glasses', 'notebook'], height: 0.88, width: 0.95 } },
  grandma:   { label: 'Grandmother', puppet: { body: 'pear', head: 'round', skin: '#a8714f', outfit: '#7b2d26', accent: '#f2c14e', hair: '#d9d9d9', hairStyle: 'bun', eyes: 'happy', eyeColor: '#2b2b2b', mouth: 'smile', limbs: 'soft', extras: ['bindi', 'glasses'], height: 0.92, width: 1.08 } },
  gardener:  { label: 'Gardener', puppet: { body: 'block', head: 'round', skin: '#9c6644', outfit: '#4f772d', accent: '#ecf39e', hair: '#3a2a1e', hairStyle: 'curly', eyes: 'round', eyeColor: '#2b1d14', mouth: 'grin', limbs: 'soft', extras: ['scarf'], height: 1, width: 1.05 } },
  repairer:  { label: 'Repairer', puppet: { body: 'block', head: 'square', skin: '#b07d5b', outfit: '#495057', accent: '#ffb703', hair: '#222222', hairStyle: 'cap', eyes: 'dots', eyeColor: '#222222', mouth: 'smile', limbs: 'soft', extras: ['mustache'], height: 1, width: 1.1 } },
  inchi:     { label: 'Inchi (learning robot)', puppet: { body: 'robot', head: 'screen', skin: '#f3ead7', outfit: '#f3ead7', accent: '#2a9d8f', hair: '#000000', hairStyle: 'none', eyes: 'glow', eyeColor: '#ffb000', mouth: 'flat', limbs: 'robot', extras: ['leaf-badge'], height: 0.72, width: 0.95 } },
};
const BLANK = LOOKS.explorer.puppet;

function normalisePuppet(p, prior) {
  const src = p && typeof p === 'object' ? p : (prior || BLANK);
  return {
    body: pick(src.body, PARTS.body, BLANK.body), head: pick(src.head, PARTS.head, BLANK.head),
    skin: hex(src.skin, BLANK.skin), outfit: hex(src.outfit, BLANK.outfit), accent: hex(src.accent, BLANK.accent),
    hair: hex(src.hair, BLANK.hair), hairStyle: pick(src.hairStyle, PARTS.hairStyle, BLANK.hairStyle),
    eyes: pick(src.eyes, PARTS.eyes, BLANK.eyes), eyeColor: hex(src.eyeColor, BLANK.eyeColor),
    mouth: pick(src.mouth, PARTS.mouth, BLANK.mouth), limbs: pick(src.limbs, PARTS.limbs, BLANK.limbs),
    extras: [...new Set((Array.isArray(src.extras) ? src.extras : []).filter(x => PARTS.extras.includes(x)))],
    height: num(src.height, 0.6, 1.3, 1), width: num(src.width, 0.75, 1.3, 1),
    background: hex(src.background, '#1e2430'),
    seed: Number.isSafeInteger(Number(src.seed)) && Number(src.seed) >= 0 ? Number(src.seed) : (prior?.seed ?? crypto.randomInt(0, 2 ** 31 - 1)),
    look: clip(src.look, 300),   // extra words for AI portraits, e.g. "cream shell, teal elbows"
  };
}

const sid = p => p + crypto.randomBytes(5).toString('hex');
const SYSTEMS = ['none', 'organs', 'digestive', 'circulatory', 'respiratory', 'excretory', 'nervous', 'skeletal', 'endocrine', 'reproductive'];
function normaliseSounds(list) {
  return (Array.isArray(list) ? list : []).slice(0, 40).map(s => ({ id: /^snd_[a-f0-9]{10}$/.test(s?.id) ? s.id : sid('snd_'), label: clip(s?.label, 60) || 'Sound', mediaId: clip(s?.mediaId, 80) }))
    .filter(s => s.mediaId);
}
function normaliseActions(list, sounds) {
  const soundIds = new Set(sounds.map(s => s.id));
  return (Array.isArray(list) ? list : []).slice(0, 30).map(a => ({
    id: /^act_[a-f0-9]{10}$/.test(a?.id) ? a.id : sid('act_'),
    name: clip(a?.name, 60) || 'Action',
    steps: (Array.isArray(a?.steps) ? a.steps : []).slice(0, 20).map(s => ({
      move: MOVES[s?.move] || s?.move === 'pose' || s?.move === 'clip' ? s.move : 'idle',
      clipId: s?.move === 'clip' && /^clip_[a-f0-9]{10}$/.test(s?.clipId) ? s.clipId : null,
      poseId: s?.move === 'pose' && /^pose_[a-f0-9]{10}$/.test(s?.poseId) ? s.poseId : null,
      view: SYSTEMS.includes(s?.view) ? s.view : null,   // 3D body-system view for this step (null keeps the current one)
      seconds: num(s?.seconds, 0.5, 20, 2),
      line: clip(s?.line, 400),
      soundId: soundIds.has(s?.soundId) ? s.soundId : null,
    })),
  })).filter(a => a.steps.length);
}
function normalisePortraits(list) {
  return (Array.isArray(list) ? list : []).slice(0, 24).map(p => ({ mediaId: clip(p?.mediaId, 80), view: VIEWS[p?.view] ? p.view : 'portrait' })).filter(p => p.mediaId);
}

/* ---------------------------- AI portraits (SDXL) ---------------------------- */
const VIEWS = {
  portrait:    { label: 'Portrait', size: [768, 768], frame: 'head and shoulders portrait, looking at the camera' },
  full:        { label: 'Full body', size: [640, 960], frame: 'full body, standing, front view, whole figure visible' },
  turnaround:  { label: 'Turnaround sheet', size: [1152, 640], frame: 'character turnaround sheet, the same character shown front view, side view and back view, side by side, full body' },
  expressions: { label: 'Expression sheet', size: [1024, 768], frame: 'character expression sheet, the same face shown happy, surprised, thinking and sad, in a grid' },
};
const COLOR_NAMES = [
  ['black', [20, 20, 20]], ['charcoal grey', [70, 70, 70]], ['grey', [140, 140, 140]], ['silver', [200, 200, 200]], ['white', [245, 245, 245]], ['cream', [243, 234, 215]],
  ['dark brown', [60, 40, 28]], ['brown', [120, 80, 50]], ['tan', [190, 140, 100]], ['beige', [220, 200, 170]],
  ['red', [200, 40, 40]], ['maroon', [120, 40, 38]], ['orange', [230, 110, 40]], ['amber', [255, 176, 0]], ['yellow', [240, 210, 60]], ['pale yellow', [236, 243, 158]],
  ['olive green', [100, 120, 50]], ['green', [70, 140, 60]], ['teal', [42, 157, 143]], ['sky blue', [120, 190, 230]], ['blue', [46, 110, 180]], ['navy blue', [40, 60, 110]],
  ['purple', [110, 70, 160]], ['pink', [240, 130, 170]],
];
function colorName(h) {
  const v = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  let best = COLOR_NAMES[0], d = Infinity;
  for (const c of COLOR_NAMES) { const e = c[1].reduce((s, x, i) => s + (x - v[i]) ** 2, 0); if (e < d) { d = e; best = c; } }
  return best[0];
}
function skinWords(h) {
  const v = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)), l = (v[0] + v[1] + v[2]) / 3;
  return l > 200 ? 'very light' : l > 160 ? 'light' : l > 120 ? 'medium brown' : l > 85 ? 'brown' : 'dark brown';
}
/** A description of the puppet for an image model, so AI pictures match the drawn character. */
function describe(c) {
  const p = c.puppet || normalisePuppet(null);
  const robot = p.body === 'robot' || p.head === 'screen';
  const words = [];
  if (robot) {
    words.push(`a small friendly robot with a ${colorName(p.skin)} shell`);
    if (p.head === 'screen') words.push(`a dark square face screen with two glowing ${colorName(p.eyeColor)} eyes`);
    if (p.limbs === 'robot') words.push(`${colorName(p.accent)} joints at the elbows and knees`);
  } else {
    const build = { round: 'a round, short', tall: 'a tall, slim', pear: 'a soft, rounded', block: 'a sturdy', robot: 'a boxy' }[p.body];
    words.push(`${build} cartoon person with ${skinWords(p.skin)} skin`);
    if (p.hairStyle !== 'none') words.push(p.hairStyle === 'cap' ? `a ${colorName(p.accent)} cap` : `${colorName(p.hair)} ${{ short: 'short', long: 'long', bun: 'hair in a bun', curly: 'curly' }[p.hairStyle]}${p.hairStyle === 'bun' ? '' : ' hair'}`);
    words.push(`${colorName(p.eyeColor)} eyes`, `wearing ${colorName(p.outfit)} clothes with ${colorName(p.accent)} details`);
  }
  const ex = { glasses: 'round glasses', antenna: 'a small antenna', 'leaf-badge': 'a glowing green leaf badge on the chest', scarf: `a ${colorName(p.accent)} scarf`, bindi: 'a bindi', mustache: 'a mustache', beard: 'a beard', notebook: 'holding a small notebook' };
  for (const e of p.extras) words.push(ex[e]);
  if (p.height <= 0.9) words.push('child-sized');
  return words.filter(Boolean).join(', ');
}
function portraitPrompt(c, view = 'portrait') {
  const v = VIEWS[view] || VIEWS.portrait, p = c.puppet || {};
  const is3d = c.stage === '3d' && c.rig3d;
  return [`${c.name}${c.tagline ? ', ' + c.tagline : ''}`, is3d ? describe3d(c) : describe(c), p.look, v.frame, is3d ? 'consistent original character design, stylised 3D animated film look, soft studio light, plain light background' : 'consistent original character design, clean flat colours, soft light, plain light background, children\'s book illustration style']
    .filter(Boolean).join('. ').slice(0, 900);
}
function portraitRequest(c, view = 'portrait') {
  const v = VIEWS[view] || VIEWS.portrait;
  return { prompt: portraitPrompt(c, view), negative: 'text, watermark, logo, extra limbs, extra fingers, distorted face, multiple different characters, photo, realistic', width: v.size[0], height: v.size[1], seed: (c.puppet || {}).seed };
}


/* ------------------------------ 3D character ------------------------------ */
// The 3D model (public/cs3d.js) is built from these choices; poses are saved joint angles.
const RIG3D = {
  build: ['slim', 'average', 'sturdy', 'round'], hands: ['mitten', 'fingers'],
  eyeShape: ['round', 'almond', 'big', 'sleepy', 'dot', 'glow'], browShape: ['straight', 'arched', 'thick', 'thin', 'none'],
  mouthShape: ['smile', 'neutral', 'grin'], earShape: ['round', 'small', 'big', 'pointed', 'none'], noseShape: ['button', 'long', 'broad', 'none'],
  hairStyle: ['short', 'long', 'bun', 'ponytail', 'braid', 'curly', 'spiky', 'bald'],
  top: ['tshirt', 'kurta', 'jacket', 'dress', 'robe', 'armor'], bottom: ['pants', 'shorts', 'skirt', 'dhoti', 'none'], shoes: ['sneakers', 'boots', 'sandals', 'barefoot'],
  extras: ['glasses', 'cap', 'scarf', 'backpack', 'watch', 'leaf-badge', 'antenna', 'bindi', 'beard', 'mustache'],
};
const JOINT_NAMES = ['root', 'hips', 'spine', 'chest', 'neck', 'head', 'upperArmL', 'forearmL', 'handL', 'fingersL', 'upperArmR', 'forearmR', 'handR', 'fingersR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'];
const FACE_KEYS = { browL: [-1, 1], browR: [-1, 1], browAngle: [-1, 1], eyeL: [0, 1], eyeR: [0, 1], lookX: [-1, 1], lookY: [-1, 1], smile: [-1, 1], open: [0, 1], wide: [-1, 1], round: [0, 1], bite: [0, 1] };
function normalisePose(p) {
  const joints = {};
  for (const [k, v] of Object.entries(p?.joints || {})) if (JOINT_NAMES.includes(k) && Array.isArray(v)) joints[k] = v.slice(0, 3).map(x => num(x, -180, 180, 0));
  const face = {};
  for (const [k, v] of Object.entries(p?.face || {})) if (FACE_KEYS[k]) face[k] = num(v, FACE_KEYS[k][0], FACE_KEYS[k][1], 0);
  const root = {}; if (p?.root && p.root.lift !== undefined) root.lift = num(p.root.lift, -0.6, 0.6, 0);
  return { joints, face, root };
}
/** Webcam capture clips: frames of joints (j), face (f) and lift (r), at fps. Up to 60 s at 15 fps. */
function normaliseClips(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map(c => {
    const fps = Math.round(num(c?.fps, 5, 30, 15));
    const frames = (Array.isArray(c?.frames) ? c.frames : []).slice(0, fps * 60).map(fr => {
      const p = normalisePose({ joints: fr?.j, face: fr?.f, root: fr?.r });
      for (const k of Object.keys(p.joints)) p.joints[k] = p.joints[k].map(Math.round);
      for (const k of Object.keys(p.face)) p.face[k] = Math.round(p.face[k] * 100) / 100;
      return { j: p.joints, f: p.face, ...(p.root.lift !== undefined ? { r: { lift: p.root.lift } } : {}) };
    });
    return { id: /^clip_[a-f0-9]{10}$/.test(c?.id) ? c.id : sid('clip_'), name: clip(c?.name, 60) || 'Capture', fps, frames, createdAt: clip(c?.createdAt, 40) || new Date().toISOString() };
  }).filter(c => c.frames.length >= 2);
}
/** Timeline animations: keyed layers (body poses, capture clips, face, additive offsets, voice lines, sounds) and IK. */
function normaliseAnims(list, poses, clips) {
  const poseIds = new Set(poses.map(p => p.id)), clipIds = new Set(clips.map(c => c.id));
  return (Array.isArray(list) ? list : []).slice(0, 20).map(a => {
    const duration = num(a?.duration, 1, 120, 8), T = t => num(t, 0, duration, 0), tr = a?.tracks || {};
    const keys = (arr, max, fn) => (Array.isArray(arr) ? arr : []).slice(0, max).map(fn).filter(Boolean).sort((x, y) => x.t - y.t);
    return {
      id: /^anim_[a-f0-9]{10}$/.test(a?.id) ? a.id : sid('anim_'), name: clip(a?.name, 60) || 'Animation', duration,
      ik: { feet: a?.ik?.feet === true },
      tracks: {
        body: keys(tr.body, 200, k => poseIds.has(k?.poseId) ? { t: T(k.t), poseId: k.poseId } : k?.pose ? { t: T(k.t), pose: normalisePose(k.pose) } : null),
        clip: keys(tr.clip, 20, k => clipIds.has(k?.clipId) ? { t: T(k.t), clipId: k.clipId, speed: num(k.speed, 0.25, 4, 1) } : null),
        face: keys(tr.face, 200, k => ({ t: T(k?.t), face: normalisePose({ face: k?.face }).face })),
        add: keys(tr.add, 200, k => ({ t: T(k?.t), joints: normalisePose({ joints: k?.joints }).joints })),
        voice: keys(tr.voice, 50, k => clip(k?.line, 400) ? { t: T(k.t), line: clip(k.line, 400) } : null),
        sound: keys(tr.sound, 50, k => /^snd_[a-f0-9]{10}$/.test(k?.soundId) ? { t: T(k.t), soundId: k.soundId } : null),
      },
    };
  });
}

/** A 3D starting rig that matches a 2D puppet's colours. */
function rigFromPuppet(pp) {
  const p = pp || BLANK, robot = p.body === 'robot' || p.head === 'screen';
  return {
    body: { skin: p.skin, height: robot ? 0.72 : Math.min(1.1, Math.max(0.75, p.height)), build: robot ? 'round' : { round: 'average', tall: 'slim', pear: 'round', block: 'sturdy' }[p.body] || 'average', headSize: robot ? 1.25 : 1.1, armLength: 1, legLength: 1, hands: robot ? 'mitten' : 'fingers', robot },
    face: { eyeShape: robot ? 'glow' : p.eyes === 'dots' ? 'dot' : p.eyes === 'sleepy' ? 'sleepy' : 'round', eyeColor: p.eyeColor, eyeSize: 1, eyeSpacing: 1, browShape: robot ? 'none' : 'arched', browColor: p.hair, mouthShape: p.mouth === 'flat' ? 'neutral' : p.mouth, lipColor: robot ? p.eyeColor : '#9b4a43', mouthWidth: 1, earShape: robot ? 'none' : 'round', earSize: 1, noseShape: robot ? 'none' : 'button', blush: false },
    hair: { style: robot ? 'bald' : { none: 'bald', short: 'short', long: 'long', bun: 'bun', curly: 'curly', cap: 'short' }[p.hairStyle] || 'short', color: p.hair },
    costume: { top: robot ? 'armor' : 'tshirt', topColor: p.outfit, accent: p.accent, bottom: robot ? 'none' : 'pants', bottomColor: robot ? p.outfit : '#2e4a6b', shoes: robot ? 'barefoot' : 'sneakers', shoeColor: robot ? p.accent : '#333333',
      extras: [...(p.extras || []).filter(x => RIG3D.extras.includes(x)), ...(p.hairStyle === 'cap' ? ['cap'] : [])] },
    background: p.background || '#1e2430', poses: [],
  };
}
function normaliseRig3d(r, prior) {
  const src = r && typeof r === 'object' ? r : prior || rigFromPuppet(null);
  const b = src.body || {}, f = src.face || {}, h = src.hair || {}, c = src.costume || {};
  const out = {
    body: { skin: hex(b.skin, '#c68863'), height: num(b.height, 0.6, 1.3, 1), build: pick(b.build, RIG3D.build, 'average'), headSize: num(b.headSize, 0.7, 1.5, 1), armLength: num(b.armLength, 0.75, 1.3, 1), legLength: num(b.legLength, 0.7, 1.3, 1), hands: pick(b.hands, RIG3D.hands, 'fingers'), robot: b.robot === true },
    face: { eyeShape: pick(f.eyeShape, RIG3D.eyeShape, 'round'), eyeColor: hex(f.eyeColor, '#3b2416'), eyeSize: num(f.eyeSize, 0.6, 1.5, 1), eyeSpacing: num(f.eyeSpacing, 0.75, 1.3, 1), browShape: pick(f.browShape, RIG3D.browShape, 'arched'), browColor: hex(f.browColor, '#2b1d14'),
      mouthShape: pick(f.mouthShape, RIG3D.mouthShape, 'smile'), lipColor: hex(f.lipColor, '#9b4a43'), mouthWidth: num(f.mouthWidth, 0.6, 1.5, 1), earShape: pick(f.earShape, RIG3D.earShape, 'round'), earSize: num(f.earSize, 0.6, 1.5, 1), noseShape: pick(f.noseShape, RIG3D.noseShape, 'button'), blush: f.blush === true },
    hair: { style: pick(h.style, RIG3D.hairStyle, 'short'), color: hex(h.color, '#2b1d14') },
    costume: { top: pick(c.top, RIG3D.top, 'tshirt'), topColor: hex(c.topColor, '#e4572e'), accent: hex(c.accent, '#2e86ab'), bottom: pick(c.bottom, RIG3D.bottom, 'pants'), bottomColor: hex(c.bottomColor, '#2e4a6b'), shoes: pick(c.shoes, RIG3D.shoes, 'sneakers'), shoeColor: hex(c.shoeColor, '#333333'),
      extras: [...new Set((Array.isArray(c.extras) ? c.extras : []).filter(x => RIG3D.extras.includes(x)))] },
    background: hex(src.background, '#1e2430'),
    poses: (Array.isArray(src.poses) ? src.poses : []).slice(0, 40).map(p => ({ id: /^pose_[a-f0-9]{10}$/.test(p?.id) ? p.id : sid('pose_'), name: clip(p?.name, 60) || 'Pose', ...normalisePose(p) })),
    clips: normaliseClips(src.clips),
  };
  out.anims = normaliseAnims(src.anims, out.poses, out.clips);
  return out;
}
/** Words for an image model, so AI pictures match the 3D character. */
function describe3d(c) {
  const r = c.rig3d, b = r.body, f = r.face, h = r.hair, k = r.costume, words = [];
  if (b.robot) words.push(`a small friendly robot with a ${colorName(b.skin)} shell`, `${colorName(k.accent)} joints`, f.eyeShape === 'glow' ? `two glowing ${colorName(f.eyeColor)} eyes` : `${colorName(f.eyeColor)} eyes`);
  else {
    words.push(`a ${{ slim: 'slim', average: '', sturdy: 'sturdy', round: 'round, soft' }[b.build]} cartoon person with ${skinWords(b.skin)} skin`.replace(/\s+/g, ' '));
    if (h.style !== 'bald') words.push(`${colorName(h.color)} ${{ short: 'short hair', long: 'long hair', bun: 'hair in a bun', ponytail: 'hair in a ponytail', braid: 'a braid', curly: 'curly hair', spiky: 'spiky hair' }[h.style]}`);
    else words.push('bald');
    words.push(`${colorName(f.eyeColor)} eyes`);
    const top = { tshirt: 't-shirt', kurta: 'kurta', jacket: 'jacket', dress: 'dress', robe: 'long robe', armor: 'armour' }[k.top];
    words.push(`wearing a ${colorName(k.topColor)} ${top}`);
    if (k.bottom !== 'none' && !['dress', 'robe'].includes(k.top)) words.push(`${colorName(k.bottomColor)} ${{ pants: 'trousers', shorts: 'shorts', skirt: 'skirt', dhoti: 'dhoti' }[k.bottom]}`);
    if (k.shoes !== 'barefoot') words.push(`${colorName(k.shoeColor)} ${k.shoes}`);
  }
  const ex = { glasses: 'round glasses', cap: `a ${colorName(k.accent)} cap`, scarf: `a ${colorName(k.accent)} scarf`, backpack: 'a backpack', watch: 'a wristwatch', 'leaf-badge': 'a glowing green leaf badge on the chest', antenna: 'a small antenna', bindi: 'a bindi', beard: 'a beard', mustache: 'a mustache' };
  for (const e of k.extras) words.push(ex[e]);
  if (b.height <= 0.9) words.push('child-sized');
  return words.filter(Boolean).join(', ');
}

/* ------------------------- recorded performances → MP4 ------------------------- */
function ffmpegPath() {
  for (const f of [process.env.NOVA_FFMPEG, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) if (f && fs.existsSync(f)) return f;
  return null;
}
function run(file, args, timeout = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, _o, stderr) => err ? reject(error('ffmpeg could not convert the clip: ' + String(stderr || err.message).trim().split('\n').slice(-2).join(' ').slice(0, 300), 500)) : resolve()));
}
/** buffer: what the app's MediaRecorder made (WebM or MP4). Saved as an H.264/AAC MP4 in the library. */
async function saveClip(store, dataDir, buffer, { character, action = '' } = {}) {
  if (!buffer || buffer.length < 1000) throw error('The recording is empty.');
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) throw error('Saving clips needs ffmpeg (brew install ffmpeg).', 412);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-clip-'));
  try {
    const inp = path.join(work, 'in.bin'), out = path.join(work, 'out.mp4');
    fs.writeFileSync(inp, buffer);
    await run(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', inp, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
    const name = `${character.name}${action ? ' — ' + clip(action, 60) : ''}.mp4`;
    return media.saveMedia(store, dataDir, { buffer: fs.readFileSync(out), originalName: name, source: 'character-studio', expectKind: 'video', provenance: { generator: 'character-studio', characterId: character.id, characterName: character.name, action: clip(action, 60) || null } });
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

/* ------------------------------- 3D export ------------------------------- */
function blenderPath() {
  // NOVA_BLENDER, when set, is the only place looked at (so it can also say "no Blender").
  if (process.env.NOVA_BLENDER) return fs.existsSync(process.env.NOVA_BLENDER) ? process.env.NOVA_BLENDER : null;
  for (const f of ['/Applications/Blender.app/Contents/MacOS/Blender', '/opt/homebrew/bin/blender', '/usr/local/bin/blender', '/usr/bin/blender']) if (fs.existsSync(f)) return f;
  return null;
}
const FBX_SCRIPT = [
  'import bpy, sys',
  'a = sys.argv[sys.argv.index("--") + 1:]',
  'bpy.ops.wm.read_factory_settings(use_empty=True)',
  'bpy.ops.import_scene.gltf(filepath=a[0])',
  'bpy.ops.export_scene.fbx(filepath=a[1], bake_anim=True, path_mode="COPY", embed_textures=True, add_leaf_bones=False)',
].join('\n');
/**
 * Saves a .glb the app made (and, for FBX, converts it with Blender) into
 * <library>/Exports. Returns { file, path, bytes, format }.
 */
async function saveExport(buffer, { dir, name = 'character', format = 'glb' } = {}) {
  if (!buffer || buffer.length < 20 || buffer.toString('latin1', 0, 4) !== 'glTF') throw error('The export is not a glTF binary.');
  if (!dir) throw error('Turn on the Maataa Library folder in Settings to save exports.', 412);
  const out = path.join(dir, 'Exports'); fs.mkdirSync(out, { recursive: true });
  const base = (String(name).replace(/[^\p{L}\p{N} _.-]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'character') + ' ' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const glb = path.join(out, base + '.glb'); fs.writeFileSync(glb, buffer);
  if (format !== 'fbx') return { format: 'glb', file: path.basename(glb), path: glb, bytes: buffer.length };
  const blender = blenderPath();
  if (!blender) throw error('FBX export needs Blender. Install it from blender.org (free), then try again. The .glb was saved: ' + glb, 412);
  const fbx = path.join(out, base + '.fbx'), script = path.join(os.tmpdir(), 'maataa-glb2fbx-' + crypto.randomBytes(4).toString('hex') + '.py');
  fs.writeFileSync(script, FBX_SCRIPT);
  try {
    await new Promise((resolve, reject) => execFile(blender, ['-b', '--factory-startup', '--python', script, '--', glb, fbx], { timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, _o, stderr) => err ? reject(error('Blender could not convert to FBX: ' + String(stderr || err.message).trim().split('\n').slice(-2).join(' ').slice(0, 300), 500)) : resolve()));
  } finally { fs.rmSync(script, { force: true }); }
  if (!fs.existsSync(fbx)) throw error('Blender finished without writing the FBX.', 500);
  return { format: 'fbx', file: path.basename(fbx), path: fbx, bytes: fs.statSync(fbx).size, glb: path.basename(glb) };
}

/* ------------------------------ webcam capture ------------------------------ */
const CAPTURE_MODELS = ['face_landmarker.task', 'pose_landmarker_lite.task'];
const captureDir = dataDir => process.env.NOVA_CAPTURE_DIR || path.join(dataDir, 'tools', 'mediapipe');
function captureStatus(dataDir) {
  const dir = captureDir(dataDir), have = CAPTURE_MODELS.filter(f => { try { return fs.statSync(path.join(dir, f)).size > 1e6; } catch (_) { return false; } });
  return { ready: have.length === CAPTURE_MODELS.length, face: have.includes('face_landmarker.task'), body: have.includes('pose_landmarker_lite.task'), dir, missing: have.length === CAPTURE_MODELS.length ? [] : ['Webcam capture models: Setup → Install → Webcam capture (about 9 MB)'] };
}
function captureModelPath(dataDir, name) {
  if (!CAPTURE_MODELS.includes(name)) throw error('Unknown capture model.', 404);
  const f = path.join(captureDir(dataDir), name); if (!fs.existsSync(f)) throw error('Install webcam capture first (Setup → Install).', 404); return f;
}

function catalog() {
  return { rig3d: RIG3D, parts: PARTS, moves: Object.entries(MOVES).map(([id, label]) => ({ id, label })), looks: Object.entries(LOOKS).map(([id, l]) => ({ id, label: l.label, puppet: l.puppet })), views: Object.entries(VIEWS).map(([id, v]) => ({ id, label: v.label })) };
}


/** Meshes made from a picture (lib/image-to-3d.js): static .glb files in DATA_DIR/meshes. */
function normaliseMeshes(list) {
  return (Array.isArray(list) ? list : []).filter(m => m && /^mesh_[a-f0-9]{12}\.glb$/.test(String(m.file))).slice(0, 12).map(m => ({
    file: String(m.file), bytes: Math.max(0, Math.round(Number(m.bytes) || 0)), name: String(m.name || 'Scan').slice(0, 60),
    sourceMediaId: m.sourceMediaId ? String(m.sourceMediaId).slice(0, 80) : null, createdAt: String(m.createdAt || '').slice(0, 40) || null,
  }));
}

/** Cutout poses on a character: [{ id, name, frames:[mediaId], fps, facing }]. Same-name cells become frames of one pose. */
function normaliseCutouts(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const name = String((p && p.name) || '').replace(/\s+/g, ' ').trim().slice(0, 32).toLowerCase().replace(/[^a-z0-9ऀ-ॿ -]/g, '').trim();
    const frames = (Array.isArray(p && p.frames) ? p.frames : p && p.mediaId ? [p.mediaId] : []).map(f => String(f || '').slice(0, 80)).filter(Boolean).slice(0, 8);
    if (!name || !frames.length) continue;
    const same = out.find(o => o.name === name);
    if (same) { same.frames = [...same.frames, ...frames].slice(0, 8); continue; }
    out.push({ id: /^cut_[a-f0-9]{8}$/.test(p.id) ? p.id : 'cut_' + crypto.randomBytes(4).toString('hex'), name, frames, fps: Math.min(24, Math.max(1, Number(p.fps) || 8)), facing: Number(p.facing) === -1 ? -1 : 1 });
    if (out.length >= 24) break;
  }
  return out;
}


module.exports = { normaliseCutouts, normaliseMeshes, saveExport, blenderPath, captureStatus, captureModelPath, CAPTURE_MODELS, normaliseClips, normaliseAnims, SYSTEMS, RIG3D, normaliseRig3d, rigFromPuppet, describe3d, PARTS, MOVES, LOOKS, VIEWS, normalisePuppet, normaliseSounds, normaliseActions, normalisePortraits, describe, portraitPrompt, portraitRequest, colorName, saveClip, catalog };
