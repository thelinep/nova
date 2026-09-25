'use strict';
/* NOVA Runtime — Export to Slides skill: notes or a chat into a slide deck.
 * Returns the deck as data and as Marp Markdown (one "---" per slide,
 * speaker notes in HTML comments). Marp for VS Code or marp-cli turns that
 * file into PowerPoint, PDF or HTML. */
const { makeSkill, need, asText } = require('./_preproduction');

function clean(v) { return asText(v).replace(/\n+/g, ' '); }

module.exports = makeSkill({
  kind: 'slides', name: 'slide deck', maxTokens: 3072,
  role: 'You turn notes, briefs and conversations into clear presentation slides for a film and media production company.',
  instruction: 'Turn this material into a slide deck. Start with a title slide. Give each slide a short title, 2 to 5 short bullet points (no full paragraphs), and speaker notes of one to three sentences. Aim for the requested number of slides, or 6 to 10 if none is given.',
  fields: ['title', 'audience', 'slideCount'],
  shape: '{"title":"","subtitle":"","slides":[{"title":"","bullets":[""],"notes":""}]}',
  validate(d) {
    const p = [];
    need(d, 'title', 'string', p, '');
    const slides = need(d, 'slides', 'array', p, '') || [];
    if (slides.length > 40) p.push('slides must have at most 40 entries');
    slides.forEach((s, i) => {
      need(s, 'title', 'string', p, `slides[${i}].`);
      if (s && s.bullets != null && !Array.isArray(s.bullets)) p.push(`slides[${i}].bullets must be an array`);
    });
    return p;
  },
  toMarkdown(d) {
    const out = ['---', 'marp: true', 'paginate: true', `title: ${JSON.stringify(clean(d.title))}`, '---', '', `# ${clean(d.title)}`];
    if (asText(d.subtitle)) out.push('', clean(d.subtitle));
    for (const s of d.slides || []) {
      out.push('', '---', '', `## ${clean(s.title)}`, '');
      for (const b of (s.bullets || []).map(clean).filter(Boolean).slice(0, 8)) out.push(`- ${b}`);
      if (asText(s.notes)) out.push('', `<!-- ${clean(s.notes).replace(/--+/g, '—')} -->`);
    }
    return out.join('\n') + '\n';
  },
});
