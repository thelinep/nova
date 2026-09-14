'use strict';

const CATEGORIES = new Set(['banquet halls', 'wedding venues', 'conference centres', 'party halls']);
const { spawn } = require('node:child_process');
const path = require('node:path');
const INDIA_SCRAPER_ROOT = path.resolve(__dirname, '../../india-scraper-next');
const RUNNER = path.join(INDIA_SCRAPER_ROOT, 'scripts/run-delhi-venue-queries.cjs');
let activeRunId = null;
function uid() { return 'col_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function cleanCategories(input) {
  const values = Array.isArray(input) ? input : [];
  const categories = values.map(x => String(x).trim().toLowerCase()).filter(Boolean);
  if (!categories.length || categories.some(x => !CATEGORIES.has(x))) throw Object.assign(new Error('Use one or more approved venue categories.'), { statusCode: 400 });
  return [...new Set(categories)];
}
function createPlan(store, body) {
  const geography = String(body.geography || '').trim();
  if (geography !== 'Delhi') throw Object.assign(new Error('Only the configured Delhi connector is available.'), { statusCode: 400 });
  const run = { id: uid(), kind: 'india-scraper-next', source: 'Google Maps public search', geography, categories: cleanCategories(body.categories), districtCount: 13, queryCount: 0, status: 'awaiting_approval', createdAt: new Date().toISOString(), approvedAt: null, startedAt: null, finishedAt: null, limitation: 'Observed public-search snapshot; source-limited and not exhaustive. Stops on access challenge.', checkpoints: [] };
  run.queryCount = run.categories.length * run.districtCount;
  store.put('collectionRuns', run);
  return run;
}
function approvePlan(store, id) {
  const run = store.get('collectionRuns', id);
  if (!run) throw Object.assign(new Error('Unknown collection run.'), { statusCode: 404 });
  if (run.status !== 'awaiting_approval') throw Object.assign(new Error('Collection run is not awaiting approval.'), { statusCode: 400 });
  run.status = 'approved'; run.approvedAt = new Date().toISOString(); store.put('collectionRuns', run); return run;
}
function executePlan(store, id) {
  const run = store.get('collectionRuns', id);
  if (!run) throw Object.assign(new Error('Unknown collection run.'), { statusCode: 404 });
  if (run.status !== 'approved') throw Object.assign(new Error('Approve the collection run before execution.'), { statusCode: 400 });
  if (activeRunId) throw Object.assign(new Error('Another collector run is active.'), { statusCode: 409 });
  if (run.categories.length !== CATEGORIES.size) throw Object.assign(new Error('The installed Delhi runner currently executes the four approved venue categories as one bounded batch.'), { statusCode: 400 });
  activeRunId = id; run.status = 'running'; run.startedAt = new Date().toISOString(); run.checkpoints.push({ at: run.startedAt, status: 'started', detail: 'Launching fixed local Delhi venue runner.' }); store.put('collectionRuns', run);
  const child = spawn(process.execPath, [RUNNER], { cwd: INDIA_SCRAPER_ROOT, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
  let detail = '';
  child.stderr.on('data', chunk => { detail = (detail + chunk).slice(-4000); });
  child.on('error', error => { const row = store.get('collectionRuns', id); if (row) { row.status = 'failed'; row.finishedAt = new Date().toISOString(); row.checkpoints.push({ at: row.finishedAt, status: 'failed', detail: error.message }); store.put('collectionRuns', row); } activeRunId = null; });
  child.on('exit', code => { const row = store.get('collectionRuns', id); if (row) { row.status = code === 0 ? 'completed' : 'paused'; row.finishedAt = new Date().toISOString(); row.checkpoints.push({ at: row.finishedAt, status: row.status, detail: detail || `Runner exited with code ${code}.` }); store.put('collectionRuns', row); } activeRunId = null; });
  return run;
}
module.exports = { createPlan, approvePlan, executePlan };
