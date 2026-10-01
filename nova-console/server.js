'use strict';
/* ===========================================================================
 * NOVA Runtime
 *
 * The local backend behind the NOVA Console prototype (Phase 1 of its
 * roadmap: "Real inference core"). Serves the modified console HTML,
 * persists every store to real SQLite (node:sqlite — no install step),
 * and proxies real inference, model lifecycle, and telemetry to/from a
 * local Ollama daemon. No external npm dependencies: node:sqlite, global
 * fetch, and node:http are all that Node 22+ needs to ship this.
 *
 * Run: node server.js   (or: npm start)
 * Config via env vars:
 *   PORT          — default 8787
 *   OLLAMA_HOST   — default http://127.0.0.1:11434
 *   DATA_DIR      — default ./data  (holds nova.db)
 * ========================================================================= */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { STORE_NAMES, openDb, Store } = require('./lib/db');
const { OllamaClient } = require('./lib/ollama');
const { TelemetryReader } = require('./lib/telemetry');
const { ingestDocument, reindexCollection, searchKnowledge, deleteDocument } = require('./lib/knowledge');
const mcpManager = require('./lib/mcp-manager');
const { runSkillSandboxed } = require('./lib/skill-runner');
const { runAgentLoop } = require('./lib/agent-loop');
const workflowEngine = require('./lib/workflow-engine');
const evalBench = require('./lib/eval-bench');
const scheduler = require('./lib/scheduler');
const { uid, logExecution } = require('./lib/exec-log');
const { checkLocalAccess } = require('./lib/local-access');
const collectorWorkflows = require('./lib/collector-workflows');
const codePlanner = require('./lib/code-planner');
const modelQualifications = require('./lib/model-qualifications');
const workspaceScanner = require('./lib/workspace-scanner');
const browserService = require('./lib/browser-service');
const workspacePlanner = require('./lib/workspace-planner');
const workspaceChanges = require('./lib/workspace-changes');
const workspaceRunner = require('./lib/workspace-runner');
const workspaceGit = require('./lib/workspace-git');
const desktopSecurity = require('./lib/desktop-security');
const { Workbench } = require('./lib/workbench');
const { WorkbenchActions } = require('./lib/workbench-actions');
const { ActivationLadder } = require('./lib/activation');
const { SecretVault } = require('./lib/secrets');
const { ConnectorRegistry } = require('./lib/connectors');
const { GitHubConnector } = require('./lib/github-connector');
const { ConnectorActions } = require('./lib/connector-actions');
const { RollbackManager } = require('./lib/rollback');
const { KillSwitch } = require('./lib/killswitch');
const { PolicyEngine } = require('./lib/policy');
const { JobEngine } = require('./lib/jobs');


const PORT = process.env.PORT === undefined ? 8787 : Number(process.env.PORT);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('PORT must be an integer from 0 to 65535');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const WORKSPACE_ROOT = path.resolve(__dirname, '..');

function gitSnapshot() {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: WORKSPACE_ROOT, encoding: 'utf8', timeout: 3000 }).trim();
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: WORKSPACE_ROOT, encoding: 'utf8', timeout: 3000 }).trim();
    const lines = execFileSync('git', ['status', '--short'], { cwd: WORKSPACE_ROOT, encoding: 'utf8', timeout: 3000 }).trim().split('\n').filter(Boolean);
    return { available: true, branch, head, changed: lines.length, files: lines.slice(0, 100), sampledAt: new Date().toISOString() };
  } catch (error) { return { available: false, error: error.message, sampledAt: new Date().toISOString() }; }
}

const { db } = openDb(DATA_DIR);
const store = new Store(db);
const browser = new browserService.BrowserService(store, DATA_DIR, desktopSecurity);
const jobEngine = new JobEngine(store, { pollMs: 500 });

const workbenchRollback = new RollbackManager(store, { domains: ['workspace', 'neuron-factory', 'browser-tools', 'release'] });
const workbenchKillSwitch = new KillSwitch(store, {
  authFn: (credential, operator) => {
    if (typeof credential !== 'string') return false;
    const expected = process.env.NOVA_RESUME_CREDENTIAL;
    if (!expected) return false;
    return credential === expected;
  },
});
const workbenchPolicy = new PolicyEngine(store);
const workbenchActions = new WorkbenchActions(store, {
  rollback: workbenchRollback,
  killSwitch: workbenchKillSwitch,
  policy: workbenchPolicy,
  jobs: jobEngine,
});


let secretVault = null;
let connectorRegistry = null;
let githubConnector = null;
let connectorActions = null;
try {
  secretVault = new SecretVault(store, { dataDir: DATA_DIR });
  connectorRegistry = new ConnectorRegistry(store);
  githubConnector = new GitHubConnector({
    registry: connectorRegistry,
    vault: secretVault,
  });
  connectorActions = new ConnectorActions({
    store,
    registry: connectorRegistry,
    connector: githubConnector,
    policy: workbenchPolicy,
  });
} catch (e) {
  console.warn('[nova-runtime] connector stack unavailable:', e.message);
}
if (workbenchActions) workbenchActions.connectorActions = connectorActions;

const ollama = new OllamaClient(process.env.OLLAMA_HOST);
const telemetry = new TelemetryReader();

// Cached reachability flag the frontend's diagnostics/status-bar can read
// cheaply and synchronously; refreshed on a slow interval in the
// background rather than on every request.
let ollamaStatusCache = { reachable: false, models: [], runningModelNames: [], error: 'not checked yet' };
async function refreshOllamaStatus() {
  ollamaStatusCache = await ollama.status();
  return ollamaStatusCache;
}
refreshOllamaStatus();
setInterval(refreshOllamaStatus, 5000);

/* ---------------------------- tiny helpers ---------------------------- */

function sendJson(res, statusCode, body) {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res, err) {
  const codeMap = {
    not_found: 404,
    not_cancellable: 409,
    bad_operator: 400,
    bad_reason: 400,
    bad_id: 400,
    bad_decision: 400,
    auth_failed: 403,
    already_halted: 409,
    not_halted: 409,
    no_rollback: 503,
    no_jobs: 503,
    no_killswitch: 503,
    no_policy: 503,
  };
  const statusCode = err.statusCode || codeMap[err.code] || 500;
  if (statusCode >= 500) console.error('[nova-runtime] error:', err);
  sendJson(res, statusCode, err.browser ? { ok:false, error:err.message || 'Internal error', ...(err.policyId ? { policy_id:err.policyId } : {}) } : { error: err.message || 'Internal error' });
}

function requireFields(body, fields) {
  for (const f of fields) {
    const v = body[f];
    if (v === undefined || v === null || v === '') {
      const e = new Error(`field_required:${f}`);
      e.statusCode = 400;
      throw e;
    }
  }
}

function requireUrl(value, field) {
  try { new URL(String(value)); }
  catch {
    const e = new Error(`field_invalid:${field}`);
    e.statusCode = 400;
    throw e;
  }
}

function requireApprovalTrue(value) {
  if (value !== true) {
    const e = new Error('field_required:approve');
    e.statusCode = 400;
    throw e;
  }
}

// uid()/logExecution() now live in lib/exec-log.js — lib/scheduler.js needs
// the same audit-trail helper from a background tick with no request/
// response in play, so it moved out from under server.js rather than being
// duplicated (see lib/exec-log.js's own header for why).

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 25 * 1024 * 1024) { reject(Object.assign(new Error('Body too large'), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) { sendJson(res, 403, { error: 'Forbidden' }); return; }
  fs.realpath(filePath, (resolveError, canonical) => {
    if (resolveError || (canonical !== PUBLIC_DIR && !canonical.startsWith(PUBLIC_DIR + path.sep))) { sendJson(res, resolveError?.code==='ENOENT'?404:403, { error: resolveError?.code==='ENOENT'?'Not found':'Forbidden' }); return; }
    fs.lstat(filePath, (linkError, stat) => {
      if (linkError || stat.isSymbolicLink()) { sendJson(res, linkError?404:403, { error: linkError?'Not found':'Forbidden' }); return; }
      fs.readFile(canonical, (err, data) => {
    if (err) { sendJson(res, 404, { error: 'Not found' }); return; }
    const ext = path.extname(canonical);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
      });
    });
  });
}

/* ----------------------------- model mapping ----------------------------- */

/** Maps one entry from Ollama's GET /api/tags into the shape the NOVA
 *  Console frontend already knows how to render (see modelCardHtml in the
 *  console). Anything Ollama doesn't expose (context window, GPU layer
 *  count) is left null rather than guessed — the frontend already renders
 *  null as "—". promptTps/genTps/ttft come from benchmark(), not here. */
function mapOllamaTagToModel(tag, runningNames, existing, metadata) {
  const prior = existing || {};
  const info = (metadata && metadata.model_info) || {};
  const contextKey = Object.keys(info).find(key => key.endsWith('.context_length'));
  const contextLength = Number(contextKey ? info[contextKey] : 0) || null;
  return {
    id: tag.name,
    name: tag.name,
    runtime: 'ollama',
    format: 'GGUF',
    quant: (tag.details && tag.details.quantization_level) || '—',
    params: (tag.details && tag.details.parameter_size) || '—',
    diskGb: typeof tag.size === 'number' ? tag.size / 1e9 : null,
    ramGb: prior.ramGb != null ? prior.ramGb : null,
    ctx: prior.ctx != null ? prior.ctx : null,
    ctxMax: contextLength || (prior.ctxMax != null ? prior.ctxMax : null),
    gpuLayers: prior.gpuLayers != null ? prior.gpuLayers : '—',
    gpuLayersMax: prior.gpuLayersMax != null ? prior.gpuLayersMax : '—',
    promptTps: prior.promptTps != null ? prior.promptTps : null,
    genTps: prior.genTps != null ? prior.genTps : null,
    ttft: prior.ttft != null ? prior.ttft : null,
    loaded: runningNames.includes(tag.name),
    runtimeKind: 'local',
    family: (tag.details && tag.details.family) || null,
    modifiedAt: tag.modified_at || null,
    capabilities: Array.isArray(metadata && metadata.capabilities) ? metadata.capabilities : (prior.capabilities || []),
    hasChatTemplate: metadata ? Boolean(metadata.template) : (prior.hasChatTemplate || false),
    capabilityCheckedAt: metadata ? new Date().toISOString() : (prior.capabilityCheckedAt || null),
    digest: tag.digest || prior.digest || null,
    codePlanningQualification: tag.digest ? modelQualifications.summary(store, tag.digest) : null,
  };
}

async function syncModelsFromOllama() {
  const status = await ollama.status();
  if (!status.reachable) {
    const err = new Error('Ollama is not reachable at ' + ollama.host + (status.error ? (' (' + status.error + ')') : ''));
    err.statusCode = 503;
    throw err;
  }
  const existingById = new Map(store.all('models').map(m => [m.id, m]));
  const inspected = await Promise.all(status.models.map(async tag => {
    try { return await ollama.show(tag.name); }
    catch (_) { return null; }
  }));
  const mapped = status.models.map((tag, index) => mapOllamaTagToModel(tag, status.runningModelNames, existingById.get(tag.name), inspected[index]));
  // Replace only the models that came from Ollama (runtimeKind local/ollama
  // rows not present in this tag list are left alone — e.g. a remote/API
  // model entry the user added by hand has nothing to do with `ollama list`).
  const mappedIds = new Set(mapped.map(m => m.id));
  for (const m of existingById.values()) {
    if (m.runtime === 'ollama' && !mappedIds.has(m.id)) store.delete('models', m.id);
  }
  for (const m of mapped) store.put('models', m);

  // Phase 5 fix: the seeded demo agents/automations point at seeded demo
  // model rows (runtime 'llama.cpp'/'MLX'/'API', never 'ollama') — real
  // ids that were never meant to be run against, only displayed. Syncing
  // real models in without also repointing anything still aimed at a demo
  // model left every seeded agent run and automation run rejected by
  // resolveOllamaModel() ("not Ollama-backed") the moment a real (or
  // stubbed) Ollama actually became reachable — the sync fixed the model
  // list but silently broke the two Phase 4/5 features built on top of it.
  // Repoint anything still aimed at a non-Ollama model at the first real
  // synced one, once, here — where the swap actually happens.
  if (mapped.length) {
    const fallbackModelId = mapped[0].id;
    for (const a of store.all('agents')) {
      const am = store.get('models', a.modelId);
      if (!am || am.runtime !== 'ollama') { a.modelId = fallbackModelId; store.put('agents', a); }
    }
    for (const auto of store.all('automations')) {
      const am = store.get('models', auto.modelId);
      if (!am || am.runtime !== 'ollama') { auto.modelId = fallbackModelId; store.put('automations', auto); }
    }
  }
  return mapped;
}

/* --------------------------------- routes -------------------------------- */

const routes = [
  { method:'POST',pattern:/^\/browser\/open$/,handler:async(req,res)=>{const b=await readJsonBody(req);requireFields(b,['agentId','url']);requireUrl(b.url,'url');sendJson(res,201,await browser.open(b.url,b));} },
  { method:'POST',pattern:/^\/browser\/pages\/([^/]+)\/click$/,handler:async(req,res,[id])=>{const b=await readJsonBody(req);requireFields(b,['selector']);sendJson(res,200,await browser.click(decodeURIComponent(id),b.selector));} },
  { method:'POST',pattern:/^\/browser\/pages\/([^/]+)\/type$/,handler:async(req,res,[id])=>{const b=await readJsonBody(req);requireFields(b,['selector','text']);sendJson(res,200,await browser.type(decodeURIComponent(id),b.selector,b.text));} },
  { method:'POST',pattern:/^\/browser\/pages\/([^/]+)\/read$/,handler:async(req,res,[id])=>sendJson(res,200,await browser.read(decodeURIComponent(id),await readJsonBody(req))) },
  { method:'POST',pattern:/^\/browser\/pages\/([^/]+)\/wait$/,handler:async(req,res,[id])=>{const b=await readJsonBody(req);if(!b.selector&&!b.ms){const e=new Error('field_required:selector_or_ms');e.statusCode=400;throw e;}sendJson(res,200,await browser.wait(decodeURIComponent(id),b));} },
  { method:'POST',pattern:/^\/browser\/pages\/([^/]+)\/screenshot$/,handler:async(req,res,[id])=>sendJson(res,200,await browser.screenshot(decodeURIComponent(id),await readJsonBody(req))) },
  { method:'POST',pattern:/^\/browser\/pages\/([^/]+)\/download$/,handler:async(req,res,[id])=>{const b=await readJsonBody(req);requireFields(b,['approve','selector','path']);requireApprovalTrue(b.approve);sendJson(res,200,await browser.download(decodeURIComponent(id),b));} },
  { method:'POST',pattern:/^\/browser\/pages\/([^/]+)\/upload$/,handler:async(req,res,[id])=>{const b=await readJsonBody(req);requireFields(b,['approve','selector','path']);requireApprovalTrue(b.approve);sendJson(res,200,await browser.upload(decodeURIComponent(id),b));} },
  { method:'POST',pattern:/^\/browser\/pages\/([^/]+)\/close$/,handler:async(_q,res,[id])=>sendJson(res,200,await browser.close(decodeURIComponent(id))) },
  { method:'POST',pattern:/^\/browser\/halt$/,handler:async(_q,res)=>sendJson(res,200,await browser.halt()) },
  { method:'GET',pattern:/^\/browser\/pages$/,handler:async(req,res)=>{const agentId=new URL(req.url,'http://localhost').searchParams.get('agentId');requireFields({agentId},['agentId']);sendJson(res,200,browser.list(agentId));} },
  { method: 'GET', pattern: /^\/api\/workspace\/roots$/, handler: async (_req, res) => sendJson(res, 200, store.all('workspaceRoots')) },
  { method: 'POST', pattern: /^\/api\/workspace\/roots$/, handler: async (req, res) => {const root=workspaceScanner.approveRoot(store,await readJsonBody(req));const permission=desktopSecurity.recordPermission(store,{rootId:root.id,path:root.path,capabilities:['filesystem:read'],source:'explicit-root-approval'});desktopSecurity.appendAudit(DATA_DIR,{action:'permission.granted',rootId:root.id,permissionId:permission.id,exactPath:root.path});sendJson(res,201,root);} },
  { method: 'DELETE', pattern: /^\/api\/workspace\/roots\/([^/]+)$/, handler: async (_req, res, [id]) => {const rootId=decodeURIComponent(id);store.delete('workspaceRoots',rootId);for(const permission of store.all('workspacePermissions').filter(x=>x.rootId===rootId)){permission.status='revoked';permission.revokedAt=new Date().toISOString();store.put('workspacePermissions',permission);}desktopSecurity.appendAudit(DATA_DIR,{action:'permission.revoked',rootId});sendJson(res, 200, { ok:true });} },
  { method: 'POST', pattern: /^\/api\/workspace\/scan$/, handler: async (req, res) => sendJson(res, 200, workspaceScanner.scanWorkspace(store, await readJsonBody(req))) },
  { method: 'POST', pattern: /^\/api\/workspace\/search$/, handler: async (req, res) => sendJson(res, 200, workspaceScanner.searchWorkspace(store, await readJsonBody(req))) },
  { method: 'POST', pattern: /^\/api\/workspace\/structured-report$/, handler: async (req, res) => sendJson(res, 200, workspaceScanner.createStructuredReport(store, await readJsonBody(req))) },
  { method: 'GET', pattern: /^\/api\/workspace\/reports$/, handler: async (_req, res) => sendJson(res, 200, store.all('workspaceReports').reverse()) },
  { method: 'GET', pattern: /^\/api\/workspace\/plans$/, handler: async (_req, res) => sendJson(res, 200, store.all('workspacePlans').reverse()) },
  { method: 'POST', pattern: /^\/api\/workspace\/plans\/from-conversation$/, handler: async (req, res) => sendJson(res, 200, workspacePlanner.createConversationPlan(store, await readJsonBody(req))) },
  { method: 'POST', pattern: /^\/api\/workspace\/plans\/([^/]+)\/root$/, handler: async (req, res, [id]) => { const body=await readJsonBody(req); sendJson(res, 200, workspacePlanner.setPlanRoot(store, decodeURIComponent(id), body.rootId)); } },
  { method: 'POST', pattern: /^\/api\/workspace\/plans\/([^/]+)\/run$/, handler: async (_req, res, [id]) => sendJson(res, 200, workspacePlanner.runPlan(store, workspaceScanner, decodeURIComponent(id))) },
  { method: 'POST', pattern: /^\/api\/workspace\/code-plan\/preview$/, handler: async (req,res)=>sendJson(res,200,await codePlanner.preview(store,workspaceScanner,ollama,await readJsonBody(req))) },
  { method: 'POST', pattern: /^\/api\/workspace\/code-plan$/, handler: async (req, res) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try {
      const input = await readJsonBody(req);
      const draft = await codePlanner.plan(store, workspaceScanner, workspaceChanges, ollama, input, { signal: controller.signal });
      if (!res.destroyed) sendJson(res, 201, draft);
    } finally { res.removeListener('close', cancel); }
  } },
  { method: 'GET', pattern: /^\/api\/workspace\/changes$/, handler: async (_req, res) => sendJson(res, 200, store.all('workspaceChanges').reverse()) },
  { method: 'GET', pattern: /^\/api\/model-qualifications$/, handler: async (_req,res)=>sendJson(res,200,store.all('modelQualifications').reverse()) },
  { method: 'POST', pattern: /^\/api\/workspace\/changes$/, handler: async (req, res) => sendJson(res, 201, workspaceChanges.proposeChange(store, workspaceScanner, await readJsonBody(req))) },
  { method: 'POST', pattern: /^\/api\/workspace\/changes\/([^/]+)\/check$/, handler: async (_req, res, [id]) => sendJson(res, 200, workspaceChanges.checkProposal(store, workspaceScanner, DATA_DIR, decodeURIComponent(id))) },
  { method: 'POST', pattern: /^\/api\/workspace\/changes\/([^/]+)\/approve$/, handler: async (_req, res, [id]) => {const result=workspaceChanges.approveProposal(store,workspaceScanner,decodeURIComponent(id));desktopSecurity.appendAudit(DATA_DIR,{action:'workspace.write.approved',proposalId:result.id,affectedFiles:result.approval.affectedFiles});sendJson(res,200,result);} },
  { method: 'POST', pattern: /^\/api\/workspace\/changes\/([^/]+)\/execute$/, handler: async (_req, res, [id]) => {const result=workspaceChanges.executeProposal(store,workspaceScanner,DATA_DIR,decodeURIComponent(id));desktopSecurity.appendAudit(DATA_DIR,{action:'workspace.write.executed',proposalId:result.id,execution:result.execution,rollback:result.rollback});sendJson(res,200,result);} },
  { method: 'GET', pattern: /^\/api\/workspace\/change-batches$/, handler: async (_req,res)=>sendJson(res,200,store.all('workspaceChangeBatches').reverse()) },
  { method: 'POST', pattern: /^\/api\/workspace\/change-batches$/, handler: async (req,res)=>sendJson(res,201,workspaceChanges.createBatch(store,workspaceScanner,await readJsonBody(req))) },
  { method: 'POST', pattern: /^\/api\/workspace\/change-batches\/([^/]+)\/check$/, handler: async (_req,res,[id])=>sendJson(res,200,workspaceChanges.checkBatch(store,workspaceScanner,DATA_DIR,decodeURIComponent(id))) },
  { method: 'POST', pattern: /^\/api\/workspace\/change-batches\/([^/]+)\/approve$/, handler: async (_req,res,[id])=>{const result=workspaceChanges.approveBatch(store,workspaceScanner,decodeURIComponent(id));desktopSecurity.appendAudit(DATA_DIR,{action:'workspace.batch.approved',batchId:result.id,approval:result.approval});sendJson(res,200,result);} },
  { method: 'POST', pattern: /^\/api\/workspace\/change-batches\/([^/]+)\/execute$/, handler: async (_req,res,[id])=>{const result=workspaceChanges.executeBatch(store,workspaceScanner,DATA_DIR,decodeURIComponent(id));desktopSecurity.appendAudit(DATA_DIR,{action:'workspace.batch.executed',batchId:result.id,execution:result.execution,rollback:result.rollback});sendJson(res,200,result);} },
  { method: 'GET', pattern: /^\/api\/workspace\/runs$/, handler: async (_req, res) => sendJson(res, 200, store.all('workspaceRuns').reverse()) },
  { method: 'POST', pattern: /^\/api\/workspace\/roots\/([^/]+)\/commands\/allow$/, handler: async (req, res, [id]) => {const body=await readJsonBody(req),root=workspaceRunner.allowRepository(store,workspaceScanner,decodeURIComponent(id),body.actions),permission=desktopSecurity.recordPermission(store,{rootId:root.id,path:root.path,capabilities:root.commandAllowlist.actions.map(x=>'command:'+x),source:'explicit-command-allowlist'});desktopSecurity.appendAudit(DATA_DIR,{action:'command.allowlist.granted',rootId:root.id,permissionId:permission.id,actions:root.commandAllowlist.actions});sendJson(res,200,root);} },
  { method: 'POST', pattern: /^\/api\/workspace\/runs$/, handler: async (req, res) => sendJson(res, 200, await workspaceRunner.run(store,workspaceScanner,workspaceChanges,DATA_DIR,await readJsonBody(req))) },
  { method: 'POST', pattern: /^\/api\/workspace\/runs\/([^/]+)\/cancel$/, handler: async (_req,res,[id])=>sendJson(res,200,workspaceRunner.cancel(store,decodeURIComponent(id))) },
  { method: 'GET', pattern: /^\/api\/workspace\/git$/, handler: async (req, res) => {const rootId=new URL(req.url,'http://localhost').searchParams.get('rootId');sendJson(res,200,workspaceGit.snapshot(store,workspaceScanner,rootId));} },
  { method: 'GET', pattern: /^\/api\/workspace\/git\/drafts$/, handler: async (_req, res) => sendJson(res,200,store.all('workspaceGitDrafts').reverse()) },
  { method: 'POST', pattern: /^\/api\/workspace\/git\/drafts$/, handler: async (req, res) => {const result=workspaceGit.createDraft(store,workspaceScanner,await readJsonBody(req));desktopSecurity.appendAudit(DATA_DIR,{action:'git.draft.created',draftId:result.id,stagedFiles:result.stagedFiles,diffSha256:result.stagedDiffSha256});sendJson(res,201,result);} },
  { method: 'POST', pattern: /^\/api\/workspace\/git\/drafts\/([^/]+)\/review$/, handler: async (_req, res, [id]) => {const result=workspaceGit.reviewDraft(store,workspaceScanner,decodeURIComponent(id));desktopSecurity.appendAudit(DATA_DIR,{action:'git.draft.reviewed',draftId:result.id,exactFiles:result.review.exactFiles,diffSha256:result.review.stagedDiffSha256});sendJson(res,200,result);} },
  { method: 'POST', pattern: /^\/api\/workspace\/git\/drafts\/([^/]+)\/commit$/, handler: async (_req, res, [id]) => {const result=workspaceGit.commitDraft(store,workspaceScanner,decodeURIComponent(id));desktopSecurity.appendAudit(DATA_DIR,{action:'git.commit.created',draftId:result.id,commit:result.commit});sendJson(res,200,result);} },
  { method: 'GET', pattern: /^\/api\/workspace\/git\/history$/, handler: async (req,res)=>{const url=new URL(req.url,'http://localhost');sendJson(res,200,workspaceGit.history(store,workspaceScanner,url.searchParams.get('rootId'),url.searchParams.get('limit')));} },
  { method: 'GET', pattern: /^\/api\/workspace\/git\/conflicts$/, handler: async (req,res)=>sendJson(res,200,workspaceGit.conflicts(store,workspaceScanner,new URL(req.url,'http://localhost').searchParams.get('rootId'))) },
  { method: 'POST', pattern: /^\/api\/workspace\/git\/branch$/, handler: async (req,res)=>sendJson(res,200,workspaceGit.branch(store,workspaceScanner,await readJsonBody(req))) },
  { method: 'POST', pattern: /^\/api\/workspace\/git\/pull-request-drafts$/, handler: async (req,res)=>sendJson(res,201,workspaceGit.preparePullRequest(store,workspaceScanner,await readJsonBody(req))) },
  { method: 'POST', pattern: /^\/api\/workspace\/git\/push-requests$/, handler: async (req,res)=>sendJson(res,201,workspaceGit.preparePush(store,workspaceScanner,await readJsonBody(req))) },
  { method: 'POST', pattern: /^\/api\/workspace\/git\/push-requests\/([^/]+)\/review$/, handler: async (_req,res,[id])=>sendJson(res,200,workspaceGit.reviewPush(store,workspaceScanner,decodeURIComponent(id))) },
  { method: 'POST', pattern: /^\/api\/workspace\/git\/push-requests\/([^/]+)\/execute$/, handler: async (_req,res,[id])=>sendJson(res,200,workspaceGit.executePush(store,workspaceScanner,decodeURIComponent(id))) },
  { method: 'GET', pattern: /^\/api\/security\/permissions$/, handler: async (_req, res) => sendJson(res,200,store.all('workspacePermissions').reverse()) },
  { method: 'GET', pattern: /^\/api\/security\/audit$/, handler: async (_req, res) => sendJson(res,200,desktopSecurity.readAudit(DATA_DIR).reverse().slice(0,200)) },
  { method: 'GET', pattern: /^\/api\/security\/backups$/, handler: async (_req, res) => sendJson(res,200,store.all('securityBackups').reverse()) },
  { method: 'POST', pattern: /^\/api\/security\/backups$/, handler: async (req, res) => {const body=await readJsonBody(req),backup=desktopSecurity.createBackup(store,DATA_DIR,body.label);desktopSecurity.appendAudit(DATA_DIR,{action:'backup.created',backupId:backup.id,sha256:backup.sha256});sendJson(res,201,backup);} },
  { method: 'POST', pattern: /^\/api\/security\/backups\/([^/]+)\/restore$/, handler: async (_req, res, [id]) => {const result=desktopSecurity.restoreBackup(store,DATA_DIR,decodeURIComponent(id));desktopSecurity.appendAudit(DATA_DIR,{action:'backup.restored',...result});sendJson(res,200,result);} },
  { method: 'GET', pattern: /^\/api\/git\/status$/, handler: async (_req, res) => sendJson(res, 200, gitSnapshot()) },
  { method: 'GET', pattern: /^\/api\/collector\/runs$/, handler: async (_req, res) => sendJson(res, 200, store.all('collectionRuns')) },
  { method: 'POST', pattern: /^\/api\/collector\/plans$/, handler: async (req, res) => sendJson(res, 201, collectorWorkflows.createPlan(store, await readJsonBody(req))) },
  { method: 'POST', pattern: /^\/api\/collector\/runs\/([^/]+)\/approve$/, handler: async (_req, res, [id]) => sendJson(res, 200, collectorWorkflows.approvePlan(store, decodeURIComponent(id))) },
  { method: 'POST', pattern: /^\/api\/collector\/runs\/([^/]+)\/execute$/, handler: async (_req, res, [id]) => sendJson(res, 202, collectorWorkflows.executePlan(store, decodeURIComponent(id))) },
  { method: 'POST', pattern: /^\/api\/collector\/runs\/([^/]+)\/cancel$/, handler: async (_req, res, [id]) => sendJson(res, 200, collectorWorkflows.cancelRun(store, decodeURIComponent(id))) },
  { method: 'GET', pattern: /^\/api\/collector\/evidence$/, handler: async (_req, res) => sendJson(res, 200, store.all('collectorEvidence').reverse()) },
  { method: 'GET', pattern: /^\/api\/collector\/venues$/, handler: async (_req, res) => sendJson(res, 200, store.all('venueObservations').reverse()) },
  { method: 'GET', pattern: /^\/api\/health$/, handler: async (req, res) => sendJson(res, 200, { ok: true, pid: process.pid, dataDir: DATA_DIR }) },

  { method: 'GET', pattern: /^\/api\/store\/([^/]+)$/, handler: async (req, res, [name]) => sendJson(res, 200, store.all(decodeURIComponent(name))) },
  /* Phase 5: real backend-driven pagination — see Store.page(). Used by the
     Trace and Execution History views instead of fetching every row and
     capping the client's in-memory copy at an arbitrary number. */
  {
    method: 'GET', pattern: /^\/api\/store\/([^/]+)\/page$/, handler: async (req, res, [name]) => {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const limit = Number(q.get('limit')) || 50;
      const before = q.get('before') || null;
      sendJson(res, 200, store.page(decodeURIComponent(name), { limit, beforeUpdatedAt: before }));
    },
  },
  { method: 'PUT', pattern: /^\/api\/store\/([^/]+)$/, handler: async (req, res, [name]) => { const body = await readJsonBody(req); if (decodeURIComponent(name) === 'modelQualifications') return sendJson(res,403,{error:'Qualification records are written only by the local validation runner.'}); sendJson(res, 200, store.put(decodeURIComponent(name), body)); } },
  { method: 'DELETE', pattern: /^\/api\/store\/([^/]+)\/([^/]+)$/, handler: async (req, res, [name, id]) => { if (decodeURIComponent(name) === 'modelQualifications') return sendJson(res,403,{error:'Qualification records are read-only.'}); store.delete(decodeURIComponent(name), decodeURIComponent(id)); sendJson(res, 200, { ok: true }); } },
  { method: 'POST', pattern: /^\/api\/store\/_clear-all$/, handler: async (req, res) => { store.clearAll(); sendJson(res, 200, { ok: true }); } },

  { method: 'GET', pattern: /^\/api\/ollama\/status$/, handler: async (req, res) => sendJson(res, 200, ollamaStatusCache) },
  { method: 'POST', pattern: /^\/api\/models\/sync$/, handler: async (req, res) => sendJson(res, 200, { models: await syncModelsFromOllama() }) },

  {
    method: 'POST', pattern: /^\/api\/models\/([^/]+)\/load$/, handler: async (req, res, [id]) => {
      const modelId = decodeURIComponent(id);
      await ollama.load(modelId);
      const m = store.get('models', modelId);
      if (m) { m.loaded = true; store.put('models', m); }
      await refreshOllamaStatus();
      sendJson(res, 200, m || { id: modelId, loaded: true });
    },
  },
  {
    method: 'POST', pattern: /^\/api\/models\/([^/]+)\/unload$/, handler: async (req, res, [id]) => {
      const modelId = decodeURIComponent(id);
      await ollama.unload(modelId);
      const m = store.get('models', modelId);
      if (m) { m.loaded = false; store.put('models', m); }
      await refreshOllamaStatus();
      sendJson(res, 200, m || { id: modelId, loaded: false });
    },
  },
  {
    method: 'POST', pattern: /^\/api\/models\/([^/]+)\/benchmark$/, handler: async (req, res, [id]) => {
      const modelId = decodeURIComponent(id);
      const result = await ollama.benchmark(modelId);
      const promptTps = result.prompt_eval_count && result.prompt_eval_duration
        ? +(result.prompt_eval_count / (result.prompt_eval_duration / 1e9)).toFixed(1) : null;
      const genTps = result.eval_count && result.eval_duration
        ? +(result.eval_count / (result.eval_duration / 1e9)).toFixed(1) : null;
      const ttft = (result.total_duration != null && result.eval_duration != null)
        ? Math.round((result.total_duration - result.eval_duration) / 1e6) : null;
      const m = store.get('models', modelId) || { id: modelId, name: modelId, runtime: 'ollama', runtimeKind: 'local' };
      m.promptTps = promptTps; m.genTps = genTps; m.ttft = ttft; m.loaded = true;
      store.put('models', m);
      sendJson(res, 200, { model: m, raw: result });
    },
  },

  {
    method: 'POST', pattern: /^\/api\/chat\/stream$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      const { model, messages, options } = body;
      if (!model || !Array.isArray(messages)) { sendJson(res, 400, { error: 'Expected {model, messages[]}' }); return; }
      const controller = new AbortController();
      req.on('close', () => controller.abort());
      let upstream;
      try {
        upstream = await ollama.chatStream(model, messages, options, controller.signal);
      } catch (e) {
        sendJson(res, 502, { error: e.message });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      try {
        for await (const chunk of upstream.body) res.write(chunk);
      } catch (e) {
        // client disconnected / aborted — nothing to send a response to
      } finally {
        res.end();
      }
    },
  },

  { method: 'GET', pattern: /^\/api\/telemetry$/, handler: async (req, res) => sendJson(res, 200, { ...(await telemetry.read()), ollama: { reachable: ollamaStatusCache.reachable } }) },

  {
    method: 'POST', pattern: /^\/api\/embeddings$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      if (!body.model || body.input == null) { sendJson(res, 400, { error: 'Expected {model, input}' }); return; }
      const embeddings = await ollama.embed(body.model, body.input);
      sendJson(res, 200, { embeddings });
    },
  },
  {
    method: 'POST', pattern: /^\/api\/knowledge\/ingest$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      const result = await ingestDocument(store, ollama, body);
      // Phase 5: the real event receiver — fires any automation actually
      // watching this collection now that a document has genuinely been
      // added to it. Doesn't block the response; a slow/failed automation
      // run shouldn't turn a successful ingest into a failed request.
      Promise.resolve(scheduler.onDocumentIngested(store, ollama, body.collectionId))
        .catch(e => console.error('[nova-runtime] event dispatch failed', e.message || e));
      sendJson(res, 200, result);
    },
  },
  {
    method: 'POST', pattern: /^\/api\/knowledge\/reindex\/([^/]+)$/, handler: async (req, res, [collectionId]) => {
      sendJson(res, 200, await reindexCollection(store, ollama, decodeURIComponent(collectionId)));
    },
  },
  {
    method: 'POST', pattern: /^\/api\/knowledge\/search$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, await searchKnowledge(store, ollama, body));
    },
  },
  {
    method: 'DELETE', pattern: /^\/api\/knowledge\/documents\/([^/]+)$/, handler: async (req, res, [id]) => {
      const collection = deleteDocument(store, decodeURIComponent(id));
      sendJson(res, 200, { ok: true, collection });
    },
  },

  /* ---- Phase 3: real MCP connections + approval-gated tool calls ---- */
  {
    method: 'POST', pattern: /^\/api\/mcp\/([^/]+)\/connect$/, handler: async (req, res, [id]) => {
      sendJson(res, 200, await mcpManager.connectServer(store, decodeURIComponent(id)));
    },
  },
  {
    method: 'POST', pattern: /^\/api\/mcp\/([^/]+)\/disconnect$/, handler: async (req, res, [id]) => {
      sendJson(res, 200, mcpManager.disconnectServer(store, decodeURIComponent(id)));
    },
  },
  {
    method: 'POST', pattern: /^\/api\/mcp\/([^/]+)\/call$/, handler: async (req, res, [id]) => {
      const body = await readJsonBody(req);
      if (!body.toolName) { sendJson(res, 400, { error: 'Expected {toolName, arguments}' }); return; }
      const outcome = await mcpManager.gatedCall(store, decodeURIComponent(id), body.toolName, body.arguments, { origin: 'manual' });
      if (outcome && outcome.pending) sendJson(res, 202, outcome);
      else sendJson(res, 200, { status: 'ok', result: outcome });
    },
  },
  { method: 'GET', pattern: /^\/api\/mcp\/approvals$/, handler: async (req, res) => sendJson(res, 200, mcpManager.listPendingApprovals()) },
  {
    method: 'POST', pattern: /^\/api\/mcp\/approvals\/([^/]+)\/approve$/, handler: async (req, res, [aid]) => {
      sendJson(res, 200, await mcpManager.resolveApproval(store, decodeURIComponent(aid), 'approve'));
    },
  },
  {
    method: 'POST', pattern: /^\/api\/mcp\/approvals\/([^/]+)\/reject$/, handler: async (req, res, [aid]) => {
      sendJson(res, 200, await mcpManager.resolveApproval(store, decodeURIComponent(aid), 'reject'));
    },
  },

  /* ---- Phase 4: real agent tool-calling loop ---- */
  {
    method: 'POST', pattern: /^\/api\/agents\/([^/]+)\/run$/, handler: async (req, res, [id]) => {
      const agentId = decodeURIComponent(id);
      const agent = store.get('agents', agentId);
      if (!agent) { sendJson(res, 404, { error: 'Unknown agent: ' + agentId }); return; }
      const body = await readJsonBody(req);
      const instruction = (body.instruction || '').trim();
      if (!instruction) { sendJson(res, 400, { error: 'Expected a non-empty {instruction}' }); return; }

      agent.status = 'running';
      store.put('agents', agent);
      const startedAt = new Date().toISOString();
      const exec = logExecution(store, 'agent', agent.name + ' · run', 'running', instruction, agent.id);
      try {
        const result = await runAgentLoop(store, ollama, agent, instruction, body.context, 'agent');
        const finishedAt = new Date().toISOString();
        agent.status = 'idle';
        agent.lastRun = finishedAt;
        agent.lastResult = { instruction, content: result.content, toolTrace: result.toolTrace, rounds: result.rounds, at: finishedAt };
        store.put('agents', agent);
        const ex = store.get('executions', exec.id);
        if (ex) { ex.status = 'success'; ex.finishedAt = finishedAt; ex.detail = result.toolTrace.length + ' tool call(s), ' + result.rounds + ' round(s)'; store.put('executions', ex); }
        sendJson(res, 200, { agent, result, startedAt, finishedAt });
      } catch (e) {
        agent.status = 'error';
        store.put('agents', agent);
        const ex = store.get('executions', exec.id);
        if (ex) { ex.status = 'error'; ex.finishedAt = new Date().toISOString(); ex.detail = e.message || String(e); store.put('executions', ex); }
        throw e;
      }
    },
  },

  /* ---- Phase 4: real, server-driven, restart-resilient workflow runs ---- */
  {
    method: 'POST', pattern: /^\/api\/workflows\/([^/]+)\/run$/, handler: async (req, res, [id]) => {
      const run = workflowEngine.startRun(store, decodeURIComponent(id));
      sendJson(res, 202, run); // stepping continues after the response — see advanceRun below
      workflowEngine.advanceRun(store, ollama, run.id).catch(e => console.error('[nova-runtime] workflow run failed', run.id, e.message || e));
    },
  },
  {
    method: 'POST', pattern: /^\/api\/workflows\/runs\/([^/]+)\/approve$/, handler: async (req, res, [runId]) => {
      const run = workflowEngine.resolveApprovalNode(store, decodeURIComponent(runId), 'approve');
      sendJson(res, 202, run);
      if (run.status === 'running') {
        workflowEngine.advanceRun(store, ollama, run.id).catch(e => console.error('[nova-runtime] workflow run failed', run.id, e.message || e));
      }
    },
  },
  {
    method: 'POST', pattern: /^\/api\/workflows\/runs\/([^/]+)\/reject$/, handler: async (req, res, [runId]) => {
      sendJson(res, 200, workflowEngine.resolveApprovalNode(store, decodeURIComponent(runId), 'reject'));
    },
  },

  /* ---- Phase 3: sandboxed skill runner ---- */
  {
    method: 'POST', pattern: /^\/api\/skills\/([^/]+)\/run$/, handler: async (req, res, [id]) => {
      const skillId = decodeURIComponent(id);
      const body = await readJsonBody(req);
      const skill = store.get('skills', skillId);
      if (!skill) { sendJson(res, 404, { error: 'Unknown skill: ' + skillId }); return; }
      if (!skill.enabled) { sendJson(res, 400, { error: 'Skill "' + skill.name + '" is disabled.' }); return; }
      if (!REAL_SKILL_IDS.has(skillId)) {
        sendJson(res, 501, { error: 'No real sandboxed implementation for "' + skill.name + '" yet.' });
        return;
      }
      if (NETWORK_SKILL_IDS.has(skillId)) {
        const prefs = store.get('preferences', 'default');
        if (!prefs || !prefs.webAccess) {
          const finishedAt = new Date().toISOString();
          skill.audit = skill.audit || [];
          skill.audit.push({ at: finishedAt, action: 'Run blocked', detail: 'Refused — workspace is LOCAL ONLY. Enable Settings > Privacy > "Allow network access" to run this skill.' });
          store.put('skills', skill);
          sendJson(res, 403, { error: 'Blocked by workspace privacy setting: network access is off (LOCAL ONLY). Enable it in Settings > Privacy to run "' + skill.name + '".' });
          return;
        }
      }
      const startedAt = new Date().toISOString();
      try {
        const result = await runSkillSandboxed(skill, body.inputs, async (toolName, args) => {
          const server = mcpManager.findServerForTool(store, toolName);
          if (!server) { const e = new Error('No connected MCP server advertises tool "' + toolName + '"'); e.statusCode = 502; throw e; }
          return mcpManager.gatedCall(store, server.id, toolName, args, { wait: true, origin: 'skill', skillName: skill.name });
        });
        const finishedAt = new Date().toISOString();
        skill.lastRun = finishedAt;
        skill.runCount = (skill.runCount || 0) + 1;
        skill.health = { ok: true, lastCheck: finishedAt, detail: 'Ran successfully.' };
        skill.audit = skill.audit || [];
        skill.audit.push({ at: finishedAt, action: 'Run', detail: summarizeSkillResult(skillId, result) });
        store.put('skills', skill);
        sendJson(res, 200, { skill, result, startedAt, finishedAt });
      } catch (e) {
        const finishedAt = new Date().toISOString();
        skill.audit = skill.audit || [];
        skill.audit.push({ at: finishedAt, action: 'Run failed', detail: e.message || String(e) });
        store.put('skills', skill);
        throw e;
      }
    },
  },
  /* ---- Phase 5: real automation runs (was a client Math.random()<0.12
     coin-flip with a jittered sleep()) — the actual pipeline now lives in
     lib/scheduler.js so a manual "Run now" click, a scheduled tick, and a
     real ingest event all share the exact same code path. ---- */
  {
    method: 'POST', pattern: /^\/api\/automations\/([^/]+)\/run$/, handler: async (req, res, [id]) => {
      const autoId = decodeURIComponent(id);
      const result = await scheduler.runAutomation(store, ollama, autoId, { origin: 'manual' });
      sendJson(res, 200, result);
    },
  },
  /* ---- Phase 5 scheduler: create/configure automations with a real
     structured trigger, and expose the ticker's own live status. ---- */
  {
    method: 'POST', pattern: /^\/api\/automations$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      sendJson(res, 201, scheduler.createAutomation(store, body));
    },
  },
  {
    method: 'POST', pattern: /^\/api\/automations\/([^/]+)\/configure$/, handler: async (req, res, [id]) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, scheduler.configureAutomation(store, decodeURIComponent(id), body));
    },
  },
  { method: 'GET', pattern: /^\/api\/scheduler\/status$/, handler: async (req, res) => sendJson(res, 200, scheduler.getSchedulerStatus(store)) },

{ method: 'GET', pattern: /^\/api\/workbench\/snapshot$/, handler: async (_req, res) => sendJson(res, 200, new Workbench(store).snapshot())},

   { method: 'GET', pattern: /^\/api\/activation$/, handler: async (_req, res) => sendJson(res, 200, new ActivationLadder(store).snapshot()) },

   { method: 'POST', pattern: /^\/api\/workbench\/actions\/quarantine\/resolve$/, handler: async (req, res) => {
       const b = await readJsonBody(req);
       requireFields(b, ['id', 'decision', 'operator']);
       sendJson(res, 200, workbenchActions.resolveQuarantine(b));
     }
   },
   { method: 'POST', pattern: /^\/api\/workbench\/actions\/job\/cancel$/, handler: async (req, res) => {
       const b = await readJsonBody(req);
       requireFields(b, ['id', 'operator']);
       sendJson(res, 200, workbenchActions.cancelJob(b));
     }
   },
   { method: 'POST', pattern: /^\/api\/workbench\/actions\/runtime\/halt$/, handler: async (req, res) => {
       const b = await readJsonBody(req);
       requireFields(b, ['operator', 'reason']);
       sendJson(res, 200, workbenchActions.haltRuntime(b));
     }
   },
   { method: 'POST', pattern: /^\/api\/workbench\/actions\/runtime\/resume$/, handler: async (req, res) => {
       const b = await readJsonBody(req);
       requireFields(b, ['operator', 'reason']);
       sendJson(res, 200, workbenchActions.resumeRuntime(b));
     }
   },
   { method: 'POST', pattern: /^\/api\/workbench\/actions\/policy\/revoke$/, handler: async (req, res) => {
       const b = await readJsonBody(req);
       requireFields(b, ['id', 'operator']);
       sendJson(res, 200, workbenchActions.revokePolicy(b));
     }
   },

   { method: 'POST', pattern: /^\/api\/workbench\/actions\/connector\/approve$/, handler: async (req, res) => {
       const b = await readJsonBody(req);
       requireFields(b, ['id', 'operator']);
       sendJson(res, 200, await workbenchActions.approveConnectorAction(b));
     }
   },
   { method: 'POST', pattern: /^\/api\/workbench\/actions\/connector\/deny$/, handler: async (req, res) => {
       const b = await readJsonBody(req);
       requireFields(b, ['id', 'operator']);
       sendJson(res, 200, workbenchActions.denyConnectorAction(b));
     }
   },
  /* ---- Phase 5: real fixed-benchmark evaluation runs ---- */
  {
    method: 'POST', pattern: /^\/api\/evaluations\/run$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      if (!body.modelId) { sendJson(res, 400, { error: 'Expected {modelId}' }); return; }
      const exec = logExecution(store, 'inference', 'Evaluation · ' + evalBench.DATASET_NAME, 'running', 'Started', body.modelId);
      try {
        const result = await evalBench.runEvaluation(store, ollama, telemetry, body.modelId);
        const model = store.get('models', body.modelId);
        const label = '#' + (20 + store.all('evaluations').length);
        const row = {
          id: uid('eval'), label, modelId: body.modelId, modelLabel: model ? (model.name + ' ' + model.quant) : body.modelId,
          dataset: result.dataset, temperature: result.temperature,
          accuracy: result.accuracy, grounded: result.grounded, citation: result.citation,
          avgTtft: result.avgTtft, decode: result.decode, peakRam: result.peakRam, peakVram: result.peakVram,
          createdAt: new Date().toISOString(),
        };
        store.put('evaluations', row);
        const exRow = store.get('executions', exec.id);
        if (exRow) { exRow.status = 'success'; exRow.finishedAt = new Date().toISOString(); exRow.detail = result.accuracy + '% accuracy over ' + evalBench.BENCH_SET.length + ' fixed item(s)'; store.put('executions', exRow); }
        sendJson(res, 200, { evaluation: row, perItem: result.perItem });
      } catch (e) {
        const exRow = store.get('executions', exec.id);
        if (exRow) { exRow.status = 'error'; exRow.finishedAt = new Date().toISOString(); exRow.detail = e.message || String(e); store.put('executions', exRow); }
        throw e;
      }
    },
  },
];

// Skills with a real sandboxed entrypoint under skills/ (Phase 3, +webfetch
// in Phase 5). Anything else still runs on the frontend's pre-existing
// simulated path — labeled as such in the UI — rather than faking a real
// run here.
const REAL_SKILL_IDS = new Set(['skl_codelint', 'skl_filesearch', 'skl_webfetch']);

// Skills that genuinely reach the network when they run — gated below by
// the workspace's own privacy preference, not just a descriptive UI label.
// Real enforcement: this refuses to even start the sandboxed worker when
// Settings > Privacy > "Allow network access" is off, so toggling that
// setting actually determines whether the request happens, the same way
// the frontend's computePrivacyState() describes it as happening.
const NETWORK_SKILL_IDS = new Set(['skl_webfetch']);

// Turns a real skill result into a short audit-trail summary carrying the
// actual numbers, matching the house style of the pre-existing seed audit
// entries (e.g. "Linted 6 files, 2 findings") instead of a canned string
// that would be identical whether the run found anything or not.
function summarizeSkillResult(skillId, result) {
  if (skillId === 'skl_codelint' && result && typeof result === 'object') {
    return 'Real sandboxed run — scanned ' + (result.filesScanned || 0) + ' file(s), ' +
      ((result.findings || []).length) + ' finding(s).';
  }
  if (skillId === 'skl_filesearch' && result && typeof result === 'object') {
    return 'Real sandboxed run — ' + ((result.matches || []).length) + ' match(es) for "' + (result.query || '') + '".';
  }
  if (skillId === 'skl_webfetch' && result && typeof result === 'object') {
    return 'Real fetch — HTTP ' + result.statusCode + ' from ' + result.url + ' (' + result.bytesRead + ' byte(s)' + (result.truncated ? ', truncated' : '') + ').';
  }
  return 'Real sandboxed run completed.';
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  const denied = checkLocalAccess(req, server.address().port);
  if (denied) { sendJson(res, 403, { error: denied }); return; }
  let pathname;
  try {
    const url = new URL(req.url, 'http://localhost');
    pathname = decodeURI(url.pathname);
  } catch {
    sendJson(res, 400, { error: 'Malformed request URL' });
    return;
  }

  if (pathname.startsWith('/api/') || pathname.startsWith('/browser/')) {
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;
      try {
        await route.handler(req, res, match.slice(1));
      } catch (e) {
        sendError(res, e);
      }
      return;
    }
    sendJson(res, 404, { error: 'No such API route: ' + req.method + ' ' + pathname });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, pathname);
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`NOVA Runtime listening on http://127.0.0.1:${server.address().port}`);
  console.log(`  data dir:    ${DATA_DIR}`);
  console.log(`  ollama host: ${ollama.host}`);
  console.log(`  stores:      ${STORE_NAMES.join(', ')}`);
  const interruptedRuns=workspaceRunner.recoverInterrupted(store);
  if(interruptedRuns)console.log(`  recovered:   ${interruptedRuns} interrupted workspace run(s)`);
  const interruptedCollectors=collectorWorkflows.recoverInterrupted(store);
  if(interruptedCollectors)console.log(`  recovered:   ${interruptedCollectors} interrupted collector run(s)`);
  // A real child MCP server process never survives a restart — reconcile
  // any stale 'connected' status in the DB to 'disconnected' before
  // anything tries to resume work that might depend on one (below).
  const reconciled = mcpManager.reconcileOnStartup(store);
  if (reconciled) console.log(`  reconciled:  ${reconciled} MCP server row(s) marked disconnected (no process survives a restart)`);
  // Phase 4: any workflow run left 'running' from before this process
  // started (crash, restart, redeploy) resumes from its last persisted
  // node rather than being silently abandoned.
  const resumed = workflowEngine.resumeInFlightRuns(store, ollama);
  if (resumed) console.log(`  resumed:     ${resumed} in-flight workflow run(s)`);
  // Phase 5: the real automations scheduler + event receiver — starts
  // ticking immediately, independent of any browser tab being open.
  const schedStatus = scheduler.startScheduler(store, ollama);
  console.log(`  scheduler:   ticking every ${schedStatus.tickMs / 1000}s` +
    (schedStatus.lastCatchUp ? ` (rescheduled ${schedStatus.lastCatchUp.rescheduled} overdue automation(s) from startup)` : ''));
});

function shutdown() {
  console.log('\nShutting down NOVA Runtime...');
  mcpManager.shutdownAll(); // real child MCP server processes — close them, don't orphan
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server };
