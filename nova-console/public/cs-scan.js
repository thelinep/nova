/* ===========================================================================
 * Character Studio: measure a picture for "Scan to 3D"
 *
 * Pure functions over RGBA pixels (a canvas ImageData) and, when MediaPipe's
 * pose tracker found a person, its 33 landmarks (normalised x, y, visibility).
 * Returns the colours sampled at the hair, face, top, bottom and shoes, the
 * body proportions, and the points used, so the page can show where it looked.
 * Nothing leaves the page here; lib/image-to-3d.js turns the result into a rig.
 * ========================================================================= */

const hex2 = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
export const toHex = ([r, g, b]) => '#' + hex2(r) + hex2(g) + hex2(b);
const rgbOf = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
export const colorDist = (a, b) => { const x = rgbOf(a), y = rgbOf(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
const median = a => { if (!a.length) return 0; const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };

/** Median colour of the opaque pixels in a square of radius r around (cx, cy), or null. */
export function medianColor(data, w, h, cx, cy, r) {
  const R = [], G = [], B = []; const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  if (x0 > x1 || y0 > y1) return null;
  const step = Math.max(1, Math.floor((x1 - x0) / 12));
  for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) { const i = (y * w + x) * 4; if (data[i + 3] < 128) continue; R.push(data[i]); G.push(data[i + 1]); B.push(data[i + 2]); }
  return R.length ? toHex([median(R), median(G), median(B)]) : null;
}

/** The colour around the edge of the picture: the background, if it is plain. Transparent edges count as none. */
export function borderColor(data, w, h) {
  const R = [], G = [], B = []; let clear = 0, n = 0;
  const take = (x, y) => { const i = (y * w + x) * 4; n++; if (data[i + 3] < 128) { clear++; return; } R.push(data[i]); G.push(data[i + 1]); B.push(data[i + 2]); };
  const s = Math.max(1, Math.floor(Math.max(w, h) / 80));
  for (let x = 0; x < w; x += s) { take(x, 0); take(x, h - 1); }
  for (let y = 0; y < h; y += s) { take(0, y); take(w - 1, y); }
  return { color: R.length ? toHex([median(R), median(G), median(B)]) : null, transparent: clear > n / 2 };
}

/** Bounding box of the pixels that differ from the background (or are opaque on a transparent picture). */
export function foregroundBox(data, w, h, bg, tol = 42) {
  const b = bg.color && !bg.transparent ? rgbOf(bg.color) : null; let x0 = w, y0 = h, x1 = -1, y1 = -1;
  const s = Math.max(1, Math.floor(Math.max(w, h) / 200));
  for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) {
    const i = (y * w + x) * 4; if (data[i + 3] < 128) continue;
    if (b && Math.hypot(data[i] - b[0], data[i + 1] - b[1], data[i + 2] - b[2]) < tol) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? { x0: 0, y0: 0, x1: w - 1, y1: h - 1, empty: true } : { x0, y0, x1, y1, empty: false };
}

// MediaPipe pose landmark numbers
const L = { nose: 0, eyeL: 2, eyeR: 5, earL: 7, earR: 8, shL: 11, shR: 12, elL: 13, elR: 14, wrL: 15, wrR: 16, hipL: 23, hipR: 24, knL: 25, knR: 26, anL: 27, anR: 28, toeL: 31, toeR: 32 };

/** Proportions and sampling points from pose landmarks (normalised to the picture), or null if the upper body is not visible. */
export function fromLandmarks(lm, w, h) {
  if (!Array.isArray(lm) || lm.length < 33) return null;
  const P = k => ({ x: lm[L[k]].x * w, y: lm[L[k]].y * h, v: lm[L[k]].visibility ?? 1 });
  const ok = (...ks) => ks.every(k => P(k).v >= 0.5 && P(k).x >= 0 && P(k).x <= w && P(k).y >= 0 && P(k).y <= h);
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y), mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  if (!ok('shL', 'shR', 'nose')) return null;
  const shL = P('shL'), shR = P('shR'), shW = d(shL, shR), shM = mid(shL, shR);
  if (shW < 4) return null;
  const metrics = { hasPose: true }, points = {};
  // head: ear to ear when both ears show, else from the eyes
  const headW = ok('earL', 'earR') ? d(P('earL'), P('earR')) : ok('eyeL', 'eyeR') ? d(P('eyeL'), P('eyeR')) * 2.4 : null;
  if (headW) metrics.headRatio = +(headW / shW).toFixed(3);
  const eyes = ok('eyeL', 'eyeR') ? mid(P('eyeL'), P('eyeR')) : P('nose'), hw = headW || shW * 0.4;
  points.hair = [eyes.x, eyes.y - hw * 0.72, hw * 0.12];
  // skin: forehead and both cheeks; measure() keeps the brightest one that is not the background, so a beard, a mask or ink lines on one of them do not win
  const nose = P('nose');
  points.skin = [eyes.x + (eyes.x - nose.x) * 0.8, eyes.y - hw * 0.32, hw * 0.06];
  points.skin2 = [nose.x - hw * 0.2, nose.y + hw * 0.02, hw * 0.05];
  points.skin3 = [nose.x + hw * 0.2, nose.y + hw * 0.02, hw * 0.05];
  if (ok('hipL', 'hipR')) {
    const hipL = P('hipL'), hipR = P('hipR'), hiM = mid(hipL, hipR), torso = d(shM, hiM);
    metrics.shoulderHip = +(shW / Math.max(1, d(hipL, hipR))).toFixed(3);
    const top = lerp(shM, hiM, 0.4); points.top = [top.x, top.y, shW * 0.12];
    if (ok('elL', 'wrL') || ok('elR', 'wrR')) { const s = ok('elL', 'wrL') ? 'L' : 'R'; metrics.armRatio = +((d(P('sh' + s), P('el' + s)) + d(P('el' + s), P('wr' + s))) / torso).toFixed(3); }
    const legs = ['L', 'R'].filter(s => ok('kn' + s, 'an' + s));
    if (legs.length) {
      metrics.legRatio = +(legs.map(s => d(P('hip' + s), P('kn' + s)) + d(P('kn' + s), P('an' + s))).reduce((a, b) => a + b, 0) / legs.length / torso).toFixed(3);
      const s = legs[0], bm = lerp(P('hip' + s), P('kn' + s), 0.5); points.bottom = [bm.x, bm.y, shW * 0.07];
      if (ok('toe' + s)) { const f = lerp(P('an' + s), P('toe' + s), 0.6); points.shoes = [f.x, f.y, shW * 0.04]; }
    } else if (ok('knL') || ok('knR')) { const s = ok('knL') ? 'L' : 'R', bm = lerp(P('hip' + s), P('kn' + s), 0.5); points.bottom = [bm.x, bm.y, shW * 0.07]; }
  } else points.top = [shM.x, shM.y + shW * 0.35, shW * 0.12];
  return { metrics, points };
}

/** Without landmarks: fixed places inside the figure's bounding box (works for a front-facing standing figure). */
export function fromBox(box) {
  const W = box.x1 - box.x0, H = box.y1 - box.y0, cx = (box.x0 + box.x1) / 2, at = t => box.y0 + H * t, r = Math.max(2, W * 0.05);
  return { metrics: { hasPose: false }, points: { hair: [cx, at(0.025), r], skin: [cx, at(0.1), r * 0.8], top: [cx, at(0.36), r * 1.4], bottom: [cx - W * 0.08, at(0.66), r], shoes: [cx - W * 0.1, at(0.975), r * 0.6] } };
}

/** Everything the server needs: { samples, metrics, points, box }. lm: MediaPipe pose landmarks for one person, or null. */
export function measure(data, w, h, lm = null) {
  const bg = borderColor(data, w, h), box = foregroundBox(data, w, h, bg);
  const plan = fromLandmarks(lm, w, h) || fromBox(box);
  const samples = {};
  for (const [k, [x, y, r]] of Object.entries(plan.points)) { const c = medianColor(data, w, h, x, y, r); if (c) samples[k] = c; }
  const skins = ['skin', 'skin2', 'skin3'].map(k => samples[k]).filter(Boolean);
  if (skins.length) { const lum = c => { const [r, g, b] = rgbOf(c); return 0.299 * r + 0.587 * g + 0.114 * b; }; const notBg = skins.filter(c => !bg.color || bg.transparent || colorDist(c, bg.color) > 30); const pool = notBg.length ? notBg : skins; pool.sort((a, b) => lum(b) - lum(a)); samples.skin = pool[0]; }
  delete samples.skin2; delete samples.skin3;
  // a "hair" sample that is really the background means a bald head or hair hidden by the crop
  if (samples.hair && bg.color && !bg.transparent && colorDist(samples.hair, bg.color) < 30) { if (samples.skin) samples.hair = samples.skin; else delete samples.hair; }
  if (bg.color && !bg.transparent) samples.background = bg.color;
  return { samples, metrics: plan.metrics, points: plan.points, box };
}
