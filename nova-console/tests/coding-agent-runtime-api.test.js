'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');
const { openDb, Store } = require('../lib/db');
const { AgentRegistry } = require('../lib/agents');
const { AgentTasks } = require('../lib/agent-tasks');
const { PLANNER_NAME, WORKER_NAME } = require('../lib/coding-agent-runtime');
const codingResult = require('../lib/coding-agent-result');
const workspaceScanner = require('../lib/workspace-scanner');

function request(base, route, options = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET';
    const req = http.request(base + route, { method, headers: { ...(method === 'POST' ? { Origin: base } : {}), ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...(options.headers || {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Request timed out')));
    req.end(body);
  });
}

async function start(dataDir) {
  const child = spawn(process.execPath, ['--no-warnings', '-e', "const {server}=require('./server'); server.on('listening',()=>process.send(server.address()));"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, NOVA_LIBRARY_DIR: path.join(dataDir, 'library'), OLLAMA_HOST: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const addressPromise = once(child, 'message').then(([value]) => value);
  const address = await Promise.race([addressPromise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
    child.once('exit', code => reject(new Error(`server exited during startup (${code})`)));
    addressPromise.finally(() => clearTimeout(timer));
  })]);
  return { base: `http://127.0.0.1:${address.port}`, async stop() {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await exited; clearTimeout(timer);
  } };
}

test('Coding Studio defers workspace batch creation until accept, then links a draft only', { timeout: 30000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-coding-studio-api-'));
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-coding-root-'));
  fs.writeFileSync(path.join(rootPath, 'before.txt'), 'before\n');
  let app;
  let db;
  try {
    app = await start(dataDir);
    const opened = openDb(dataDir); db = opened.db;
    const store = new Store(db);
    const registry = new AgentRegistry(store);
    const tasks = new AgentTasks(store, { registry });
    const planner = registry.getByName(PLANNER_NAME);
    const worker = registry.getByName(WORKER_NAME);
    assert.ok(planner && worker, 'server seeds its dedicated Coding Studio agents');
    const root = workspaceScanner.approveRoot(store, { path: rootPath, label: 'fixture' });
    const payload = { codingStudio: true, rootId: root.id, modelId: 'fixture-model:latest', modelDigest: 'sha256:' + 'a'.repeat(64), request: 'create new.txt', brahmiComments: false, feedback: '' };
    const task = tasks.create({ creatorId: planner.id, assigneeId: worker.id, title: 'Coding Studio proposal', payload });
    tasks.start(task.id, worker.id);
    const draft = { schema: codingResult.SCHEMA, version: codingResult.VERSION, summary: 'Create a sample file', changes: [{ operation: 'create', relativePath: 'new.txt', content: 'hello\n', impact: 'Adds the requested sample file.' }] };
    const draftSha256 = crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
    tasks.awaitResultReview(task.id, { batchId: null, taskId: task.id, rootId: payload.rootId, modelDigest: payload.modelDigest, draft, draftSha256, proposal: { summary: draft.summary, changes: draft.changes, acceptanceChecks: [] }, acceptanceChecks: [] }, worker.id);

    assert.equal(store.all('workspaceChangeBatches').length, 0, 'pending model output is not in the workspace batch store');
    const forge = await request(app.base, `/api/agents/tasks/${task.id}/review`, { method: 'POST', body: { decision: 'accept', reason: 'Looks fine', batchId: 'batch_forged' } });
    assert.equal(forge.status, 400, 'review body cannot supply or replace a batch');
    const inaccessible = await request(app.base, '/api/workspace/change-batches/batch_not_created/check', { method: 'POST' });
    assert.equal(inaccessible.status, 404, 'existing workspace batch routes have no pending proposal to act on');
    assert.equal(store.all('workspaceChangeBatches').length, 0);

    const accepted = await request(app.base, `/api/agents/tasks/${task.id}/review`, { method: 'POST', body: { decision: 'accept', reason: 'Reviewed the proposal.' } });
    assert.equal(accepted.status, 200, accepted.body);
    const acceptedTask = JSON.parse(accepted.body).task;
    assert.equal(acceptedTask.state, 'accepted');
    assert.equal(acceptedTask.codingStudio, true);
    assert.equal(acceptedTask.rootId, payload.rootId);
    assert.equal(acceptedTask.modelId, payload.modelId);
    assert.ok(acceptedTask.batchId);
    const batch = store.get('workspaceChangeBatches', acceptedTask.batchId);
    assert.equal(batch.status, 'draft', 'agent acceptance does not approve or apply workspace changes');
    assert.equal(batch.codingStudioTaskId, task.id);
    assert.equal(batch.modelDigest, payload.modelDigest);
    assert.equal(batch.sourceDraftSha256, draftSha256);
    assert.equal(fs.existsSync(path.join(rootPath, 'new.txt')), false, 'review does not write into the approved project');

    const detailResponse = await request(app.base, `/api/agents/tasks/${task.id}`);
    assert.equal(detailResponse.status, 200);
    const detail = JSON.parse(detailResponse.body);
    assert.equal(detail.task.result.proposal.summary, draft.summary);
    assert.equal(detail.task.batchPreview.status, 'draft');
    assert.equal(detail.task.batchPreview.changes[0].relativePath, 'new.txt');
    assert.equal('copy' in detail.task.batchPreview, false);
    assert.equal(JSON.stringify(detail).includes(rootPath), false, 'detail contains no absolute root path');
    assert.equal(JSON.stringify(detail).includes('copy.path'), false);

    const invalidCreate = await request(app.base, '/api/agents/coding/tasks', { method: 'POST', body: { rootId: root.id, modelId: 'fixture-model:latest', request: '' } });
    assert.equal(invalidCreate.status, 400, 'invalid requests are rejected before any model call');
    const unavailable = await request(app.base, '/api/agents/coding/tasks', { method: 'POST', body: { rootId: root.id, modelId: 'fixture-model:latest', request: 'create a new example.txt file', brahmiComments: false } });
    assert.ok([412, 503].includes(unavailable.status), 'dispatch fails closed when the selected model cannot be qualified or Ollama is unavailable');
    assert.equal(store.agentTasksList({}).filter(row => JSON.parse(row.payload_json || '{}').codingStudio).length, 1, 'failed preflight creates no task');
  } finally {
    if (db) db.close();
    if (app) await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});
