#!/usr/bin/env node
// Runs the four requested venue queries across Delhi's 13 districts.
// Each query is delegated to test-event-query.cjs, which writes immutable
// Query Studio history including timestamps, source status, and raw records.
const { execFile } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('../lib/event-planners/store.cjs');
const studio = require('../lib/event-planners/studio.cjs');

const categories = ['banquet halls', 'wedding venues', 'conference centres', 'party halls'];
const run = (args) => new Promise((resolve, reject) => execFile(process.execPath, args, { timeout: 120000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(Error(stderr || error.message)) : resolve(JSON.parse(stdout))));

(async () => {
  const db = await store.open(false);
  try {
    await studio.init(db);
    const blocked = await store.all(db, "SELECT id FROM query_history WHERE status='blocked' LIMIT 1");
    if (blocked.length) throw Error('A prior Google access challenge requires review before venue collection can continue.');
    const districts = await store.all(db, "SELECT id, district, state FROM tasks WHERE state='Delhi' ORDER BY district");
    if (districts.length !== 13) throw Error(`Expected 13 Delhi districts, found ${districts.length}.`);
    const methods = [];
    for (const category of categories) {
      const id = `venue-${category.replace(/[^a-z]+/g, '-').replace(/-$/, '')}`;
      const template = `${category} in {district} district, {state}, India`;
      await store.run(db, 'INSERT OR IGNORE INTO query_methods VALUES (?,?,?,?,?)', [id, `Delhi venues · ${category}`, template, new Date().toISOString(), 'Puppeteer; Google Maps public search; Delhi venue collection v1']);
      methods.push(id);
    }
    for (const methodId of methods) for (const district of districts) {
      const prior = await store.all(db, "SELECT id FROM query_history WHERE task_id=? AND method_id=? AND status IN ('limited_view','visible_list_exhausted','no_results','partial') LIMIT 1", [district.id, methodId]);
      if (prior.length) continue;
      const result = await run([path.join(__dirname, 'test-event-query.cjs'), methodId, district.id]);
      console.log(JSON.stringify({ district: district.district, methodId, ...result }));
      if (result.status === 'blocked') throw Error('Google access challenge recorded; collection stopped without bypass.');
    }
  } finally { await store.close(db); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
