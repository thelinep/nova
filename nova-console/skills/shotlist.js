'use strict';
/* NOVA Runtime — Shot List skill: scenes or a script into numbered shots. */
const { makeSkill, need, esc, asText, sourceText } = require('./_preproduction');

const MIN_SHOTS = 3;

// Screenplay scene headings (INT./EXT./INT/EXT./I/E), optionally after "Scene 3:".
const HEADING = /^\s*(?:scene\s+\d+[a-z]?\s*[:.\-]\s*)?((?:INT\.?\/EXT|EXT\.?\/INT|INT|EXT|I\/E)\.?\s+[^\n]+)$/gim;
function sceneHeadings(source) {
  const out = []; let m; HEADING.lastIndex = 0;
  while ((m = HEADING.exec(String(source || '')))) out.push(m[1].replace(/\.\s*$/, '').trim().split(/\.\s+(?=[A-Z][a-z])/)[0]);
  return out;
}

// Split a script at its scene headings. Small local models often drop later
// scenes when asked for several at once, so each scene is planned on its own.
function splitScenes(source) {
  const text = String(source || ''), starts = []; let m; HEADING.lastIndex = 0;
  while ((m = HEADING.exec(text))) starts.push(m.index);
  if (starts.length < 2) return null;
  return { preamble: text.slice(0, starts[0]).trim(), parts: starts.map((at, i) => text.slice(at, starts[i + 1] ?? text.length).trim()) };
}

const SPEC = {
  kind: 'shotlist', name: 'shot list', maxTokens: 3072,
  instruction: 'Break this material into scenes and a numbered shot list. For every shot give the shot size (e.g. WS, MS, CU, ECU, OTS, INSERT), camera angle, camera movement, a short description of the action, and an estimated duration in seconds. Give every scene at least ' + MIN_SHOTS + ' shots, for example a wide shot that sets the place, a medium shot of the action and a close-up of the key moment.',
  fields: ['title', 'style', 'cameraKit'],
  hint(source) {
    const h = sceneHeadings(source);
    return h.length > 1 ? `The source has ${h.length} scenes: ${h.map((x, i) => `${i + 1}) ${x}`).join('; ')}. Return one entry in "scenes" for each of them, in this order.` : '';
  },
  check(d, source) {
    const h = sceneHeadings(source), scenes = Array.isArray(d.scenes) ? d.scenes : [], problems = [];
    if (h.length > 1 && scenes.length < h.length) problems.push(`the source has ${h.length} scenes (${h.join('; ')}) but "scenes" has only ${scenes.length}; include every scene`);
    scenes.forEach((sc, i) => { const n = Array.isArray(sc.shots) ? sc.shots.length : 0; if (n < MIN_SHOTS) problems.push(`scenes[${i}] has ${n} shot(s); give at least ${MIN_SHOTS} (wide, medium, close-up)`); });
    return problems;
  },
  shape: '{"title":"","scenes":[{"scene":"1","heading":"INT. LOCATION - DAY","shots":[{"shot":"1A","size":"WS","angle":"eye level","movement":"static","description":"","lens":"TBC","durationSec":5,"notes":""}]}]}',
  validate(d) {
    const p = [];
    need(d, 'title', 'string', p, '');
    (need(d, 'scenes', 'array', p, '') || []).forEach((s, i) => {
      need(s, 'scene', 'string', p, `scenes[${i}].`); need(s, 'heading', 'string', p, `scenes[${i}].`);
      (need(s, 'shots', 'array', p, `scenes[${i}].`) || []).forEach((shot, j) => {
        for (const k of ['shot', 'size', 'angle', 'movement', 'description']) need(shot, k, 'string', p, `scenes[${i}].shots[${j}].`);
        if (shot && shot.durationSec != null && !(Number(shot.durationSec) > 0)) p.push(`scenes[${i}].shots[${j}].durationSec must be a positive number`);
      });
    });
    return p;
  },
  toMarkdown(d) {
    const out = [`# Shot list: ${asText(d.title)}`, ''];
    let total = 0, count = 0;
    for (const s of d.scenes || []) {
      out.push(`## Scene ${asText(s.scene)}: ${asText(s.heading)}`, '', '| Shot | Size | Angle | Movement | Lens | Description | Sec | Notes |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const shot of s.shots || []) {
        const sec = Number(shot.durationSec) > 0 ? Number(shot.durationSec) : null; if (sec) total += sec; count++;
        out.push(`| ${esc(shot.shot)} | ${esc(shot.size)} | ${esc(shot.angle)} | ${esc(shot.movement)} | ${esc(shot.lens || 'TBC')} | ${esc(shot.description)} | ${sec ?? 'TBC'} | ${esc(shot.notes)} |`);
      }
      out.push('');
    }
    out.push(`**${count} shots**, about ${Math.round(total / 6) / 10} minutes of estimated screen time.`);
    return out.join('\n') + '\n';
  },
};

const base = makeSkill(SPEC);
const shotId = (scene, j) => `${scene}${j < 26 ? String.fromCharCode(65 + j) : `-${j + 1}`}`;

async function run(inputs, tools, host) {
  inputs = inputs || {}; host = host || {};
  const split = splitScenes(await sourceText(inputs, host));
  if (!split) return base.run(inputs, tools, host);
  const scenes = []; let title = asText(inputs.title), model = null, repaired = false, chars = 0;
  for (const part of split.parts) {
    const text = split.preamble ? `Context (not a scene of its own): ${split.preamble}\n\n${part}` : part;
    const r = await base.run({ ...inputs, text, sessionId: undefined }, tools, host);
    title = title || asText(r.data.title); model = r.model || model; repaired = repaired || r.repaired; chars += r.sourceCharacters;
    for (const sc of r.data.scenes) scenes.push(sc);
  }
  scenes.forEach((sc, i) => { sc.scene = String(i + 1); sc.shots.forEach((shot, j) => { shot.shot = shotId(i + 1, j); }); });
  const data = { title: title || 'Untitled', scenes };
  return { kind: SPEC.kind, data, markdown: SPEC.toMarkdown(data), model, repaired, sourceCharacters: chars, sourceTruncated: false, scenesPlannedSeparately: split.parts.length };
}

module.exports = { run, sceneHeadings, splitScenes, MIN_SHOTS };
