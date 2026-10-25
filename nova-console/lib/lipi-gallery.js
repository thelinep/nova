'use strict';
/**
 * Brahmi gallery: original inscriptions and manuscripts in Brahmi and its variants, with credits.
 * Data: lib/lipi-brahmi-gallery.json (written from Wikimedia Commons metadata); images: public/lipi-brahmi/.
 */
const fs = require('node:fs');
const path = require('node:path');

let cache = null;
const load = () => cache || (cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'lipi-brahmi-gallery.json'), 'utf8')));
const error = (message, statusCode) => Object.assign(new Error(message), { statusCode });

/** The catalogue, optionally filtered by variant key and a search over title, site, country, language and note. */
function gallery({ variant = '', q = '' } = {}) {
  const d = load();
  if (variant && !d.variants[variant]) throw error(`Unknown variant ${variant}.`, 400);
  const needle = String(q).trim().toLowerCase();
  const items = d.items.filter(i => (!variant || i.variant === variant)
    && (!needle || [i.title, i.site, i.region, i.country, i.language, i.note, i.credit.author].join(' ').toLowerCase().includes(needle)));
  const counts = Object.fromEntries(Object.keys(d.variants).map(k => [k, d.items.filter(i => i.variant === k).length]));
  return { variants: d.variants, counts, total: d.items.length, items, resources: d.resources, notes: d.notes, source: d.source };
}

function item(id) {
  const it = load().items.find(i => i.id === id);
  if (!it) throw error(`No gallery item ${id}.`, 404);
  return it;
}

module.exports = { gallery, item };
