'use strict';
/* NOVA Runtime — Shot List skill: scenes or a script into numbered shots. */
const { makeSkill, need, esc, asText } = require('./_preproduction');

// Screenplay scene headings (INT./EXT./INT/EXT./I/E), optionally after "Scene 3:".
const HEADING = /^\s*(?:scene\s+\d+[a-z]?\s*[:.\-]\s*)?((?:INT\.?\/EXT|EXT\.?\/INT|INT|EXT|I\/E)\.?\s+[^\n]+)$/gim;
function sceneHeadings(source) {
  const out = []; let m; HEADING.lastIndex = 0;
  while ((m = HEADING.exec(String(source || '')))) out.push(m[1].replace(/\.\s*$/, '').trim().split(/\.\s+(?=[A-Z][a-z])/)[0]);
  return out;
}

module.exports = Object.assign(makeSkill({
  kind: 'shotlist', name: 'shot list', maxTokens: 3072,
  instruction: 'Break this material into scenes and a numbered shot list. For every shot give the shot size (e.g. WS, MS, CU, ECU, OTS, INSERT), camera angle, camera movement, a short description of the action, and an estimated duration in seconds.',
  fields: ['title', 'style', 'cameraKit'],
  hint(source) {
    const h = sceneHeadings(source);
    return h.length > 1 ? `The source has ${h.length} scenes: ${h.map((x, i) => `${i + 1}) ${x}`).join('; ')}. Return one entry in "scenes" for each of them, in this order.` : '';
  },
  check(d, source) {
    const h = sceneHeadings(source), got = Array.isArray(d.scenes) ? d.scenes.length : 0;
    return h.length > 1 && got < h.length ? [`the source has ${h.length} scenes (${h.join('; ')}) but "scenes" has only ${got}; include every scene`] : [];
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
}), { sceneHeadings });
