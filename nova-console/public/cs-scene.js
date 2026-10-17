/* ===========================================================================
 * Character Studio scenes: what is on stage at time t, and drawing it.
 *
 * Pure evaluation (frameState) is shared by the preview, the recorder and
 * the tests. The stage is 1920×1080 logical units; drawScene fits it to any
 * canvas, in 16:9 or letterboxed into 9:16 (captions go in the lower bar).
 * ========================================================================= */
export const STAGE = { W: 1920, H: 1080 };
export const EASE = {
  linear: k => k, hold: () => 0, easeIn: k => k * k, easeOut: k => 1 - (1 - k) * (1 - k),
  easeInOut: k => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2),
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const MOVING = /run|walk|chase|jump|dance/;

export function beatAt(scene, t) {
  const b = scene.beats || []; if (!b.length) return null;
  return b.find(x => t >= x.start && t < x.end) || (t >= b[b.length - 1].end ? b[b.length - 1] : b[0]);
}

/** One actor at time t: { x, y, pose, facing, moving, k, frameTime, talking, line }. */
export function actorState(scene, actor, t) {
  const b = beatAt(scene, t); const st = b && b.actors && b.actors[actor.id];
  if (!st) return { x: STAGE.W / 2, y: actor.y || 1000, pose: 'idle', facing: 1, moving: false, k: 0, frameTime: t, talking: false, line: null };
  const len = Math.max(1e-6, b.end - b.start), k = clamp((t - b.start) / len, 0, 1);
  const moving = st.to !== st.x;
  const x = st.x + (st.to - st.x) * (moving && !MOVING.test(st.pose) ? EASE.easeInOut(k) : k);
  const bounce = moving ? Math.abs(Math.sin(t * Math.PI * 3.2)) * 14 * (actor.scale || 1) : 0;
  const line = (scene.dialogue || []).find(d => d.actor === actor.id && t >= d.start && t < d.end) || null;
  return { x, y: (actor.y || 1000) - bounce, pose: st.pose, facing: st.facing === -1 ? -1 : 1, moving, k, frameTime: t - b.start, talking: !!line, line };
}

/** Camera at t: centre x, y and zoom (1 = the whole stage), plus fade (1 = black). */
export function cameraAt(scene, t) {
  const s = (scene.shots || []).find(x => t >= x.start && t < x.end) || (scene.shots || []).slice(-1)[0];
  if (!s) return { x: STAGE.W / 2, y: STAGE.H / 2, zoom: 1, fade: 0 };
  const k = (EASE[s.easing] || EASE.easeInOut)(clamp((t - s.start) / Math.max(1e-6, s.end - s.start), 0, 1));
  const zoom = s.zoom + (s.toZoom - s.zoom) * k, hw = STAGE.W / 2 / zoom, hh = STAGE.H / 2 / zoom;
  const x = clamp(s.x + (s.toX - s.x) * k, hw, STAGE.W - hw), y = clamp(s.y + (s.toY - s.y) * k, hh, STAGE.H - hh);
  const fade = s.transition === 'fade' ? clamp(1 - (t - s.start) / (s.transitionDuration || 0.4), 0, 1) : 0;
  return { x, y, zoom, fade };
}

export function captionsAt(scene, t) { return (scene.dialogue || []).filter(d => t >= d.start && t < d.end); }

/** Effects showing at t: [{ kind, x, y, age }]. A bonk lasts 0.6 s at the start of its beat; dust follows movers. */
export function effectsAt(scene, t, height = a => 330 * (a.scale || 1)) {
  const b = beatAt(scene, t); if (!b || !b.effect || b.effect === 'none') return [];
  const age = t - b.start, out = [];
  const states = (scene.actors || []).map(a => ({ a, s: actorState(scene, a, t) }));
  if (b.effect === 'bonk' && age < 0.6) {
    const tg = states.find(x => x.a.id === b.target) || states[1] || states[0];
    if (tg) out.push({ kind: 'bonk', x: tg.s.x, y: tg.s.y - height(tg.a) * 0.92, age });
  } else if (b.effect === 'dust') {
    for (const { a, s } of states) if (s.moving) for (let i = 0; i < 3; i++) out.push({ kind: 'dust', x: s.x - s.facing * (60 + i * 46) * (a.scale || 1), y: s.y - 10, age: (age + i * 0.13) % 0.5, i });
  } else if (b.effect === 'sparkle') {
    const tg = states.find(x => x.a.id === b.target) || states[0];
    if (tg) for (let i = 0; i < 6; i++) out.push({ kind: 'sparkle', x: tg.s.x + Math.cos(i + age * 3) * 120, y: tg.s.y - height(tg.a) * 0.5 + Math.sin(i * 2 + age * 4) * 140, age: (age + i * 0.2) % 1, i });
  }
  return out;
}

export function frameState(scene, t) {
  return { t, camera: cameraAt(scene, t), actors: (scene.actors || []).map(a => ({ actor: a, ...actorState(scene, a, t) })), captions: captionsAt(scene, t), effects: effectsAt(scene, t) };
}

/** The output canvas size for a recording profile. */
export function outputSize(profile = {}) {
  const h = profile.height === 1080 ? 1080 : 720;
  return profile.aspect === '9:16' ? { w: h, h: Math.round(h * 16 / 9) } : { w: Math.round(h * 16 / 9), h };
}

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/), lines = []; let cur = '';
  for (const w of words) { const n = cur ? cur + ' ' + w : w; if (ctx.measureText(n).width > maxW && cur) { lines.push(cur); cur = w; } else cur = n; }
  if (cur) lines.push(cur); return lines.slice(0, 3);
}

/**
 * Draws the scene at t on ctx (size w×h). env: {
 *   background: Image|null, drawActor(ctx, actor, state, heightPx) — draws one actor standing at (0,0) feet, facing right,
 *   actorHeight(actor) — logical height for effects, captions: bool, labels: {actorId: name}, guides: bool }
 */
export function drawScene(ctx, scene, t, w, h, env = {}) {
  const f = frameState(scene, t), portrait = h > w;
  const sw = w, sh = portrait ? w * 9 / 16 : h, oy = portrait ? (h - sh) / 2 : 0;
  ctx.save(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  ctx.beginPath(); ctx.rect(0, oy, sw, sh); ctx.clip();
  const cam = f.camera, k = sw / STAGE.W * cam.zoom;
  ctx.translate(sw / 2, oy + sh / 2); ctx.scale(k, k); ctx.translate(-cam.x, -cam.y);
  // background
  const bg = scene.background || {};
  ctx.fillStyle = bg.color || '#1e2430'; ctx.fillRect(0, 0, STAGE.W, STAGE.H);
  if (env.background && env.background.width) { const iw = env.background.width, ih = env.background.height, s = Math.max(STAGE.W / iw, STAGE.H / ih); ctx.drawImage(env.background, (STAGE.W - iw * s) / 2, (STAGE.H - ih * s) / 2, iw * s, ih * s); }
  else { const g = ctx.createLinearGradient(0, STAGE.H * 0.78, 0, STAGE.H); g.addColorStop(0, 'rgba(255,255,255,0.06)'); g.addColorStop(1, 'rgba(0,0,0,0.3)'); ctx.fillStyle = g; ctx.fillRect(0, STAGE.H * 0.78, STAGE.W, STAGE.H * 0.22); }
  // actors, back to front by their ground line
  for (const s of f.actors.slice().sort((a, b) => a.y - b.y)) {
    if (!s.actor.characterId || !env.drawActor) continue;
    const hp = (env.actorHeight ? env.actorHeight(s.actor) : 330 * (s.actor.scale || 1));
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(s.x, (s.actor.y || 1000) + 4, hp * 0.22, hp * 0.035, 0, 0, 7); ctx.fill(); ctx.restore();
    ctx.save(); ctx.translate(s.x, s.y); if (s.facing === -1) ctx.scale(-1, 1);
    env.drawActor(ctx, s.actor, s, hp); ctx.restore();
    if (env.guides) { ctx.save(); ctx.fillStyle = 'rgba(255,176,0,0.9)'; ctx.font = '600 30px system-ui'; ctx.textAlign = 'center'; ctx.fillText(s.actor.label, s.x, (s.actor.y || 1000) + 44); ctx.restore(); }
  }
  // effects
  for (const e of f.effects) {
    ctx.save();
    if (e.kind === 'bonk') {
      const r = 60 + e.age * 160; ctx.globalAlpha = 1 - e.age / 0.6; ctx.translate(e.x, e.y); ctx.fillStyle = '#ffd23f'; ctx.strokeStyle = '#7a2e00'; ctx.lineWidth = 6;
      ctx.beginPath(); for (let i = 0; i < 20; i++) { const a = i / 20 * Math.PI * 2, rr = i % 2 ? r * 0.5 : r; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#7a2e00'; ctx.font = `900 ${Math.round(r * 0.5)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('BONK!', 0, 0);
    } else if (e.kind === 'dust') {
      ctx.globalAlpha = 0.45 * (1 - e.age / 0.5); ctx.fillStyle = '#d9c7a3'; ctx.beginPath(); ctx.arc(e.x, e.y - e.age * 40, 18 + e.age * 70, 0, 7); ctx.fill();
    } else if (e.kind === 'sparkle') {
      ctx.globalAlpha = Math.sin(e.age * Math.PI); ctx.translate(e.x, e.y); ctx.fillStyle = '#fff6b0'; ctx.beginPath(); for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2, rr = i % 2 ? 6 : 26; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
  // camera fade and captions in screen space
  if (cam.fade > 0) { ctx.save(); ctx.globalAlpha = cam.fade; ctx.fillStyle = '#000'; ctx.fillRect(0, oy, sw, sh); ctx.restore(); }
  if (env.captions !== false && f.captions.length) {
    const fs = Math.round((portrait ? w * 0.055 : h * 0.048)), lines = [];
    ctx.save(); ctx.font = `600 ${fs}px "Noto Sans Devanagari", "Kohinoor Devanagari", "Mukta", system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (const c of f.captions) lines.push(...wrap(ctx, (env.labels && env.labels[c.actor] && env.speakerNames ? env.labels[c.actor] + ': ' : '') + c.text, w * 0.86));
    const lh = fs * 1.35, base = portrait ? oy + sh + lh * 1.2 : h - fs * 0.9 - (lines.length - 1) * lh;
    for (const [i, l] of lines.entries()) {
      const y = base + i * lh, mw = ctx.measureText(l).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(w / 2 - mw / 2 - fs * 0.4, y - fs * 1.02, mw + fs * 0.8, fs * 1.32);
      ctx.fillStyle = '#fff'; ctx.fillText(l, w / 2, y);
    }
    ctx.restore();
  }
  return f;
}
