'use strict';
/* NOVA Runtime — Call Sheet skill: a schedule and crew notes into a day's call sheet. */
const { makeSkill, need, esc, asText } = require('./_preproduction');

module.exports = makeSkill({
  kind: 'callsheet', name: 'call sheet',
  instruction: "Draft a call sheet for one shoot day: general call time, location, the day's schedule by time with scene numbers, cast calls, crew calls by department, and safety and logistics notes. Leave any time, address, phone number or hospital as TBC unless it is in the source or the details.",
  fields: ['production', 'shootDay', 'date', 'generalCall', 'location', 'director', 'producer'],
  shape: '{"production":"","shootDay":"Day 1 of 3","date":"","generalCall":"07:00","location":{"name":"","address":"TBC","parking":"TBC","nearestHospital":"TBC"},"weather":"TBC","schedule":[{"time":"07:00","scene":"1","description":"","cast":[""]}],"cast":[{"name":"","role":"","call":"07:30","notes":""}],"crew":[{"department":"","name":"","call":"06:30"}],"notes":[""]}',
  validate(d) {
    const p = [];
    need(d, 'production', 'string', p, ''); need(d, 'generalCall', 'string', p, '');
    const loc = need(d, 'location', 'object', p, ''); if (loc) need(loc, 'name', 'string', p, 'location.');
    (need(d, 'schedule', 'array', p, '') || []).forEach((s, i) => { need(s, 'time', 'string', p, `schedule[${i}].`); need(s, 'description', 'string', p, `schedule[${i}].`); });
    if (d && d.cast != null && !Array.isArray(d.cast)) p.push('cast must be an array');
    if (d && d.crew != null && !Array.isArray(d.crew)) p.push('crew must be an array');
    return p;
  },
  toMarkdown(d) {
    const loc = d.location || {};
    return [
      `# Call sheet: ${asText(d.production)}`, '',
      '| Day | Date | General call | Weather |', '| --- | --- | --- | --- |',
      `| ${esc(d.shootDay || 'TBC')} | ${esc(d.date || 'TBC')} | ${esc(d.generalCall)} | ${esc(d.weather || 'TBC')} |`, '',
      '## Location', '', `- **${asText(loc.name)}**, ${asText(loc.address || 'TBC')}`, `- Parking: ${asText(loc.parking || 'TBC')}`, `- Nearest hospital: ${asText(loc.nearestHospital || 'TBC')}`, '',
      '## Schedule', '', '| Time | Scene | Description | Cast |', '| --- | --- | --- | --- |',
      ...(d.schedule || []).map(s => `| ${esc(s.time)} | ${esc(s.scene || '')} | ${esc(s.description)} | ${esc((s.cast || []).join(', '))} |`), '',
      ...(Array.isArray(d.cast) && d.cast.length ? ['## Cast', '', '| Name | Role | Call | Notes |', '| --- | --- | --- | --- |', ...d.cast.map(c => `| ${esc(c.name)} | ${esc(c.role)} | ${esc(c.call)} | ${esc(c.notes)} |`), ''] : []),
      ...(Array.isArray(d.crew) && d.crew.length ? ['## Crew', '', '| Department | Name | Call |', '| --- | --- | --- |', ...d.crew.map(c => `| ${esc(c.department)} | ${esc(c.name)} | ${esc(c.call)} |`), ''] : []),
      ...(Array.isArray(d.notes) && d.notes.length ? ['## Notes', '', ...d.notes.map(n => `- ${asText(n)}`), ''] : []),
    ].join('\n').trim() + '\n';
  },
});
