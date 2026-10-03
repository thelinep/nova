'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { openDb, Store } = require('../lib/db');
const { AgentRegistry } = require('../lib/agents');
const { AgentTasks } = require('../lib/agent-tasks');

function get(base, route, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + route, { method: options.method || 'GET', headers: options.headers || {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Request timed out')));
    req.end(options.body);
  });
}

async function start(dataDir) {
  const child = spawn(process.execPath, ['--no-warnings', '-e', "const {server}=require('./server'); server.on('listening',()=>process.send(server.address()));"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, NOVA_LIBRARY_DIR: path.join(dataDir, 'library'), OLLAMA_HOST: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const addressPromise = once(child, 'message').then(([value]) => value);
  const address = await Promise.race([
    addressPromise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
      child.once('exit', code => reject(new Error(`server exited during startup (${code})`)));
      addressPromise.finally(() => clearTimeout(timer));
    }),
  ]);
  return {
    base: `http://127.0.0.1:${address.port}`,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    },
  };
}

test('agent team API exposes task evidence read-only and reports execution/review gates honestly', { timeout: 30000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-agents-api-'));
  const { db } = openDb(dataDir);
  const store = new Store(db);
  const registry = new AgentRegistry(store);
  const tasks = new AgentTasks(store, { registry });
  const lead = registry.create({ name: 'studio-lead', role: 'supervisor' });
  const coder = registry.create({ name: 'studio-coder', role: 'worker', supervisorId: lead.id, allowedTools: ['workspace:read'] });
  const task = tasks.create({ title: 'Inspect a bounded code change', description: 'Return a proposal only.', creatorId: lead.id, assigneeId: coder.id, payload: { scope: 'single-file', workspaceRoot: '/example/project' } });
  tasks.start(task.id, coder.id);
  tasks.complete(task.id, { output: 'proposed diff', artifact: { path: 'src/example.js', patch: '@@ -1 +1 @@' } }, coder.id);
  store.setGlobalHalt('1');
  db.close();

  let app;
  try {
    app = await start(dataDir);
    const teamResponse = await get(app.base, '/api/agents/team');
    assert.equal(teamResponse.status, 200);
    const team = JSON.parse(teamResponse.body);
    assert.equal(team.agents.length, 2);
    assert.equal(team.agents.find(agent => agent.id === coder.id).supervisor_id, lead.id);
    assert.deepEqual(team.agents.find(agent => agent.id === coder.id).allowed_tools, ['workspace:read']);
    assert.equal(team.tasks[0].id, task.id);
    assert.equal(team.tasks[0].state, 'completed');
    assert.equal(team.controls.runtime_halted, true);
    assert.equal(team.controls.execution_available, false);
    assert.equal(team.controls.execution_reason, 'agent_job_bridge_not_registered');
    assert.equal(team.controls.human_result_review_available, false);

    const detailResponse = await get(app.base, `/api/agents/tasks/${encodeURIComponent(task.id)}`);
    assert.equal(detailResponse.status, 200);
    const detail = JSON.parse(detailResponse.body);
    assert.equal(detail.task.payload.scope, 'single-file');
    assert.equal(detail.task.result.artifact.path, 'src/example.js');
    assert.equal(detail.events.at(-1).kind, 'completed');
    assert.equal(detail.controls.runtime_halted, true);
    assert.equal(detail.controls.human_result_review_available, false);

    const noDispatch = await get(app.base, `/api/agents/tasks/${task.id}/start`, { method: 'POST', headers: { Origin: app.base } });
    assert.equal(noDispatch.status, 404, 'task API must not accidentally expose execution');
    const noReviewTransition = await get(app.base, `/api/agents/tasks/${task.id}/review`, { method: 'POST', headers: { Origin: app.base } });
    assert.equal(noReviewTransition.status, 404, 'task API must not imply a human review state exists');
    const missing = await get(app.base, '/api/agents/tasks/tsk_missing');
    assert.equal(missing.status, 404);
  } finally {
    if (app) await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
