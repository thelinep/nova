#!/usr/bin/env node
'use strict';
// Adds cards from a JSON file to the running Maataa's Radheya board (skips titles already there).
//   node scripts/radheya-add-cards.js scripts/radheya-media-gap-cards.json [http://127.0.0.1:8787]
const fs = require('node:fs');
const [file, base = process.env.MAATAA_URL || 'http://127.0.0.1:8787'] = process.argv.slice(2);
if (!file) { console.error('Usage: radheya-add-cards.js cards.json [url]'); process.exit(2); }
(async () => {
  const cards = JSON.parse(fs.readFileSync(file, 'utf8'));
  let view;
  try { const r = await fetch(base + '/api/radheya'); if (!r.ok) throw new Error('HTTP ' + r.status); view = await r.json(); }
  catch (e) { console.error(`Maataa is not answering at ${base} (${e.message}). Open Maataa, then run this again.`); process.exit(1); }
  const have = new Set((view.cards || []).map(c => c.title.trim().toLowerCase()));
  for (const c of cards) {
    if (have.has(c.title.trim().toLowerCase())) { console.log('already there  ', c.title); continue; }
    const r = await fetch(base + '/api/radheya/cards', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(c) });
    const out = await r.json().catch(() => ({}));
    console.log(r.ok ? 'added          ' : 'not added      ', c.title, r.ok ? `→ ${out.column}` : `(${out.error || r.status})`);
  }
})();
