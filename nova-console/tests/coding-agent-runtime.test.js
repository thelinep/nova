'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, Store } = require('../lib/db');
const { AgentRegistry } = require('../lib/agents');
const { AgentTasks } = require('../lib/agent-tasks');
const { BudgetEngine } = require('../lib/budgets');
const { AgentBudgets } = require('../lib/agent-budgets');
const { CodingAgentRuntime, PLANNER_NAME, WORKER_NAME, JOB_KIND, LIMITS } = require('../lib/coding-agent-runtime');
const { PolicyEngine } = require('../lib/policy');

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-coding-runtime-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  const registry = new AgentRegistry(store);
  const tasks = new AgentTasks(store, { registry });
  const budgetLedger = new AgentBudgets({ store, registry, budgetEngine: new BudgetEngine(store) });
  const policy = new PolicyEngine(store);
  const digest = 'sha256:' + 'b'.repeat(64);
  const response = { message: { content: '{}' }, prompt_eval_count: 10, eval_count: 5 };
  const ollama = {
    status: async () => ({ reachable: true, models: [{ name: 'model:latest', digest }] }),
    show: async () => ({ capabilities: ['completion'], template: 'chat', model_info: { 'test.context_length': 8192 } }),
    chatFull: async (_model, _messages, request = {}) => {
      options.onChatStarted?.();
      if (options.cancelDuringChat) return new Promise((resolve, reject) => {
        if (request.signal?.aborted) return reject(request.signal.reason);
        request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      });
      return options.chatError ? Promise.reject(options.chatError) : response;
    },
  };
  const plan = { draft: { summary: 'Make a small change', changes: [{ operation: 'create', relativePath: 'new.txt', content: 'hello' }] }, acceptanceChecks: [], planner: { modelId: 'model:latest' } };
  const planner = {
    preview: async () => ({ ready: true, selectedModel: { id: 'model:latest', digest } }),
    plan: async (_store, _scanner, _changes, client, input, opts) => {
      assert.equal(input.modelId, 'model:latest');
      assert.equal(opts.draftOnly, true);
      await client.chatFull('model:latest', [], { signal: opts.signal, options: { num_ctx: 8192, num_predict: 1024 } });
      return plan;
    },
  };
  const scanner = { approvedRoot: () => ({ id: 'root_test', path: dir }) };
  const changes = {};
  const runtime = new CodingAgentRuntime({ store, registry, tasks, scanner, changes, planner, ollama, budgets: budgetLedger, policy });
  const agents = runtime.seed();
  return { dir, db, store, registry, tasks, budgetLedger, policy, digest, runtime, agents };
}
function close(env) { try { env.runtime.stop(); env.db.close(); } catch {} fs.rmSync(env.dir, { recursive: true, force: true }); }
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for Coding Studio task state.');
}

for (const outcome of ['success', 'failure']) {
  test(`Coding Studio ${outcome} settles bounded token usage exactly once`, async () => {
    const env = fixture({ chatError: outcome === 'failure' ? new Error('local model failure') : null });
    try {
      const ctx = { task: { id: 'tsk_usage', payload: { codingStudio: true, rootId: 'root_test', modelId: 'model:latest', modelDigest: env.digest, request: 'Create new.txt', feedback: '' } }, agent: { id: env.agents.worker.id }, signal: new AbortController().signal };
      if (outcome === 'success') {
        const result = await env.runtime._execute(ctx);
        assert.equal(result.usage.tokens, 15);
        assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'tokens').used, 15);
      } else {
        await assert.rejects(env.runtime._execute(ctx), /local model failure/);
        assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'tokens').used, LIMITS.maxContextTokens, 'failed request is charged its reserved context');
      }
      assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'tokens').used <= LIMITS.maxTotalTokens, true);
    } finally { close(env); }
  });
}

test('Coding Studio success charges one job and one measured token amount across runtime and bridge', async () => {
  const env = fixture();
  try {
    env.runtime.start();
    const { task } = await env.runtime.createTask({ rootId: 'root_test', modelId: 'model:latest', request: 'Create new.txt' });
    await waitFor(() => env.tasks.get(task.id).state === 'awaiting_result_review');
    assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'tokens').used, 15);
    assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'jobs').used, 1);
  } finally { close(env); }
});

test('Coding Studio cancellation charges one bounded reserved-token amount and one dispatched job', async () => {
  let chatStarted = false;
  const env = fixture({ cancelDuringChat: true, onChatStarted: () => { chatStarted = true; } });
  try {
    env.runtime.start();
    const { task } = await env.runtime.createTask({ rootId: 'root_test', modelId: 'model:latest', request: 'Create new.txt' });
    await waitFor(() => chatStarted);
    await env.runtime.cancelTask(task.id);
    await waitFor(() => env.tasks.get(task.id).state === 'cancelled');
    assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'tokens').used, LIMITS.maxContextTokens);
    assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'jobs').used, 1);
  } finally { close(env); }
});

test('coding-only bridge refuses an enqueue failure without leaving a task or job', async () => {
  const env = fixture();
  try {
    env.runtime.stop();
    // Replace just the engine enqueue behavior after bridge registration.
    env.runtime.engine.enqueue = () => { throw new Error('synthetic enqueue failure'); };
    await assert.rejects(env.runtime.createTask({ rootId: 'root_test', modelId: 'model:latest', request: 'Create new.txt' }), /synthetic enqueue failure/);
    assert.equal(env.store.agentTasksList({}).filter(task => JSON.parse(task.payload_json || '{}').codingStudio).length, 0);
    assert.equal(env.store.jobsListByKindAndState(JOB_KIND, 'queued').length, 0);
    assert.equal(env.store.jobsListByKindAndState(JOB_KIND, 'running').length, 0);
  } finally { close(env); }
});

test('Coding Studio honors an explicit deny for the internal worker and approved root', () => {
  const env = fixture();
  try {
    env.policy.grant({ subject: { type: 'agent', id: env.agents.worker.id }, resource: { type: 'workspace', id: 'root_test' }, effect: 'deny', scope: 'read_only' });
    assert.throws(() => env.runtime._assertPolicy(env.agents.worker.id, 'root_test'), /policy denied/i);
  } finally { close(env); }
});
