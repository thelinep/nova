// ===========================================================================
// Character Studio 3D: a procedural, fully posable 3D character (three.js).
//   Face:    eyes, eyebrows, mouth, ears, nose, hair, with expression controls
//   Body:    torso, arms, hands (mittens or fingers), legs, feet
//   Costume: top, bottom, shoes, extras
//   Pose:    every joint (3 axes), root turn/lean/lift, face, saved poses
// Everything is built from simple shapes at runtime: no model files, all
// original designs. Loaded on demand by index.html (import('/cs3d.js')).
// ===========================================================================
import * as THREE from './vendor/three.module.min.js';

const D = Math.PI / 180;

/* --------------------------------- joints --------------------------------- */
// UI units are degrees. sign maps the UI direction onto the axis for the
// character's LEFT side; right-side joints mirror Y and Z.
export const JOINTS = {
  root:      { label: 'Whole body', group: 'Body',      axes: [['Turn', 'y', -180, 180, 1], ['Lean forward', 'x', -30, 60, 1], ['Tilt sideways', 'z', -30, 30, 1]] },
  hips:      { label: 'Hips',       group: 'Body',      axes: [['Bend forward', 'x', -30, 90, 1], ['Twist', 'y', -45, 45, 1], ['Tilt', 'z', -25, 25, 1]] },
  spine:     { label: 'Waist',      group: 'Body',      axes: [['Bend forward', 'x', -30, 60, 1], ['Twist', 'y', -45, 45, 1], ['Tilt', 'z', -30, 30, 1]] },
  chest:     { label: 'Chest',      group: 'Body',      axes: [['Bend forward', 'x', -25, 45, 1], ['Twist', 'y', -40, 40, 1], ['Tilt', 'z', -25, 25, 1]] },
  neck:      { label: 'Neck',       group: 'Head',      axes: [['Nod', 'x', -30, 40, 1], ['Turn', 'y', -50, 50, 1], ['Tilt', 'z', -30, 30, 1]] },
  head:      { label: 'Head',       group: 'Head',      axes: [['Nod', 'x', -35, 40, 1], ['Turn', 'y', -60, 60, 1], ['Tilt', 'z', -35, 35, 1]] },
  upperArmL: { label: 'Left upper arm',  group: 'Left arm',  axes: [['Raise forward', 'x', -60, 180, -1], ['Twist', 'y', -90, 90, 1], ['Raise sideways', 'z', -20, 180, 1]] },
  forearmL:  { label: 'Left elbow',      group: 'Left arm',  axes: [['Bend', 'x', 0, 150, -1], ['Twist', 'y', -90, 90, 1], ['Swing', 'z', -30, 30, 1]] },
  handL:     { label: 'Left wrist',      group: 'Left arm',  axes: [['Bend', 'x', -70, 70, -1], ['Twist', 'y', -90, 90, 1], ['Side', 'z', -40, 40, 1]] },
  fingersL:  { label: 'Left fingers',    group: 'Left arm',  axes: [['Curl', 'z', -10, 100, -1]] },
  upperArmR: { label: 'Right upper arm', group: 'Right arm', axes: [['Raise forward', 'x', -60, 180, -1], ['Twist', 'y', -90, 90, 1], ['Raise sideways', 'z', -20, 180, 1]] },
  forearmR:  { label: 'Right elbow',     group: 'Right arm', axes: [['Bend', 'x', 0, 150, -1], ['Twist', 'y', -90, 90, 1], ['Swing', 'z', -30, 30, 1]] },
  handR:     { label: 'Right wrist',     group: 'Right arm', axes: [['Bend', 'x', -70, 70, -1], ['Twist', 'y', -90, 90, 1], ['Side', 'z', -40, 40, 1]] },
  fingersR:  { label: 'Right fingers',   group: 'Right arm', axes: [['Curl', 'z', -10, 100, -1]] },
  thighL:    { label: 'Left hip joint',  group: 'Left leg',  axes: [['Raise forward', 'x', -45, 120, -1], ['Twist', 'y', -45, 45, 1], ['Out to the side', 'z', -15, 80, 1]] },
  shinL:     { label: 'Left knee',       group: 'Left leg',  axes: [['Bend', 'x', 0, 150, 1]] },
  footL:     { label: 'Left ankle',      group: 'Left leg',  axes: [['Point', 'x', -40, 60, 1], ['Turn', 'y', -30, 30, 1], ['Roll', 'z', -25, 25, 1]] },
  thighR:    { label: 'Right hip joint', group: 'Right leg', axes: [['Raise forward', 'x', -45, 120, -1], ['Twist', 'y', -45, 45, 1], ['Out to the side', 'z', -15, 80, 1]] },
  shinR:     { label: 'Right knee',      group: 'Right leg', axes: [['Bend', 'x', 0, 150, 1]] },
  footR:     { label: 'Right ankle',     group: 'Right leg', axes: [['Point', 'x', -40, 60, 1], ['Turn', 'y', -30, 30, 1], ['Roll', 'z', -25, 25, 1]] },
};
export const FACE_CONTROLS = [
  ['browL', 'Left eyebrow up', -1, 1], ['browR', 'Right eyebrow up', -1, 1], ['browAngle', 'Eyebrows: sad ↔ cross', -1, 1],
  ['eyeL', 'Left eye open', 0, 1], ['eyeR', 'Right eye open', 0, 1], ['lookX', 'Look left ↔ right', -1, 1], ['lookY', 'Look down ↔ up', -1, 1],
  ['smile', 'Frown ↔ smile', -1, 1], ['open', 'Mouth open', 0, 1],
];
export const NEUTRAL_FACE = { browL: 0, browR: 0, browAngle: 0, eyeL: 1, eyeR: 1, lookX: 0, lookY: 0, smile: 0.25, open: 0, wide: 0, round: 0, bite: 0 };
export const EXPRESSIONS = {
  neutral:   { label: 'Neutral',   face: {} },
  happy:     { label: 'Happy',     face: { browL: 0.3, browR: 0.3, smile: 1, eyeL: 0.85, eyeR: 0.85 } },
  laugh:     { label: 'Laughing',  face: { browL: 0.4, browR: 0.4, smile: 1, open: 0.6, eyeL: 0.35, eyeR: 0.35 } },
  sad:       { label: 'Sad',       face: { browL: 0.25, browR: 0.25, browAngle: -0.9, smile: -0.8, lookY: -0.4, eyeL: 0.8, eyeR: 0.8 } },
  angry:     { label: 'Cross',     face: { browL: -0.4, browR: -0.4, browAngle: 0.9, smile: -0.5, eyeL: 0.8, eyeR: 0.8 } },
  surprised: { label: 'Surprised', face: { browL: 1, browR: 1, open: 0.75, smile: 0 } },
  thinking:  { label: 'Thinking',  face: { browL: 0.7, browR: -0.15, lookX: 0.5, lookY: 0.6, smile: -0.1 } },
  wink:      { label: 'Wink',      face: { eyeR: 0.05, smile: 0.9, browR: -0.2 } },
  sleepy:    { label: 'Sleepy',    face: { eyeL: 0.25, eyeR: 0.25, browL: -0.1, browR: -0.1, smile: 0 } },
};
const P = (joints, root = {}, face = {}) => ({ joints, root, face });
export const POSES = {
  stand:   { label: 'Relaxed stand', ...P({ upperArmL: [0, 0, 8], upperArmR: [0, 0, 8], forearmL: [12, 0, 0], forearmR: [12, 0, 0], fingersL: [25], fingersR: [25] }) },
  tpose:   { label: 'T-pose', ...P({ upperArmL: [0, 0, 88], upperArmR: [0, 0, 88], fingersL: [0], fingersR: [0] }) },
  wave:    { label: 'Wave', ...P({ upperArmL: [0, 0, 8], forearmL: [12, 0, 0], upperArmR: [10, -20, 140], forearmR: [35, 0, 0], handR: [0, 0, 10], fingersR: [0], head: [0, -8, -8] }, {}, { smile: 1, browL: 0.3, browR: 0.3 }) },
  cheer:   { label: 'Cheer', ...P({ upperArmL: [10, 0, 155], upperArmR: [10, 0, 155], forearmL: [15, 0, 0], forearmR: [15, 0, 0], fingersL: [70], fingersR: [70], head: [-10, 0, 0] }, { lift: 0.02 }, { smile: 1, open: 0.5, browL: 0.6, browR: 0.6 }) },
  think:   { label: 'Thinking', ...P({ upperArmL: [30, 0, 15], forearmL: [80, 50, 0], upperArmR: [45, 0, -10], forearmR: [140, -20, 0], handR: [-30, 0, 0], fingersR: [60], head: [-8, 15, 12] }, {}, EXPRESSIONS.thinking.face) },
  point:   { label: 'Point', ...P({ upperArmL: [0, 0, 8], forearmL: [12, 0, 0], upperArmR: [85, 0, 8], forearmR: [5, 0, 0], fingersR: [10], head: [0, -12, 0], chest: [0, -10, 0] }) },
  hips:    { label: 'Hands on hips', ...P({ upperArmL: [-15, 30, 40], upperArmR: [-15, 30, 40], forearmL: [95, 40, 0], forearmR: [95, 40, 0], fingersL: [20], fingersR: [20], chest: [-5, 0, 0] }, {}, { smile: 0.6 }) },
  shy:     { label: 'Shy', ...P({ upperArmL: [20, 0, -12], upperArmR: [20, 0, -12], forearmL: [55, -40, 0], forearmR: [55, -40, 0], head: [18, 10, 14], neck: [8, 0, 0] }, {}, { lookY: -0.5, lookX: -0.4, smile: 0.4 }) },
  bow:     { label: 'Bow', ...P({ hips: [35, 0, 0], spine: [10, 0, 0], head: [10, 0, 0], upperArmL: [0, 0, 4], upperArmR: [0, 0, 4], forearmL: [10, 0, 0], forearmR: [10, 0, 0] }, {}, { eyeL: 0.4, eyeR: 0.4 }) },
  sit:     { label: 'Sit', ...P({ thighL: [90, 0, 6], thighR: [90, 0, 6], shinL: [90], shinR: [90], upperArmL: [30, 0, 10], upperArmR: [30, 0, 10], forearmL: [40, 0, 0], forearmR: [40, 0, 0] }, { lift: -0.45 }) },
  run:     { label: 'Run', ...P({ chest: [12, 0, 0], thighL: [50, 0, 0], shinL: [75], thighR: [-30, 0, 0], shinR: [45], footR: [30, 0, 0], upperArmL: [-40, 0, 10], forearmL: [80, 0, 0], upperArmR: [50, 0, 10], forearmR: [85, 0, 0], fingersL: [70], fingersR: [70] }, { lean: 8, lift: -0.03 }, { smile: 0.5 }) },
  kneel:   { label: 'Kneel', ...P({ thighL: [90, 0, 0], shinL: [90], thighR: [-10, 0, 0], shinR: [100], footR: [40, 0, 0], upperArmL: [20, 0, 10], forearmL: [60, 0, 0] }, { lift: -0.42 }) },
  dance:   { label: 'Dance', ...P({ hips: [0, 0, 10], chest: [0, 10, -12], upperArmL: [20, 0, 130], forearmL: [70, 0, 0], upperArmR: [30, 0, 40], forearmR: [90, 30, 0], thighR: [40, 0, 15], shinR: [70] }, {}, { smile: 1, open: 0.3 }) },
};

/* ------------------------------ starting looks ------------------------------ */
export const LOOKS3D = {
  explorer: { label: 'Young explorer', rig: { body: { skin: '#c68863', height: 0.82, build: 'average', headSize: 1.15, armLength: 1, legLength: 0.95, hands: 'mitten', robot: false }, face: { eyeShape: 'round', eyeColor: '#3b2416', eyeSize: 1.1, eyeSpacing: 1, browShape: 'arched', browColor: '#2b1d14', mouthShape: 'smile', lipColor: '#9b4a43', mouthWidth: 1, earShape: 'round', earSize: 1, noseShape: 'button', blush: true }, hair: { style: 'ponytail', color: '#2b1d14' }, costume: { top: 'tshirt', topColor: '#e4572e', accent: '#2e86ab', bottom: 'shorts', bottomColor: '#2e4a6b', shoes: 'sneakers', shoeColor: '#f5f5f5', extras: ['backpack'] } } },
  thinker:  { label: 'Careful thinker', rig: { body: { skin: '#b5795a', height: 0.84, build: 'slim', headSize: 1.12, armLength: 1, legLength: 1, hands: 'fingers', robot: false }, face: { eyeShape: 'round', eyeColor: '#1b1b1b', eyeSize: 1, eyeSpacing: 1, browShape: 'straight', browColor: '#1b1b1b', mouthShape: 'neutral', lipColor: '#8f4a40', mouthWidth: 0.9, earShape: 'round', earSize: 1, noseShape: 'button', blush: false }, hair: { style: 'short', color: '#1b1b1b' }, costume: { top: 'kurta', topColor: '#3d5a80', accent: '#ee6c4d', bottom: 'pants', bottomColor: '#e0d8c8', shoes: 'sandals', shoeColor: '#6b4226', extras: ['glasses', 'watch'] } } },
  grandma:  { label: 'Grandmother', rig: { body: { skin: '#a8714f', height: 0.92, build: 'round', headSize: 1, armLength: 1, legLength: 0.9, hands: 'fingers', robot: false }, face: { eyeShape: 'almond', eyeColor: '#2b2b2b', eyeSize: 0.9, eyeSpacing: 1, browShape: 'thin', browColor: '#bdbdbd', mouthShape: 'smile', lipColor: '#8a4b45', mouthWidth: 1, earShape: 'round', earSize: 1.05, noseShape: 'broad', blush: true }, hair: { style: 'bun', color: '#dcdcdc' }, costume: { top: 'robe', topColor: '#7b2d26', accent: '#f2c14e', bottom: 'none', bottomColor: '#7b2d26', shoes: 'sandals', shoeColor: '#5a3a22', extras: ['bindi', 'glasses', 'scarf'] } } },
  gardener: { label: 'Gardener', rig: { body: { skin: '#9c6644', height: 1, build: 'sturdy', headSize: 1, armLength: 1, legLength: 1, hands: 'fingers', robot: false }, face: { eyeShape: 'round', eyeColor: '#2b1d14', eyeSize: 1, eyeSpacing: 1, browShape: 'thick', browColor: '#3a2a1e', mouthShape: 'grin', lipColor: '#7d3b33', mouthWidth: 1.1, earShape: 'round', earSize: 1, noseShape: 'broad', blush: false }, hair: { style: 'curly', color: '#3a2a1e' }, costume: { top: 'jacket', topColor: '#4f772d', accent: '#ecf39e', bottom: 'pants', bottomColor: '#5c4033', shoes: 'boots', shoeColor: '#3b2a1a', extras: ['scarf'] } } },
  repairer: { label: 'Repairer', rig: { body: { skin: '#b07d5b', height: 1, build: 'sturdy', headSize: 1, armLength: 1.05, legLength: 1, hands: 'fingers', robot: false }, face: { eyeShape: 'dot', eyeColor: '#222222', eyeSize: 1, eyeSpacing: 1, browShape: 'thick', browColor: '#222222', mouthShape: 'smile', lipColor: '#7d3b33', mouthWidth: 1, earShape: 'big', earSize: 1, noseShape: 'long', blush: false }, hair: { style: 'short', color: '#222222' }, costume: { top: 'tshirt', topColor: '#495057', accent: '#ffb703', bottom: 'pants', bottomColor: '#264653', shoes: 'boots', shoeColor: '#222222', extras: ['cap', 'mustache', 'watch'] } } },
  robot:    { label: 'Learning robot', rig: { body: { skin: '#f3ead7', height: 0.72, build: 'round', headSize: 1.25, armLength: 0.95, legLength: 0.85, hands: 'mitten', robot: true }, face: { eyeShape: 'glow', eyeColor: '#ffb000', eyeSize: 1.15, eyeSpacing: 1, browShape: 'none', browColor: '#333333', mouthShape: 'neutral', lipColor: '#ffb000', mouthWidth: 0.8, earShape: 'none', earSize: 1, noseShape: 'none', blush: false }, hair: { style: 'bald', color: '#000000' }, costume: { top: 'armor', topColor: '#f3ead7', accent: '#2a9d8f', bottom: 'none', bottomColor: '#f3ead7', shoes: 'barefoot', shoeColor: '#2a9d8f', extras: ['leaf-badge', 'antenna'] } } },
};

/* --------------------------------- helpers --------------------------------- */
const mats = [];
function mat(color, opts = {}) { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0, ...opts }); mats.push(m); return m; }
function mesh(geo, material, joint, parent) { const m = new THREE.Mesh(geo, material); m.castShadow = true; m.receiveShadow = true; m.userData.joint = joint; parent.add(m); return m; }
function capsule(r, len, material, joint, parent, y = -len / 2 - r * 0) {
  const m = mesh(new THREE.CapsuleGeometry(r, Math.max(0.001, len), 6, 14), material, joint, parent); m.position.y = y; return m;
}
function ellipsoid(rx, ry, rz, material, joint, parent, pos = [0, 0, 0], seg = 28) {
  const m = mesh(new THREE.SphereGeometry(1, seg, Math.round(seg * 0.7)), material, joint, parent); m.scale.set(rx, ry, rz); m.position.set(...pos); return m;
}
function group(parent, name, pos = [0, 0, 0]) { const g = new THREE.Group(); g.name = name; g.position.set(...pos); parent.add(g); return g; }

/* ---------------------------------- build ---------------------------------- */
function buildCharacter(rig) {
  const b = rig.body, f = rig.face, h = rig.hair, c = rig.costume, ex = new Set(c.extras || []);
  const robot = !!b.robot;
  const skinM = robot ? mat(b.skin, { roughness: 0.32, metalness: 0.25 }) : mat(b.skin, { roughness: 0.7 });
  const jointM = mat(c.accent, { roughness: 0.4, metalness: robot ? 0.3 : 0 });
  const topM = robot && c.top === 'armor' ? skinM : mat(c.topColor, { roughness: c.top === 'armor' ? 0.35 : 0.85, metalness: c.top === 'armor' ? 0.3 : 0 });
  const accM = mat(c.accent, { roughness: 0.6 });
  const botM = mat(c.bottomColor, { roughness: 0.85 });
  const shoeM = mat(c.shoeColor, { roughness: 0.55 });
  const hairM = mat(h.color, { roughness: 0.75 });
  const W = { slim: [0.105, 0.125], average: [0.125, 0.145], sturdy: [0.15, 0.175], round: [0.17, 0.16] }[b.build] || [0.125, 0.145];
  const waist = W[0], chestR = W[1];
  const thighLen = 0.3 * b.legLength, shinLen = 0.3 * b.legLength, upperLen = 0.24 * b.armLength, foreLen = 0.22 * b.armLength;
  const limbR = b.build === 'slim' ? 0.034 : b.build === 'sturdy' ? 0.046 : 0.04;
  const headR = 0.135 * b.headSize;
  const footH = 0.045;
  const J = {};

  const root = new THREE.Group(); root.name = 'root'; J.root = root;
  const lift = group(root, 'lift');
  const hips = group(lift, 'hips', [0, thighLen + shinLen + footH, 0]); J.hips = hips;
  const spine = group(hips, 'spine', [0, 0.08, 0]); J.spine = spine;
  const chest = group(spine, 'chest', [0, 0.16, 0]); J.chest = chest;
  const neck = group(chest, 'neck', [0, 0.2, 0]); J.neck = neck;
  const head = group(neck, 'head', [0, 0.05, 0]); J.head = head;

  // --- torso (costume colours) ---
  const longTop = ['kurta', 'dress', 'robe'].includes(c.top);
  const pelvisM = longTop ? topM : c.bottom === 'none' || c.bottom === 'skirt' ? (c.bottom === 'skirt' ? botM : topM) : botM;
  ellipsoid(waist * 1.05, 0.085, waist * 0.8, pelvisM, 'hips', hips, [0, 0.01, 0]);
  ellipsoid((waist + chestR) / 2 * (b.build === 'round' ? 1.12 : 1), 0.15, (waist + chestR) / 2 * (b.build === 'round' ? 0.95 : 0.74), topM, 'spine', spine, [0, 0.07, 0]);
  ellipsoid(chestR, 0.17, chestR * 0.7, topM, 'chest', chest, [0, 0.08, 0]);
  if (c.top === 'jacket') { const z = mesh(new THREE.BoxGeometry(0.012, 0.3, 0.01), accM, 'chest', chest); z.position.set(0, 0.04, chestR * 0.69); }
  if (c.top === 'kurta') { const z = mesh(new THREE.BoxGeometry(0.03, 0.14, 0.01), accM, 'chest', chest); z.position.set(0, 0.12, chestR * 0.66); }
  if (c.top === 'armor') { const r = mesh(new THREE.TorusGeometry(chestR * 0.55, 0.008, 8, 32), jointM, 'chest', chest); r.position.set(0, 0.08, chestR * 0.62); }
  if (!robot && c.top !== 'armor') { const belt = mesh(new THREE.TorusGeometry(waist * 1.0, 0.012, 8, 40), longTop ? accM : mat('#3a2a1a'), 'hips', hips); belt.rotation.x = Math.PI / 2; belt.position.y = 0.07; belt.scale.set(1, 0.76, 1); }
  // skirts and long tops hang from the hips
  const skirtLen = { kurta: thighLen * 0.75, dress: thighLen + shinLen * 0.25, robe: thighLen + shinLen * 0.92 }[c.top] || (c.bottom === 'skirt' ? thighLen * 0.85 : 0);
  if (skirtLen) {
    const sk = mesh(new THREE.CylinderGeometry(waist * 1.02, waist * (c.top === 'robe' ? 1.75 : 1.6), skirtLen, 32, 1, true), c.bottom === 'skirt' && !longTop ? botM : topM, 'hips', hips);
    sk.material.side = THREE.DoubleSide; sk.position.y = 0.04 - skirtLen / 2; sk.scale.z = 0.82;
  }
  if (c.bottom === 'dhoti') { const d = mesh(new THREE.CylinderGeometry(waist * 1.05, waist * 1.35, thighLen * 0.5, 28, 1, true), botM, 'hips', hips); d.material.side = THREE.DoubleSide; d.position.y = -thighLen * 0.2; d.scale.z = 0.85; }
  // neck
  capsule(limbR * 1.25, 0.04, skinM, 'neck', neck, 0.02);

  // --- head and face ---
  const skull = ellipsoid(headR, headR * 1.06, headR * 0.98, skinM, 'head', head, [0, headR * 0.95, 0], 40);
  const fc = group(head, 'face', [0, headR * 0.95, 0]);
  const surfZ = y => Math.sqrt(Math.max(0, (headR * 0.98) ** 2 * (1 - (y / (headR * 1.06)) ** 2)));
  const face = { eyes: [], brows: [], mouth: null };
  const eyeR = headR * 0.2 * f.eyeSize, eyeX = headR * 0.37 * f.eyeSpacing, eyeY = headR * 0.05;
  for (const side of [1, -1]) {
    const SD = side > 0 ? 'L' : 'R';
    const eg = group(fc, 'eye' + SD, [side * eyeX, eyeY, surfZ(eyeY) - eyeR * 0.45]);
    eg.rotation.y = side * 0.18;
    const shapeScale = { round: [1, 1], almond: [1.25, 0.72], big: [1.3, 1.3], sleepy: [1.05, 0.8], dot: [0.4, 0.5], glow: [1.05, 1.2] }[f.eyeShape] || [1, 1];
    const inner = group(eg, 'eyeInner' + SD); inner.scale.set(shapeScale[0], shapeScale[1], 1);
    let iris = null, pupil = null;
    if (f.eyeShape === 'dot') { ellipsoid(eyeR * 0.9, eyeR * 0.9, eyeR * 0.6, mat(f.eyeColor, { roughness: 0.3 }), 'head', inner); }
    else if (f.eyeShape === 'glow' || robot) {
      ellipsoid(eyeR * 1.15, eyeR * 1.15, eyeR * 0.3, mat('#16181d', { roughness: 0.2 }), 'head', inner, [0, 0, 0]);
      iris = ellipsoid(eyeR * 0.7, eyeR * 0.7, eyeR * 0.25, mat(f.eyeColor, { emissive: f.eyeColor, emissiveIntensity: 1.4, roughness: 0.3 }), 'head', inner, [0, 0, eyeR * 0.18]); iris.name = 'iris' + SD;
    } else {
      ellipsoid(eyeR, eyeR, eyeR * 0.55, mat('#fbfbf8', { roughness: 0.35 }), 'head', inner);
      iris = group(inner, 'iris' + SD, [0, 0, eyeR * 0.552]);
      const ir = mesh(new THREE.CircleGeometry(eyeR * 0.6, 32), mat(f.eyeColor, { roughness: 0.3 }), 'head', iris);
      pupil = mesh(new THREE.CircleGeometry(eyeR * 0.28, 24), mat('#050505', { roughness: 0.2 }), 'head', iris); pupil.position.z = 0.0008;
      const hl = mesh(new THREE.CircleGeometry(eyeR * 0.12, 12), new THREE.MeshBasicMaterial({ color: '#ffffff' }), 'head', iris); hl.position.set(eyeR * 0.18, eyeR * 0.2, 0.0016);
      ir.castShadow = pupil.castShadow = false;
    }
    // eyelid: a skin-coloured shell that closes from above
    let lid = null;
    if (f.eyeShape !== 'dot' && f.eyeShape !== 'glow' && !robot) {
      lid = mesh(new THREE.SphereGeometry(eyeR * 1.06, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), skinM, 'head', inner); lid.rotation.x = -Math.PI / 2; lid.scale.z = 0.62; lid.name = 'lid' + SD;
    }
    face.eyes.push({ g: eg, inner, iris, lid, side, sleepy: f.eyeShape === 'sleepy' });
    // eyebrow
    if (f.browShape !== 'none') {
      const bg = group(fc, 'brow' + SD, [side * eyeX * 1.02, eyeY + eyeR * 1.7 * (shapeScale[1] > 1 ? 1.15 : 1), 0]);
      bg.position.z = surfZ(bg.position.y) + 0.002; bg.rotation.y = side * 0.2;
      const bm = mat(f.browColor, { roughness: 0.8 });
      const t = { thick: 0.016, thin: 0.006, straight: 0.01, arched: 0.009 }[f.browShape] || 0.01;
      let bmesh;
      if (f.browShape === 'arched') { bmesh = mesh(new THREE.TorusGeometry(eyeR * 1.3, t, 6, 18, Math.PI * 0.55), bm, 'head', bg); bmesh.rotation.z = Math.PI / 2 - Math.PI * 0.275; bmesh.position.y = -eyeR * 1.15; }
      else { bmesh = mesh(new THREE.CapsuleGeometry(t, eyeR * 1.6, 4, 8), bm, 'head', bg); bmesh.rotation.z = Math.PI / 2; }
      face.brows.push({ g: bg, side, baseY: bg.position.y });
    }
  }
  if (f.blush && !robot) for (const side of [1, -1]) { const bl = mesh(new THREE.CircleGeometry(headR * 0.13, 20), new THREE.MeshBasicMaterial({ color: '#ff8a8a', transparent: true, opacity: 0.35 }), 'head', fc); const y = -headR * 0.22; bl.position.set(side * headR * 0.55, y, surfZ(y) * 0.86 + 0.012); bl.rotation.y = side * 0.55; bl.castShadow = false; }
  // nose
  if (f.noseShape !== 'none' && !robot) {
    const y = -headR * 0.14, z = surfZ(y);
    if (f.noseShape === 'long') { const n = mesh(new THREE.CapsuleGeometry(headR * 0.07, headR * 0.12, 4, 10), skinM, 'head', fc); n.rotation.x = Math.PI / 2.6; n.position.set(0, y, z + headR * 0.03); }
    else ellipsoid(headR * (f.noseShape === 'broad' ? 0.15 : 0.1), headR * (f.noseShape === 'broad' ? 0.09 : 0.09), headR * 0.09, skinM, 'head', fc, [0, y, z - headR * 0.01]);
  }
  // mouth: lip arc + open cavity + teeth
  {
    const y = -headR * 0.45, z = surfZ(y), mw = headR * 0.32 * f.mouthWidth;
    const mg = group(fc, 'mouth', [0, y, z - 0.004]);
    const lipM = robot ? mat(f.lipColor, { emissive: f.lipColor, emissiveIntensity: 1.2 }) : mat(f.lipColor, { roughness: 0.5 });
    const arc = Math.PI * 0.8;
    const lipG = group(mg, 'mouthLipArc');
    const lip = mesh(new THREE.TorusGeometry(mw, robot ? 0.007 : 0.0085, 8, 32, arc), lipM, 'head', lipG); lip.castShadow = false;
    const cavity = ellipsoid(mw * 0.92, mw * 0.55, mw * 0.25, mat('#3b0d0d', { roughness: 0.9 }), 'head', mg, [0, 0, -mw * 0.06]); cavity.castShadow = false;
    const teeth = mesh(new THREE.BoxGeometry(mw * 1.2, mw * 0.18, mw * 0.08), mat('#fffdf5', { roughness: 0.3 }), 'head', mg); teeth.castShadow = false;
    lip.name = 'mouthLip'; cavity.name = 'mouthCavity'; teeth.name = 'mouthTeeth';
    face.mouth = { g: mg, lipG, lip, cavity, teeth, mw, arc, grin: f.mouthShape === 'grin', base: f.mouthShape === 'smile' ? 0.45 : f.mouthShape === 'grin' ? 0.7 : 0.05, robot };
  }
  // ears
  if (f.earShape !== 'none' && !robot) for (const side of [1, -1]) {
    const s = f.earSize * (f.earShape === 'big' ? 1.35 : f.earShape === 'small' ? 0.75 : 1);
    if (f.earShape === 'pointed') { const e = mesh(new THREE.ConeGeometry(headR * 0.15 * s, headR * 0.55 * s, 12), skinM, 'head', fc); e.position.set(side * headR * 0.98, headR * 0.12, -headR * 0.05); e.rotation.z = -side * 0.75; e.scale.z = 0.45; }
    else ellipsoid(headR * 0.13 * s, headR * 0.22 * s, headR * 0.08 * s, skinM, 'head', fc, [side * headR * 0.98, 0, -headR * 0.04]);
  }
  if (robot && ex.has('antenna')) { capsule(0.006, headR * 0.35, jointM, 'head', fc, headR * 1.06 + headR * 0.2); ellipsoid(headR * 0.09, headR * 0.09, headR * 0.09, mat(c.accent, { emissive: c.accent, emissiveIntensity: 0.6 }), 'head', fc, [0, headR * 1.48, 0]); }
  if (robot) for (const side of [1, -1]) ellipsoid(headR * 0.14, headR * 0.14, headR * 0.06, jointM, 'head', fc, [side * headR * 0.98, 0, 0]);
  // hair
  const cap = (scale = 1.07, theta = 0.56, tilt = -0.42) => { const m = mesh(new THREE.SphereGeometry(headR * scale, 36, 18, 0, Math.PI * 2, 0, Math.PI * theta), hairM, 'head', fc); m.rotation.x = tilt; m.scale.set(1.0, 1.04, 0.99); return m; };
  if (h.style !== 'bald') {
    if (['short', 'long', 'bun', 'ponytail', 'braid', 'spiky'].includes(h.style)) cap();
    if (h.style === 'long') { const back = mesh(new THREE.CapsuleGeometry(headR * 0.82, headR * 1.3, 6, 16), hairM, 'head', fc); back.position.set(0, -headR * 0.55, -headR * 0.42); back.scale.z = 0.55; for (const side of [1, -1]) { const s = mesh(new THREE.CapsuleGeometry(headR * 0.22, headR * 1.1, 4, 10), hairM, 'head', fc); s.position.set(side * headR * 0.86, -headR * 0.5, -headR * 0.08); } }
    if (h.style === 'bun') ellipsoid(headR * 0.42, headR * 0.42, headR * 0.42, hairM, 'head', fc, [0, headR * 0.82, -headR * 0.72]);
    if (h.style === 'ponytail') { ellipsoid(headR * 0.13, headR * 0.13, headR * 0.13, accM, 'head', fc, [0, headR * 0.45, -headR * 1.02]); const t = mesh(new THREE.CapsuleGeometry(headR * 0.2, headR * 1.05, 4, 12), hairM, 'head', fc); t.position.set(0, -headR * 0.2, -headR * 1.18); t.rotation.x = 0.35; }
    if (h.style === 'braid') for (let i = 0; i < 6; i++) ellipsoid(headR * (0.2 - i * 0.012), headR * 0.17, headR * (0.2 - i * 0.012), hairM, 'head', fc, [0, headR * (0.1 - i * 0.3), -headR * (1.0 + i * 0.02)]);
    if (h.style === 'curly') { const n = 34; for (let i = 0; i < n; i++) { const yy = 1 - (i / (n - 1)) * 1.15, r = Math.sqrt(Math.max(0, 1 - yy * yy)), th = i * 2.399963; const x = Math.cos(th) * r, z = Math.sin(th) * r; if (z > 0.35 && yy < 0.55) continue; ellipsoid(headR * 0.3, headR * 0.3, headR * 0.3, hairM, 'head', fc, [x * headR * 0.98, yy * headR * 1.02 + headR * 0.05, z * headR * 0.98]); } }
    if (h.style === 'spiky') for (let i = 0; i < 13; i++) { const th = i * 2.399963, r = 0.35 + (i % 4) * 0.15, x = Math.cos(th) * r, z = Math.sin(th) * r - 0.15; const s = mesh(new THREE.ConeGeometry(headR * 0.16, headR * 0.6, 8), hairM, 'head', fc); const yy = Math.sqrt(Math.max(0.05, 1 - x * x - z * z)); s.position.set(x * headR, yy * headR * 1.02, z * headR); s.lookAt(new THREE.Vector3(x * 3 * headR, yy * 3 * headR + headR * 0.3, z * 3 * headR).add(fc.position)); s.rotateX(Math.PI / 2); }
  }
  if (ex.has('cap')) { const cp = mesh(new THREE.SphereGeometry(headR * 1.1, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.45), accM, 'head', fc); cp.rotation.x = -0.25; const brim = mesh(new THREE.CylinderGeometry(headR * 0.75, headR * 0.75, 0.008, 32, 1, false, -Math.PI / 2, Math.PI), accM, 'head', fc); brim.position.set(0, headR * 0.42, headR * 0.62); brim.rotation.x = 0.12; }
  if (ex.has('glasses')) { const gm = mat('#1d1d1d', { roughness: 0.4 }); for (const side of [1, -1]) { const r = mesh(new THREE.TorusGeometry(eyeR * 1.45, 0.005, 8, 28), gm, 'head', fc); r.position.set(side * eyeX, eyeY, surfZ(eyeY) + 0.012); r.rotation.y = side * 0.18; const arm = mesh(new THREE.BoxGeometry(0.006, 0.006, headR * 0.9), gm, 'head', fc); arm.position.set(side * headR * 0.92, eyeY, headR * 0.35); } const br = mesh(new THREE.BoxGeometry(eyeX * 2 - eyeR * 2.9, 0.006, 0.006), gm, 'head', fc); br.position.set(0, eyeY + eyeR * 0.3, surfZ(eyeY) + 0.02); }
  if (ex.has('bindi') && !robot) { const bd = mesh(new THREE.CircleGeometry(headR * 0.045, 16), mat('#c1121f'), 'head', fc); const y = eyeY + eyeR * 2.2; bd.position.set(0, y, surfZ(y) + 0.002); bd.castShadow = false; }
  if (ex.has('beard') && !robot) ellipsoid(headR * 0.6, headR * 0.42, headR * 0.45, hairM, 'head', fc, [0, -headR * 0.62, headR * 0.5]);
  if (ex.has('mustache') && !robot) for (const side of [1, -1]) { const m = mesh(new THREE.CapsuleGeometry(headR * 0.06, headR * 0.18, 4, 8), hairM, 'head', fc); const y = -headR * 0.32; m.position.set(side * headR * 0.13, y, surfZ(y) + 0.005); m.rotation.z = Math.PI / 2 + side * 0.25; }
  if (ex.has('scarf')) { const sc = mesh(new THREE.TorusGeometry(limbR * 2.2, limbR * 0.9, 10, 28), accM, 'neck', neck); sc.rotation.x = Math.PI / 2; sc.position.y = 0.01; const tail = capsule(limbR * 0.7, 0.12, accM, 'chest', chest, 0.13); tail.position.set(chestR * 0.3, 0.12, chestR * 0.68); tail.rotation.z = 0.15; }
  if (ex.has('backpack')) { const bp = mesh(new THREE.BoxGeometry(chestR * 1.3, 0.22, 0.09), accM, 'chest', chest); bp.position.set(0, 0.07, -chestR * 0.72 - 0.04); }
  if (ex.has('leaf-badge')) { const sh = new THREE.Shape(); sh.moveTo(0, -0.035); sh.quadraticCurveTo(0.035, 0, 0, 0.035); sh.quadraticCurveTo(-0.035, 0, 0, -0.035); const lf = mesh(new THREE.ShapeGeometry(sh), mat('#3fbf6a', { emissive: '#3fbf6a', emissiveIntensity: 0.9 }), 'chest', chest); lf.position.set(0, 0.11, chestR * 0.7 + 0.004); lf.castShadow = false; }

  // --- arms ---
  const sleeveUpper = ['tshirt', 'kurta', 'jacket', 'robe', 'armor'].includes(c.top);
  const sleeveFore = ['kurta', 'jacket', 'robe', 'armor'].includes(c.top);
  for (const [s, side] of [['L', 1], ['R', -1]]) {
    const sh = group(chest, 'shoulder' + s, [side * (chestR + limbR * 0.4), 0.17, 0]);
    ellipsoid(limbR * 1.35, limbR * 1.35, limbR * 1.35, robot ? jointM : sleeveUpper ? topM : skinM, 'upperArm' + s, sh);
    const ua = group(sh, 'upperArm' + s); J['upperArm' + s] = ua;
    capsule(limbR * (sleeveUpper ? 1.12 : 1), upperLen, robot ? skinM : sleeveUpper ? topM : skinM, 'upperArm' + s, ua);
    if (c.top === 'tshirt' && !robot) { capsule(limbR * 0.98, upperLen * 0.45, skinM, 'upperArm' + s, ua, -upperLen * 0.75); }
    const fa = group(ua, 'forearm' + s, [0, -upperLen, 0]); J['forearm' + s] = fa;
    ellipsoid(limbR * 1.05, limbR * 1.05, limbR * 1.05, robot ? jointM : sleeveFore ? topM : skinM, 'forearm' + s, fa);
    capsule(limbR * (sleeveFore ? 1.05 : 0.92), foreLen, robot ? skinM : sleeveFore ? topM : skinM, 'forearm' + s, fa);
    if (sleeveFore && !robot) { const cuff = mesh(new THREE.TorusGeometry(limbR * 1.0, 0.008, 8, 20), accM, 'forearm' + s, fa); cuff.rotation.x = Math.PI / 2; cuff.position.y = -foreLen * 0.95; }
    if (ex.has('watch') && s === 'L') { const w = mesh(new THREE.TorusGeometry(limbR * 0.95, 0.009, 8, 20), mat('#222'), 'forearmL', fa); w.rotation.x = Math.PI / 2; w.position.y = -foreLen * 0.85; }
    const hd = group(fa, 'hand' + s, [0, -foreLen, 0]); J['hand' + s] = hd;
    const hm = robot ? jointM : skinM, hr = limbR * 1.25;
    const fing = group(hd, 'fingers' + s, [0, -hr * 1.1, 0]); J['fingers' + s] = fing;
    if (b.hands === 'fingers' && !robot) {
      ellipsoid(hr * 0.42, hr * 0.85, hr * 0.85, hm, 'hand' + s, hd, [0, -hr * 0.6, 0]);
      const segs = [];
      for (let i = 0; i < 4; i++) {
        const z = (i - 1.5) * hr * 0.42, len = hr * (i === 0 || i === 3 ? 0.42 : 0.5);
        const f1 = group(fing, 'f' + s + i, [0, 0, z]); f1.userData.seg = 1; capsule(hr * 0.16, len, hm, 'fingers' + s, f1, -len / 2);
        const f2 = group(f1, 'g' + s + i, [0, -len, 0]); f2.userData.seg = 2; capsule(hr * 0.15, len * 0.8, hm, 'fingers' + s, f2, -len * 0.4);
        segs.push(f1, f2);
      }
      const th = group(hd, 'thumb', [-side * hr * 0.1, -hr * 0.45, hr * 0.62]); capsule(hr * 0.18, hr * 0.45, hm, 'hand' + s, th, -hr * 0.22); th.rotation.set(0.6, 0, side * 0.5);
      fing.userData.segs = segs;
    } else {
      ellipsoid(hr * 0.55, hr * 0.95, hr * 0.85, hm, 'hand' + s, hd, [0, -hr * 0.75, 0]);
      const mit = group(fing, 'mitten' + s, [0, 0, 0]); mit.userData.seg = 3; ellipsoid(hr * 0.5, hr * 0.55, hr * 0.8, hm, 'fingers' + s, mit, [0, -hr * 0.35, 0]);
      fing.userData.segs = [mit];
      const th = group(hd, 'thumb', [-side * hr * 0.05, -hr * 0.55, hr * 0.7]); capsule(hr * 0.22, hr * 0.35, hm, 'hand' + s, th, -hr * 0.18); th.rotation.set(0.7, 0, side * 0.45);
    }
  }
  // --- legs ---
  for (const [s, side] of [['L', 1], ['R', -1]]) {
    const th = group(hips, 'thigh' + s, [side * waist * 0.52, -0.02, 0]); J['thigh' + s] = th;
    const thighM = robot ? skinM : ['pants', 'shorts', 'dhoti'].includes(c.bottom) ? botM : skinM;
    const shinM = robot ? skinM : ['pants'].includes(c.bottom) ? botM : c.bottom === 'dhoti' ? botM : skinM;
    capsule(limbR * 1.25, thighLen, thighM, 'thigh' + s, th);
    if (c.bottom === 'shorts' && !robot) capsule(limbR * 1.05, thighLen * 0.35, skinM, 'thigh' + s, th, -thighLen * 0.8);
    const sn = group(th, 'shin' + s, [0, -thighLen, 0]); J['shin' + s] = sn;
    ellipsoid(limbR * 1.15, limbR * 1.15, limbR * 1.15, robot ? jointM : thighM, 'shin' + s, sn);
    capsule(limbR * 1.05, shinLen, shinM, 'shin' + s, sn);
    const ft = group(sn, 'foot' + s, [0, -shinLen, 0]); J['foot' + s] = ft;
    const fm = c.shoes === 'barefoot' ? (robot ? jointM : skinM) : shoeM;
    const shoe = ellipsoid(limbR * 1.35, footH * 0.62, limbR * 2.6, fm, 'foot' + s, ft, [0, -footH * 0.42, limbR * 1.1]);
    if (c.shoes === 'boots' && !robot) capsule(limbR * 1.2, shinLen * 0.3, shoeM, 'shin' + s, sn, -shinLen * 0.85);
    if (c.shoes === 'sneakers') { const sole = ellipsoid(limbR * 1.4, footH * 0.2, limbR * 2.65, mat('#fafafa'), 'foot' + s, ft, [0, -footH * 0.9, limbR * 1.1]); sole.castShadow = false; }
    if (c.shoes === 'sandals') { shoe.scale.y *= 0.45; shoe.position.y = -footH * 0.75; ellipsoid(limbR * 1.1, footH * 0.45, limbR * 2.1, skinM, 'foot' + s, ft, [0, -footH * 0.3, limbR * 1.0]); }
  }
  const height = (thighLen + shinLen + footH + 0.08 + 0.16 + 0.2 + 0.05 + headR * 2) ;
  root.scale.setScalar(b.height * 1.25);
  return { root, J, lift, face, height: height * b.height * 1.25, legLen: thighLen + shinLen + footH, m: { waist, chestR, headR, limbR, robot, thighLen, shinLen, upperLen, foreLen, footH, shoulderX: chestR + limbR * 0.4 } };
}

/* --------------------------------- moves --------------------------------- */
const add = (a, b) => [0, 1, 2].map(i => (a?.[i] || 0) + (b?.[i] || 0));
function basePose(name) { const p = POSES[name] || POSES.stand; return { joints: JSON.parse(JSON.stringify(p.joints)), root: { ...p.root }, face: { ...p.face } }; }
/** A procedural move at time t (seconds). hold: a saved pose to perform from. */
export function animate(move, t, level = 0, hold = null) {
  const w = (f, a = 1, ph = 0) => Math.sin(t * f + ph) * a;
  let p = hold ? { joints: JSON.parse(JSON.stringify(hold.joints || {})), root: { ...(hold.root || {}) }, face: { ...(hold.face || {}) } } : basePose('stand');
  const J = p.joints, set = (k, v) => { J[k] = add(J[k], v); };
  // breathing and blinking everywhere
  set('chest', [w(1.8, 1.2), 0, 0]); set('head', [w(0.7, 1.5), w(0.45, 2), 0]);
  const blink = (t % 3.9) < 0.12 ? 0.05 : 1;
  switch (move) {
    case 'talk': set('head', [w(6.5, 3), w(2.1, 4), w(1.7, 3)]); set('upperArmR', [25 + w(2.4, 8), 0, 5]); set('forearmR', [55 + w(3, 12), -20, 0]); set('fingersR', [-15]); break;
    case 'wave': p = basePose('wave'); p.joints.forearmR = add(p.joints.forearmR, [w(9, 18), 0, w(9, 22)]); break;
    case 'nod': set('head', [Math.abs(w(5, 18)), 0, 0]); break;
    case 'shake': set('head', [0, w(9, 28), 0]); p.face.smile = -0.2; break;
    case 'jump': { const ph = (t % 1.1) / 1.1, air = Math.max(0, Math.sin(ph * Math.PI * 1.25)), crouch = ph > 0.82 || ph < 0.05 ? 1 : 0; p.root.lift = air * 0.35 - crouch * 0.06; for (const s of ['L', 'R']) { set('upperArm' + s, [20, 0, 40 + air * 110]); set('thigh' + s, [crouch * 35 + air * 15, 0, 0]); set('shin' + s, [crouch * 60 + air * 30]); } p.face.open = air * 0.4; p.face.smile = 0.9; break; }
    case 'walk': { const c = w(6, 1); set('thighL', [c * 28, 0, 0]); set('thighR', [-c * 28, 0, 0]); set('shinL', [Math.max(0, -c) * 40 + 5]); set('shinR', [Math.max(0, c) * 40 + 5]); set('upperArmL', [-c * 25, 0, 0]); set('upperArmR', [c * 25, 0, 0]); set('forearmL', [20, 0, 0]); set('forearmR', [20, 0, 0]); p.root.lift = -Math.abs(w(6, 0.015)); p.root.walk = Math.sin(t * 0.7) * 0.6; p.root.turn = Math.cos(t * 0.7) > 0 ? 90 : -90; break; }
    case 'dance': p = basePose('dance'); p.joints.hips = add(p.joints.hips, [0, w(4, 15), w(4, 10)]); p.joints.chest = add(p.joints.chest, [0, w(4, -15), w(4, -12)]); p.joints.upperArmL = add(p.joints.upperArmL, [0, 0, w(4, 25)]); p.joints.upperArmR = add(p.joints.upperArmR, [0, 0, w(4, -25)]); p.root.lift = -Math.abs(w(8, 0.03)); p.root.turn = w(2, 25); break;
    case 'think': p = basePose('think'); p.joints.head = add(p.joints.head, [0, w(0.8, 6), 0]); break;
    case 'celebrate': p = basePose('cheer'); p.root.lift = Math.max(0, w(7, 0.1)); p.joints.upperArmL = add(p.joints.upperArmL, [0, 0, w(12, 8)]); p.joints.upperArmR = add(p.joints.upperArmR, [0, 0, w(12, -8)]); break;
    case 'point': p = basePose('point'); break;
    case 'bow': { const b = Math.min(1, t / 0.6) * (t < 1.6 ? 1 : Math.max(0, 1 - (t - 1.6) / 0.6)); p = basePose('stand'); p.joints.hips = [40 * b, 0, 0]; p.joints.head = [12 * b, 0, 0]; p.face.eyeL = p.face.eyeR = 1 - 0.6 * b; break; }
    case 'sad': p = basePose('stand'); Object.assign(p.face, EXPRESSIONS.sad.face); p.joints.head = [20, 0, 6]; p.joints.chest = [10, 0, 0]; p.joints.upperArmL = p.joints.upperArmR = [0, 0, 3]; break;
    case 'surprise': p = basePose('stand'); Object.assign(p.face, EXPRESSIONS.surprised.face); p.joints.upperArmL = p.joints.upperArmR = [30, 0, 45]; p.joints.forearmL = p.joints.forearmR = [70, 0, 0]; p.joints.fingersL = p.joints.fingersR = [-5]; p.joints.chest = [-8, 0, 0]; p.root.lift = t < 0.25 ? t * 0.2 : Math.max(0, 0.05 - (t - 0.25) * 0.2); break;
    case 'pose': case 'idle': default: break;
  }
  p.face.eyeL = Math.min(p.face.eyeL ?? 1, blink); p.face.eyeR = Math.min(p.face.eyeR ?? 1, blink);
  if (level > 0.03) { p.face.open = Math.max(p.face.open || 0, Math.min(1, level * 1.1)); }
  else if (move === 'talk') p.face.open = Math.max(p.face.open || 0, Math.max(0, w(14, 0.35) + 0.1));
  return p;
}


/* ------------------------------ body systems ------------------------------ */
// Simplified, labelled, not-to-scale models of the body's systems, drawn inside
// the character while the skin turns see-through. Flows (food, blood, air,
// urine, nerve signals, hormones) move along the paths.
export const SYSTEMS = {
  none:         { label: 'Normal' },
  organs:       { label: 'All organs', note: 'The main organs together. A simplified model: sizes and places are approximate.' },
  digestive:    { label: 'Nutrition (digestion)', note: 'Food: mouth → oesophagus → stomach → small intestine, where nutrients pass into the blood (gold dots) → large intestine → rectum → anus. The liver makes bile and the pancreas adds digestive juices; food does not pass through them.' },
  circulatory:  { label: 'Transport (circulation)', note: 'The heart pumps blood. Arteries (red) carry blood away from the heart; veins (blue) bring it back. The names describe direction, not always how much oxygen the blood has.' },
  respiratory:  { label: 'Respiration (breathing)', note: 'Air: nose and mouth → windpipe → bronchi → lungs. The diaphragm moves down to breathe in. In the lungs oxygen passes into the blood and carbon dioxide comes out. Breathing moves air; cellular respiration releases energy from food in cells.' },
  excretory:    { label: 'Excretion (urinary)', note: 'Kidneys filter the blood and remove wastes such as urea, and balance water and salts. Urine: kidneys → ureters → bladder → urethra. Excretion is different from egestion (removing undigested food).' },
  nervous:      { label: 'Nervous system', note: 'The brain and spinal cord send and receive signals along nerves to every part of the body.' },
  skeletal:     { label: 'Skeleton', note: 'Bones support the body, protect organs (the skull protects the brain, the ribs protect the heart and lungs) and work with muscles at the joints.' },
  endocrine:    { label: 'Hormones (endocrine)', note: 'Endocrine glands release hormones, chemical messengers carried by the blood, that influence growth, development and other body functions.' },
  reproductive: { label: 'Reproduction', note: 'Reproductive organs develop towards maturity during puberty, at a different time and pace for each person. A simplified, respectful school-level model; personal questions belong with a trusted adult or health professional.' },
};
const L = {
  mouth: 'Mouth · मुँह', oesophagus: 'Oesophagus · ग्रासनली', stomach: 'Stomach · आमाशय', liver: 'Liver · यकृत', gall: 'Gall bladder · पित्ताशय', pancreas: 'Pancreas · अग्न्याशय', small: 'Small intestine · छोटी आँत', large: 'Large intestine · बड़ी आँत', rectum: 'Rectum, anus · मलाशय, गुदा',
  heart: 'Heart · हृदय', artery: 'Arteries · धमनियाँ', vein: 'Veins · शिराएँ', lungs: 'Lungs · फेफड़े', trachea: 'Windpipe · श्वासनली', bronchi: 'Bronchi · श्वसनी', diaphragm: 'Diaphragm · डायाफ़्राम', nose: 'Nose · नाक',
  kidneys: 'Kidneys · गुर्दे', ureters: 'Ureters · मूत्रवाहिनी', bladder: 'Bladder · मूत्राशय', urethra: 'Urethra · मूत्रमार्ग',
  brain: 'Brain · मस्तिष्क', cord: 'Spinal cord · मेरुरज्जु', nerves: 'Nerves · तंत्रिकाएँ',
  skull: 'Skull · खोपड़ी', spine: 'Backbone · रीढ़', ribs: 'Ribs · पसलियाँ', pelvis: 'Pelvis · श्रोणि', limbs: 'Limb bones · हड्डियाँ',
  pituitary: 'Pituitary · पीयूष ग्रंथि', thyroid: 'Thyroid · थायरॉइड', adrenal: 'Adrenal glands · अधिवृक्क', ovaries: 'Ovaries · अंडाशय', testes: 'Testes · वृषण',
  uterus: 'Uterus · गर्भाशय', tubes: 'Oviducts · अंडवाहिनी', ducts: 'Sperm ducts · शुक्रवाहिनी', prostate: 'Prostate gland · प्रोस्टेट',
};
function labelSprite(text, color = '#ffffff') {
  const c = document.createElement('canvas'), x = c.getContext('2d'), fs = 34;
  x.font = `600 ${fs}px -apple-system, "Segoe UI", "Noto Sans Devanagari", "Kohinoor Devanagari", sans-serif`;
  const w = Math.ceil(x.measureText(text).width) + 28; c.width = w; c.height = fs + 22;
  x.font = `600 ${fs}px -apple-system, "Segoe UI", "Noto Sans Devanagari", "Kohinoor Devanagari", sans-serif`;
  x.fillStyle = 'rgba(12,15,22,0.82)'; x.beginPath(); if (x.roundRect) x.roundRect(0, 0, w, c.height, 14); else x.rect(0, 0, w, c.height); x.fill();
  x.fillStyle = color; x.fillRect(0, 0, 7, c.height); x.fillStyle = '#ffffff'; x.textBaseline = 'middle'; x.fillText(text, 16, c.height / 2 + 1);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true })); sp.renderOrder = 10;
  const h = 0.042; sp.scale.set(h * w / c.height, h, 1); sp.center.set(0, 0.5); sp.userData.w = h * w / c.height; return sp;
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);
function tube(points, r, color, parent, opts = {}) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const m = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, points.length * 16), r, 10, false), new THREE.MeshStandardMaterial({ color, roughness: 0.5, emissive: color, emissiveIntensity: opts.glow ?? 0.15, transparent: !!opts.opacity, opacity: opts.opacity ?? 1 }));
  m.renderOrder = 2; parent.add(m); return { mesh: m, curve };
}
function blob(pos, r, color, parent, opts = {}) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), new THREE.MeshStandardMaterial({ color, roughness: 0.45, emissive: color, emissiveIntensity: opts.glow ?? 0.15, transparent: !!opts.opacity, opacity: opts.opacity ?? 1 }));
  m.scale.set(...(Array.isArray(r) ? r : [r, r, r])); m.position.copy(pos); if (opts.rot) m.rotation.set(...opts.rot); m.renderOrder = 2; parent.add(m); return m;
}

function buildAnatomy(ch, system, { variant = 'female', labels = true } = {}) {
  const g = new THREE.Group(); g.name = 'anatomy'; ch.root.add(g);
  const { J, m } = ch, w = m.waist, cR = m.chestR, hR = m.headR, lR = m.limbR;
  ch.root.updateMatrixWorld(true);
  const at = (obj, x = 0, y = 0, z = 0) => ch.root.worldToLocal(obj.localToWorld(V(x, y, z)));
  const head = at(J.head, 0, hR * 0.95, 0), chest = at(J.chest, 0, 0.09, 0), spine = at(J.spine, 0, 0.07, 0), hips = at(J.hips, 0, 0.01, 0), neck = at(J.neck, 0, 0.02, 0);
  const mouth = head.clone().add(V(0, -hR * 0.45, hR * 0.8)), nose = head.clone().add(V(0, -hR * 0.12, hR * 0.85));
  const side = s => ({ sh: at(J['upperArm' + s]), el: at(J['forearm' + s]), wr: at(J['hand' + s]), fi: at(J['fingers' + s], 0, -lR * 1.5, 0), hp: at(J['thigh' + s]), kn: at(J['shin' + s]), an: at(J['foot' + s]), toe: at(J['foot' + s], 0, -0.03, lR * 2.6) });
  const SL = side('L'), SR = side('R');
  const flows = [], beats = [], labs = [], all = system === 'organs';
  const label = (key, anchor, color, dir) => { if (!labels) return; const sp = labelSprite(L[key], color); const d = dir ?? (anchor.x >= 0 ? 1 : -1); const x = d * (cR * 1.9 + 0.03); sp.position.set(d > 0 ? x : x - sp.userData.w, anchor.y, anchor.z + 0.05); g.add(sp);
    const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints([anchor, V(x, anchor.y, anchor.z + 0.05)]), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false })); ln.renderOrder = 9; g.add(ln); labs.push({ sp, ln, d, x, anchor }); };
  const layout = () => { for (const d of [1, -1]) { const list = labs.filter(l => l.d === d).sort((a, b) => b.anchor.y - a.anchor.y); let prev = Infinity; for (const l of list) { const y = Math.min(l.anchor.y, prev - 0.05); prev = y; l.sp.position.y = y; l.ln.geometry.setFromPoints([l.anchor, V(l.x, y, l.anchor.z + 0.05)]); } } };
  const flow = (curve, color, n, speed, size = 0.006, opts = {}) => { const dots = []; for (let i = 0; i < n; i++) { const d = new THREE.Mesh(new THREE.SphereGeometry(size, 10, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: !opts.top })); d.renderOrder = 4; g.add(d); dots.push(d); } flows.push({ curve, dots, speed, phase: Math.random(), ...opts }); };
  const back = z => z - w * 0.15, front = z => z + w * 0.25;

  // --- digestive ---
  if (system === 'digestive' || all) {
    const stomach = spine.clone().add(V(w * 0.42, 0.075, w * 0.18));
    const oes = tube([mouth.clone().add(V(0, -0.01, -hR * 0.2)), neck.clone().add(V(0, 0, -0.005)), chest.clone().add(V(0.004, 0, -cR * 0.15)), stomach.clone().add(V(-w * 0.18, 0.04, 0))], 0.0075, '#e9a3a3', g);
    blob(stomach, [w * 0.36, 0.06, w * 0.26], '#e98a8a', g, { rot: [0, 0, -0.55] });
    const liver = spine.clone().add(V(-w * 0.3, 0.13, w * 0.22)); blob(liver, [w * 0.6, 0.05, w * 0.36], '#8a3b2e', g, { rot: [0, 0, 0.25] });
    const gall = liver.clone().add(V(w * 0.12, -0.05, w * 0.12)); blob(gall, 0.012, '#5fae5a', g);
    const panc = spine.clone().add(V(w * 0.1, 0.02, -w * 0.02)); blob(panc, [w * 0.42, 0.013, 0.014], '#f2c879', g, { rot: [0, 0, -0.2] });
    const sc = hips.clone().add(V(0, 0.06, w * 0.28)); const coil = [];
    for (let i = 0; i <= 7; i++) { const yy = sc.y + 0.05 - i * 0.015; coil.push(V(sc.x + (i % 2 ? 1 : -1) * w * 0.38, yy, sc.z + (i % 2 ? 0.006 : -0.006))); coil.push(V(sc.x + (i % 2 ? -1 : 1) * w * 0.38, yy - 0.0075, sc.z)); }
    const smallT = tube([stomach.clone().add(V(w * 0.1, -0.05, 0)), sc.clone().add(V(w * 0.3, 0.07, 0)), ...coil], 0.008, '#f0b9a8', g);
    const lStart = coil[coil.length - 1];
    const largeT = tube([lStart, hips.clone().add(V(-w * 0.62, 0.02, w * 0.2)), spine.clone().add(V(-w * 0.62, 0.06, w * 0.25)), spine.clone().add(V(0, 0.09, w * 0.36)), spine.clone().add(V(w * 0.62, 0.06, w * 0.25)), hips.clone().add(V(w * 0.55, 0.0, w * 0.15)), hips.clone().add(V(w * 0.1, -0.04, -w * 0.05)), hips.clone().add(V(0, -0.1, -w * 0.12))], 0.013, '#c7866b', g);
    if (!all) {
      const path = new THREE.CurvePath(); path.add(oes.curve); path.add(new THREE.LineCurve3(oes.curve.getPoint(1), stomach)); path.add(new THREE.LineCurve3(stomach, smallT.curve.getPoint(0))); path.add(smallT.curve); path.add(largeT.curve);
      flow(path, '#ffd166', 26, 0.035, 0.006);
      for (let i = 0; i < 8; i++) { const from = smallT.curve.getPoint(0.3 + i * 0.08); const to = from.clone().add(V((Math.random() - 0.5) * 0.16, 0.05 + Math.random() * 0.12, 0.04)); flow(new THREE.LineCurve3(from, to), '#ffb000', 1, 0.5 + Math.random() * 0.3, 0.004, { fade: true }); }
    }
    label('mouth', mouth, '#ffd166'); label('oesophagus', neck.clone().add(V(0, -0.02, 0)), '#e9a3a3', -1); label('stomach', stomach, '#e98a8a'); label('liver', liver, '#c0634f'); label('gall', gall, '#5fae5a', -1); label('pancreas', panc, '#f2c879');
    label('small', coil[6], '#f0b9a8', -1); label('large', spine.clone().add(V(w * 0.62, 0.06, w * 0.25)), '#c7866b'); label('rectum', hips.clone().add(V(0, -0.09, -w * 0.12)), '#c7866b', -1);
  }
  // --- respiratory ---
  let lungs = [], diaphragm = null;
  if (system === 'respiratory' || system === 'circulatory' || all) {
    const top = chest.clone().add(V(0, 0.1, 0));
    const tr = tube([nose.clone().add(V(0, -0.005, -hR * 0.25)), head.clone().add(V(0, -hR * 0.75, hR * 0.15)), neck.clone().add(V(0, 0.01, lR * 0.4)), top], system === 'respiratory' ? 0.008 : 0.006, '#9fd3e8', g, { opacity: system === 'respiratory' ? 0 : 0.6 });
    for (const sx of [1, -1]) {
      const lc = chest.clone().add(V(sx * cR * 0.48, 0.02, 0.0));
      lungs.push(blob(lc, [cR * 0.4, 0.11, cR * 0.42 * 0.72], '#f2a7b8', g, { opacity: system === 'respiratory' || all ? 0.92 : 0.35 }));
      if (system === 'respiratory') { const br = tube([top, top.clone().add(V(sx * cR * 0.2, -0.03, 0)), lc.clone().add(V(-sx * cR * 0.1, 0.02, 0))], 0.005, '#9fd3e8', g); flow(br.curve, '#d8f3ff', 4, 0.6, 0.005, { breath: true }); }
    }
    if (system === 'respiratory' || all) { diaphragm = new THREE.Mesh(new THREE.SphereGeometry(cR * 0.95, 32, 12, 0, Math.PI * 2, 0, Math.PI * 0.32), new THREE.MeshStandardMaterial({ color: '#d4776f', roughness: 0.6, emissive: '#d4776f', emissiveIntensity: 0.15, side: THREE.DoubleSide })); diaphragm.position.copy(chest.clone().add(V(0, -0.16, 0))); diaphragm.scale.set(1, 0.45, 0.72); diaphragm.renderOrder = 2; g.add(diaphragm); diaphragm.userData.y = diaphragm.position.y; }
    if (system === 'respiratory') { flow(tr.curve, '#d8f3ff', 10, 0.5, 0.005, { breath: true }); label('nose', nose, '#9fd3e8', -1); label('trachea', neck, '#9fd3e8'); label('bronchi', top, '#9fd3e8', -1); label('lungs', lungs[0].position, '#f2a7b8'); label('diaphragm', diaphragm.position, '#d4776f', -1); }
    else if (all) label('lungs', lungs[0].position, '#f2a7b8');
  }
  // --- circulatory ---
  let heart = null;
  if (system === 'circulatory' || system === 'endocrine' || all) {
    const hp = chest.clone().add(V(cR * 0.16, -0.03, cR * 0.18));
    heart = blob(hp, [cR * 0.24, cR * 0.28, cR * 0.2], '#c1121f', g, { rot: [0, 0, 0.4], glow: 0.35 }); beats.push(heart);
    if (system !== 'endocrine') label('heart', hp, '#ff4d5e');
  }
  const vessels = [];
  if (system === 'circulatory' || system === 'endocrine') {
    const hp = heart.position, aortaTop = hp.clone().add(V(0, 0.07, -0.01)), backZ = -w * 0.25;
    const routes = (off, z) => [
      [hp, aortaTop, neck.clone().add(V(off * 0.6, 0, z)), head.clone().add(V(off, -hR * 0.2, z))],
      ...[SL, SR].map(S => [hp, aortaTop, chest.clone().add(V(Math.sign(S.sh.x) * cR * 0.5, 0.12, z)), S.sh.clone().add(V(0, 0, z)), S.el.clone().add(V(off * 0.3, 0, z)), S.wr.clone().add(V(0, 0, z)), S.fi]),
      ...[SL, SR].map(S => [hp, chest.clone().add(V(off * 0.5, -0.05, backZ)), spine.clone().add(V(off * 0.5, 0, backZ)), hips.clone().add(V(Math.sign(S.hp.x) * w * 0.25, -0.02, z)), S.hp.clone().add(V(0, -0.04, z)), S.kn.clone().add(V(off * 0.3, 0, z)), S.an.clone().add(V(0, 0, z)), S.toe]),
    ];
    for (const r of routes(0.004, 0.006)) { const t = tube(r, 0.0042, '#e63946', g, { glow: 0.3 }); vessels.push(t.curve); if (system === 'circulatory') flow(t.curve, '#ff4d5e', 7, 0.16, 0.0055, { top: true }); }
    if (system === 'circulatory') {
      for (const r of routes(-0.006, -0.006)) { const t = tube(r.slice().reverse(), 0.0042, '#3a86ff', g, { glow: 0.3 }); flow(t.curve, '#6fa8ff', 7, 0.13, 0.0055, { top: true }); }
      for (const l of lungs) { const t = tube([heart.position, l.position.clone().add(V(0, 0.02, 0.01)), heart.position.clone().add(V(0, 0.01, 0.01))], 0.004, '#b06fc4', g); flow(t.curve, '#d9a7ff', 4, 0.3, 0.005, { top: true }); }
      label('artery', SL.el, '#e63946'); label('vein', SR.el.clone().add(V(0, -0.02, 0)), '#3a86ff'); label('lungs', lungs[1].position, '#f2a7b8');
    }
  }
  // --- excretory ---
  if (system === 'excretory' || all || system === 'endocrine') {
    const kz = -w * 0.32, kids = [1, -1].map(sx => spine.clone().add(V(sx * w * 0.42, 0.04, kz)));
    for (const [i, k] of kids.entries()) blob(k, [w * 0.18, 0.045, w * 0.13], '#9d3b4a', g, { rot: [0, 0, i ? -0.2 : 0.2] });
    if (system === 'excretory' || all) {
      const bladderP = hips.clone().add(V(0, -0.03, w * 0.35)); const bl = blob(bladderP, [w * 0.24, 0.04, w * 0.2], '#f2d06b', g, { opacity: 0.9 }); bl.userData.fill = true; beats.push(bl);
      if (system === 'excretory') {
        for (const k of kids) { const u = tube([k, k.clone().add(V(-Math.sign(k.x) * w * 0.1, -0.08, w * 0.15)), bladderP.clone().add(V(Math.sign(k.x) * w * 0.12, 0.02, 0))], 0.0035, '#f2d06b', g); flow(u.curve, '#ffe066', 4, 0.12, 0.005, { top: true });
          const ra = tube([spine.clone().add(V(0, 0.05, -w * 0.2)), k], 0.004, '#e63946', g); flow(ra.curve, '#ff4d5e', 3, 0.3, 0.0045, { top: true }); }
        const ur = tube([bladderP, bladderP.clone().add(V(0, -0.07, -w * 0.08))], 0.0035, '#f2d06b', g);
        label('kidneys', kids[0], '#c75a6a'); label('ureters', kids[1].clone().add(V(0, -0.06, w * 0.1)), '#f2d06b', -1); label('bladder', bladderP, '#f2d06b'); label('urethra', ur.curve.getPoint(1), '#f2d06b', -1);
      } else if (all) label('kidneys', kids[0], '#c75a6a');
    }
    if (system === 'endocrine') { for (const k of kids) blob(k.clone().add(V(0, 0.045, 0)), [w * 0.12, 0.018, w * 0.1], '#ffb703', g, { glow: 0.5 }); label('adrenal', kids[0].clone().add(V(0, 0.045, 0)), '#ffb703'); }
  }
  // --- nervous ---
  if (system === 'nervous' || all) {
    const br = head.clone().add(V(0, hR * 0.22, -hR * 0.05)); blob(br, [hR * 0.66, hR * 0.5, hR * 0.72], '#f4b6c2', g, { glow: 0.25 });
    if (system === 'nervous') {
      const cord = tube([head.clone().add(V(0, -hR * 0.3, -hR * 0.3)), neck.clone().add(V(0, 0, -lR * 0.6)), chest.clone().add(V(0, 0, -cR * 0.55)), spine.clone().add(V(0, 0, -w * 0.6)), hips.clone().add(V(0, 0.02, -w * 0.55))], 0.006, '#ffe8a3', g, { glow: 0.4 });
      flow(cord.curve, '#fff3b0', 6, 0.35, 0.006, { top: true });
      for (const S of [SL, SR]) {
        const a = tube([chest.clone().add(V(0, 0.12, -cR * 0.55)), S.sh, S.el, S.wr, S.fi], 0.0028, '#ffd166', g, { glow: 0.4 }); flow(a.curve, '#fff3b0', 3, 0.45, 0.0045, { top: true, both: true });
        const l = tube([hips.clone().add(V(0, 0.02, -w * 0.55)), S.hp, S.kn, S.an, S.toe], 0.0032, '#ffd166', g, { glow: 0.4 }); flow(l.curve, '#fff3b0', 3, 0.4, 0.0045, { top: true, both: true });
      }
      label('brain', br, '#f4b6c2'); label('cord', chest.clone().add(V(0, 0, -cR * 0.55)), '#ffe8a3', -1); label('nerves', SL.el, '#ffd166');
    } else if (all) label('brain', br, '#f4b6c2');
  }
  // --- skeleton ---
  if (system === 'skeletal') {
    const bone = '#efe6d2', bm = new THREE.MeshStandardMaterial({ color: bone, roughness: 0.55, emissive: bone, emissiveIntensity: 0.12 });
    const seg = (a, b, r) => { const len = a.distanceTo(b); const c = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.001, len - r * 2), 6, 12), bm); c.position.copy(a).add(b).multiplyScalar(0.5); c.quaternion.setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize()); c.renderOrder = 2; g.add(c); return c; };
    const sk = blob(head.clone().add(V(0, hR * 0.08, 0)), [hR * 0.86, hR * 0.88, hR * 0.9], bone, g, { glow: 0.12 });
    for (const sx of [1, -1]) blob(head.clone().add(V(sx * hR * 0.33, hR * 0.05, hR * 0.72)), [hR * 0.17, hR * 0.15, hR * 0.08], '#3b3328', g, { glow: 0 });
    blob(head.clone().add(V(0, -hR * 0.55, hR * 0.35)), [hR * 0.42, hR * 0.18, hR * 0.38], bone, g, { glow: 0.12 });
    const spinePts = [head.clone().add(V(0, -hR * 0.6, -hR * 0.25)), neck, chest.clone().add(V(0, 0.1, -cR * 0.5)), chest.clone().add(V(0, -0.05, -cR * 0.55)), spine.clone().add(V(0, 0, -w * 0.5)), hips.clone().add(V(0, 0.03, -w * 0.45))];
    const sc = new THREE.CatmullRomCurve3(spinePts); for (let i = 0; i <= 22; i++) { const p = sc.getPoint(i / 22); const v = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.009, 0.018), bm); v.position.copy(p); v.renderOrder = 2; g.add(v); }
    for (let i = 0; i < 7; i++) { const r = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 6, 28, Math.PI * 1.7), bm); const y = chest.y + 0.11 - i * 0.03, sc2 = 1 - Math.abs(i - 2.5) * 0.06; r.scale.set(cR * 0.95 * sc2, cR * 0.68 * sc2, cR * 0.95); r.position.set(chest.x, y, chest.z - cR * 0.05); r.rotation.set(Math.PI / 2, 0, Math.PI / 2 + Math.PI * 0.15 + Math.PI * 0.0); r.renderOrder = 2; g.add(r); }
    seg(chest.clone().add(V(0, 0.12, cR * 0.62)), chest.clone().add(V(0, -0.06, cR * 0.66)), 0.007);
    for (const S of [SL, SR]) { seg(chest.clone().add(V(0, 0.15, cR * 0.5)), S.sh, 0.006); seg(S.sh, S.el, lR * 0.42); seg(S.el, S.wr, lR * 0.35); seg(S.wr, S.fi, lR * 0.3); seg(S.hp, S.kn, lR * 0.55); seg(S.kn, S.an, lR * 0.45); seg(S.an, S.toe, lR * 0.35); blob(S.kn.clone().add(V(0, 0, lR * 0.6)), lR * 0.45, bone, g); }
    const pel = new THREE.Mesh(new THREE.TorusGeometry(w * 0.7, 0.018, 8, 32), bm); pel.position.copy(hips.clone().add(V(0, 0.02, 0))); pel.rotation.x = Math.PI / 2.4; pel.scale.set(1, 0.75, 1.4); pel.renderOrder = 2; g.add(pel);
    label('skull', sk.position, '#efe6d2'); label('spine', spinePts[3], '#efe6d2', -1); label('ribs', chest.clone().add(V(cR * 0.6, 0.02, 0)), '#efe6d2'); label('pelvis', hips, '#efe6d2', -1); label('limbs', SR.kn, '#efe6d2');
  }
  // --- endocrine ---
  if (system === 'endocrine') {
    const pit = head.clone().add(V(0, -hR * 0.05, 0)); blob(pit, 0.01, '#ffb703', g, { glow: 0.6 });
    const thy = neck.clone().add(V(0, 0.005, lR * 0.9)); for (const sx of [1, -1]) blob(thy.clone().add(V(sx * 0.012, 0, 0)), [0.012, 0.016, 0.008], '#ffb703', g, { glow: 0.6 });
    const panc = spine.clone().add(V(w * 0.1, 0.02, -w * 0.02)); blob(panc, [w * 0.42, 0.013, 0.014], '#ffb703', g, { rot: [0, 0, -0.2], glow: 0.5 });
    const gon = variant === 'male' ? [1, -1].map(sx => hips.clone().add(V(sx * w * 0.14, -0.12, w * 0.3))) : [1, -1].map(sx => hips.clone().add(V(sx * w * 0.42, 0.0, w * 0.08)));
    for (const p of gon) blob(p, variant === 'male' ? [0.014, 0.019, 0.013] : [0.013, 0.009, 0.01], '#ffb703', g, { glow: 0.6 });
    for (const c of vessels) flow(c, '#ffd60a', 3, 0.12, 0.0055, { top: true });
    label('pituitary', pit, '#ffb703', -1); label('thyroid', thy, '#ffb703'); label('pancreas', panc, '#ffb703'); label(variant === 'male' ? 'testes' : 'ovaries', gon[1], '#ffb703', -1);
  }
  // --- reproductive (school-level, simplified) ---
  if (system === 'reproductive') {
    if (variant === 'male') {
      const tp = [1, -1].map(sx => hips.clone().add(V(sx * w * 0.14, -0.12, w * 0.3)));
      for (const p of tp) blob(p, [0.014, 0.019, 0.013], '#d98bb5', g, { glow: 0.3 });
      const pr = hips.clone().add(V(0, -0.045, w * 0.2)); blob(pr, [0.016, 0.012, 0.014], '#b56aa0', g, { glow: 0.3 });
      for (const p of tp) tube([p, p.clone().add(V(Math.sign(p.x) * w * 0.12, 0.06, -w * 0.05)), hips.clone().add(V(Math.sign(p.x) * w * 0.25, 0.02, w * 0.1)), pr], 0.003, '#e8a6c9', g);
      label('testes', tp[1], '#d98bb5', -1); label('ducts', hips.clone().add(V(w * 0.25, 0.02, w * 0.1)), '#e8a6c9'); label('prostate', pr, '#b56aa0');
    } else {
      const ut = hips.clone().add(V(0, 0.0, w * 0.12)); blob(ut, [0.03, 0.04, 0.025], '#d98bb5', g, { glow: 0.3 });
      const ov = [1, -1].map(sx => hips.clone().add(V(sx * w * 0.42, 0.0, w * 0.08)));
      for (const p of ov) { blob(p, [0.013, 0.009, 0.01], '#f2c6de', g, { glow: 0.3 }); tube([ut.clone().add(V(Math.sign(p.x) * 0.02, 0.03, 0)), ut.clone().add(V(Math.sign(p.x) * w * 0.3, 0.04, 0)), p.clone().add(V(0, 0.015, 0))], 0.003, '#e8a6c9', g); }
      label('uterus', ut, '#d98bb5'); label('ovaries', ov[1], '#f2c6de', -1); label('tubes', ut.clone().add(V(w * 0.3, 0.04, 0)), '#e8a6c9');
    }
  }
  layout();
  const update = t => {
    const breath = (Math.sin(t * 1.6) + 1) / 2;
    for (const l of lungs) { const s = 1 + (system === 'respiratory' || all ? 0.12 : 0.05) * breath; l.scale.x = l.userData.sx || (l.userData.sx = l.scale.x); l.scale.x = l.userData.sx * s; l.scale.y = (l.userData.sy || (l.userData.sy = l.scale.y)) * (1 + 0.08 * breath); }
    if (diaphragm) diaphragm.position.y = diaphragm.userData.y - breath * 0.018;
    for (const b of beats) { if (b.userData.fill) { const f = 0.75 + 0.25 * ((t * 0.08) % 1); b.scale.set(w * 0.24 * f, 0.04 * f, w * 0.2 * f); continue; } const beat = Math.max(0, Math.sin(t * 7.5)) ** 4; b.scale.set(cR * 0.24 * (1 + beat * 0.12), cR * 0.28 * (1 + beat * 0.12), cR * 0.2 * (1 + beat * 0.12)); }
    for (const f of flows) f.dots.forEach((d, i) => {
      let u = (f.phase + i / f.dots.length + t * f.speed) % 1;
      if (f.breath) { u = (i / f.dots.length + (breath > 0.5 ? breath - 0.5 : 0.5 - breath) * 1.6) % 1; d.material.color.set(Math.sin(t * 1.6) > 0 ? '#d8f3ff' : '#9aa5b1'); }
      if (f.both && i % 2) u = 1 - u;
      d.position.copy(f.curve.getPointAt ? f.curve.getPointAt(u) : f.curve.getPoint(u));
      if (f.fade) d.material.opacity = 1 - u;
    });
  };
  return { group: g, update };
}

/* ------------------------------ timeline ------------------------------ */
const smooth = k => k * k * (3 - 2 * k);
const lerpJ = (a = [0, 0, 0], b = [0, 0, 0], k) => [0, 1, 2].map(i => (a[i] || 0) + ((b[i] || 0) - (a[i] || 0)) * k);
function between(keys, t) {
  if (!keys || !keys.length) return null;
  const ks = keys.slice().sort((x, y) => x.t - y.t);
  if (t <= ks[0].t) return [ks[0], ks[0], 0];
  for (let i = 0; i < ks.length - 1; i++) if (t <= ks[i + 1].t) return [ks[i], ks[i + 1], smooth((t - ks[i].t) / Math.max(1e-6, ks[i + 1].t - ks[i].t))];
  return [ks[ks.length - 1], ks[ks.length - 1], 0];
}
function mixPose(a, b, k) {
  const joints = {}; for (const n of new Set([...Object.keys(a.joints || {}), ...Object.keys(b.joints || {})])) joints[n] = lerpJ(a.joints?.[n], b.joints?.[n], k);
  const face = {}; for (const n of new Set([...Object.keys(a.face || {}), ...Object.keys(b.face || {})])) face[n] = (a.face?.[n] ?? NEUTRAL_FACE[n] ?? 0) + ((b.face?.[n] ?? NEUTRAL_FACE[n] ?? 0) - (a.face?.[n] ?? NEUTRAL_FACE[n] ?? 0)) * k;
  return { joints, root: { lift: (a.root?.lift || 0) + ((b.root?.lift || 0) - (a.root?.lift || 0)) * k }, face };
}
/** A capture clip at time t (seconds from its start): frames at clip.fps. */
export function clipFrame(clip, t) {
  const fr = clip.frames || []; if (!fr.length) return null;
  const x = Math.max(0, Math.min(fr.length - 1, t * (clip.fps || 15))), i = Math.floor(x), k = x - i;
  const A = fr[i], B = fr[Math.min(fr.length - 1, i + 1)];
  return mixPose({ joints: A.j, face: A.f, root: A.r }, { joints: B.j, face: B.f, root: B.r }, k);
}
export const clipDuration = clip => (clip.frames || []).length / (clip.fps || 15);
/**
 * The pose of a timeline animation at time t. Layers: body keys (poses), capture
 * clips (override body while they play, blended at the edges), face keys, an
 * additive layer of joint offsets, and IK feet.
 */
export function evalAnim(anim, t, { poses = [], clips = [] } = {}) {
  const tr = anim.tracks || {};
  const poseOf = k => k.poseId ? (poses.find(p => p.id === k.poseId) || { joints: {}, face: {} }) : (k.pose || { joints: {}, face: {} });
  const b = between(tr.body, t);
  let pose = b ? mixPose(poseOf(b[0]), poseOf(b[1]), b[2]) : basePose('stand');
  for (const c of tr.clip || []) {
    const clip = clips.find(x => x.id === c.clipId); if (!clip) continue;
    const sp = c.speed || 1, len = clipDuration(clip) / sp, local = t - c.t;
    if (local < 0 || local > len) continue;
    const edge = Math.min(1, local / 0.25, (len - local) / 0.25), fp = clipFrame(clip, local * sp);
    if (fp) pose = mixPose(pose, fp, smooth(Math.max(0, edge)));
  }
  const f = between(tr.face, t);
  if (f) { const face = mixPose({ face: f[0].face }, { face: f[1].face }, f[2]).face; pose.face = { ...pose.face, ...face }; }
  const ad = between(tr.add, t);
  if (ad) { const off = mixPose({ joints: ad[0].joints }, { joints: ad[1].joints }, ad[2]).joints; for (const [n, v] of Object.entries(off)) pose.joints[n] = lerpJ(pose.joints[n], [0, 0, 0], 0).map((x, i) => x + (v[i] || 0)); }
  pose.root = { ...pose.root, ikFeet: !!(anim.ik && anim.ik.feet) };
  return pose;
}

/* --------------------------------- stage --------------------------------- */
export function createStage(canvas, { onSelect } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, canvas.width / canvas.height, 0.05, 50);
  scene.add(new THREE.HemisphereLight('#f2f5ff', '#3a3226', 0.9));
  const key = new THREE.DirectionalLight('#fff4e5', 2.2); key.position.set(1.6, 3.2, 2.4); key.castShadow = true; key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -1.5, right: 1.5, top: 2.5, bottom: -0.5, near: 0.5, far: 8 }); scene.add(key);
  const rim = new THREE.DirectionalLight('#a9c7ff', 1.1); rim.position.set(-2, 2, -2.5); scene.add(rim);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(3, 48), new THREE.ShadowMaterial({ opacity: 0.32 })); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.9, 64), new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.06, roughness: 1 })); disc.rotation.x = -Math.PI / 2; disc.position.y = 0.001; scene.add(disc);

  let ch = null, rigData = null, selected = null, sys = { mode: 'none', xray: 0.14, labels: true, flow: true, speed: 1, variant: 'female' }, anatomy = null, autoRotate = 0, sysT = 0;
  const ANAT_POSE = { joints: { upperArmL: [0, 0, 22], upperArmR: [0, 0, 22], forearmL: [8, 0, 0], forearmR: [8, 0, 0], fingersL: [10], fingersR: [10] }, root: {}, face: { ...NEUTRAL_FACE, smile: 0.3 } };
  const cur = { joints: {}, root: { turn: 0, lean: 0, tilt: 0, lift: 0, walk: 0 }, face: { ...NEUTRAL_FACE } };
  let tgt = JSON.parse(JSON.stringify(cur));
  const orbit = { yaw: 0.35, pitch: 0.12, dist: 3.6, target: new THREE.Vector3(0, 0.85, 0) };
  const placeCamera = () => { const { yaw, pitch, dist, target } = orbit; camera.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * dist, target.y + Math.sin(pitch) * dist, target.z + Math.cos(yaw) * Math.cos(pitch) * dist); camera.lookAt(target); };

  function disposeChar() { if (!ch) return; scene.remove(ch.root); ch.root.traverse(o => { if (o.geometry) o.geometry.dispose(); }); for (const m of mats.splice(0)) m.dispose(); }
  function build(rig) {
    disposeChar(); anatomy = null; rigData = rig; ch = buildCharacter(rig); scene.add(ch.root);
    scene.background = new THREE.Color(rig.background || '#1e2430');
    orbit.target.set(0, ch.height * 0.55, 0); orbit.dist = ch.height * 2.05 + 0.35;
    placeCamera(); applyHighlight();
    if (sys.mode !== 'none') applySystem();
  }
  function xray(on) {
    ch.root.traverse(o => { if (!o.isMesh || o.parent?.name === 'anatomy' || isAnat(o)) return; const mm = o.material; if (!mm) return; if (on) { if (o.userData.op === undefined) { o.userData.op = mm.opacity; o.userData.tr = mm.transparent; o.userData.dw = mm.depthWrite; } mm.transparent = true; mm.opacity = sys.xray; mm.depthWrite = false; } else if (o.userData.op !== undefined) { mm.opacity = o.userData.op; mm.transparent = o.userData.tr; mm.depthWrite = o.userData.dw; } mm.needsUpdate = true; });
  }
  function isAnat(o) { for (let p = o; p; p = p.parent) if (p.name === 'anatomy') return true; return false; }
  function applySystem() {
    if (!ch) return;
    if (anatomy) { ch.root.remove(anatomy.group); anatomy.group.traverse(o => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose?.(); }); anatomy = null; }
    if (sys.mode === 'none') { xray(false); return; }
    setTarget(ANAT_POSE, true); applyPose(0);
    const savedRot = ch.root.rotation.clone(), savedPos = ch.root.position.clone(), savedLift = ch.lift.position.y; ch.root.rotation.set(0, 0, 0); ch.root.position.set(0, 0, 0); ch.lift.position.y = 0;
    anatomy = buildAnatomy(ch, sys.mode, sys);
    ch.root.rotation.copy(savedRot); ch.root.position.copy(savedPos); ch.lift.position.y = savedLift;
    xray(true);
  }
  function setSystem(mode, opts = {}) { Object.assign(sys, opts, { mode: SYSTEMS[mode] ? mode : 'none' }); applySystem(); }
  function applyHighlight() {
    if (!ch) return;
    ch.root.traverse(o => { if (o.isMesh && o.material && o.material.emissive && !o.userData.glow) { if (o.userData.baseEm === undefined) { o.userData.baseEm = o.material.emissive.getHex(); o.userData.baseEi = o.material.emissiveIntensity; if (o.userData.baseEm) o.userData.glow = true; } } });
    const sel = selected;
    ch.root.traverse(o => { if (!o.isMesh || !o.material?.emissive || o.userData.glow) return; if (sel && o.userData.joint === sel) { if (!o.userData.hl) { o.material = o.material.clone(); mats.push(o.material); o.userData.hl = true; } o.material.emissive.set('#ffb000'); o.material.emissiveIntensity = 0.14; } else if (o.userData.hl) { o.material.emissive.setHex(0); o.material.emissiveIntensity = 0; } });
  }
  function setTarget(pose, immediate = false) {
    if (sys.mode !== 'none' && pose !== ANAT_POSE) { const face = pose.face || {}; pose = { ...ANAT_POSE, face: { ...ANAT_POSE.face, open: face.open || 0, eyeL: face.eyeL ?? 1, eyeR: face.eyeR ?? 1 } }; }
    tgt = { joints: JSON.parse(JSON.stringify(pose.joints || {})), root: { turn: 0, lean: 0, tilt: 0, lift: 0, walk: 0, ...(pose.root || {}) }, face: { ...NEUTRAL_FACE, ...(pose.face || {}) } };
    if (immediate) { cur.joints = JSON.parse(JSON.stringify(tgt.joints)); cur.root = { ...tgt.root }; cur.face = { ...tgt.face }; }
  }
  function applyPose(dt) {
    const k = 1 - Math.pow(0.0005, dt); // smooth follow
    for (const name of Object.keys(JOINTS)) {
      const a = cur.joints[name] || [0, 0, 0], b = tgt.joints[name] || [0, 0, 0];
      cur.joints[name] = [0, 1, 2].map(i => (a[i] || 0) + ((b[i] || 0) - (a[i] || 0)) * k);
    }
    for (const key of Object.keys(tgt.root)) cur.root[key] = (cur.root[key] || 0) + (tgt.root[key] - (cur.root[key] || 0)) * (key === 'turn' ? k * 0.6 : k);
    for (const key of Object.keys(tgt.face)) cur.face[key] = (cur.face[key] ?? 0) + (tgt.face[key] - (cur.face[key] ?? 0)) * Math.min(1, k * 2.2);
    if (!ch) return;
    if (tgt.root.ikFeet && (cur.root.lift || 0) < -0.005) {
      const a = ch.m.thighLen, b = ch.m.shinLen, L0 = a + b;
      const dd = Math.max(0.35 * L0, Math.min(L0 - 1e-4, L0 + (cur.root.lift || 0) * ch.legLen));
      const knee = Math.PI - Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - dd * dd) / (2 * a * b))));
      const thigh = Math.acos(Math.max(-1, Math.min(1, (a * a + dd * dd - b * b) / (2 * a * dd))));
      for (const sd of ['L', 'R']) {
        const th = cur.joints['thigh' + sd] = (cur.joints['thigh' + sd] || [0, 0, 0]).slice(); th[0] = thigh / D;
        cur.joints['shin' + sd] = [knee / D, 0, 0];
        const ft = cur.joints['foot' + sd] = (cur.joints['foot' + sd] || [0, 0, 0]).slice(); ft[0] = (thigh - knee) / D;
      }
    }
    for (const [name, spec] of Object.entries(JOINTS)) {
      const g = name === 'root' ? null : ch.J[name]; if (!g && name !== 'root') continue;
      const v = cur.joints[name] || [0, 0, 0], right = name.endsWith('R');
      if (name.startsWith('fingers')) { const curl = (v[0] || 0) * D * -1 * (right ? -1 : 1); for (const s of g.userData.segs || []) s.rotation.z = curl * (s.userData.seg === 2 ? 1.1 : s.userData.seg === 3 ? 0.9 : 1); continue; }
      if (name === 'root') continue;
      const r = [0, 0, 0];
      spec.axes.forEach(([, axis, , , sign], i) => { const idx = { x: 0, y: 1, z: 2 }[axis]; let val = (v[i] || 0) * sign * D; if (right && axis !== 'x') val = -val; r[idx] = val; });
      g.rotation.set(r[0], r[1], r[2], 'XZY');
    }
    const rv = cur.joints.root || [0, 0, 0];
    ch.root.rotation.set(((rv[1] || 0) + (cur.root.lean || 0)) * D, ((rv[0] || 0) + (cur.root.turn || 0)) * D, ((rv[2] || 0) + (cur.root.tilt || 0)) * D, 'YXZ');
    ch.lift.position.y = (cur.root.lift || 0) * ch.legLen;
    ch.root.position.x = (cur.root.walk || 0);
    // face
    const f = cur.face, F = ch.face;
    for (const e of F.eyes) {
      const open = Math.max(0.04, Math.min(1, e.side > 0 ? f.eyeL : f.eyeR)) * (e.sleepy ? 0.7 : 1);
      if (e.lid) e.lid.rotation.x = -Math.PI / 2 + (1 - open) * Math.PI;
      else e.inner.scale.y = (e.inner.userData.sy || (e.inner.userData.sy = e.inner.scale.y)) * open;
      if (e.iris) { e.iris.position.x = (f.lookX || 0) * 0.012 * (e.lid ? 1 : 0.6); e.iris.position.y = (f.lookY || 0) * 0.01; }
    }
    for (const bw of F.brows) { const up = bw.side > 0 ? f.browL : f.browR; bw.g.position.y = bw.baseY + (up || 0) * 0.018; bw.g.rotation.z = bw.side * (f.browAngle || 0) * 0.42; }
    const m = F.mouth; if (m) {
      const sm = Math.max(-1, Math.min(1, (f.smile ?? 0) * 0.85 + m.base * 0.35)), op = Math.max(0, Math.min(1, f.open || 0));
      const depth = Math.max(0.08, Math.abs(sm));
      const wide = Math.max(-1, Math.min(1, f.wide || 0)), round = Math.max(0, Math.min(1, f.round || 0)), bite = Math.max(0, Math.min(1, f.bite || 0));
      const wx = Math.max(0.45, 1 + wide * 0.3 - round * 0.45);
      m.lipG.scale.set(wx, depth * 0.55, 1);
      m.lip.rotation.z = sm >= 0 ? -Math.PI / 2 - m.arc / 2 : Math.PI / 2 - m.arc / 2;
      m.lipG.position.y = sm >= 0 ? m.mw * depth * 0.55 : -m.mw * depth * 0.55;
      const cav = op > 0.04 ? 1 : 1e-4; m.cavity.scale.set(m.mw * 0.85 * wx * (1 - round * 0.25) * cav, (m.mw * 0.12 + op * m.mw * 0.55 + round * m.mw * 0.15) * cav, m.mw * 0.25 * cav); m.cavity.position.y = -op * m.mw * 0.18;
      const showT = !m.robot && (op > 0.12 || bite > 0.3 || (m.grin && sm > 0.4)); m.teeth.scale.setScalar(showT ? 1 : 1e-4); m.teeth.position.set(0, m.grin && op <= 0.12 ? m.mw * 0.05 : m.mw * 0.08 - op * m.mw * 0.02, m.mw * 0.02);
      if (m.robot) { m.lipG.scale.y = Math.max(0.08, depth * 0.4) * (1 + op * 2.5); }
    }
  }
  let last = performance.now();
  function frame() { const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now; applyPose(dt); if (anatomy && sys.flow) { sysT += dt * sys.speed; anatomy.update(sysT); } if (autoRotate) orbit.yaw += dt * autoRotate; placeCamera(); renderer.render(scene, camera); }
  function resize(w, h) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  resize(canvas.width, canvas.height);

  // orbit + pick
  let drag = null;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, moved: false, pan: e.shiftKey || e.button === 2 }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.pan) { orbit.target.y = Math.max(0.1, Math.min(3, orbit.target.y + dy * 0.004)); } else { orbit.yaw -= dx * 0.008; orbit.pitch = Math.max(-0.3, Math.min(1.2, orbit.pitch + dy * 0.006)); }
    drag.x = e.clientX; drag.y = e.clientY;
  });
  canvas.addEventListener('pointerup', e => {
    if (drag && !drag.moved && ch) {
      const r = canvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera); const hit = ray.intersectObject(ch.root, true).find(h => h.object.userData.joint);
      select(hit ? hit.object.userData.joint : null); if (onSelect) onSelect(selected);
    }
    drag = null;
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => { e.preventDefault(); orbit.dist = Math.max(0.8, Math.min(8, orbit.dist * (1 + Math.sign(e.deltaY) * 0.08))); }, { passive: false });
  canvas.addEventListener('dblclick', () => { if (ch) { orbit.yaw = 0.35; orbit.pitch = 0.12; orbit.target.set(0, ch.height * 0.55, 0); orbit.dist = ch.height * 2.05 + 0.35; } });
  function select(j) { selected = j && JOINTS[j] ? j : null; applyHighlight(); }
  function view(name) { if (!ch) return; const H = ch.height; const far = H * 2.05 + 0.35; const v = { front: [0, 0.1, far, H * 0.55], side: [Math.PI / 2, 0.1, far, H * 0.55], back: [Math.PI, 0.1, far, H * 0.55], face: [0.12, 0.04, H * 0.55 + 0.12, H * 0.88] }[name]; if (!v) return; [orbit.yaw, orbit.pitch, orbit.dist] = v; orbit.target.set(0, v[3], 0); }
  /** Two-bone IK: joint values that put a hand at target (chest space, metres from the shoulder: [out, up, forward]). */
  function solveReach(side, target) {
    if (!ch) return null;
    const m = ch.m, a = m.upperLen, b = m.foreLen, sg = side === 'L' ? 1 : -1;
    const T = new THREE.Vector3(sg * target[0], target[1], target[2]);
    let d = T.length(); const dir = d > 1e-6 ? T.clone().divideScalar(d) : new THREE.Vector3(0, -1, 0);
    d = Math.max(0.03, Math.min(a + b - 1e-4, d));
    const bend = Math.PI - Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b))));
    const alpha = Math.acos(Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d))));
    // elbow points down and back: bend plane contains dir and a pole below/behind
    const pole = new THREE.Vector3(0, -1, -0.6).normalize();
    let n = new THREE.Vector3().crossVectors(dir, pole); if (n.lengthSq() < 1e-6) n.set(1, 0, 0); n.normalize();
    const u = dir.clone().applyAxisAngle(n, alpha);             // upper-arm direction
    const yAxis = u.clone().negate();                              // bone points along -Y
    let zAxis = dir.clone().sub(u.clone().multiplyScalar(dir.dot(u))); if (zAxis.lengthSq() < 1e-8) zAxis.set(0, 0, 1); zAxis.normalize();
    const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize(); zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
    const e = new THREE.Euler().setFromQuaternion(q, 'XZY');
    const R = side === 'R' ? -1 : 1, wrap = v => { while (v > Math.PI) v -= 2 * Math.PI; while (v <= -Math.PI) v += 2 * Math.PI; return v; };
    const A = [e.x, e.y, e.z].map(wrap), B = [wrap(e.x + Math.PI), wrap(e.y + Math.PI), wrap(Math.PI - e.z)], cost = v => Math.abs(v[0]) * 1.2 + Math.abs(v[1]) * 1.5 + Math.abs(v[2]);
    const [x, y, z] = cost(B) < cost(A) ? B : A;
    return { ['upperArm' + side]: [-x / D, (y / D) * R, (z / D) * R], ['forearm' + side]: [bend / D, 0, 0] };
  }
  /** Binary glTF (.glb) of the character, posed now or animated by sampler(t) → pose for duration seconds. */
  async function exportGLB({ sampler = null, duration = 0, fps = 30, name = 'character' } = {}) {
    const { GLTFExporter } = await import('./vendor/GLTFExporter.js');
    const keepSys = sys.mode; if (keepSys !== 'none') setSystem('none');
    const nodes = []; ch.root.traverse(o => { if (o.isObject3D && o.name && !o.isMesh) nodes.push(o); else if (o.isMesh && /^(lid|mouth)/.test(o.name)) nodes.push(o); });
    const seen = new Set(); const uniq = nodes.filter(o => !seen.has(o.name) && seen.add(o.name));
    ch.root.name = 'root'; const saved = { cur: JSON.parse(JSON.stringify(cur)), tgt: JSON.parse(JSON.stringify(tgt)) };
    const animations = [];
    if (sampler && duration > 0) {
      const n = Math.max(2, Math.round(duration * fps) + 1), times = new Float32Array(n);
      const data = uniq.map(() => ({ p: new Float32Array(n * 3), q: new Float32Array(n * 4), s: new Float32Array(n * 3) }));
      for (let i = 0; i < n; i++) {
        const t = Math.min(duration, i / fps); times[i] = t; setTarget(sampler(t), true); applyPose(0);
        uniq.forEach((o, k) => { o.position.toArray(data[k].p, i * 3); o.quaternion.toArray(data[k].q, i * 4); o.scale.toArray(data[k].s, i * 3); });
      }
      const tracks = [];
      const varies = (arr, w) => { for (let i = w; i < arr.length; i++) if (Math.abs(arr[i] - arr[i % w]) > 1e-5) return true; return false; };
      uniq.forEach((o, k) => {
        if (varies(data[k].p, 3)) tracks.push(new THREE.VectorKeyframeTrack(o.name + '.position', times, data[k].p));
        if (varies(data[k].q, 4)) tracks.push(new THREE.QuaternionKeyframeTrack(o.name + '.quaternion', times, data[k].q));
        if (varies(data[k].s, 3)) tracks.push(new THREE.VectorKeyframeTrack(o.name + '.scale', times, data[k].s));
      });
      animations.push(new THREE.AnimationClip(name, duration, tracks));
    }
    const out = await new GLTFExporter().parseAsync(ch.root, { binary: true, animations, onlyVisible: true });
    Object.assign(cur, saved.cur); tgt = saved.tgt; applyPose(0);
    if (keepSys !== 'none') setSystem(keepSys);
    return { glb: out, tracks: animations[0] ? animations[0].tracks.length : 0, nodes: uniq.length };
  }
  // A mesh made from a picture (TripoSR): a statue shown alone, or beside the posable character.
  let meshObj = null;
  function hideMesh() { if (!meshObj) return; scene.remove(meshObj); meshObj.traverse(o => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose?.(); }); meshObj = null; if (ch) { ch.root.visible = true; ch.root.position.z = 0; } }
  async function showMesh(data, { beside = false, height = null } = {}) {
    const { GLTFLoader } = await import('./vendor/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(data instanceof ArrayBuffer ? data : await (await fetch(data)).arrayBuffer(), '');
    hideMesh();
    const g = new THREE.Group(); g.name = 'scanMesh'; g.add(gltf.scene);
    gltf.scene.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; if (o.material) { o.material.side = THREE.DoubleSide; if (o.geometry.attributes.color) { o.material.vertexColors = true; o.material.roughness = 0.85; o.material.metalness = 0; } } } });
    const box = new THREE.Box3().setFromObject(gltf.scene), size = box.getSize(new THREE.Vector3());
    const H = Number(height) || (ch ? ch.height / 1.25 : 1.6), k = size.y > 1e-6 ? H / size.y : 1;
    gltf.scene.scale.setScalar(k); gltf.scene.position.set(-(box.min.x + box.max.x) / 2 * k, -box.min.y * k, -(box.min.z + box.max.z) / 2 * k);
    if (beside && ch) { g.position.x = Math.max(0.55, size.x * k * 0.5 + 0.35); ch.root.position.z = 0; } else if (ch) ch.root.visible = false;
    scene.add(g); meshObj = g;
    let tris = 0; gltf.scene.traverse(o => { if (o.isMesh) tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3; });
    return { triangles: Math.round(tris), size: [size.x * k, size.y * k, size.z * k] };
  }
  return { build, setTarget, frame, resize, select, view, setSystem, solveReach, exportGLB, showMesh, hideMesh, get mesh() { return !!meshObj; }, get metrics() { return ch ? { ...ch.m, legLen: ch.legLen, height: ch.height } : null; }, get system() { return { ...sys }; }, set autoRotate(v) { autoRotate = Number(v) || 0; }, get selected() { return selected; }, get current() { return cur; }, snapshot: () => canvas.toDataURL('image/png'), dispose() { hideMesh(); disposeChar(); renderer.dispose(); } };
}
