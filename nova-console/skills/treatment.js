'use strict';
/* NOVA Runtime — Treatment skill: a brief or pages into a structured treatment. */
const { makeSkill, need, esc, asText } = require('./_preproduction');

module.exports = makeSkill({
  kind: 'treatment', name: 'treatment',
  instruction: 'Write a treatment for this project: a one-sentence logline, a synopsis in present tense, the main characters, themes, tone, visual style, and the story told in acts or sequences.',
  fields: ['title', 'format', 'runtime', 'audience'],
  shape: '{"title":"","logline":"","format":"","genre":"","tone":"","synopsis":"","characters":[{"name":"","description":""}],"themes":[""],"visualStyle":"","structure":[{"part":"","summary":""}]}',
  validate(d) {
    const p = [];
    need(d, 'title', 'string', p, ''); need(d, 'logline', 'string', p, ''); need(d, 'synopsis', 'string', p, '');
    (need(d, 'characters', 'array', p, '') || []).forEach((c, i) => { need(c, 'name', 'string', p, `characters[${i}].`); need(c, 'description', 'string', p, `characters[${i}].`); });
    (need(d, 'structure', 'array', p, '') || []).forEach((s, i) => { need(s, 'part', 'string', p, `structure[${i}].`); need(s, 'summary', 'string', p, `structure[${i}].`); });
    return p;
  },
  toMarkdown(d) {
    return [
      `# ${asText(d.title)}`, '', `**Logline:** ${asText(d.logline)}`, '',
      `| Format | Genre | Tone |`, `| --- | --- | --- |`, `| ${esc(d.format || 'TBC')} | ${esc(d.genre || 'TBC')} | ${esc(d.tone || 'TBC')} |`, '',
      '## Synopsis', '', asText(d.synopsis), '',
      '## Characters', '', ...(d.characters || []).map(c => `- **${asText(c.name)}:** ${asText(c.description)}`), '',
      ...(Array.isArray(d.themes) && d.themes.length ? ['## Themes', '', ...d.themes.map(t => `- ${asText(t)}`), ''] : []),
      ...(d.visualStyle ? ['## Visual style', '', asText(d.visualStyle), ''] : []),
      '## Structure', '', ...(d.structure || []).map(s => `### ${asText(s.part)}\n\n${asText(s.summary)}\n`),
    ].join('\n').trim() + '\n';
  },
});
