// ===========================================================================
// Character Studio capture: webcam face and body tracking (MediaPipe Tasks,
// running locally in this window) turned into the 3D character's joint angles
// and face values. The maths is here; the camera and MediaPipe are driven by
// index.html. Nothing leaves the computer.
// ===========================================================================
import * as THREE from './vendor/three.module.min.js';

const D = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const V = p => new THREE.Vector3(p.x, -p.y, -p.z);   // MediaPipe world (x right, y down, z away from camera) → ours (y up, z towards the viewer)

/** Face values from MediaPipe face blendshapes ({name: score}) and the head matrix (16 numbers, column-major). */
export function faceFromBlendshapes(bs, matrix = null, { mirror = true } = {}) {
  const g = k => bs[k] || 0;
  const L = mirror ? 'Right' : 'Left', R = mirror ? 'Left' : 'Right';     // the mirrored side moves the character's side you see
  const face = {
    browL: clamp(g('browOuterUp' + L) * 0.8 + g('browInnerUp') * 0.5 - g('browDown' + L) * 1.1, -1, 1),
    browR: clamp(g('browOuterUp' + R) * 0.8 + g('browInnerUp') * 0.5 - g('browDown' + R) * 1.1, -1, 1),
    browAngle: clamp((g('browDownLeft') + g('browDownRight')) * 0.6 - g('browInnerUp') * 0.9, -1, 1),
    eyeL: clamp(1 - g('eyeBlink' + L) * 1.25 + g('eyeWide' + L) * 0.2, 0, 1),
    eyeR: clamp(1 - g('eyeBlink' + R) * 1.25 + g('eyeWide' + R) * 0.2, 0, 1),
    lookX: clamp(((g('eyeLookOutLeft') - g('eyeLookInLeft')) + (g('eyeLookInRight') - g('eyeLookOutRight'))) * 0.6 * (mirror ? -1 : 1), -1, 1),
    lookY: clamp(((g('eyeLookUpLeft') + g('eyeLookUpRight')) - (g('eyeLookDownLeft') + g('eyeLookDownRight'))) * 0.7, -1, 1),
    smile: clamp((g('mouthSmileLeft') + g('mouthSmileRight')) * 0.75 - (g('mouthFrownLeft') + g('mouthFrownRight')) * 0.8, -1, 1),
    open: clamp(g('jawOpen') * 1.5, 0, 1),
    round: clamp(g('mouthPucker') + g('mouthFunnel') * 0.8, 0, 1),
    wide: clamp((g('mouthStretchLeft') + g('mouthStretchRight')) * 0.8 - g('mouthPucker') * 0.5, -1, 1),
    bite: clamp(g('mouthRollLower') * 1.2, 0, 1),
  };
  let head = null;
  if (matrix && matrix.length === 16) {
    const m = new THREE.Matrix4().fromArray(matrix), e = new THREE.Euler().setFromRotationMatrix(m, 'YXZ');
    const s = mirror ? -1 : 1;
    head = [clamp(-e.x / D, -40, 40), clamp((e.y / D) * s, -60, 60), clamp((-e.z / D) * s, -35, 35)];
  }
  return { face, head };
}

// MediaPipe pose landmark indices (33-point model)
const P = { lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28, lFoot: 31, rFoot: 32 };
const basis = (x0, y) => { const z = new THREE.Vector3().crossVectors(x0, y).normalize(); const x = new THREE.Vector3().crossVectors(y, z).normalize(); return new THREE.Matrix4().makeBasis(x, y.clone().normalize(), z); };
const toLocal = (B, v) => v.clone().applyMatrix4(B.clone().transpose()); // B is orthonormal (rotation only)

/** XZY Euler angles have a twin solution; keep the one with the smaller, in-range angles. */
export function bestEuler(e) {
  const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; };
  const A = [e.x, e.y, e.z].map(wrap), B = [wrap(e.x + Math.PI), wrap(e.y + Math.PI), wrap(Math.PI - e.z)];
  const cost = v => Math.abs(v[0]) * 1.2 + Math.abs(v[1]) * 1.5 + Math.abs(v[2]) + (v[0] > 60 * D * 3.2 || v[0] < -60 * D ? 4 : 0);
  return cost(B) < cost(A) ? B : A;
}

/** Joint values (Character Studio UI degrees) for a limb from its two segment directions in the parent's frame. */
function limb(u, f, side, kind) {
  const yAxis = u.clone().negate();
  const perpTo = v => v.clone().sub(u.clone().multiplyScalar(v.dot(u)));
  let perp = perpTo(f), zAxis;
  if (perp.length() > 0.26) zAxis = perp.normalize().multiplyScalar(kind === 'leg' ? -1 : 1);     // a clear bend: the bend sets the twist
  else {                                                                                       // nearly straight: keep a natural twist
    let ref = perpTo(new THREE.Vector3(0, 0, 1)); if (ref.length() < 0.3) ref = perpTo(new THREE.Vector3(0, u.z > 0 ? 1 : -1, 0));
    zAxis = ref.normalize();
  }
  const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize(); zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis)), 'XZY');
  const R = side === 'R' ? -1 : 1, bend = Math.acos(clamp(u.dot(f), -1, 1)) / D;
  const [x, y, z] = bestEuler(e);
  return [[-x / D, (y / D) * R, (z / D) * R], bend];
}

/**
 * Joint values from MediaPipe pose world landmarks (33 points, metres, hips at the origin).
 * mirror: your right arm moves the character's left arm, like a mirror.
 */
export function bodyFromLandmarks(lm, { mirror = true, legs = true, turn = false } = {}) {
  if (!lm || lm.length < 29) return null;
  const pt = i => { const v = V(lm[i]); if (mirror) v.x = -v.x; return v; };
  const side = (l, r) => (mirror ? [r, l] : [l, r]);   // [character-left index, character-right index]
  const [lSh, rSh] = side(P.lSh, P.rSh).map(pt), [lHip, rHip] = side(P.lHip, P.rHip).map(pt);
  const hipC = lHip.clone().add(rHip).multiplyScalar(0.5), shC = lSh.clone().add(rSh).multiplyScalar(0.5);
  const up = shC.clone().sub(hipC).normalize();
  const chestB = basis(lSh.clone().sub(rSh).normalize(), up);
  const hipB = basis(lHip.clone().sub(rHip).normalize(), new THREE.Vector3(0, 1, 0));
  const joints = {};
  for (const sd of ['L', 'R']) {
    const [sh, el, wr] = (sd === 'L' ? side(P.lSh, P.rSh)[0] : side(P.lSh, P.rSh)[1]) === P.lSh
      ? [P.lSh, P.lEl, P.lWr] : [P.rSh, P.rEl, P.rWr];
    const u = toLocal(chestB, pt(el).sub(pt(sh)).normalize()), f = toLocal(chestB, pt(wr).sub(pt(el)).normalize());
    const [ua, bend] = limb(u, f, sd, 'arm');
    joints['upperArm' + sd] = ua.map(x => Math.round(x)); joints['forearm' + sd] = [Math.round(clamp(bend, 0, 150)), 0, 0];
    if (legs) {
      const [hp, kn, an] = (sd === 'L' ? side(P.lHip, P.rHip)[0] : side(P.lHip, P.rHip)[1]) === P.lHip ? [P.lHip, P.lKn, P.lAn] : [P.rHip, P.rKn, P.rAn];
      const ut = toLocal(hipB, pt(kn).sub(pt(hp)).normalize()), s = toLocal(hipB, pt(an).sub(pt(kn)).normalize());
      const [ta, kb] = limb(ut, s, sd, 'leg');
      joints['thigh' + sd] = ta.map(x => Math.round(x)); joints['shin' + sd] = [Math.round(clamp(kb, 0, 150)), 0, 0];
    }
  }
  // torso: chest relative to hips, split between waist and chest
  const qc = new THREE.Quaternion().setFromRotationMatrix(chestB), qh = new THREE.Quaternion().setFromRotationMatrix(hipB);
  const rel = new THREE.Euler().setFromQuaternion(qh.clone().invert().multiply(qc), 'XZY');
  const t = [rel.x / D, rel.y / D, rel.z / D].map(v => Math.round(v / 2));
  joints.spine = [clamp(t[0], -30, 60), clamp(t[1], -45, 45), clamp(t[2], -30, 30)];
  joints.chest = [clamp(t[0], -25, 45), clamp(t[1], -40, 40), clamp(t[2], -25, 25)];
  if (turn) { const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(qh); joints.root = [Math.round(Math.atan2(fwd.x, fwd.z) / D), 0, 0]; }
  return { joints };
}

/** Exponential smoothing of a pose (joints and face) towards the newest reading. */
export function smoothPose(prev, next, k = 0.45) {
  if (!prev) return next;
  const out = { joints: { ...prev.joints }, face: { ...prev.face } };
  for (const [n, v] of Object.entries(next.joints || {})) { const a = prev.joints?.[n] || v; out.joints[n] = v.map((x, i) => (a[i] ?? x) + (x - (a[i] ?? x)) * k); }
  for (const [n, v] of Object.entries(next.face || {})) out.face[n] = (prev.face?.[n] ?? v) + (v - (prev.face?.[n] ?? v)) * Math.min(1, k * 1.4);
  return out;
}
