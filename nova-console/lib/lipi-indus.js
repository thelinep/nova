'use strict';
/** Indus (Harappan) signs board: openly licensed reference signs and signs cut from seals (lib/lipi-indus.json). */
const fs = require('node:fs');
const path = require('node:path');
let cache = null;
const load = () => cache || (cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'lipi-indus.json'), 'utf8')));
const error = (message, statusCode) => Object.assign(new Error(message), { statusCode });

function board({ group = '' } = {}) {
  const d = load();
  if (group && !d.groups[group]) throw error(`Unknown group ${group}.`, 400);
  const counts = Object.fromEntries(Object.keys(d.groups).map(g => [g, d.signs.filter(s => s.group === g).length]));
  return { ...d, signs: group ? d.signs.filter(s => s.group === group) : d.signs, counts, total: d.signs.length };
}

function object(id) {
  const d = load();
  const o = d.objects.find(x => x.id === id);
  if (!o) throw error(`No object ${id}.`, 404);
  return { ...o, signs: d.signs.filter(s => s.object === id) };
}

module.exports = { board, object };
