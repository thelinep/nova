'use strict';

const CATEGORIES = new Set(['banquet halls', 'wedding venues', 'conference centres', 'party halls']);
const { spawn } = require('node:child_process');
const path = require('node:path');
const evidenceStore = require('./collector-evidence');
const INDIA_SCRAPER_ROOT = path.resolve(__dirname, '../../india-scraper-next');
const RUNNER = path.join(INDIA_SCRAPER_ROOT, 'scripts/run-delhi-venue-queries.cjs');
let active = null;
function classifyExit(evidence, detail, code, cancelRequested=false) { if(cancelRequested)return'cancelled';if(evidence.some(x=>x.status==='blocked')||/challenge|blocked|captcha/i.test(detail))return'challenge-stopped';if(code===0&&!/Invalid collector evidence:/i.test(detail))return'completed';return'paused'; }
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
  if (!['awaiting_approval','paused','challenge-stopped'].includes(run.status)) throw Object.assign(new Error('Collection run is not awaiting approval or resumable.'), { statusCode: 400 });
  const at=new Date().toISOString();run.status = 'approved'; run.approvedAt = at;if(run.startedAt){run.resumedAt=at;run.checkpoints.push({at,status:'resume-approved',detail:'User approved resume from persisted query-history checkpoints.'});}store.put('collectionRuns', run); return run;
}
function executePlan(store, id) {
  const run = store.get('collectionRuns', id);
  if (!run) throw Object.assign(new Error('Unknown collection run.'), { statusCode: 404 });
  if (run.status !== 'approved') throw Object.assign(new Error('Approve the collection run before execution.'), { statusCode: 400 });
  if (active) throw Object.assign(new Error('Another collector run is active.'), { statusCode: 409 });
  if (run.categories.length !== CATEGORIES.size) throw Object.assign(new Error('The installed Delhi runner currently executes the four approved venue categories as one bounded batch.'), { statusCode: 400 });
  const priorEvidence=store.all('collectorEvidence').filter(x=>x.runId===id);run.status = 'running'; run.startedAt = run.startedAt||new Date().toISOString(); run.lastStartedAt=new Date().toISOString();run.completedQueries=priorEvidence.length;run.checkpoints.push({ at: run.lastStartedAt, status: priorEvidence.length?'resumed':'started', detail: priorEvidence.length?`Resuming after ${priorEvidence.length} persisted query checkpoint(s).`:'Launching fixed local Delhi venue runner.' }); store.put('collectionRuns', run);
  const child = spawn(process.execPath, [RUNNER], { cwd: INDIA_SCRAPER_ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached:process.platform!=='win32' });active={id,child};
  let detail = '';
  let pending='';child.stdout.on('data',chunk=>{pending+=chunk.toString();const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines){if(!line.trim())continue;const row=store.get('collectionRuns',id);if(!row)continue;try{const result=JSON.parse(line);const evidence=evidenceStore.persist(store,row,result);row.completedQueries=store.all('collectorEvidence').filter(x=>x.runId===id).length;row.checkpoints.push({at:evidence.finishedAt,status:evidence.status,queryHistoryId:evidence.queryHistoryId,detail:`${evidence.district} · ${evidence.methodId} · ${evidence.resultCount} result(s)`});store.put('collectionRuns',row);}catch(error){detail=(detail+'\nInvalid collector evidence: '+error.message).slice(-4000);try{child.kill('SIGTERM');}catch(_){}}}});
  child.stderr.on('data', chunk => { detail = (detail + chunk).slice(-4000); });
  child.on('error', error => { const row = store.get('collectionRuns', id); if (row) { row.status = 'failed'; row.finishedAt = new Date().toISOString(); row.checkpoints.push({ at: row.finishedAt, status: 'failed', detail: error.message }); store.put('collectionRuns', row); } active = null; });
  child.on('exit', code => { const row = store.get('collectionRuns', id); if (row) { const evidence=store.all('collectorEvidence').filter(x=>x.runId===id);row.status=classifyExit(evidence,detail,code,row.cancelRequested);row.finishedAt = new Date().toISOString(); row.checkpoints.push({ at: row.finishedAt, status: row.status, detail: detail || `Runner exited with code ${code}.` }); store.put('collectionRuns', row); } active = null; });
  return run;
}
function cancelRun(store,id){const run=store.get('collectionRuns',id);if(!run)throw Object.assign(new Error('Unknown collection run.'),{statusCode:404});if(!active||active.id!==id||run.status!=='running')throw Object.assign(new Error('Collector run is not active.'),{statusCode:409});run.cancelRequested=true;run.cancelRequestedAt=new Date().toISOString();run.checkpoints.push({at:run.cancelRequestedAt,status:'cancelling',detail:'User requested cancellation.'});store.put('collectionRuns',run);try{process.platform==='win32'?active.child.kill('SIGTERM'):process.kill(-active.child.pid,'SIGTERM');}catch(_){}return run;}
function recoverInterrupted(store){let count=0;for(const run of store.all('collectionRuns'))if(run.status==='running'){run.status='paused';run.finishedAt=new Date().toISOString();run.checkpoints.push({at:run.finishedAt,status:'paused',detail:'Maataa restarted; runner checkpoint will be reused on the next approved execution.'});store.put('collectionRuns',run);count++;}return count;}
module.exports = { createPlan, approvePlan, executePlan, cancelRun, recoverInterrupted, classifyExit };
